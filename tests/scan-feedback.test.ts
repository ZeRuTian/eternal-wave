import test from "node:test";
import assert from "node:assert/strict";
import { ReceiveRate, scanRegion, positionHint, type ScanPosition } from "../shared/scan-feedback.ts";

const pos = (x: number, y: number, size: number): ScanPosition => ({
  topLeft: { x, y }, topRight: { x: x + size, y },
  bottomRight: { x: x + size, y: y + size }, bottomLeft: { x, y: y + size },
});

test("ROI retains quiet-zone margin at full source resolution and clips to video bounds", () => {
  assert.deepEqual(scanRegion(pos(300, 200, 400), 1280, 960), { x: 228, y: 128, w: 544, h: 544 });
  const clipped = scanRegion(pos(0, 0, 950), 1280, 960);
  assert.equal(clipped.x, 0);
  assert.equal(clipped.y, 0);
  assert.equal(clipped.h, 960);
  assert.ok(clipped.w <= 1280);
});

test("distance feedback distinguishes small QR from clipped QR", () => {
  assert.match(positionHint(pos(400, 300, 150), 1280, 960), /偏小/);
  assert.match(positionHint(pos(0, 0, 900), 1280, 960), /远离/);
  assert.match(positionHint(pos(200, 100, 700), 1280, 960), /已定位/);
});

test("recent useful rate ignores zero-byte repeats and expires on loss of progress", () => {
  const rate = new ReceiveRate();
  rate.add(0, 1000);
  rate.add(1000, 1000);
  rate.add(2000, 1000);
  assert.equal(rate.read(2000).bytesPerSecond, 1000);
  rate.add(4000, 0);
  assert.deepEqual(rate.read(5000), { bytesPerSecond: 0, stalled: true });
  rate.reset();
  assert.deepEqual(rate.read(5001), { bytesPerSecond: 0, stalled: true });
});
