import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import QRCode from "qrcode";
import DecimenCodec from "../vendor/decimen-codec/decimen_codec.js";
import { TrackedDecoder } from "../receive/tracked-decoder.ts";
import { encodeBatch } from "../send/encode.ts";
import { fitQrGrid, composeQr, qrGrid } from "../shared/qr-layout.ts";
import { MultiScanTracker } from "../shared/scan-feedback.ts";
import { prepareTransfer, frameStream } from "../shared/ew-sender.ts";
import { EwReceiver } from "../shared/ew-receiver.ts";
import { parseFrame, FRAME_TYPE_DATA } from "../shared/ew-protocol.ts";
import { MemoryBackend } from "./memory-backend.ts";

const wasm = readFileSync(new URL("../vendor/decimen-codec/decimen_codec.wasm", import.meta.url));
const codec = await DecimenCodec({ instantiateWasm(imports, done) {
  const module = new WebAssembly.Module(wasm);
  done(new WebAssembly.Instance(module, imports), module);
  return {};
} });

function enlarge(image: ReturnType<typeof encodeBatch>, offset = 0) {
  const scale = 3;
  const width = image.width * scale + 60, height = image.height * scale + 60;
  const pixels = new Uint32Array(width * height).fill(0xffffffff);
  for (let y = 0; y < image.height * scale; y++) {
    for (let x = 0; x < image.width * scale; x++) {
      pixels[(y + 20 + offset) * width + x + 20 + offset] = image.pixels[Math.floor(y / scale) * image.width + Math.floor(x / scale)]!;
    }
  }
  return { pixels: new Uint8ClampedArray(pixels.buffer), width, height };
}

test("grid geometry keeps all tiles inside narrow mobile and desktop budgets", () => {
  assert.deepEqual(qrGrid(2), { cols: 2, rows: 1 });
  for (const count of [1, 2, 4] as const) {
    const g = qrGrid(count);
    for (const dpr of [1, 2, 3]) {
      const size = fitQrGrid(185 * g.cols, 185 * g.rows, 320, 600, dpr);
      assert.ok(size.cssWidth <= 320 && size.cssHeight <= 600);
      assert.equal(size.width % (185 * g.cols), 0);
    }
  }
  assert.throws(() => composeQr([]));
});

for (const count of [1, 2, 4] as const) test(`${count} codes: actual WASM decode → CRC → complete file, tracked and motion fallback`, async () => {
  const original = Uint8Array.from({ length: 14000 }, (_, i) => (i * 73 + (i >>> 4)) & 255);
  const prepared = await prepareTransfer({ name: "multi.bin", mime: "application/octet-stream", bytes: original, frameBytes: 1000, allowGzip: false });
  const version = QRCode.create([{ data: new Uint8Array(1000), mode: "byte" } as any], { errorCorrectionLevel: "L" }).version;
  const stream = frameStream(prepared);
  const decoder = new TrackedDecoder(codec);
  const tracker = new MultiScanTracker();
  const storage = new MemoryBackend();
  const receiver = new EwReceiver();
  await receiver.attachBackend(storage);
  let trackedHits = 0, motionFallback = false;
  try {
    for (let frame = 0; frame < 100 && !receiver.isDone; frame++) {
      const packets = [];
      for (let i = 0; i < count; i++) packets.push((await stream.next()).value!);
      const data = packets.map(p => parseFrame(p)!).filter(p => p.header.frameType === FRAME_TYPE_DATA);
      assert.equal(new Set(data.map(p => p.header.seq)).size, data.length, "each tile has a distinct data sequence");
      const image = enlarge(encodeBatch({ packets, version, ecc: "L", frame }), frame >= 4 ? 12 : 0);
      const decoded = decoder.decode(image.pixels, image.width, image.height, tracker.symbols);
      assert.equal(decoded.symbols.length, count);
      if (decoded.engine === "tracked") trackedHits++;
      if (frame === 4) motionFallback = decoded.engine === "full";
      for (const symbol of decoded.symbols) {
        assert.ok(packets.some(p => Buffer.from(p).equals(Buffer.from(symbol.bytes))), "byte-for-byte optical parity");
        receiver.handleFrame(symbol.bytes);
      }
      tracker.update({ id: frame, bytes: null, ...decoded }, image.width, image.height, frame * 33);
      await new Promise(r => setTimeout(r, 0));
    }
    assert.ok(receiver.isDone);
    assert.deepEqual(storage.parts.get(0), original);
    assert.ok(trackedHits > 0, "fast path is really exercised");
    assert.ok(motionFallback, "motion reacquires on the same frame");
  } finally { decoder.dispose(); }
});

