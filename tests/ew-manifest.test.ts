import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveOrigLen,
  encodeManifest,
  joinManifestFrames,
  parseManifest,
  sanitizeName,
  splitManifest,
  type TransferManifestV1,
} from "../shared/ew-manifest.ts";
import { SEGMENT_SIZE } from "../shared/ew-protocol.ts";
import { sha256Once } from "../shared/ew-sha256.ts";

function makeManifest(overrides: Partial<TransferManifestV1> = {}): TransferManifestV1 {
  const fileLen = 5 * 1024 * 1024 + 100; // 2 段
  return {
    protocolVersion: 1,
    encrypted: false,
    allowGzip: true,
    name: "测试文件.bin",
    mime: "application/octet-stream",
    fileLen,
    segmentSize: SEGMENT_SIZE,
    segmentCount: 2,
    compressionMode: 1,
    cryptoMode: 0,
    pbkdf2Iterations: 0,
    salt: null,
    fileSha256: sha256Once(new Uint8Array([1, 2, 3])),
    segmentParams: [
      { encodedLen: 1000, segCrc32: 0x12345678, noncePrefix: null },
      { encodedLen: 800, segCrc32: 0x87654321, noncePrefix: null },
    ],
    ...overrides,
  };
}

test("清单编解码往返（未加密）", () => {
  const m = makeManifest();
  const bytes = encodeManifest(m);
  const parsed = parseManifest(bytes);
  assert.equal(parsed.name, m.name);
  assert.equal(parsed.mime, m.mime);
  assert.equal(parsed.fileLen, m.fileLen);
  assert.equal(parsed.segmentCount, m.segmentCount);
  assert.equal(parsed.encrypted, false);
  assert.deepEqual(parsed.fileSha256, m.fileSha256);
  assert.deepEqual(parsed.segmentParams, m.segmentParams);
});

test("清单编解码往返（加密：盐 + nonce 前缀）", () => {
  const salt = new Uint8Array(16).fill(0x5a);
  const m = makeManifest({
    encrypted: true,
    cryptoMode: 1,
    pbkdf2Iterations: 600_000,
    salt,
    segmentParams: [
      { encodedLen: 1000, segCrc32: 0x12345678, noncePrefix: new Uint8Array(8).fill(0x11) },
      { encodedLen: 800, segCrc32: 0x87654321, noncePrefix: new Uint8Array(8).fill(0x22) },
    ],
  });
  const bytes = encodeManifest(m);
  const parsed = parseManifest(bytes);
  assert.equal(parsed.encrypted, true);
  assert.deepEqual(parsed.salt, salt);
  assert.deepEqual(parsed.segmentParams, m.segmentParams);
});

test("超长文件名/超长 MIME 拒绝", () => {
  assert.throws(() => encodeManifest(makeManifest({ name: "x".repeat(1025) })), /文件名/);
  assert.throws(() => encodeManifest(makeManifest({ mime: "x".repeat(513) })), /MIME/);
});

test("清单 CRC 篡改拒绝", () => {
  const bytes = encodeManifest(makeManifest());
  bytes[bytes.length - 1]! ^= 0xff;
  assert.throws(() => parseManifest(bytes), /校验和/);
});

test("清单字段篡改拒绝（段数与文件长度不一致）", () => {
  const m = makeManifest({ segmentCount: 3 }); // fileLen 只够 2 段
  const bytes = encodeManifest(m);
  assert.throws(() => parseManifest(bytes), /段数量与文件长度不一致/);
});

test("文件名为空/路径穿越净化", () => {
  assert.equal(sanitizeName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeName("..\\..\\evil.txt"), "evil.txt");
  assert.equal(sanitizeName("a\u0000b"), "ab");
  assert.equal(sanitizeName("   "), "transfer.bin");
  assert.equal(sanitizeName("."), "transfer.bin");
});

test("deriveOrigLen 边界", () => {
  assert.equal(deriveOrigLen(0, SEGMENT_SIZE, SEGMENT_SIZE), SEGMENT_SIZE);
  assert.equal(deriveOrigLen(1, SEGMENT_SIZE + 1, SEGMENT_SIZE), 1);
  assert.throws(() => deriveOrigLen(1, SEGMENT_SIZE, SEGMENT_SIZE), /超出/);
  assert.throws(() => deriveOrigLen(-1, 100, SEGMENT_SIZE), /不能为负/);
});

test("分片 split/join 往返", () => {
  const bytes = new Uint8Array(5000).map((_, i) => i % 251);
  const chunks = splitManifest(bytes, 1000);
  assert.equal(chunks.length, 5);
  const map = new Map(chunks.map((c, i) => [i, c]));
  const joined = joinManifestFrames(map, 5);
  assert.ok(joined);
  assert.deepEqual(joined, bytes);
  // 缺片 → null
  const missing = new Map(chunks.map((c, i) => [i, c]));
  missing.delete(2);
  assert.equal(joinManifestFrames(missing, 5), null);
});

test("清单整体可装入单个 QR 帧 payload（256MB 文件）", () => {
  const fileLen = 256 * 1024 * 1024;
  const segmentCount = Math.ceil(fileLen / SEGMENT_SIZE); // 64
  const m: TransferManifestV1 = {
    protocolVersion: 1,
    encrypted: true,
    allowGzip: true,
    name: "大型文件.dat",
    mime: "application/octet-stream",
    fileLen,
    segmentSize: SEGMENT_SIZE,
    segmentCount,
    compressionMode: 1,
    cryptoMode: 1,
    pbkdf2Iterations: 600_000,
    salt: new Uint8Array(16).fill(0x42),
    fileSha256: sha256Once(new Uint8Array(32)),
    segmentParams: Array.from({ length: segmentCount }, (_, i) => ({
      encodedLen: 4 * 1024 * 1024,
      segCrc32: 0xdeadbeef,
      noncePrefix: new Uint8Array(8).fill(i),
    })),
  };
  const bytes = encodeManifest(m);
  // 2331 帧 → payload 2283 字节，必须单帧装下
  assert.ok(bytes.length <= 2283, `清单 ${bytes.length} 字节超过单帧容量`);
});
