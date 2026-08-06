// 发送核心：文件 → 分段 → 压缩/加密 → 喷泉编码 → 帧流。
//
// 纯逻辑层，不依赖 DOM：UI（send/main.ts）只负责把帧渲染成二维码并驱动
// 定时器；测试（tests/ew-e2e.test.ts）直接消费帧字节流验证协议。
//
// 调度（对应 PLAN.md）：
// - 开始连续发送清单帧 3 次；
// - 此后每 MANIFEST_RESEND_INTERVAL(120) 个数据帧后重发 1 次清单帧；
// - 数据帧按段推进：每段发送 ceil(1.35 × k) 个不同 seq 帧，发完切下一段；
//   全部段发完一轮后回到段 0 继续循环；
// - seq 全局递增（不按段重置），保证同段内 seq 唯一。

import { LTEncoder } from "./fountain";
import { MANIFEST_RESEND_INTERVAL, SEGMENT_COVERAGE, SEGMENT_SIZE, crc32, newTransferId, packFrame, type FrameHeader, MAX_FILE_BYTES, FRAME_TYPE_DATA, FRAME_TYPE_MANIFEST, MAX_FILE_LABEL } from "./ew-protocol";
import { deriveOrigLen, encodeManifest, sanitizeName, splitManifest, type SegmentParamV1, type TransferManifestV1 } from "./ew-manifest";
import { prepareSegment } from "./ew-segment";
import { deriveKey, randomSalt } from "./ew-crypto";
import { PBKDF2_ITERATIONS } from "./ew-constants";
import { sha256Once } from "./ew-sha256";

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
  /** 文件字节。 */
  bytes: Uint8Array;
  /** 每帧 QR 字节数（含帧头），默认 2331。 */
  frameBytes?: number;
  /** 可选口令；为空则明文传输。 */
  passphrase?: string;
  /** 是否允许逐段 gzip。 */
  allowGzip?: boolean;
}

export interface PreparedTransfer {
  manifest: TransferManifestV1;
  /** 各段的编码后数据（index → envelope 字节）。 */
  segments: Uint8Array[];
  /** 清单帧头数组（同一份清单，分片后每片一个帧头）。 */
  manifestHeaders: FrameHeader[];
  manifestFrames: Uint8Array[];
  transferId: Uint8Array;
  blockLen: number;
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
 * 准备一次传输：校验上限 → 逐段压缩/加密 → 构建清单 → 预生成清单帧。
 * 大文件（>64MB）不在此处整载入——调用方负责以文件流分片读入；本函数
 * 接收完整字节数组（浏览器中由 File 对象读出）。
 */
export async function prepareTransfer(opts: SenderOptions): Promise<PreparedTransfer> {
  const name = sanitizeName(opts.name);
  const bytes = opts.bytes;
  if (bytes.length === 0) throw new Error("请选择非空文件");
  if (bytes.length > MAX_FILE_BYTES) {
    throw new Error(`文件上限为 ${MAX_FILE_LABEL}，当前 ${bytes.length} 字节`);
  }
  const frameBytes = opts.frameBytes ?? DEFAULT_FRAME_BYTES;
  const blockLen = ewBlockLength(frameBytes);
  if (blockLen <= 0 || blockLen > 4096) throw new Error(`帧字节数 ${frameBytes} 不合法`);

  const segmentCount = Math.ceil(bytes.length / SEGMENT_SIZE);
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
  const segments: Uint8Array[] = [];
  for (let i = 0; i < segmentCount; i++) {
    const origLen = deriveOrigLen(i, bytes.length, SEGMENT_SIZE);
    const orig = bytes.subarray(i * SEGMENT_SIZE, i * SEGMENT_SIZE + origLen);
    const res = await prepareSegment(orig, i, { allowGzip, key });
    segments.push(res.envelope.bytes);
    segmentParams.push(res.params);
  }

  // 文件级 SHA-256（增量计算，避免额外大分配）
  const fileSha256 = sha256Once(bytes);

  const manifest: TransferManifestV1 = {
    protocolVersion: 1,
    encrypted: key !== null,
    allowGzip,
    name,
    mime: opts.mime || "application/octet-stream",
    fileLen: bytes.length,
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
    fileLen: bytes.length,
    crc32: crc32(chunk),
  }));
  const manifestFrames = manifestHeaders.map((h, i) => packFrame(h, chunks[i]!));

  return { manifest, segments, manifestHeaders, manifestFrames, transferId, blockLen };
}

/**
 * 帧流生成器：产生无限帧序列（循环调度）。
 * 每次调用返回下一帧字节；永不结束（调用方按需取帧并控制节奏）。
 */
export function* frameStream(p: PreparedTransfer): Generator<Uint8Array> {
  const manifestBurst = 3; // 开始时连续 3 次清单
  for (let i = 0; i < manifestBurst; i++) {
    for (const f of p.manifestFrames) yield f;
  }

  const framesPerSegment = p.segments.map((seg) => {
    const k = Math.max(1, Math.ceil(seg.length / p.blockLen));
    return { k, frames: Math.ceil(SEGMENT_COVERAGE * k), encoder: new LTEncoder(seg, p.blockLen, sessionSeed(p.transferId)) };
  });

  let seq = 0;
  let dataSinceManifest = 0;
  let segIdx = 0;
  for (;;) {
    // 每 120 个数据帧后重发一次清单
    if (dataSinceManifest >= MANIFEST_RESEND_INTERVAL) {
      for (const f of p.manifestFrames) yield f;
      dataSinceManifest = 0;
    }
    const cur = framesPerSegment[segIdx]!;
    for (let i = 0; i < cur.frames; i++) {
      if (dataSinceManifest >= MANIFEST_RESEND_INTERVAL) {
        for (const f of p.manifestFrames) yield f;
        dataSinceManifest = 0;
      }
      const block = cur.encoder.encode(seq);
      yield packFrame(
        {
          frameType: FRAME_TYPE_DATA,
          transferId: p.transferId,
          segmentIndex: segIdx,
          segmentCount: p.segments.length,
          seq,
          k: cur.k,
          blockLen: p.blockLen,
          segmentLen: p.segments[segIdx]!.length,
          fileLen: p.manifest.fileLen,
          crc32: crc32(block),
        },
        block,
      );
      seq++;
      dataSinceManifest++;
    }
    segIdx = (segIdx + 1) % p.segments.length;
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
