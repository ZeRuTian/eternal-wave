// Eternal Wave Protocol v1 — 帧格式、CRC32 与硬上限。
//
// 与上游 Decimen 协议（20 字节帧头）不兼容：本协议使用 48 字节自描述帧头，
// 支持 4 MiB 分段、清单帧、可选加密与检查点续传。
//
// 帧头布局（全部 little-endian）：
//   0   u8   magic0 = 0xE7
//   1   u8   magic1 = 0x57
//   2   u8   version = 1
//   3   u8   frameType  (1=manifest, 2=data)
//   4   u8[16] transferId  128-bit 随机，发送端每次启动新生成
//  20   u32  segmentIndex  data: 段序号; manifest: 分片序号
//  24   u32  segmentCount  data: 段总数; manifest: 分片总数
//  28   u32  seq           data: 喷泉帧序号; manifest: 恒 0
//  32   u16  k             data: 本段源块数; manifest: 恒 0
//  34   u16  blockLen      data: 每帧 payload 字节数; manifest: 本片长度
//  36   u32  segmentLen    data: 本段编码后总长度; manifest: 清单总长
//  40   u32  fileLen       原始文件字节数（两种帧都有）
//  44   u32  crc32         payload 的 CRC32（IEEE 802.3）
//
// 安全原则：所有解析路径先校验字段关系与上限，再分配内存。

export const HEADER_LEN = 48;
export const MAGIC0 = 0xe7;
export const MAGIC1 = 0x57;
export const PROTOCOL_VERSION = 1;

export const FRAME_TYPE_MANIFEST = 1;
export const FRAME_TYPE_DATA = 2;

// ---- 硬上限（先于任何分配校验） ----
export const MAX_FILE_BYTES = 256 * 1024 * 1024; // 256 MiB
export const SEGMENT_SIZE = 4 * 1024 * 1024; // 4 MiB
export const MAX_SEGMENTS = Math.ceil(MAX_FILE_BYTES / SEGMENT_SIZE); // 64
export const MAX_SEGMENT_ENCODED = 8 * 1024 * 1024; // 压缩+加密后单段上限
export const MAX_SOURCE_BLOCKS = 0xffff; // k 是 u16
export const MAX_BLOCK_LEN = 4096; // blockLen 是 u16 但上限收紧
export const MAX_NAME_LEN = 1024; // 文件名 UTF-8 字节上限
export const MAX_MIME_LEN = 512; // MIME 类型字节上限
export const MAX_FILE_LABEL = "256 MB";

export const MANIFEST_PROTOCOL_VERSION = 1;
export const MANIFEST_FLAG_ENCRYPTED = 1 << 0;
export const MANIFEST_FLAG_ALLOW_GZIP = 1 << 1;

// 清单帧每 120 个数据帧后重发一次（发送调度）。
export const MANIFEST_RESEND_INTERVAL = 120;

// 每段发送 ≈ 1.35 × k 个不同帧后切换下一段（发送调度）。
export const SEGMENT_COVERAGE = 1.35;

/** 数据帧：所有字段必须在分配前通过的关系校验。 */
export interface FrameHeader {
  frameType: number;
  transferId: Uint8Array; // 16 字节
  segmentIndex: number;
  segmentCount: number;
  seq: number;
  k: number;
  blockLen: number;
  segmentLen: number;
  fileLen: number;
  crc32: number;
}

export function packFrame(h: FrameHeader, payload: Uint8Array): Uint8Array {
  if (h.transferId.length !== 16) throw new Error("transferId 必须为 16 字节");
  if (payload.length !== h.blockLen) {
    throw new Error(`payload 长度 ${payload.length} 与 blockLen ${h.blockLen} 不一致`);
  }
  const out = new Uint8Array(HEADER_LEN + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, MAGIC0);
  dv.setUint8(1, MAGIC1);
  dv.setUint8(2, PROTOCOL_VERSION);
  dv.setUint8(3, h.frameType);
  out.set(h.transferId, 4);
  dv.setUint32(20, h.segmentIndex >>> 0, true);
  dv.setUint32(24, h.segmentCount >>> 0, true);
  dv.setUint32(28, h.seq >>> 0, true);
  dv.setUint16(32, h.k, true);
  dv.setUint16(34, h.blockLen, true);
  dv.setUint32(36, h.segmentLen >>> 0, true);
  dv.setUint32(40, h.fileLen >>> 0, true);
  const crc = crc32(payload);
  dv.setUint32(44, crc, true);
  out.set(payload, HEADER_LEN);
  return out;
}

