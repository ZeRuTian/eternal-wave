import test from "node:test";
import assert from "node:assert/strict";
import { decodeWorkerBudget } from "../shared/decode-budget.ts";
test("decode budget scales with measured latency but stays bounded", () => {
  assert.equal(decodeWorkerBudget(5, 60, 8), 1);
  assert.equal(decodeWorkerBudget(20, 60, 8), 2);
  assert.equal(decodeWorkerBudget(80, 60, 8), 4);
  assert.equal(decodeWorkerBudget(80, 60, 1), 1);
  assert.equal(decodeWorkerBudget(NaN, 60, 8), 2);
});
