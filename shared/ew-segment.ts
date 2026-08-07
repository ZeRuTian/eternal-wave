// SegmentEnvelopeV1 — 段处理链：原始段 → [gzip] → [AES-256-GCM] → 编码后段。
//
// 每段独立处理：压缩按段判断（仅在确实缩小时采用 gzip），加密逐段使用
// 独立 nonce。编码后段（envelope）进入喷泉编码发送；接收端恢复后校验
// segCrc32 → 解密 → 解压 → 与推导的原始长度比对。
//
// 安全：解压输出上限 = 段原始长度（防压缩炸弹）；gzip 尾部声明的长度只作
// 提示，不做信任（与上游 gunzipAsync 相同思路，但按段粒度实现）。

import { crc32, SEGMENT_SIZE } from "./ew-protocol";
import type { SegmentParamV1 } from "./ew-manifest";
import { decryptSegment, encryptSegment } from "./ew-crypto";

export type SegmentCompression = 0 | 1; // 0=none, 1=gzip

export interface SegmentEnvelopeV1 {
  /** 编码后段（压缩+加密后）。发送端将其切块喷泉编码；接收端恢复它。 */
  bytes: Uint8Array;
  /** 该段是否经过 gzip。 */
  gzipped: boolean;
}

export interface SegmentOptions {
  /** 允许尝试 gzip（清单 flags bit1）。实际是否压缩由"确实缩小 64B+"决定。 */
  allowGzip: boolean;
  /** 加密密钥；为空表示本传输未加密。 */
  key: CryptoKey | null;
  /** 重建发送分段时复用清单内的 nonce；首次准备时留空并随机生成。 */
  noncePrefix?: Uint8Array | null;
}

export interface SegmentResult {
  envelope: SegmentEnvelopeV1;
  params: SegmentParamV1;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 解压并强制输出上限。`maxBytes` 必须已由调用方按段原始长度推导。
 * 超出上限立即中止，防止 gzip 炸弹。
 */
async function gunzipCapped(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const inflated = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const reader = inflated.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("解压后的数据超过段原始长度，已中止（疑似压缩炸弹）");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * 发送端：处理单个原始段 → 编码后段。
 * 返回 envelope（进入喷泉编码）与清单需要的段参数。
 */
export async function prepareSegment(
  origBytes: Uint8Array,
  segmentIndex: number,
  opts: SegmentOptions,
): Promise<SegmentResult> {
  if (origBytes.length > SEGMENT_SIZE) {
    throw new Error(`段 ${segmentIndex} 超过 ${SEGMENT_SIZE} 字节上限`);
  }
  // 压缩：仅在确实缩小时采用 gzip（+64 字节开销阈值）
  let body = origBytes;
  let gzipped = false;
  if (opts.allowGzip && origBytes.length >= 128) {
    const compressed = await gzip(origBytes);
    if (compressed.length + 64 < origBytes.length) {
      body = compressed;
      gzipped = true;
    }
  }

  // 加密：压缩后加密
  let encoded = body;
  let noncePrefix: Uint8Array | null = null;
  if (opts.key) {
    const enc = await encryptSegment(body, opts.key, segmentIndex, opts.noncePrefix ?? undefined);
    encoded = enc.data;
    noncePrefix = enc.noncePrefix;
  }

  const params: SegmentParamV1 = {
    encodedLen: encoded.length,
    segCrc32: crc32(encoded),
    noncePrefix,
  };
  return {
    envelope: { bytes: encoded, gzipped },
    params,
  };
}

/**
 * 接收端：恢复编码后段 → 原始段。
 * 校验 segCrc32 → 解密 → gzip 自动检测（magic 0x1f 0x8b，解压失败回退为
 * 未压缩）→ 长度必须等于推导的段原始长度。
 *
 * @param segmentIndex 段序号（参与 nonce 构造，必须与发送端一致）
 * @param opts.origLen 该段的推导原始长度（deriveOrigLen），用于解压上限与终检。
 */
export async function recoverSegment(
  envelopeBytes: Uint8Array,
  params: SegmentParamV1,
  segmentIndex: number,
  opts: { key: CryptoKey | null; origLen: number },
): Promise<Uint8Array> {
  if (envelopeBytes.length !== params.encodedLen) {
    throw new Error("段长度与清单声明不一致");
  }
  if (crc32(envelopeBytes) !== params.segCrc32) {
    throw new Error("段校验失败：喷泉解码结果与段 CRC 不符");
  }
  let body = envelopeBytes;
  if (opts.key) {
    if (!params.noncePrefix) throw new Error("加密传输缺少段 nonce 前缀");
    body = await decryptSegment(body, opts.key, segmentIndex, params.noncePrefix);
  }
  // gzip 自动检测：0x1f 0x8b 开头尝试解压；失败（非 gzip 数据/损坏）回退。
  let out: Uint8Array;
  if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) {
    try {
      out = await gunzipCapped(body, opts.origLen);
    } catch {
      out = body; // 不是合法 gzip（极小概率的明文巧合），按未压缩处理
    }
  } else {
    out = body;
  }
  if (out.length !== opts.origLen) {
    throw new Error(`段恢复长度 ${out.length} 与声明 ${opts.origLen} 不一致`);
  }
  return out;
}
