import assert from "node:assert/strict";
import test from "node:test";
import { prepareSegment, recoverSegment } from "../shared/ew-segment.ts";
import { deriveKey, randomSalt } from "../shared/ew-crypto.ts";
import { SEGMENT_SIZE } from "../shared/ew-protocol.ts";
import { crc32 } from "../shared/ew-protocol.ts";

const KEY = "测试口令";
let derivedKey: CryptoKey | null = null;
async function key(): Promise<CryptoKey> {
  if (!derivedKey) derivedKey = await deriveKey(KEY, randomSalt());
  return derivedKey;
}

test("段处理链往返：原始 → 压缩 → 加密 → 解密 → 解压 → 原始", async () => {
  const plain = new TextEncoder().encode("可压缩内容".repeat(2000)); // 重复文本，gzip 收益大
  const { envelope, params } = await prepareSegment(plain, 0, { allowGzip: true, key: await key() });
  assert.ok(params.encodedLen > 0);
  const recovered = await recoverSegment(envelope.bytes, params, 0, {
    key: await key(),
    origLen: plain.length,
  });
  assert.deepEqual(recovered, plain);
});

test("未加密 + 未压缩往返", async () => {
  const plain = crypto.getRandomValues(new Uint8Array(256)); // 真随机，gzip 无收益
  const { envelope, params } = await prepareSegment(plain, 0, { allowGzip: true, key: null });
  assert.equal(envelope.gzipped, false);
  const recovered = await recoverSegment(envelope.bytes, params, 0, { key: null, origLen: plain.length });
  assert.deepEqual(recovered, plain);
});

test("压缩仅在缩小 64B+ 时启用", async () => {
  // 高熵数据：gzip 无法缩小 → 不压缩
  const high = crypto.getRandomValues(new Uint8Array(4096));
  const r1 = await prepareSegment(high, 0, { allowGzip: true, key: null });
  assert.equal(r1.envelope.gzipped, false);

  // 低熵数据：gzip 大幅缩小 → 压缩
  const low = new TextEncoder().encode("ABCDEFG".repeat(1000));
  const r2 = await prepareSegment(low, 0, { allowGzip: true, key: null });
  assert.equal(r2.envelope.gzipped, true);
  assert.ok(r2.params.encodedLen + 64 < low.length);
});

test("allowGzip=false 时强制不压缩", async () => {
  const low = new TextEncoder().encode("ABCDEFG".repeat(1000));
  const r = await prepareSegment(low, 0, { allowGzip: false, key: null });
  assert.equal(r.envelope.gzipped, false);
  assert.equal(r.params.encodedLen, low.length);
});

test("边界：1B / 4MiB-1 / 4MiB / 4MiB+1", async () => {
  for (const n of [1, SEGMENT_SIZE - 1, SEGMENT_SIZE]) {
    const data = new Uint8Array(n);
    for (let i = 0; i < n; i++) data[i] = i % 251;
    const { envelope, params } = await prepareSegment(data, 0, { allowGzip: true, key: null });
    const recovered = await recoverSegment(envelope.bytes, params, 0, { key: null, origLen: n });
    assert.deepEqual(recovered, data, `size ${n}`);
  }
  // 4MiB+1 超段上限 → 拒绝
  await assert.rejects(
    prepareSegment(new Uint8Array(SEGMENT_SIZE + 1), 0, { allowGzip: true, key: null }),
    /超过/,
  );
});

test("错误口令 → 解密失败", async () => {
  const k1 = await deriveKey("口令A", randomSalt());
  const k2 = await deriveKey("口令B", randomSalt());
  const plain = new TextEncoder().encode("机密数据".repeat(100));
  const { envelope, params } = await prepareSegment(plain, 0, { allowGzip: true, key: k1 });
  await assert.rejects(
    recoverSegment(envelope.bytes, params, 0, { key: k2, origLen: plain.length }),
    /解密失败/,
  );
});

test("密文篡改 1 字节 → 段校验失败", async () => {
  const plain = new TextEncoder().encode("数据".repeat(100));
  const { envelope, params } = await prepareSegment(plain, 0, { allowGzip: false, key: await key() });
  const tampered = envelope.bytes.slice();
  tampered[0]! ^= 0x01;
  // CRC 先失败（段校验失败），因为 CRC 在加密层之外
  await assert.rejects(
    recoverSegment(tampered, params, 0, { key: await key(), origLen: plain.length }),
    /段校验失败|解密失败/,
  );
});

test("压缩炸弹：解压输出超段原始长度 → 拒绝", async () => {
  // 构造一个极小的 gzip 数据，解压后会膨胀到超过 origLen 上限。
  // 用 DecompressionStream 生成真实的高压缩比 gzip（10MB 重复 → 极小）。
  const big = new TextEncoder().encode("A".repeat(10 * 1024 * 1024));
  const stream = new Blob([big as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  const gz = new Uint8Array(await new Response(stream).arrayBuffer());
  assert.ok(gz.length < 1024 * 1024, "测试前提：10MB 重复应压缩到 <1MB");
  // 清单声称该段原始长度只有 1KB（但 gzip 实际会解出 10MB）→ 解压上限 1KB → 拒绝
  const params = { encodedLen: gz.length, segCrc32: crc32(gz), noncePrefix: null };
  await assert.rejects(
    recoverSegment(gz, params, 0, { key: null, origLen: 1024 }),
    /压缩炸弹|段恢复长度/,
  );
});

test("段 CRC 不符 → 拒绝", async () => {
  const plain = new Uint8Array([1, 2, 3, 4, 5]);
  const { envelope, params } = await prepareSegment(plain, 0, { allowGzip: false, key: null });
  const bad = envelope.bytes.slice();
  bad[0]! ^= 0x80;
  await assert.rejects(recoverSegment(bad, { ...params, segCrc32: crc32(bad) ^ 1 }, 0, { key: null, origLen: 5 }), /段校验失败/);
});

test("恢复长度与声明不一致 → 拒绝", async () => {
  const plain = new Uint8Array([1, 2, 3, 4, 5]);
  const { envelope, params } = await prepareSegment(plain, 0, { allowGzip: false, key: null });
  await assert.rejects(
    recoverSegment(envelope.bytes, params, 0, { key: null, origLen: 6 }),
    /不一致/,
  );
});

test("加密时 nonce 前缀参与段参数，往返一致", async () => {
  const plain = new TextEncoder().encode("加密往返".repeat(500));
  const { envelope, params } = await prepareSegment(plain, 7, { allowGzip: true, key: await key() });
  assert.ok(params.noncePrefix);
  const recovered = await recoverSegment(envelope.bytes, params, 7, {
    key: await key(),
    origLen: plain.length,
  });
  assert.deepEqual(recovered, plain);
});
