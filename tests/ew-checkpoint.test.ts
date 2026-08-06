import assert from "node:assert/strict";
import test from "node:test";
import {
  completedCount,
  encodeCheckpoint,
  isSegmentComplete,
  markSegmentComplete,
  newCheckpoint,
  parseCheckpoint,
} from "../shared/ew-checkpoint.ts";
import { SEGMENT_SIZE } from "../shared/ew-protocol.ts";

const tid = () => new Uint8Array(16).fill(7);

test("检查点往返", () => {
  const cp = newCheckpoint(tid(), 10, 5 * 1024 * 1024);
  markSegmentComplete(cp, 0);
  markSegmentComplete(cp, 3);
  markSegmentComplete(cp, 9);
  const bytes = encodeCheckpoint(cp);
  const parsed = parseCheckpoint(bytes);
  assert.ok(parsed);
  assert.equal(parsed.segmentCount, 10);
  assert.equal(parsed.fileLen, 5 * 1024 * 1024);
  assert.equal(parsed.segmentSize, SEGMENT_SIZE);
  assert.equal(completedCount(parsed), 3);
  assert.equal(isSegmentComplete(parsed, 0), true);
  assert.equal(isSegmentComplete(parsed, 1), false);
  assert.equal(isSegmentComplete(parsed, 3), true);
  assert.equal(isSegmentComplete(parsed, 9), true);
});

test("位图边界：1 / 64 段；65 段越界拒绝", () => {
  for (const n of [1, 64]) {
    const cp = newCheckpoint(tid(), n, n * SEGMENT_SIZE);
    for (let i = 0; i < n; i++) markSegmentComplete(cp, i);
    const parsed = parseCheckpoint(encodeCheckpoint(cp));
    assert.ok(parsed);
    assert.equal(completedCount(parsed), n);
  }
  // 65 段超过 MAX_SEGMENTS=64 → encode 拒绝
  assert.throws(() => newCheckpoint(tid(), 65, 65 * SEGMENT_SIZE) && encodeCheckpoint(newCheckpoint(tid(), 65, 65 * SEGMENT_SIZE)), /段数量/);
  // 位图字节数 = ceil(n/8)
  assert.equal(encodeCheckpoint(newCheckpoint(tid(), 1, 100)).length, 34 + 1 + 4);
  assert.equal(encodeCheckpoint(newCheckpoint(tid(), 64, 64 * SEGMENT_SIZE)).length, 34 + 8 + 4);
});

test("损坏 magic → null", () => {
  const bytes = encodeCheckpoint(newCheckpoint(tid(), 2, 100));
  bytes[0] = 0x00;
  assert.equal(parseCheckpoint(bytes), null);
});

test("损坏 version → null", () => {
  const bytes = encodeCheckpoint(newCheckpoint(tid(), 2, 100));
  bytes[5] = 99;
  assert.equal(parseCheckpoint(bytes), null);
});

test("损坏 CRC → null", () => {
  const bytes = encodeCheckpoint(newCheckpoint(tid(), 2, 100));
  bytes[bytes.length - 1]! ^= 0xff;
  assert.equal(parseCheckpoint(bytes), null);
});

test("长度不匹配 → null", () => {
  const bytes = encodeCheckpoint(newCheckpoint(tid(), 2, 100));
  assert.equal(parseCheckpoint(bytes.subarray(0, bytes.length - 2)), null);
});

test("越界段计数 → null", () => {
  const cp = newCheckpoint(tid(), 100, 100 * SEGMENT_SIZE); // 超过 MAX_SEGMENTS=64
  // newCheckpoint 本身允许构造，但 encode 应拒绝
  assert.throws(() => encodeCheckpoint(cp), /段数量/);
});

test("markSegmentComplete 越界安全", () => {
  const cp = newCheckpoint(tid(), 4, 100);
  markSegmentComplete(cp, -1);
  markSegmentComplete(cp, 99);
  assert.equal(completedCount(cp), 0);
  assert.equal(isSegmentComplete(cp, 5), false);
});
