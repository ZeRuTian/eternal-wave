import assert from "node:assert/strict";
import test from "node:test";
import { buildNonce, decryptSegment, deriveKey, encryptSegment, randomSalt } from "../shared/ew-crypto.ts";
import { GCM_TAG_LEN, NONCE_PREFIX_LEN, SALT_LEN } from "../shared/ew-constants.ts";

test("deriveKey 确定性：同盐同口令 → 同密钥（导出 raw 比对）", async () => {
  const salt = randomSalt();
  const k1 = await deriveKey("秘密口令123", salt, 600_000, true);
  const k2 = await deriveKey("秘密口令123", salt, 600_000, true);
  const raw1 = new Uint8Array(await crypto.subtle.exportKey("raw", k1));
  const raw2 = new Uint8Array(await crypto.subtle.exportKey("raw", k2));
  assert.deepEqual(raw1, raw2);
});

test("不同盐 → 不同密钥", async () => {
  const k1 = await deriveKey("口令", randomSalt(), 600_000, true);
  const k2 = await deriveKey("口令", randomSalt(), 600_000, true);
  const raw1 = new Uint8Array(await crypto.subtle.exportKey("raw", k1));
  const raw2 = new Uint8Array(await crypto.subtle.exportKey("raw", k2));
  assert.notDeepEqual(raw1, raw2);
});

test("encrypt/decrypt 往返", async () => {
  const key = await deriveKey("测试口令", randomSalt());
  const plain = new TextEncoder().encode("Eternal Wave 测试数据 0123456789");
  const { data, noncePrefix } = await encryptSegment(plain, key, 3);
  assert.equal(data.length, plain.length + GCM_TAG_LEN);
  assert.equal(noncePrefix.length, NONCE_PREFIX_LEN);
  const recovered = await decryptSegment(data, key, 3, noncePrefix);
  assert.deepEqual(recovered, plain);
});

test("nonce 唯一性：不同段序号产生不同 nonce，解密不串段", async () => {
  const key = await deriveKey("口令", randomSalt());
  const plain = new Uint8Array([1, 2, 3, 4, 5]);
  const a = await encryptSegment(plain, key, 1);
  const b = await encryptSegment(plain, key, 2);
  // 段 1 的密文用段 2 的 nonce 前缀解 → 失败
  await assert.rejects(decryptSegment(a.data, key, 2, a.noncePrefix), /解密失败/);
  assert.notDeepEqual(a.noncePrefix, b.noncePrefix);
  // 同段同前缀 → 正确解密
  assert.deepEqual(await decryptSegment(a.data, key, 1, a.noncePrefix), plain);
});

test("buildNonce 布局：8 字节前缀 ‖ u32LE(段序号)", () => {
  const prefix = new Uint8Array(8).fill(0x11);
  const nonce = buildNonce(prefix, 0x01020304);
  assert.deepEqual(nonce.subarray(0, 8), prefix);
  assert.equal(new DataView(nonce.buffer).getUint32(8, true), 0x01020304);
});

test("错误口令 → 解密失败", async () => {
  const key1 = await deriveKey("正确口令", randomSalt());
  const key2 = await deriveKey("错误口令", randomSalt());
  const plain = new TextEncoder().encode("重要内容");
  const { data, noncePrefix } = await encryptSegment(plain, key1, 0);
  await assert.rejects(decryptSegment(data, key2, 0, noncePrefix), /解密失败/);
});

test("密文篡改 1 字节 → GCM 认证失败", async () => {
  const key = await deriveKey("口令", randomSalt());
  const plain = new TextEncoder().encode("一段会被篡改的数据");
  const { data, noncePrefix } = await encryptSegment(plain, key, 0);
  data[3]! ^= 0x01;
  await assert.rejects(decryptSegment(data, key, 0, noncePrefix), /解密失败/);
});

test("盐长度校验", async () => {
  await assert.rejects(deriveKey("口令", new Uint8Array(8)), /盐必须/);
});

test("salt 长度黄金向量", () => {
  assert.equal(SALT_LEN, 16);
  assert.equal(NONCE_PREFIX_LEN, 8);
  assert.equal(GCM_TAG_LEN, 16);
});