export interface ParsedFrame {
  header: FrameHeader;
  payload: Uint8Array;
}

/**
 * 严格解析一帧。任何字段越界、关系矛盾或 CRC 不符都返回 null（丢弃），
 * 且保证在读取到 payload 字节之前完成全部上限校验，不会为恶意帧分配
 * 与 payload 等大的内存。
 */
export function parseFrame(bytes: Uint8Array): ParsedFrame | null {
  if (bytes.length <= HEADER_LEN) return null;
  if (bytes[0] !== MAGIC0 || bytes[1] !== MAGIC1) return null;
  if (bytes[2] !== PROTOCOL_VERSION) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frameType = dv.getUint8(3);
  if (frameType !== FRAME_TYPE_MANIFEST && frameType !== FRAME_TYPE_DATA) return null;

  const header: FrameHeader = {
    frameType,
    transferId: bytes.slice(4, 20),
    segmentIndex: dv.getUint32(20, true),
    segmentCount: dv.getUint32(24, true),
    seq: dv.getUint32(28, true),
    k: dv.getUint16(32, true),
    blockLen: dv.getUint16(34, true),
    segmentLen: dv.getUint32(36, true),
    fileLen: dv.getUint32(40, true),
    crc32: dv.getUint32(44, true),
  };

  // ---- 上限与关系校验（全部先于任何 payload 分配） ----
  if (header.fileLen === 0 || header.fileLen > MAX_FILE_BYTES) return null;
  if (header.segmentCount === 0 || header.segmentCount > MAX_SEGMENTS) return null;
  if (header.blockLen === 0 || header.blockLen > MAX_BLOCK_LEN) return null;
  if (bytes.length !== HEADER_LEN + header.blockLen) return null;

  if (frameType === FRAME_TYPE_MANIFEST) {
    // 清单帧：segmentIndex = 分片序号, segmentCount = 分片总数, k/seq 恒 0
    if (header.k !== 0 || header.seq !== 0) return null;
    if (header.segmentIndex >= header.segmentCount) return null;
    if (header.segmentLen === 0 || header.segmentLen > 8 * 1024 * 1024) return null;
  } else {
    // 数据帧：k/segmentLen/segmentIndex 关系
    if (header.k === 0 || header.k > MAX_SOURCE_BLOCKS) return null;
    if (header.segmentIndex >= header.segmentCount) return null;
    if (header.segmentLen === 0 || header.segmentLen > MAX_SEGMENT_ENCODED) return null;
    // k 个块必须能恰好覆盖 segmentLen（最后一个块可不满）
    if (header.k > Math.ceil(header.segmentLen / header.blockLen)) return null;
    // 兼容性：文件总长与段数关系（最后一段可不满）
    if (header.segmentCount > Math.ceil(header.fileLen / SEGMENT_SIZE)) return null;
  }

  const payload = bytes.subarray(HEADER_LEN);
  if (crc32(payload) !== header.crc32) return null;
  return { header, payload };
}

// ---- CRC32（IEEE 802.3，多项式 0xEDB88320） ----
let crcTable: Uint32Array | null = null;

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

/** 标准 CRC-32（zlib 语义）：初始 0xFFFFFFFF，输出异或 0xFFFFFFFF。 */
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) crcTable = buildCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---- 128 位传输 ID ----
/** 生成新的随机传输 ID（16 字节）。 */
export function newTransferId(): Uint8Array {
  const out = new Uint8Array(16);
  crypto.getRandomValues(out);
  return out;
}

/** 将传输 ID 转成可读字符串（仅用于 UI 展示/日志，不用于协议）。 */
export function transferIdHex(id: Uint8Array): string {
  return Array.from(id)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
