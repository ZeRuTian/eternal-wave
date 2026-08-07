// 256MB 上限文件 e2e（可压缩数据；随机 256MB 会显著拖慢 CI，本测试为上限验证）。
import assert from "node:assert/strict";
import test from "node:test";
import { EwReceiver } from "../shared/ew-receiver.ts";
import { MemoryBackend } from "./memory-backend.ts";
import { prepareTransfer, frameStream } from "../shared/ew-sender.ts";
import { sha256Once } from "../shared/ew-sha256.ts";
import { MAX_FILE_BYTES } from "../shared/ew-protocol.ts";

test("256 MB 上限文件（64 段，可压缩）完整链路", async () => {
  const unit = new TextEncoder().encode("Eternal Wave 最大文件上限验证测试。");
  const bytes = new Uint8Array(MAX_FILE_BYTES);
  for (let off = 0; off < bytes.length; off += unit.length) {
    bytes.set(unit.subarray(0, Math.min(unit.length, bytes.length - off)), off);
  }
  const prepared = await prepareTransfer({
    name: "max.bin",
    mime: "application/octet-stream",
    bytes,
    frameBytes: 2331,
  });
  assert.equal(prepared.manifest.segmentCount, 64);
  const backend = new MemoryBackend();
  backend.shaResult = sha256Once(bytes);
  const receiver = new EwReceiver();
  await receiver.attachBackend(backend);
  const gen = frameStream(prepared);
  const rnd = mulberry32(42);
  for (let i = 0; i < 3_000_000 && !receiver.isDone; i++) {
    const f = gen.next().value as Uint8Array;
    if (rnd() < 0.2) continue;
    receiver.handleFrame(f);
    if ((i & 0x3ff) === 0) await new Promise((r) => setTimeout(r, 0));
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(receiver.isDone, `256MB 应收满（completed=${receiver.completed}/${prepared.manifest.segmentCount}）`);
  // 抽查首中尾三段
  for (const idx of [0, 32, 63]) {
    const part = backend.parts.get(idx);
    assert.ok(part, `段 ${idx} 应存在`);
    assert.equal(part.length, Math.min(4 * 1024 * 1024, bytes.length - idx * 4 * 1024 * 1024));
  }
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
