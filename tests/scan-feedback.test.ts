import test from "node:test";
import assert from "node:assert/strict";
import { ReceiveRate, ScanTracker, scanRegion, trustedScanPosition, type ScanPosition } from "../shared/scan-feedback.ts";
import { packFrame, crc32, FRAME_TYPE_DATA } from "../shared/ew-protocol.ts";

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

const payload = new Uint8Array([1, 2, 3, 4]);
const bytes = packFrame({ frameType: FRAME_TYPE_DATA, transferId: new Uint8Array(16),
  segmentIndex: 0, segmentCount: 1, seq: 0, k: 1, blockLen: 4, segmentLen: 4, fileLen: 4,
  crc32: crc32(payload) }, payload);
const report = { id: 1, bytes, position: pos(20, 30, 100) };

test("only validated transfer frames can steer ROI; failed and unrelated QR candidates are ignored", () => {
  assert.equal(trustedScanPosition({ ...report, bytes: null }, 1280, 960), null);
  assert.equal(trustedScanPosition({ ...report, bytes: new TextEncoder().encode("https://example.com") }, 1280, 960), null);
  const damaged = bytes.slice();
  damaged[damaged.length - 1] ^= 1;
  assert.equal(trustedScanPosition({ ...report, bytes: damaged }, 1280, 960), null);
});

test("trusted ROI coordinates are translated in explicit corner order, independent of object key order", () => {
  const { topLeft, topRight, bottomRight, bottomLeft } = report.position;
  const position = { bottomLeft, topRight, topLeft, bottomRight };
  assert.deepEqual(trustedScanPosition({ ...report, position, region: { x: 300, y: 200, w: 600, h: 600 } }, 1280, 960), pos(320, 230, 100));
});

test("degenerate lines, skinny polygons, crossed corners and out-of-frame geometry do not lock", () => {
  const p = pos(10, 10, 100);
  const invalid = [pos(-10, 0, 100), pos(1200, 900, 200), pos(NaN, 0, 100),
    { ...p, bottomLeft: p.bottomRight, bottomRight: p.bottomLeft },
    { topLeft: {x:0,y:0}, topRight: {x:100,y:100}, bottomRight: {x:101,y:101}, bottomLeft: {x:1,y:1} }];
  for (const position of invalid) assert.equal(trustedScanPosition({ ...report, position }, 1280, 960), null);
  assert.equal(trustedScanPosition({ ...report, region: {x:1100,y:0,w:600,h:600} }, 1280, 960), null);
});

test("three misses restore full-frame search; old replies cannot relock the stale ROI", () => {
  const tracker = new ScanTracker();
  tracker.update(report, 1280, 960, 10);
  assert.ok(tracker.position);
  tracker.update({ ...report, id: 2, bytes: null }, 1280, 960, 20);
  tracker.update({ ...report, id: 3, bytes: null }, 1280, 960, 30);
  assert.ok(tracker.position);
  tracker.update({ ...report, id: 4, bytes: null }, 1280, 960, 40);
  assert.equal(tracker.position, null);
  tracker.update({ ...report, id: 3 }, 1280, 960, 50);
  assert.equal(tracker.position, null);
  tracker.update({ ...report, id: 5, position: pos(700, 400, 250) }, 1280, 960, 60);
  assert.deepEqual(tracker.position, pos(700, 400, 250));
});

test("new sessions start unlocked and rejected candidates do not refresh the lock time", () => {
  const tracker = new ScanTracker();
  tracker.update(report, 1280, 960, 10);
  tracker.update({ ...report, id: 2, bytes: null }, 1280, 960, 20);
  assert.equal(tracker.at, 10);
  tracker.reset();
  assert.equal(tracker.position, null);
  tracker.update(report, 1280, 960, 30);
  assert.equal(tracker.at, 30);
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
