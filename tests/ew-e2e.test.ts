// 端到端模拟链路：发送端帧流 →（丢帧/乱序/重复注入）→ 接收端重组 → 校验。
//
// 这是 PLAN.md "断网状态从 file:// 双击 HTML 验证" 的协议层等价物：
// 跳过 QR 光学渲染/摄像头解码（本机无法真机验证），直接验证从文件字节到
// 帧再到文件字节的完整链路在随机 30% 丢帧、乱序、重复帧下保持正确。

import assert from "node:assert/strict";
import test from "node:test";
import { EwReceiver } from "../shared/ew-receiver.ts";
import { MemoryBackend } from "./memory-backend.ts";
import { prepareTransfer, frameStream, sessionSeed } from "../shared/ew-sender.ts";
import { sha256Once } from "../shared/ew-sha256.ts";
import { SEGMENT_SIZE } from "../shared/ew-protocol.ts";

/** 确定性伪随机（测试内固定种子，不依赖 Math.random）。 */
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

async function runLink(
  bytes: Uint8Array,
  opts: {
    name?: string;
    mime?: string;
    passphrase?: string;
    frameBytes?: number;
    coverage?: number;
    allowGzip?: boolean;
    dropRate?: number;
    dupRate?: number;
    shuffle?: boolean;
    limit?: number; // 最多取多少帧（0=无限）
    seed?: number;
  } = {},
): Promise<{ backend: MemoryBackend; framesUsed: number; receiver: EwReceiver }> {
  const rnd = mulberry32(opts.seed ?? 42);
  const prepared = await prepareTransfer({
    name: opts.name ?? "e2e.bin",
    mime: opts.mime ?? "application/octet-stream",
    bytes,
    frameBytes: opts.frameBytes ?? 2331,
    passphrase: opts.passphrase,
    coverage: opts.coverage,
    allowGzip: opts.allowGzip,
  });

  const backend = new MemoryBackend();
  backend.shaResult = sha256Once(bytes); // 目标哈希
  const receiver = new EwReceiver({
    requestPassphrase: async () => opts.passphrase ?? null,
  });
  await receiver.attachBackend(backend);

  const gen = frameStream(prepared);
  let framesUsed = 0;
  const maxFrames = opts.limit ?? 0;
  const dropRate = opts.dropRate ?? 0.3;
  const dupRate = opts.dupRate ?? 0.1;

  // 注入信道损伤。shuffle 模式需要先收集再乱序（限制收集量防内存爆）；
  // 其余模式流式喂给接收端（200 万帧全收集 ≈ 4.7GB，会 OOM）。
  const collect: Uint8Array[] | null = opts.shuffle ? [] : null;
  const MAX_SYNC_FRAMES = 2_000_000;
  for (let i = 0; i < (maxFrames > 0 ? maxFrames : MAX_SYNC_FRAMES); i++) {
    const frame = gen.next();
    if (frame.done) break;
    const f = frame.value as Uint8Array;
    if (rnd() < dropRate) continue; // 丢帧
    if (collect) {
      collect.push(f);
      if (rnd() < dupRate) collect.push(f.slice()); // 重复帧
      if (collect.length > 200_000) break; // shuffle 模式收集上限，防 OOM
    } else {
      receiver.handleFrame(f);
      framesUsed++;
      if (rnd() < dupRate) receiver.handleFrame(f.slice()); // 重复帧
      // 周期让出事件循环：handleParsed 是异步链，同步狂喂会让发送端
      // 分配无法回收（单帧 2.3KB × 200 万 ≈ 4.7GB）→ SIGABRT；也让
      // 接收端的完成链能及时推进（贴近真实 30fps 输入节奏）。
      if ((i & 0x3f) === 0) await new Promise((r) => setTimeout(r, 0));
      if (receiver.isDone) break;
    }
  }
  if (collect) {
    // 乱序：Fisher–Yates
    for (let i = collect.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [collect[i], collect[j]] = [collect[j]!, collect[i]!];
    }
    for (let i = 0; i < collect.length; i++) {
      receiver.handleFrame(collect[i]!);
      framesUsed++;
      // 与流式模式同理：周期让出事件循环，让异步处理链推进
      if ((i & 0x3ff) === 0) await new Promise((r) => setTimeout(r, 0));
      if (receiver.isDone) break;
    }
  }
  await new Promise((r) => setTimeout(r, 20)); // 等待异步 finish
  return { backend, framesUsed, receiver };
}

test("1 字节文件：普通链路", async () => {
  const bytes = new Uint8Array([0x42]);
  const { backend, receiver } = await runLink(bytes, { seed: 1 });
  assert.ok(receiver.isDone, "接收应完成");
  assert.deepEqual(backend.parts.get(0), bytes);
});

test("4 MiB 边界文件（恰好一段）", async () => {
  const bytes = new Uint8Array(SEGMENT_SIZE);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 5) % 251;
  const { backend, receiver } = await runLink(bytes, { seed: 2 });
  assert.ok(receiver.isDone);
  assert.equal(backend.parts.get(0)!.length, SEGMENT_SIZE);
  assert.deepEqual(backend.parts.get(0), bytes);
});

