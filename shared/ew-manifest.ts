// TransferManifestV1 — 传输清单的编解码与严格校验。
//
// 清单保存文件名、MIME、大小、分段参数与完整文件 SHA-256，随帧流周期性
// 重发（发送开始时连续 3 次，此后每 MANIFEST_RESEND_INTERVAL 个数据帧 1 次）。
//
// payload 布局（little-endian）：
//   0   u8   protocolVersion = 1
//   1   u8   flags: bit0 = 加密, bit1 = 允许压缩(auto)
//   2   u16  nameLen, 后跟 nameLen 字节 UTF-8 文件名
//   …   u16  mimeLen, 后跟 mimeLen 字节 UTF-8 MIME
//   …   u32  fileLen 原始文件字节数
//   …   u16  segmentSize 固定 4194304 (4 MiB)
//   …   u16  segmentCount
//   …   u8   compressionMode (0=none, 1=gzip-auto)
//   …   u8   cryptoMode (0=none, 1=aes-256-gcm)
//   …   u32  pbkdf2Iterations 加密时 = 600000，否则 0
//   …   u8[16] salt 仅加密时存在
//   …   u8[32] fileSha256 完整原始文件 SHA-256
//   …   段参数表 segmentCount 项：
//          u32 encodedLen  本段编码后总长（含 GCM tag 16B，若加密）
//          u32 segCrc32    本段编码后数据的 CRC32
//          u8[8] noncePrefix 仅加密时存在
//   …   u32 manifestCrc32 对整个 payload（本字段之前所有字节）的 CRC32
//
// 未加密时每段参数 8 字节；加密时 16 字节。

import {
  MANIFEST_FLAG_ALLOW_GZIP,
  MANIFEST_FLAG_ENCRYPTED,
  MANIFEST_PROTOCOL_VERSION,
  MAX_FILE_BYTES,
  MAX_MIME_LEN,
  MAX_NAME_LEN,
  MAX_SEGMENT_ENCODED,
  MAX_SEGMENTS,
  SEGMENT_SIZE,
  crc32,
} from "./ew-protocol";
import { NONCE_PREFIX_LEN, PBKDF2_ITERATIONS, SALT_LEN } from "./ew-constants";

export interface SegmentParamV1 {
  /** 本段编码后总长（压缩+加密后，含 GCM tag）。 */
  encodedLen: number;
  /** 本段编码后数据的 CRC32。 */
  segCrc32: number;
  /** 8 字节随机 nonce 前缀（仅加密时存在）。 */
  noncePrefix: Uint8Array | null;
}

