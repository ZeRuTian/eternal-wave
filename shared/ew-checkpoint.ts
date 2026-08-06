// TransferCheckpointV1 — 接收进度检查点（.ewckpt 文件）。
//
// 布局（little-endian）：
//   0   u8[4]  magic "EWCP"
//   4   u16    version = 1
//   6   u8[16] transferId
//  22   u32    segmentCount
//  26   u32    fileLen
//  30   u32    segmentSize
//  34   u8[M]  完成位图：ceil(segmentCount/8) 字节，bit i = 段 i 已完成
//  34+M u32    crc32（对之前所有字节）
//
// 损坏/版本不符 → parse 返回 null，调用方视为无检查点、从头开始
// （保留 .ewpart，仅提示用户）。写入语义：调用方负责临时文件 + 原子 rename
// （见 ew-storage.ts）。

import { crc32, MAX_SEGMENTS, SEGMENT_SIZE } from "./ew-protocol";
import { MAX_FILE_BYTES } from "./ew-protocol";

const CHECKPOINT_MAGIC = "EWCP";
const CHECKPOINT_VERSION = 1;

export interface TransferCheckpointV1 {
  transferId: Uint8Array; // 16 字节
  segmentCount: number;
  fileLen: number;
  segmentSize: number;
  /** 完成位图，ceil(segmentCount/8) 字节；bit i（LSB 起）对应段 i。 */
  bitmap: Uint8Array;
}

export function encodeCheckpoint(cp: TransferCheckpointV1): Uint8Array {
  if (cp.transferId.length !== 16) throw new Error("检查点 transferId 必须为 16 字节");
  if (cp.segmentCount <= 0 || cp.segmentCount > MAX_SEGMENTS) {
    throw new Error("检查点段数量越界");
  }
  const bitmapLen = Math.ceil(cp.segmentCount / 8);
  const out = new Uint8Array(34 + bitmapLen + 4);
  const dv = new DataView(out.buffer);
  out.set(new TextEncoder().encode(CHECKPOINT_MAGIC), 0);
  dv.setUint16(4, CHECKPOINT_VERSION, true);
  out.set(cp.transferId, 6);
  dv.setUint32(22, cp.segmentCount, true);
  dv.setUint32(26, cp.fileLen, true);
  dv.setUint32(30, cp.segmentSize, true);
  out.set(cp.bitmap.subarray(0, bitmapLen), 34);
  const bodyLen = 34 + bitmapLen;
  dv.setUint32(bodyLen, crc32(out.subarray(0, bodyLen)), true);
  return out;
}

/** 解析检查点。任何结构/版本/CRC 问题都返回 null（不抛错——损坏的检查点
 *  只是"没有检查点"，不应中断恢复流程）。 */
export function parseCheckpoint(bytes: Uint8Array): TransferCheckpointV1 | null {
  if (bytes.length < 38) return null;
  const magic = new TextDecoder().decode(bytes.subarray(0, 4));
  if (magic !== CHECKPOINT_MAGIC) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint16(4, true);
  if (version !== CHECKPOINT_VERSION) return null;
  const segmentCount = dv.getUint32(22, true);
  if (segmentCount <= 0 || segmentCount > MAX_SEGMENTS) return null;
  const fileLen = dv.getUint32(26, true);
  if (fileLen <= 0 || fileLen > MAX_FILE_BYTES) return null;
  const segmentSize = dv.getUint32(30, true);
  if (segmentSize !== SEGMENT_SIZE) return null;
  const bitmapLen = Math.ceil(segmentCount / 8);
  if (bytes.length !== 34 + bitmapLen + 4) return null;
  const declaredCrc = dv.getUint32(34 + bitmapLen, true);
  const actualCrc = crc32(bytes.subarray(0, 34 + bitmapLen));
  if (declaredCrc !== actualCrc) return null;
  return {
    transferId: bytes.slice(6, 22),
    segmentCount,
    fileLen,
    segmentSize,
    bitmap: bytes.slice(34, 34 + bitmapLen),
  };
}

/** 段 i 是否已完成。 */
export function isSegmentComplete(cp: TransferCheckpointV1, index: number): boolean {
  if (index < 0 || index >= cp.segmentCount) return false;
  return ((cp.bitmap[index >> 3]! >> (index & 7)) & 1) === 1;
}

/** 标记段 i 已完成（就地修改，调用方随后 encodeCheckpoint + 持久化）。 */
export function markSegmentComplete(cp: TransferCheckpointV1, index: number): void {
  if (index < 0 || index >= cp.segmentCount) return;
  cp.bitmap[index >> 3] = (cp.bitmap[index >> 3]! | (1 << (index & 7))) & 0xff;
}

/** 已完成段数。 */
export function completedCount(cp: TransferCheckpointV1): number {
  let n = 0;
  for (let i = 0; i < cp.segmentCount; i++) if (isSegmentComplete(cp, i)) n++;
  return n;
}

/** 新建空白检查点。 */
export function newCheckpoint(
  transferId: Uint8Array,
  segmentCount: number,
  fileLen: number,
  segmentSize: number = SEGMENT_SIZE,
): TransferCheckpointV1 {
  return {
    transferId,
    segmentCount,
    fileLen,
    segmentSize,
    bitmap: new Uint8Array(Math.ceil(segmentCount / 8)),
  };
}