test("4 MiB + 1 字节（两段，第二段不满）", async () => {
  const bytes = new Uint8Array(SEGMENT_SIZE + 1);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17) % 251;
  const { backend, receiver } = await runLink(bytes, { seed: 3 });
  assert.ok(receiver.isDone);
  assert.deepEqual(backend.parts.get(0), bytes.subarray(0, SEGMENT_SIZE));
  assert.deepEqual(backend.parts.get(1), bytes.subarray(SEGMENT_SIZE));
});

test("64 MB 文件（16 段，可压缩文本）", async () => {
  // 用重复文本模拟可压缩大文件（64MB 真实随机数据会显著拖慢测试）
  const unit = new TextEncoder().encode("Eternal Wave 动态二维码文件传输测试。".repeat(97));
  const bytes = new Uint8Array(64 * 1024 * 1024);
  for (let off = 0; off < bytes.length; off += unit.length) {
    bytes.set(unit.subarray(0, Math.min(unit.length, bytes.length - off)), off);
  }
  const { backend, receiver } = await runLink(bytes, { seed: 4, dropRate: 0.3 });
  assert.ok(receiver.isDone);
  // 逐段比对（避免再分配 64MB 拷贝）
  for (let i = 0; i < 16; i++) {
    const part = backend.parts.get(i)!;
    assert.equal(part.length, Math.min(SEGMENT_SIZE, bytes.length - i * SEGMENT_SIZE));
    for (let j = 0; j < part.length; j += 4096) {
      const a = part.subarray(j, Math.min(j + 4096, part.length));
      const b = bytes.subarray(i * SEGMENT_SIZE + j, i * SEGMENT_SIZE + j + a.length);
      assert.deepEqual(a, b);
    }
  }
});

test("加密链路：口令 + 30% 丢帧", async () => {
  const bytes = new TextEncoder().encode("机密文件内容".repeat(1000));
  const { backend, receiver } = await runLink(bytes, {
    passphrase: "correct-horse-battery-staple",
    seed: 5,
  });
  assert.ok(receiver.isDone, "加密链路应收满");
  assert.deepEqual(backend.parts.get(0), bytes);
});

