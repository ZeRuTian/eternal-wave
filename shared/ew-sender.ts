// 发送核心：文件 → 分段 → 压缩/加密 → 喷泉编码 → 帧流。
//
// 纯逻辑层，不依赖 DOM：UI（send/main.ts）只负责把帧渲染成二维码并驱动
// 定时器；测试（tests/ew-e2e.test.ts）直接消费帧字节流验证协议。
//
// 调度（对应 PLAN.md）：
// - 开始连续发送清单帧 3 次；
// - 此后每 MANIFEST_RESEND_INTERVAL(24) 个数据帧后重发 1 次清单帧；
// - 数据帧按段推进：每段发送 ceil(1.35 × k) 个不同 seq 帧，发完切下一段；
//   全部段发完一轮后回到段 0 继续循环；
// - seq 全局递增（不按段重置），保证同段内 seq 唯一。

import { LTEncoder } from "./fountain";
import { MANIFEST_RESEND_INTERVAL, SEGMENT_COVERAGE, SEGMENT_SIZE, crc32, newTransferId, packFrame, type FrameHeader, MAX_FILE_BYTES, FRAME_TYPE_DATA, FRAME_TYPE_MANIFEST, MAX_FILE_LABEL } from "./ew-protocol";
import { deriveOrigLen, encodeManifest, sanitizeName, splitManifest, type SegmentParamV1, type TransferManifestV1 } from "./ew-manifest";
import { prepareSegment } from "./ew-segment";
import { deriveKey, randomSalt } from "./ew-crypto";
import { PBKDF2_ITERATIONS } from "./ew-constants";
import { Sha256 } from "./ew-sha256";

export const DEFAULT_FRAME_BYTES = 2331;
export const DEFAULT_TX_FPS = 30;
export const TX_FPS_OPTIONS: readonly number[] = [10, 15, 20, 24, 30, 60];
export const FRAME_BYTES_OPTIONS: readonly number[] = [500, 1000, 1465, 1850, 2331, 2953];

/** payload 字节数 = frameBytes - 帧头。 */
export function ewBlockLength(frameBytes: number): number {
  return frameBytes - 48;
}

export interface SenderOptions {
  /** 文件名（将按 safeFileName 净化）。 */
  name: string;
  mime: string;
  /** 文件来源。浏览器 UI 直接传 File，测试可继续传 Uint8Array。 */
  bytes: Uint8Array | Blob;
  /** 每帧 QR 字节数（含帧头），默认 2331。 */
  frameBytes?: number;
  /** 可选口令；为空则明文传输。 */
  passphrase?: string;
  /** 是否允许逐段 gzip。 */
  allowGzip?: boolean;
  /**
   * 喷泉冗余系数：每段发送 ceil(coverage × k) 个不同帧后切下一段。
   * 1.35 = 稳健（默认，抗 30% 丢帧）；1.2 = 高速（信道干净时吞吐约 +10%，
   * 必须高于 LT 解码开销 ~1.16 才能一轮收满；1.1 会导致等第二轮反而更慢）。
   * 纯发送端调度参数，接收端无需感知，新旧版本完全兼容。
   */
  coverage?: number;
  /** 预处理进度（完成分段数 / 总分段数），供大文件 UI 展示。 */
  onPrepareProgress?: (completed: number, total: number) => void;
}

export interface PreparedTransfer {
  manifest: TransferManifestV1;
  /** 清单帧头数组（同一份清单，分片后每片一个帧头）。 */
  manifestHeaders: FrameHeader[];
  manifestFrames: Uint8Array[];
  transferId: Uint8Array;
  blockLen: number;
  /** 本传输使用的喷泉冗余系数（决定调度节奏，不影响协议）。 */
  coverage: number;
  /** 分段按需读取，避免把 256 MB 原文和全部编码副本同时留在内存。 */
  source: SenderSource;
  allowGzip: boolean;
  key: CryptoKey | null;
  /** 最近使用的编码分段（LRU，最多 2 个），避免短文件循环时反复压缩/加密。 */
  segmentCache: Map<number, Uint8Array>;
}

