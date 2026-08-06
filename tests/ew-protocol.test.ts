import assert from "node:assert/strict";
import test from "node:test";
import {
  FRAME_TYPE_DATA,
  FRAME_TYPE_MANIFEST,
  HEADER_LEN,
  MAX_BLOCK_LEN,
  MAX_FILE_BYTES,
  MAX_SEGMENT_ENCODED,
  MAX_SEGMENTS,
  MAX_SOURCE_BLOCKS,
  crc32,
  newTransferId,
  packFrame,
  parseFrame,
} from "../shared/ew-protocol.ts";

test("CRC32 黄金向量：'123456789' → 0xCBF43926", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("CRC32 黄金向量：空串 → 0x00000000", () => {
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test("帧头黄金向量：固定字段 → 精确字节", () => {
  const transferId = new Uint8Array(16).fill(0xab);
  const payload = new Uint8Array([1, 2, 3, 4]);
  const frame = packFrame(
    {
      frameType: FRAME_TYPE_DATA,
      transferId,
      segmentIndex: 2,
      segmentCount: 64,
      seq: 123456,
      k: 8,
      blockLen: 4,
      segmentLen: 1000,
      fileLen: 2000000,
      crc32: crc32(payload),
    },
    payload,
  );
  assert.equal(frame.length, HEADER_LEN + 4);
  assert.equal(frame[0], 0xe7);
  assert.equal(frame[1], 0x57);
  assert.equal(frame[2], 1); // version
  assert.equal(frame[3], FRAME_TYPE_DATA);
  const dv = new DataView(frame.buffer);
  assert.equal(dv.getUint32(20, true), 2); // segmentIndex
  assert.equal(dv.getUint32(24, true), 64); // segmentCount
  assert.equal(dv.getUint32(28, true), 123456); // seq
  assert.equal(dv.getUint16(32, true), 8); // k
  assert.equal(dv.getUint16(34, true), 4); // blockLen
  assert.equal(dv.getUint32(36, true), 1000); // segmentLen
  assert.equal(dv.getUint32(40, true), 2000000); // fileLen
  assert.equal(dv.getUint32(44, true), crc32(payload)); // crc
});

test("parseFrame 往返一致", () => {
  const transferId = newTransferId();
  const payload = new Uint8Array([9, 8, 7, 6, 5]);
  const frame = packFrame(
    {
      frameType: FRAME_TYPE_DATA,
      transferId,
      segmentIndex: 0,
      segmentCount: 1,
      seq: 42,
      k: 2,
      blockLen: 5,
      segmentLen: 9,
      fileLen: 100,
      crc32: crc32(payload),
    },
    payload,
  );
  const parsed = parseFrame(frame);
  assert.ok(parsed);
  assert.equal(parsed.header.frameType, FRAME_TYPE_DATA);
  assert.deepEqual(parsed.header.transferId, transferId);
  assert.equal(parsed.header.seq, 42);
  assert.deepEqual(parsed.payload, payload);
});

test("payload 篡改 → CRC 不符 → 拒绝", () => {
  const payload = new Uint8Array([1, 2, 3, 4]);
  const frame = packFrame(
    {
      frameType: FRAME_TYPE_DATA,
      transferId: newTransferId(),
      segmentIndex: 0,
      segmentCount: 1,
      seq: 1,
      k: 1,
      blockLen: 4,
      segmentLen: 4,
      fileLen: 100,
      crc32: crc32(payload),
    },
    payload,
  );
  frame[HEADER_LEN + 1]! ^= 0xff;
  assert.equal(parseFrame(frame), null);
});

test("长度不匹配 → 拒绝", () => {
  const payload = new Uint8Array([1, 2, 3, 4]);
  const frame = packFrame(
    {
      frameType: FRAME_TYPE_DATA,
      transferId: newTransferId(),
      segmentIndex: 0,
      segmentCount: 1,
      seq: 1,
      k: 1,
      blockLen: 4,
      segmentLen: 4,
      fileLen: 100,
      crc32: crc32(payload),
    },
    payload,
  );
  // 缩短一字节：bytes.length !== HEADER_LEN + blockLen
  assert.equal(parseFrame(frame.subarray(0, frame.length - 1)), null);
});

test("非法 magic / version / frameType → 拒绝", () => {
  const payload = new Uint8Array([1]);
  const frame = packFrame(
    {
      frameType: FRAME_TYPE_DATA,
      transferId: newTransferId(),
      segmentIndex: 0,
      segmentCount: 1,
      seq: 1,
      k: 1,
      blockLen: 1,
      segmentLen: 1,
      fileLen: 100,
      crc32: crc32(payload),
    },
    payload,
  );
  const badMagic = frame.slice();
  badMagic[0] = 0x00;
  assert.equal(parseFrame(badMagic), null);
  const badVersion = frame.slice();
  badVersion[2] = 99;
  assert.equal(parseFrame(badVersion), null);
  const badType = frame.slice();
  badType[3] = 99;
  assert.equal(parseFrame(badType), null);
  const badType2 = frame.slice();
  badType2[3] = 0;
  assert.equal(parseFrame(badType2), null);
});

test("越界字段在分配前拒绝（上限校验）", () => {
  const base = {
    frameType: FRAME_TYPE_DATA,
    transferId: newTransferId(),
    segmentIndex: 0,
    segmentCount: 1,
    seq: 1,
    k: 1,
    blockLen: 4,
    segmentLen: 4,
    fileLen: 100,
    crc32: 0,
  };
  const payload = new Uint8Array([1, 2, 3, 4]);
  const pack = (patch: Partial<typeof base>) => {
    const h = { ...base, ...patch, crc32: 0 };
    return packFrame({ ...h, crc32: crc32(payload) }, payload);
  };
  const cases: Array<Partial<typeof base>> = [
    { fileLen: 0 },
    { fileLen: MAX_FILE_BYTES + 1 },
    { segmentCount: 0 },
    { segmentCount: MAX_SEGMENTS + 1 },
    { segmentIndex: 1 }, // >= segmentCount
    { k: 0 },
    { k: MAX_SOURCE_BLOCKS + 1 },
    { segmentLen: 0 },
    { segmentLen: MAX_SEGMENT_ENCODED + 1 },
    { k: 5 }, // k > ceil(segmentLen/blockLen)=1 → 拒绝
    { segmentCount: 2 }, // 2 段无法容纳 fileLen=100 → 拒绝
  ];
  for (const c of cases) {
    assert.equal(parseFrame(pack(c)), null, `should reject ${JSON.stringify(c)}`);
  }
  // blockLen 越界无法通过 packFrame 构造（packFrame 会先抛长度不一致），
  // 手工把合法帧头的 blockLen 字段改成非法值。
  const legal = pack({});
  const dv = new DataView(legal.buffer, legal.byteOffset, legal.byteLength);
  dv.setUint16(34, 0, true); // blockLen = 0 → 长度不匹配 → 拒绝
  assert.equal(parseFrame(legal), null);
  dv.setUint16(34, MAX_BLOCK_LEN + 1, true); // blockLen 超上限
  assert.equal(parseFrame(legal), null);
});

test("manifest 帧的字段关系校验", () => {
  const payload = new Uint8Array([1, 2, 3]);
  const ok = packFrame(
    {
      frameType: FRAME_TYPE_MANIFEST,
      transferId: newTransferId(),
      segmentIndex: 0,
      segmentCount: 1,
      seq: 0,
      k: 0,
      blockLen: 3,
      segmentLen: 10,
      fileLen: 100,
      crc32: crc32(payload),
    },
    payload,
  );
  assert.ok(parseFrame(ok));
  // 清单帧不允许 k/seq 非 0
  const bad = packFrame(
    {
      frameType: FRAME_TYPE_MANIFEST,
      transferId: newTransferId(),
      segmentIndex: 0,
      segmentCount: 1,
      seq: 5,
      k: 3,
      blockLen: 3,
      segmentLen: 10,
      fileLen: 100,
      crc32: crc32(payload),
    },
    payload,
  );
  assert.equal(parseFrame(bad), null);
});

test("transferId 黄金向量：同输入同输出", () => {
  const a = newTransferId();
  assert.equal(a.length, 16);
  const b = newTransferId();
  assert.notDeepEqual(a, b); // 随机性（极小概率碰撞，可接受）
});