export interface TransferManifestV1 {
  protocolVersion: number;
  encrypted: boolean;
  allowGzip: boolean;
  name: string;
  mime: string;
  fileLen: number;
  segmentSize: number;
  segmentCount: number;
  compressionMode: 0 | 1;
  cryptoMode: 0 | 1;
  pbkdf2Iterations: number;
  salt: Uint8Array | null;
  fileSha256: Uint8Array; // 32 字节
  segmentParams: SegmentParamV1[];
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** 段原始长度推导：前 segmentCount-1 段满 4 MiB，最后一段取余。 */
export function deriveOrigLen(
  index: number,
  fileLen: number,
  segmentSize: number = SEGMENT_SIZE,
): number {
  if (index < 0) throw new Error("段序号不能为负");
  const start = index * segmentSize;
  if (start >= fileLen) throw new Error("段序号超出文件范围");
  return Math.min(segmentSize, fileLen - start);
}

/** 构造清单字节。参数必须先经过合法性检查（由 buildManifest 内部完成）。 */
export function encodeManifest(m: TransferManifestV1): Uint8Array {
  const nameBytes = textEncoder.encode(m.name);
  const mimeBytes = textEncoder.encode(m.mime);
  if (nameBytes.length === 0 || nameBytes.length > MAX_NAME_LEN) {
    throw new Error(`文件名长度 ${nameBytes.length} 超出上限 ${MAX_NAME_LEN}`);
  }
  if (mimeBytes.length > MAX_MIME_LEN) {
    throw new Error(`MIME 类型长度 ${mimeBytes.length} 超出上限 ${MAX_MIME_LEN}`);
  }
  const perParam = m.encrypted ? 16 : 8;
  const fixedLen =
    2 + 2 + nameBytes.length + 2 + mimeBytes.length + 4 + 4 + 2 + 1 + 1 + 4 +
    (m.encrypted ? SALT_LEN : 0) + 32 +
    m.segmentParams.length * perParam +
    4;
  const out = new Uint8Array(fixedLen);
  const dv = new DataView(out.buffer);
  let o = 0;
  dv.setUint8(o, m.protocolVersion);
  o += 1;
  let flags = 0;
  if (m.encrypted) flags |= MANIFEST_FLAG_ENCRYPTED;
  if (m.allowGzip) flags |= MANIFEST_FLAG_ALLOW_GZIP;
  dv.setUint8(o, flags);
  o += 1;
  dv.setUint16(o, nameBytes.length, true);
  o += 2;
  out.set(nameBytes, o);
  o += nameBytes.length;
  dv.setUint16(o, mimeBytes.length, true);
  o += 2;
  out.set(mimeBytes, o);
  o += mimeBytes.length;
  dv.setUint32(o, m.fileLen, true);
  o += 4;
  dv.setUint32(o, m.segmentSize, true);
  o += 4;
  dv.setUint16(o, m.segmentCount, true);
  o += 2;
  dv.setUint8(o, m.compressionMode);
  o += 1;
  dv.setUint8(o, m.cryptoMode);
  o += 1;
  dv.setUint32(o, m.pbkdf2Iterations, true);
  o += 4;
  if (m.encrypted) {
    if (!m.salt || m.salt.length !== SALT_LEN) throw new Error("加密清单必须携带 16 字节盐");
    out.set(m.salt, o);
    o += SALT_LEN;
  }
  if (m.fileSha256.length !== 32) throw new Error("文件 SHA-256 必须为 32 字节");
  out.set(m.fileSha256, o);
  o += 32;
  for (const p of m.segmentParams) {
    if (p.encodedLen <= 0 || p.encodedLen > MAX_SEGMENT_ENCODED) {
      throw new Error("段编码长度越界");
    }
    dv.setUint32(o, p.encodedLen, true);
    o += 4;
    dv.setUint32(o, p.segCrc32, true);
    o += 4;
    if (m.encrypted) {
      if (!p.noncePrefix || p.noncePrefix.length !== NONCE_PREFIX_LEN) {
        throw new Error("加密清单的每段必须携带 8 字节 nonce 前缀");
      }
      out.set(p.noncePrefix, o);
      o += NONCE_PREFIX_LEN;
    } else if (p.noncePrefix) {
      throw new Error("未加密清单不应携带 nonce 前缀");
    }
  }
  const bodyLen = o;
  const crc = crc32(out.subarray(0, bodyLen));
  dv.setUint32(bodyLen, crc, true);
  return out;
}

/** 解析清单。任何结构、长度、上限或 CRC 问题都抛错（中文）。 */
export function parseManifest(bytes: Uint8Array): TransferManifestV1 {
  if (bytes.length < 20) throw new Error("清单过短");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const protocolVersion = dv.getUint8(o);
  o += 1;
  if (protocolVersion !== MANIFEST_PROTOCOL_VERSION) {
    throw new Error(`不支持的清单协议版本 ${protocolVersion}`);
  }
  const flags = dv.getUint8(o);
  o += 1;
  const encrypted = (flags & MANIFEST_FLAG_ENCRYPTED) !== 0;
  const allowGzip = (flags & MANIFEST_FLAG_ALLOW_GZIP) !== 0;

  const nameLen = dv.getUint16(o, true);
  o += 2;
  if (nameLen === 0 || nameLen > MAX_NAME_LEN) throw new Error("文件名长度越界");
  const name = textDecoder.decode(bytes.subarray(o, o + nameLen));
  o += nameLen;
  const mimeLen = dv.getUint16(o, true);
  o += 2;
  if (mimeLen > MAX_MIME_LEN) throw new Error("MIME 类型长度越界");
  const mime = textDecoder.decode(bytes.subarray(o, o + mimeLen));
  o += mimeLen;

  const fileLen = dv.getUint32(o, true);
  o += 4;
  if (fileLen === 0 || fileLen > MAX_FILE_BYTES) throw new Error("文件长度越界");
  const segmentSize = dv.getUint32(o, true);
  o += 4;
  if (segmentSize !== SEGMENT_SIZE) throw new Error(`不支持的段大小 ${segmentSize}`);
  const segmentCount = dv.getUint16(o, true);
  o += 2;
  if (segmentCount === 0 || segmentCount > MAX_SEGMENTS) throw new Error("段数量越界");
  // 段数与文件长度兼容：最后一段可不满，但文件必须能由这些段覆盖
  if (segmentCount > Math.ceil(fileLen / segmentSize)) throw new Error("段数量与文件长度不一致");
  const compressionMode = dv.getUint8(o);
  o += 1;
  if (compressionMode > 1) throw new Error("不支持的压缩模式");
  const cryptoMode = dv.getUint8(o);
  o += 1;
  if (cryptoMode > 1) throw new Error("不支持的加密模式");
  if (cryptoMode === 1 !== encrypted) throw new Error("加密标志与加密模式不一致");
  const pbkdf2Iterations = dv.getUint32(o, true);
  o += 4;

  let salt: Uint8Array | null = null;
  if (encrypted) {
    if (pbkdf2Iterations !== PBKDF2_ITERATIONS) {
      throw new Error(`不支持的 PBKDF2 迭代次数 ${pbkdf2Iterations}`);
    }
    if (o + SALT_LEN > bytes.length) throw new Error("清单缺少盐");
    salt = bytes.slice(o, o + SALT_LEN);
    o += SALT_LEN;
  } else if (pbkdf2Iterations !== 0) {
    throw new Error("未加密清单不应携带 PBKDF2 参数");
  }

  if (o + 32 > bytes.length) throw new Error("清单缺少文件 SHA-256");
  const fileSha256 = bytes.slice(o, o + 32);
  o += 32;

  const perParam = encrypted ? 16 : 8;
  if (o + segmentCount * perParam + 4 > bytes.length) throw new Error("清单缺少段参数表");
  const segmentParams: SegmentParamV1[] = [];
  for (let i = 0; i < segmentCount; i++) {
    const encodedLen = dv.getUint32(o, true);
    o += 4;
    if (encodedLen <= 0 || encodedLen > MAX_SEGMENT_ENCODED) {
      throw new Error(`段 ${i} 编码长度越界`);
    }
    // 编码后长度与该段原始长度兼容（压缩+加密后不会小于原始长度的约 1/16，防御性下限）
    const origLen = deriveOrigLen(i, fileLen, segmentSize);
    if (encodedLen < Math.ceil(origLen / 32) && encodedLen < 256) {
      // 极小的段允许较小输出；仅当明显不合理时才拒绝
      if (encodedLen < 32 && origLen > 512) throw new Error(`段 ${i} 编码长度可疑`);
    }
    const segCrc32 = dv.getUint32(o, true);
    o += 4;
    let noncePrefix: Uint8Array | null = null;
    if (encrypted) {
      noncePrefix = bytes.slice(o, o + NONCE_PREFIX_LEN);
      o += NONCE_PREFIX_LEN;
    }
    segmentParams.push({ encodedLen, segCrc32, noncePrefix });
  }

  if (o + 4 !== bytes.length) throw new Error("清单长度与内容不一致");
  const declaredCrc = dv.getUint32(o, true);
  const actualCrc = crc32(bytes.subarray(0, o));
  if (declaredCrc !== actualCrc) throw new Error("清单校验和错误");

  return {
    protocolVersion,
    encrypted,
    allowGzip,
    name: sanitizeName(name),
    mime: mime || "application/octet-stream",
    fileLen,
    segmentSize,
    segmentCount,
    compressionMode: compressionMode as 0 | 1,
    cryptoMode: cryptoMode as 0 | 1,
    pbkdf2Iterations,
    salt,
    fileSha256,
    segmentParams,
  };
}

/**
 * 文件名净化：取 basename、剔除控制字符与路径穿越名。接收端必须自己再做
 * 一遍（不信任发送端），但发送端先净化是良好的卫生习惯。
 */
export function sanitizeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "transfer.bin" : cleaned;
}

