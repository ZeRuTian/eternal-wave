import assert from "node:assert/strict";
import test from "node:test";
import { Sha256, sha256Hex, sha256Once } from "../shared/ew-sha256.ts";

const hex = (b: Uint8Array) =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

test("SHA-256 黄金向量：空串", () => {
  assert.equal(
    hex(sha256Once(new Uint8Array(0))),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("SHA-256 黄金向量：abc", () => {
  assert.equal(
    hex(sha256Once(new TextEncoder().encode("abc"))),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("SHA-256 黄金向量：长文本（跨块边界）", async () => {
  const input = new TextEncoder().encode("Eternal Wave".repeat(1000)); // 13000 字节，多块
  assert.equal(
    hex(sha256Once(input)),
    // 用 Web Crypto 交叉验证
    hex(new Uint8Array(await crypto.subtle.digest("SHA-256", input as BufferSource))),
  );
});

test("增量 update 与一次性结果一致（各种分块大小）", async () => {
  const data = new Uint8Array(300_000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 131 + 7) % 256;
  const expected = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource)));

  for (const chunkSize of [1, 3, 64, 63, 65, 1024, 300_000]) {
    const h = new Sha256();
    for (let off = 0; off < data.length; off += chunkSize) {
      h.update(data.subarray(off, Math.min(off + chunkSize, data.length)));
    }
    assert.equal(hex(h.digest()), expected, `chunk ${chunkSize}`);
  }
});

test("流式 digest 大文件增量（与 Web Crypto 一致）", async () => {
  // 模拟 4 MiB 段数据流式校验
  const seg = new Uint8Array(4 * 1024 * 1024);
  for (let i = 0; i < seg.length; i++) seg[i] = (i % 251);
  const h = new Sha256();
  const CH = 64 * 1024;
  for (let off = 0; off < seg.length; off += CH) {
    h.update(seg.subarray(off, Math.min(off + CH, seg.length)));
  }
  const got = hex(h.digest());
  const want = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", seg as BufferSource)));
  assert.equal(got, want);
});

test("sha256Hex 便捷入口", () => {
  assert.equal(
    sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