interface SenderSource {
  readonly size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

function createSource(input: Uint8Array | Blob): SenderSource {
  if (input instanceof Uint8Array) {
    return {
      size: input.length,
      async read(start, end) {
        return input.slice(start, end);
      },
    };
  }
  return {
    size: input.size,
    async read(start, end) {
      return new Uint8Array(await input.slice(start, end).arrayBuffer());
    },
  };
}

/** 从传输 ID 派生喷泉码种子（128 位 → 32 位，发送/接收两端一致）。 */
export function sessionSeed(transferId: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < transferId.length; i++) {
    h ^= transferId[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 准备一次传输：校验上限 → 按 4 MiB 分段读取、分析 → 构建清单 → 预生成清单帧。
 * 浏览器可直接传入 File/Blob；这里只保留来源与分段参数，不保留整文件或
 * 全部分段的编码副本。实际发送时会用清单中的 nonce 按需重建当前分段。
 */
export async function prepareTransfer(opts: SenderOptions): Promise<PreparedTransfer> {
  const name = sanitizeName(opts.name);
  const source = createSource(opts.bytes);
  if (source.size === 0) throw new Error("请选择非空文件");
  if (source.size > MAX_FILE_BYTES) {
    throw new Error(`文件上限为 ${MAX_FILE_LABEL}，当前 ${source.size} 字节`);
  }
  const frameBytes = opts.frameBytes ?? DEFAULT_FRAME_BYTES;
  const blockLen = ewBlockLength(frameBytes);
  if (blockLen <= 0 || blockLen > 4096) throw new Error(`帧字节数 ${frameBytes} 不合法`);

  const segmentCount = Math.ceil(source.size / SEGMENT_SIZE);
  const allowGzip = opts.allowGzip ?? true;

  // 可选加密：先派生密钥（逐段加密复用同一密钥）
  let key: CryptoKey | null = null;
  let salt: Uint8Array | null = null;
  if (opts.passphrase && opts.passphrase.length > 0) {
    salt = randomSalt();
    key = await deriveKey(opts.passphrase, salt);
  }

  // 逐段处理
  const segmentParams: SegmentParamV1[] = [];
  const fileHash = new Sha256();
  for (let i = 0; i < segmentCount; i++) {
    const origLen = deriveOrigLen(i, source.size, SEGMENT_SIZE);
    const start = i * SEGMENT_SIZE;
    const orig = await source.read(start, start + origLen);
    if (orig.length !== origLen) throw new Error(`读取分段 ${i + 1} 失败：长度不完整`);
    fileHash.update(orig);
    const res = await prepareSegment(orig, i, { allowGzip, key });
    segmentParams.push(res.params);
    opts.onPrepareProgress?.(i + 1, segmentCount);
  }

  const fileSha256 = fileHash.digest();

  const manifest: TransferManifestV1 = {
    protocolVersion: 1,
    encrypted: key !== null,
    allowGzip,
    name,
    mime: opts.mime || "application/octet-stream",
    fileLen: source.size,
    segmentSize: SEGMENT_SIZE,
    segmentCount,
    compressionMode: allowGzip ? 1 : 0,
    cryptoMode: key ? 1 : 0,
    pbkdf2Iterations: key ? PBKDF2_ITERATIONS : 0,
    salt,
    fileSha256,
    segmentParams,
  };

  // 清单 → 分片 → 清单帧（帧头 + 分片 payload）
  const manifestBytes = encodeManifest(manifest);
  const chunks = splitManifest(manifestBytes, blockLen);
  const transferId = newTransferId();
  const manifestHeaders: FrameHeader[] = chunks.map((chunk, i) => ({
    frameType: FRAME_TYPE_MANIFEST,
    transferId,
    segmentIndex: i,
    segmentCount: chunks.length,
    seq: 0,
    k: 0,
    blockLen: chunk.length,
    segmentLen: manifestBytes.length,
    fileLen: source.size,
    crc32: crc32(chunk),
  }));
  const manifestFrames = manifestHeaders.map((h, i) => packFrame(h, chunks[i]!));

  const coverage = opts.coverage ?? SEGMENT_COVERAGE;
  if (!(coverage >= 1.0 && coverage <= 2.0)) throw new Error(`喷泉冗余系数 ${coverage} 不合法（应在 1.0–2.0）`);

  return {
    manifest,
    manifestHeaders,
    manifestFrames,
    transferId,
    blockLen,
    coverage,
    source,
    allowGzip,
    key,
    segmentCache: new Map(),
  };
}

/** 从文件来源重建一个编码分段；有界缓存最多保留最近两个编码分段。 */
async function buildEncodedSegment(p: PreparedTransfer, index: number): Promise<Uint8Array> {
  const cached = p.segmentCache.get(index);
  if (cached) {
    // Map 的插入顺序充当 LRU：命中后移到队尾。
    p.segmentCache.delete(index);
    p.segmentCache.set(index, cached);
    return cached;
  }
  const origLen = deriveOrigLen(index, p.manifest.fileLen, SEGMENT_SIZE);
  const start = index * SEGMENT_SIZE;
  const orig = await p.source.read(start, start + origLen);
  if (orig.length !== origLen) throw new Error(`读取分段 ${index + 1} 失败：长度不完整`);
  const expected = p.manifest.segmentParams[index];
  if (!expected) throw new Error(`清单缺少分段 ${index + 1}`);
  const rebuilt = await prepareSegment(orig, index, {
    allowGzip: p.allowGzip,
    key: p.key,
    noncePrefix: expected.noncePrefix,
  });
  if (
    rebuilt.params.encodedLen !== expected.encodedLen ||
    rebuilt.params.segCrc32 !== expected.segCrc32
  ) {
    throw new Error(`分段 ${index + 1} 重建结果与清单不一致`);
  }
  p.segmentCache.set(index, rebuilt.envelope.bytes);
  while (p.segmentCache.size > 2) {
    const oldest = p.segmentCache.keys().next().value as number | undefined;
    if (oldest === undefined) break;
    p.segmentCache.delete(oldest);
  }
  return rebuilt.envelope.bytes;
}

/**
 * 帧流生成器：产生无限帧序列（循环调度）。
 * 每次调用返回下一帧字节；永不结束（调用方按需取帧并控制节奏）。
 */
export async function* frameStream(p: PreparedTransfer): AsyncGenerator<Uint8Array> {
  const manifestBurst = 3; // 开始时连续 3 次清单
  for (let i = 0; i < manifestBurst; i++) {
    for (const f of p.manifestFrames) yield f;
  }

  const framesPerSegment = p.manifest.segmentParams.map((segment) => {
    const k = Math.max(1, Math.ceil(segment.encodedLen / p.blockLen));
    return { k, frames: Math.ceil(p.coverage * k) };
  });

  let seq = 0;
  let dataSinceManifest = 0;
  let segIdx = 0;
  for (;;) {
    // 按配置间隔重发清单，允许接收端中途加入。
    if (dataSinceManifest >= MANIFEST_RESEND_INTERVAL) {
      for (const f of p.manifestFrames) yield f;
      dataSinceManifest = 0;
    }
    const cur = framesPerSegment[segIdx]!;
    const segment = await buildEncodedSegment(p, segIdx);
    const encoder = new LTEncoder(segment, p.blockLen, sessionSeed(p.transferId));
    for (let i = 0; i < cur.frames; i++) {
      if (dataSinceManifest >= MANIFEST_RESEND_INTERVAL) {
        for (const f of p.manifestFrames) yield f;
        dataSinceManifest = 0;
      }
      const block = encoder.encode(seq);
      yield packFrame(
        {
          frameType: FRAME_TYPE_DATA,
          transferId: p.transferId,
          segmentIndex: segIdx,
          segmentCount: p.manifest.segmentCount,
          seq,
          k: cur.k,
          blockLen: p.blockLen,
          segmentLen: segment.length,
          fileLen: p.manifest.fileLen,
          crc32: crc32(block),
        },
        block,
      );
      seq++;
      dataSinceManifest++;
    }
    segIdx = (segIdx + 1) % p.manifest.segmentCount;
  }
}

/** 检查一个原始文件是否在给定帧字节数下可分块（k ≤ 0xffff）。 */
export function ewFitsSegment(encodedLen: number, frameBytes: number): boolean {
  const blockLen = ewBlockLength(frameBytes);
  return Math.ceil(encodedLen / blockLen) <= 0xffff;
}

/** 计算某段编码后长度的理论帧数（ceil）。 */
export function ewSegmentFrames(encodedLen: number, frameBytes: number): number {
  return Math.ceil(encodedLen / ewBlockLength(frameBytes));
}
