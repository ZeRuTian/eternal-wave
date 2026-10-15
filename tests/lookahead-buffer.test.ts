import test from "node:test";
import assert from "node:assert/strict";
import { LookaheadBuffer } from "../shared/lookahead-buffer.ts";

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test("lookahead recovers its full reserve after a stall and a burst of consumption", async () => {
  let next = 0;
  let release: (() => void) | undefined;
  let stall = false;
  const buffer = new LookaheadBuffer(3, async () => {
    if (stall) await new Promise<void>(resolve => { release = resolve; });
    return next++;
  }, error => { throw error; });
  buffer.start();
  await settle();
  assert.equal(buffer.size, 3);
  stall = true;
  assert.deepEqual([buffer.take(), buffer.take(), buffer.take()], [0, 1, 2]);
  assert.equal(buffer.take(), undefined);
  stall = false;
  release!();
  await settle();
  assert.equal(buffer.size, 3, "reserve must refill without waiting for another display tick");
  assert.deepEqual([buffer.take(), buffer.take(), buffer.take()], [3, 4, 5]);
  buffer.dispose();
});

test("lookahead never overlaps production or grows beyond capacity", async () => {
  let active = 0, peak = 0, produced = 0;
  const buffer = new LookaheadBuffer(3, async () => {
    peak = Math.max(peak, ++active);
    await settle();
    active--;
    return produced++;
  }, error => { throw error; });
  for (let i = 0; i < 25; i++) { buffer.start(); buffer.take(); await settle(); assert.ok(buffer.size <= 3); }
  assert.equal(peak, 1);
  buffer.dispose();
});

test("stopping a pending frame discards it and does not report a stale error", async () => {
  let reject!: (error: Error) => void;
  const errors: unknown[] = [];
  const buffer = new LookaheadBuffer(3, () => new Promise<number>((_, no) => { reject = no; }), e => errors.push(e));
  buffer.start();
  buffer.dispose();
  reject(new Error("old generation"));
  await settle();
  assert.equal(buffer.size, 0);
  assert.deepEqual(errors, []);
});

test("generation errors stop refill and report once", async () => {
  const errors: unknown[] = [];
  let calls = 0;
  const buffer = new LookaheadBuffer(3, async () => { calls++; throw new Error("failed"); }, e => errors.push(e));
  buffer.start();
  await settle();
  buffer.take(); buffer.start();
  await settle();
  assert.equal(calls, 1);
  assert.equal(errors.length, 1);
});
