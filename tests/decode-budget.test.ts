import test from "node:test";
import assert from "node:assert/strict";
import { AdaptiveDecodeTuner, decodeWorkerBudget, type DecodeSample } from "../shared/decode-budget.ts";
test("decode budget scales with measured latency but stays bounded", () => {
  assert.equal(decodeWorkerBudget(5, 60, 8), 1);
  assert.equal(decodeWorkerBudget(20, 60, 8), 2);
  assert.equal(decodeWorkerBudget(80, 60, 8), 4);
  assert.equal(decodeWorkerBudget(80, 60, 1), 1);
  assert.equal(decodeWorkerBudget(NaN, 60, 8), 2);
});

const sample = (now: number, usefulBytes: number, extras: Partial<DecodeSample> = {}): DecodeSample => ({
  now, usefulBytes, workers: 2, captures: now * 0.03, drops: 0, decodeMs: 5, limit: 4, ...extras,
});
test("extra threads must increase accepted throughput; slower trial reverts and is not immediately retried", () => {
  const t = new AdaptiveDecodeTuner();
  t.observe(sample(0, 0));
  assert.equal(t.observe(sample(4000, 100000, {drops: 24})), 3);
  // Growth is measured only AFTER it has actually been applied.
  assert.equal(t.observe(sample(4100, 100000, {workers: 3,drops: 24})), null);
  assert.equal(t.observe(sample(8100, 160000, {workers: 3,drops: 24})), 2);
  t.observe(sample(8200, 160000,{drops:24}));
  assert.equal(t.observe(sample(24200, 560000, {drops:180})), null);
});
test("an increase with no measurable throughput gain is reverted", () => {
  const t = new AdaptiveDecodeTuner();
  t.observe(sample(0,0));
  assert.equal(t.observe(sample(4000,100000,{drops:24})),3);
  t.observe(sample(4100,100000,{workers:3,drops:24}));
  assert.equal(t.observe(sample(8100,200000,{workers:3,drops:24})),2);
});
test("a useful increase is retained within the hardware limit", () => {
  const t = new AdaptiveDecodeTuner();
  t.observe(sample(0,0,{limit:3}));
  assert.equal(t.observe(sample(4000,100000,{drops:24,limit:3})),3);
  t.observe(sample(4100,100000,{workers:3,drops:24,limit:3}));
  assert.equal(t.observe(sample(8100,250000,{workers:3,drops:24,limit:3})),null);
  assert.equal(t.observe(sample(24100,850000,{workers:3,drops:200,limit:3})),null);
});
test("idle shrinking waits for the actual pool size before starting its trial", () => {
  const t = new AdaptiveDecodeTuner();
  t.observe(sample(0,0));
  assert.equal(t.observe(sample(4000,100000)),1);
  assert.equal(t.observe(sample(8000,200000)),null);
  assert.equal(t.observe(sample(8100,200000,{workers:1})),null);
  assert.equal(t.observe(sample(12100,300000,{workers:1})),null);
});
test("shrinking that harms throughput rolls back; silence never justifies tuning", () => {
  const t = new AdaptiveDecodeTuner();
  t.observe(sample(0,0));
  assert.equal(t.observe(sample(4000,0,{drops:24})),null);
  assert.equal(t.observe(sample(8000,100000)),1);
  t.observe(sample(8100,100000,{workers:1}));
  assert.equal(t.observe(sample(12100,175000,{workers:1})),2);
  t.reset();
  assert.equal(t.observe(sample(20000,0)),null);
});