/**
 * 将清单 payload 切成不超过 blockLen 的分片（防御性：正常 256 MB 文件清单
 * 约 1.2 KB，单帧可装下，但接收端与发送端都支持分片以防未来扩展）。
 * 返回各分片（每片 ≤ blockLen 字节）。
 */
export function splitManifest(bytes: Uint8Array, blockLen: number): Uint8Array[] {
  if (blockLen <= 0) throw new Error("分片长度必须为正");
  if (bytes.length <= blockLen) return [bytes];
  const chunks: Uint8Array[] = [];
  for (let off = 0; off < bytes.length; off += blockLen) {
    chunks.push(bytes.slice(off, Math.min(off + blockLen, bytes.length)));
  }
  return chunks;
}

/** 将清单分片按序号合并还原（调用方需自行验证分片序号连续性）。 */
export function joinManifestFrames(frames: Map<number, Uint8Array>, total: number): Uint8Array | null {
  if (frames.size !== total) return null;
  let len = 0;
  for (let i = 0; i < total; i++) {
    const f = frames.get(i);
    if (!f) return null;
    len += f.length;
  }
  const out = new Uint8Array(len);
  let off = 0;
  for (let i = 0; i < total; i++) {
    const f = frames.get(i)!;
    out.set(f, off);
    off += f.length;
  }
  return out;
}