test("加密链路：错误口令 → 解密失败提示，不完成", async () => {
  const bytes = new TextEncoder().encode("重要数据".repeat(200));
  const rnd = mulberry32(6);
  const prepared = await prepareTransfer({
    name: "secret.bin",
    mime: "text/plain",
    bytes,
    passphrase: "真实口令",
  });
  const backend = new MemoryBackend();
  backend.shaResult = sha256Once(bytes);
  const errs: string[] = [];
  const receiver = new EwReceiver({
    onError: (e) => errs.push(e),
    requestPassphrase: async () => "错误口令",
  });
  await receiver.attachBackend(backend);
  const gen = frameStream(prepared);
  // PBKDF2 600k 次派生需要数百毫秒：先喂清单帧，等 manifest 就绪后再喂数据帧
  for (let i = 0; i < 10; i++) {
    receiver.handleFrame(gen.next().value as Uint8Array);
    if (receiver.hasManifest) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(receiver.hasManifest, "清单应就绪");
  // 数据帧循环（等清单发布后再喂）
  for (let i = 0; i < 20000 && !receiver.isDone; i++) {
    const f = gen.next().value as Uint8Array;
    if (rnd() < 0.2) continue;
    receiver.handleFrame(f);
    if ((i & 0x3ff) === 0) await new Promise((r) => setTimeout(r, 0));
  }
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(receiver.isDone, false);
  assert.ok(errs.some((e) => e.includes("解密失败")), `应出现解密失败，实际: ${errs.join(";")}`);
});

test("30% 丢帧 + 10% 重复 + 乱序：2MB 随机数据", async () => {
  const bytes = new Uint8Array(2 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919 + 3) % 251;
  const { backend, receiver, framesUsed } = await runLink(bytes, {
    seed: 7,
    dropRate: 0.3,
    dupRate: 0.1,
    shuffle: true,
  });
  assert.ok(receiver.isDone, `应完成（用了 ${framesUsed} 帧）`);
  assert.deepEqual(backend.parts.get(0), bytes);
});

test("中途发送端重启（新传输 ID）→ 接收端重置并按新流完成", async () => {
  const bytes = new Uint8Array(500_000);
  // 使用确定性的高熵数据，避免原先的 251 字节周期样本被 gzip 大幅压缩，
  // 导致第一条流在“重启”前已经完成，测试实际上没有覆盖会话切换。
  const dataRnd = mulberry32(0x4557);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(dataRnd() * 256);
  const rnd = mulberry32(8);
  let manifestsSeen = 0;

  // 第一段流：发一半后"重启"
  const preparedA = await prepareTransfer({ name: "a.bin", mime: "application/octet-stream", bytes });
  const backend = new MemoryBackend();
  backend.shaResult = sha256Once(bytes);
  const receiver = new EwReceiver({ onManifest: () => { manifestsSeen++; } });
  await receiver.attachBackend(backend);
  const genA = frameStream(preparedA);
  for (let i = 0; i < 300; i++) {
    const f = genA.next().value as Uint8Array;
    if (rnd() < 0.3) continue;
    receiver.handleFrame(f);
  }
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(receiver.isDone, false, "第一条流在重启前不应完成");
  // 发送端重启：新 transferId
  const preparedB = await prepareTransfer({ name: "a.bin", mime: "application/octet-stream", bytes });
  assert.notDeepEqual(preparedA.transferId, preparedB.transferId);
  const genB = frameStream(preparedB);
  for (let i = 0; i < 10_000 && !receiver.isDone; i++) {
    const f = genB.next().value as Uint8Array;
    if (rnd() < 0.3) continue;
    receiver.handleFrame(f);
    // 真实 UI 按摄像头帧率输入；定期让出事件循环，避免同步测试制造数百万
    // 个 Promise 微任务并饿死分段恢复/检查点写入。
    if ((i & 0xff) === 0) await new Promise((r) => setTimeout(r, 0));
  }
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(manifestsSeen >= 2, `应接受重启前后两份清单，实际 ${manifestsSeen}`);
  assert.ok(receiver.isDone);
  assert.deepEqual(backend.parts.get(0), bytes);
});

test("低帧率/小帧字节配置（500B/帧）也正确", async () => {
  const bytes = new Uint8Array(200_000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 251;
  const { backend, receiver } = await runLink(bytes, { frameBytes: 500, seed: 9 });
  assert.ok(receiver.isDone);
  assert.deepEqual(backend.parts.get(0), bytes);
});

test("高速模式（冗余 1.2）：干净信道多段传输帧数显著少于稳健模式", async () => {
  // 多段（8 MiB = 2 段）+ 禁用 gzip 的确定性数据：coverage 差异在每段
  // 的冗余浪费上体现——高速 1.2 一轮收满后浪费少，稳健 1.35 每段多发
  // ~0.15k 帧。单段/可压缩场景 k 太小或收满即止，无法体现差异。
  // 用确定性数据（非随机），保证帧数断言稳定可重复。
  const bytes = new Uint8Array(8 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13 + 5) % 251;
  // 干净信道：0 丢帧 0 重复（屏幕捕获近似场景）
  const { receiver, framesUsed: fastFrames } = await runLink(bytes, {
    coverage: 1.2,
    dropRate: 0,
    dupRate: 0,
    allowGzip: false,
    seed: 11,
  });
  assert.ok(receiver.isDone, "高速模式在干净信道应收满");
  const { receiver: robust, framesUsed: robustFrames } = await runLink(bytes, {
    coverage: 1.35,
    dropRate: 0,
    dupRate: 0,
    allowGzip: false,
    seed: 11,
  });
  assert.ok(robust.isDone);
  // 高速应显著少于稳健：同一数据、同一 seed，差异 = 每段冗余浪费差
  assert.ok(fastFrames < robustFrames, `高速 ${fastFrames} 帧 < 稳健 ${robustFrames} 帧`);
  const ratio = fastFrames / robustFrames;
  assert.ok(
    ratio < 0.95,
    `高速帧数应比稳健少 5% 以上（实际比例 ${ratio.toFixed(3)}：${fastFrames}/${robustFrames}）`,
  );
});

test("高速模式（冗余 1.2）：5% 轻丢帧仍可完成（覆盖常见屏幕捕获抖动）", async () => {
  const bytes = new Uint8Array(200_000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 3) % 251;
  const { backend, receiver } = await runLink(bytes, {
    coverage: 1.2,
    dropRate: 0.05,
    dupRate: 0,
    seed: 13,
  });
  assert.ok(receiver.isDone, "高速模式在 5% 丢帧下应收满（多轮循环补帧）");
  assert.deepEqual(backend.parts.get(0), bytes);
});

test("k ≤ 0xffff 帧数计算正确（ewSegmentFrames）", async () => {
  const { ewFitsSegment, ewSegmentFrames } = await import("../shared/ew-sender.ts");
  // 8 MiB 编码段（单段上限）在最小帧 500B 下 k≈18566，不会超 0xffff——
  // 分段设计本身就规避了上游的 k 上限问题。
  assert.equal(ewFitsSegment(8 * 1024 * 1024, 500), true);
  assert.equal(ewFitsSegment(8 * 1024 * 1024, 2331), true);
  // 数学正确性
  assert.equal(ewSegmentFrames(1, 2331), 1);
  assert.equal(ewSegmentFrames(2283, 2331), 1);
  assert.equal(ewSegmentFrames(2284, 2331), 2);
  assert.equal(ewSegmentFrames(8 * 1024 * 1024, 500), Math.ceil((8 * 1024 * 1024) / (500 - 48)));
});
