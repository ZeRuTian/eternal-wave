import assert from "node:assert/strict";
import test from "node:test";
import type { StorageBackend } from "../shared/ew-storage.ts";
import { autoSaveAndCleanup } from "../shared/ew-storage.ts";

function backendWith(
  save: () => Promise<void>,
  cleanup: () => Promise<void>,
): StorageBackend {
  return {
    kind: "desktop-dir",
    label: "test",
    async selectAndOpen() {},
    async ensureTransfer() { return true; },
    async loadCheckpoint() { return null; },
    async saveCheckpoint() {},
    async writeSegment() {},
    async readSegment() { return null; },
    async streamSha256() { return new Uint8Array(); },
    saveFinalFile: save,
    cleanupTemp: cleanup,
    async dispose() {},
  };
}

test("自动收尾严格先保存最终文件，再清理临时文件", async () => {
  const calls: string[] = [];
  const backend = backendWith(
    async () => { calls.push("save"); },
    async () => { calls.push("cleanup"); },
  );

  const result = await autoSaveAndCleanup(backend, "done.bin", "application/octet-stream");

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, ["save", "cleanup"]);
});

test("自动保存失败时不清理临时文件", async () => {
  const calls: string[] = [];
  const failure = new Error("save failed");
  const backend = backendWith(
    async () => { calls.push("save"); throw failure; },
    async () => { calls.push("cleanup"); },
  );

  const result = await autoSaveAndCleanup(backend, "done.bin", "application/octet-stream");

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.stage, "save");
    assert.equal(result.error, failure);
  }
  assert.deepEqual(calls, ["save"]);
});

test("文件已保存但清理失败时准确返回清理阶段", async () => {
  const failure = new Error("cleanup failed");
  const backend = backendWith(
    async () => undefined,
    async () => { throw failure; },
  );

  const result = await autoSaveAndCleanup(backend, "done.bin", "application/octet-stream");

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.stage, "cleanup");
    assert.equal(result.error, failure);
  }
});
