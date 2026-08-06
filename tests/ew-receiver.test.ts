import assert from "node:assert/strict";
import test from "node:test";
import { EwReceiver } from "../shared/ew-receiver.ts";
import { MemoryBackend } from "./memory-backend.ts";
import type { StorageBackend } from "../shared/ew-storage.ts";
import { SEGMENT_SIZE, crc32, packFrame, type FrameHeader } from "../shared/ew-protocol.ts";
import { FRAME_TYPE_DATA, FRAME_TYPE_MANIFEST } from "../shared/ew-protocol.ts";
import { encodeManifest, type TransferManifestV1 } from "../shared/ew-manifest.ts";
import { sha256Once } from "../shared/ew-sha256.ts";

function makeManifest(overrides: Partial<TransferManifestV1> = {}): TransferManifestV1 {
  const fileLen = 1000; // 1 段
  return {
    protocolVersion: 1,
    encrypted: false,
    allowGzip: false,
    name: "test.bin",
    mime: "application/octet-stream",
    fileLen,
    segmentSize: SEGMENT_SIZE,
    segmentCount: 1,
    compressionMode: 0,
    cryptoMode: 0,
    pbkdf2Iterations: 0,
    salt: null,
    fileSha256: sha256Once(new Uint8Array(fileLen).fill(7)),
    segmentParams: [{ encodedLen: 1000, segCrc32: crc32(new Uint8Array(1000).fill(7)), noncePrefix: null }],
    ...overrides,
  };
}

function manifestFrame(m: TransferManifestV1, tid: Uint8Array, seq = 0): Uint8Array {
  const bytes = encodeManifest(m);
  const header: FrameHeader = {
    frameType: FRAME_TYPE_MANIFEST,
    transferId: tid,
    segmentIndex: 0,
    segmentCount: 1,
    seq: 0,
    k: 0,
    blockLen: bytes.length,
    segmentLen: bytes.length,
    fileLen: m.fileLen,
    crc32: crc32(bytes),
  };
  return packFrame(header, bytes);
}

function dataFrame(
  tid: Uint8Array,
  seq: number,
  payload: Uint8Array,
  overrides: Partial<FrameHeader> = {},
): Uint8Array {
  const header: FrameHeader = {
    frameType: FRAME_TYPE_DATA,
    transferId: tid,
    segmentIndex: 0,
    segmentCount: 1,
    seq,
    k: 1,
    blockLen: payload.length,
    segmentLen: payload.length,
    fileLen: 1000,
    crc32: crc32(payload),
    ...overrides,
  };
  return packFrame(header, payload);
}

test("伪造文件长度 → 拒绝（帧头校验）", () => {
  const recv = new EwReceiver();
  const frame = dataFrame(new Uint8Array(16), 0, new Uint8Array(10), { fileLen: 0 });
  recv.handleFrame(frame); // 不抛错、不分配
  assert.equal(recv.hasManifest, false);
});

test("伪造段数 → 拒绝", () => {
  const recv = new EwReceiver();
  const frame = dataFrame(new Uint8Array(16), 0, new Uint8Array(10), { segmentCount: 9999 });
  recv.handleFrame(frame);
  assert.equal(recv.hasManifest, false);
});

test("伪造块数量（k 越界）→ 拒绝", () => {
  const recv = new EwReceiver();
  const frame = dataFrame(new Uint8Array(16), 0, new Uint8Array(10), { k: 0xffff + 1 });
  recv.handleFrame(frame);
  assert.equal(recv.hasManifest, false);
});

test("超长元数据/清单 → 拒绝（parseManifest 上限）", () => {
  const recv = new EwReceiver();
  // 构造超长清单 payload（> MAX_BLOCK_LEN=4096），模拟恶意超长元数据：
  // parseFrame 的 blockLen 上限校验应在分配前拒绝。
  const tid = new Uint8Array(16).fill(1);
  const longPayload = new Uint8Array(5000).fill(0x41);
  const frame = packFrame(
    {
      frameType: FRAME_TYPE_MANIFEST,
      transferId: tid,
      segmentIndex: 0,
      segmentCount: 1,
      seq: 0,
      k: 0,
      blockLen: longPayload.length,
      segmentLen: longPayload.length,
      fileLen: 1000,
      crc32: crc32(longPayload),
    },
    longPayload,
  );
  recv.handleFrame(frame); // blockLen > 4096 → 拒绝，无分配
  assert.equal(recv.hasManifest, false);
});

test("清单 CRC 篡改 → onError 且无 manifest", async () => {
  const errs: string[] = [];
  const recv = new EwReceiver({ onError: (e) => errs.push(e) });
  const m = makeManifest();
  const tid = new Uint8Array(16).fill(2);
  const bytes = encodeManifest(m);
  bytes[bytes.length - 1]! ^= 0xff;
  const frame = packFrame(
    {
      frameType: FRAME_TYPE_MANIFEST,
      transferId: tid,
      segmentIndex: 0,
      segmentCount: 1,
      seq: 0,
      k: 0,
      blockLen: bytes.length,
      segmentLen: bytes.length,
      fileLen: m.fileLen,
      crc32: crc32(bytes),
    },
    bytes,
  );
  recv.handleFrame(frame);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(recv.hasManifest, false);
  assert.ok(errs.length > 0);
});

test("无清单先到数据帧 → 丢弃", async () => {
  const recv = new EwReceiver();
  recv.handleFrame(dataFrame(new Uint8Array(16).fill(3), 0, new Uint8Array(10)));
  assert.equal(recv.hasManifest, false);
  assert.equal(recv.framesSeen, 1); // 帧被解析但丢弃
});

test("传输 ID 变化 → 重置为新传输", async () => {
  const backend = new MemoryBackend();
  const recv = new EwReceiver();
  await recv.attachBackend(backend);
  const tidA = new Uint8Array(16).fill(0xaa);
  const tidB = new Uint8Array(16).fill(0xbb);
  const m = makeManifest();
  recv.handleFrame(manifestFrame(m, tidA));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(recv.hasManifest);
  // 新传输的清单帧 → 重置
  const m2 = makeManifest({ fileLen: 2000 });
  recv.handleFrame(manifestFrame(m2, tidB));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(recv.hasManifest);
});

test("空间不足 → 拒绝开始", async () => {
  const backend = new MemoryBackend();
  backend.ensureOk = false;
  const errs: string[] = [];
  const recv = new EwReceiver({ onError: (e) => errs.push(e) });
  await recv.attachBackend(backend);
  recv.handleFrame(manifestFrame(makeManifest(), new Uint8Array(16).fill(4)));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(recv.hasManifest, false);
  assert.ok(errs.some((e) => e.includes("空间不足")));
});

test("加密清单无口令 → 拒绝并提示", async () => {
  const salt = new Uint8Array(16).fill(9);
  const m = makeManifest({
    encrypted: true,
    cryptoMode: 1,
    pbkdf2Iterations: 600_000,
    salt,
    segmentParams: [
      {
        encodedLen: 1000,
        segCrc32: crc32(new Uint8Array(1000).fill(7)),
        noncePrefix: new Uint8Array(8).fill(1),
      },
    ],
  });
  const errs: string[] = [];
  const recv = new EwReceiver({ onError: (e) => errs.push(e) });
  recv.handleFrame(manifestFrame(m, new Uint8Array(16).fill(5)));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(recv.hasManifest, false);
  assert.ok(errs.some((e) => e.includes("口令")));
});