test("multi tracker ignores failed candidates, old replies and clears after three misses", async () => {
  const prepared = await prepareTransfer({ name: "x", bytes: new Uint8Array([1, 2, 3]), frameBytes: 500 });
  const bytes = (await frameStream(prepared).next()).value!;
  const position = { topLeft: {x:20,y:20}, topRight: {x:120,y:20}, bottomRight: {x:120,y:120}, bottomLeft: {x:20,y:120} };
  const tracker = new MultiScanTracker();
  tracker.update({id:10, bytes:null, symbols:[{bytes, position, modules:57}]}, 500, 500, 0);
  assert.equal(tracker.symbols.length, 1);
  tracker.update({id:9, bytes:null, symbols:[]}, 500, 500, 1);
  assert.equal(tracker.symbols.length, 1);
  for (let id = 11; id <= 13; id++) tracker.update({id, bytes:null, symbols:[]}, 500, 500, id);
  assert.equal(tracker.symbols.length, 0);
  tracker.update({id:14, bytes:null, symbols:[{bytes:new Uint8Array([1]),position,modules:57}]}, 500, 500, 14);
  assert.equal(tracker.symbols.length, 0);
});

test("four-code optical transfer survives a temporarily obscured tile and still restores the complete file", async () => {
  const original=Uint8Array.from({length:80000},(_,i)=>(i*73+(i>>>4))&255);
  const prepared=await prepareTransfer({name:"obscured.bin",mime:"application/octet-stream",bytes:original,frameBytes:1000,allowGzip:false});
  const stream=frameStream(prepared);
  const version=QRCode.create([{data:new Uint8Array(1000),mode:"byte"} as any],{errorCorrectionLevel:"L"}).version;
  const decoder=new TrackedDecoder(codec),tracker=new MultiScanTracker(),backend=new MemoryBackend();
  const receiver=new EwReceiver();await receiver.attachBackend(backend);
  let partialFrames=0,recoveredFrames=0;
  try {
    for(let frame=0;frame<120&&!receiver.isDone;frame++) {
      const packets=[];for(let i=0;i<4;i++)packets.push((await stream.next()).value!);
      const raster=encodeBatch({packets,version,ecc:"L",frame});
      const image=enlarge(raster);
      const obscured=frame>=3&&frame<=10;
      if(obscured) {
        const tile=raster.width/2*3,pixels=new Uint32Array(image.pixels.buffer);
        for(let y=20;y<20+tile;y++)pixels.fill(0xffffffff,y*image.width+20+tile,y*image.width+20+2*tile);
      }
      const decoded=decoder.decode(image.pixels,image.width,image.height,tracker.symbols,frame*33);
      assert.equal(decoded.symbols.length,obscured?3:4);
      if(obscured)partialFrames++;if(frame>10&&decoded.symbols.length===4)recoveredFrames++;
      tracker.update({id:frame,bytes:null,...decoded},image.width,image.height,frame*33);
      for(const symbol of decoded.symbols)receiver.handleFrame(symbol.bytes);
      await new Promise(r=>setTimeout(r,0));
    }
    assert.ok(partialFrames>0&&recoveredFrames>0);
    assert.ok(receiver.isDone);
    assert.deepEqual(backend.parts.get(0),original);
  } finally {decoder.dispose();}
});

for (const frameBytes of [2331, 2953]) test(`dense four-code ${frameBytes} byte full/tracked parity`, async () => {
  const prepared = await prepareTransfer({name:"dense.bin",bytes:Uint8Array.from({length:16000},(_,i)=>i%251),allowGzip:false,frameBytes});
  const stream = frameStream(prepared);
  for(let i=0;i<3;i++) await stream.next();
  const packets=[];
  for(let i=0;i<4;i++) packets.push((await stream.next()).value!);
  const version = QRCode.create([{data:new Uint8Array(frameBytes),mode:"byte"} as any],{errorCorrectionLevel:"L"}).version;
  const img = enlarge(encodeBatch({packets,version,ecc:"L",frame:0}));
  const decoder=new TrackedDecoder(codec);
  try {
    const full=decoder.decode(img.pixels,img.width,img.height);
    assert.equal(full.symbols.length,4);
    const seeds=full.symbols.map(s=>({position:s.position!,modules:s.modules!}));
    const tracked=decoder.decode(img.pixels,img.width,img.height,seeds);
    assert.equal(tracked.engine,"tracked");
    assert.deepEqual(tracked.symbols.map(s=>s.bytes),full.symbols.map(s=>s.bytes));
    // Informational CPU-only microbenchmark; never gate correctness on timings.
    const measure=(fn:()=>unknown)=>{const start=performance.now();for(let i=0;i<30;i++) fn();return (performance.now()-start)/30;};
    const fullMs=measure(()=>decoder.decode(img.pixels,img.width,img.height));
    const trackedMs=measure(()=>decoder.decode(img.pixels,img.width,img.height,seeds));
    console.log(JSON.stringify({frameBytes,codes:4,fullMs,trackedMs,scope:"synthetic desktop CPU, not optical transfer speed"}));
  } finally {decoder.dispose();}
});
