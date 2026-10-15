import test from "node:test";
import assert from "node:assert/strict";
import type { DecimenModule, DecimenResult } from "../vendor/decimen-codec/decimen_codec";
import { TrackedDecoder } from "../receive/tracked-decoder.ts";
import { MultiScanTracker, mergeScanSymbols, type ScanPosition } from "../shared/scan-feedback.ts";
import { frameStream, prepareTransfer } from "../shared/ew-sender.ts";

const prepared = await prepareTransfer({name:"partial.bin",mime:"application/octet-stream",bytes:new Uint8Array([1,2,3]),frameBytes:500});
const bytes = (await frameStream(prepared).next()).value!;
const position = (x: number): ScanPosition => ({topLeft:{x,y:20},topRight:{x:x+100,y:20},bottomRight:{x:x+100,y:120},bottomLeft:{x,y:120}});
const symbols = [20,150,280,410].map(x => ({bytes,position:position(x),modules:21}));
function harness(failures: number[], full: DecimenResult[] = [], throwFull = false) {
  let attempts = 0, fullSearches = 0;
  const codec = { HEAPU8: new Uint8Array(640*480*4+8),_malloc:()=>8,_free:()=>{},
    readTracked:()=>{const i=attempts++%4;return {...symbols[i]!,valid:!failures.includes(i),error:""};},
    readFull:()=>{fullSearches++;if(throwFull)throw new Error("search failed");return {size:()=>full.length,get:(i:number)=>full[i]!,delete:()=>{}};},
  } as unknown as DecimenModule;
  return {decoder:new TrackedDecoder(codec),get attempts(){return attempts;},get fullSearches(){return fullSearches;}};
}
const pixels=new Uint8ClampedArray(640*480*4);

test("a failed first/middle tile never discards the other three successful packets", () => {
  for(const failed of [0,1,2,3]) {
    const h=harness([failed]);
    const decoded=h.decoder.decode(pixels,640,480,symbols,0);
    assert.equal(h.attempts,4);
    assert.equal(decoded.symbols.length,3);
    assert.deepEqual(decoded.symbols.map(s=>s.position),symbols.filter((_,i)=>i!==failed).map(s=>s.position));
    h.decoder.dispose();
  }
});
test("fresh and tracked symbols merge by physical location, retaining identical manifests in distinct tiles", () => {
  const fresh={...symbols[0]!,position:position(22)};
  const merged=mergeScanSymbols([fresh],symbols);
  assert.equal(merged.length,4);
  assert.equal(merged[0],fresh);
  assert.equal(merged[1]!.position,symbols[1]!.position);
});
test("full-search errors preserve copied tracked packets", () => {
  const h=harness([0],[],true);
  assert.equal(h.decoder.decode(pixels,640,480,symbols,0).symbols.length,3);
  h.decoder.dispose();
});
test("repeated partial loss limits full-search cost without delaying total loss", () => {
  const h=harness([1]);
  for(const now of [0,33,66,99]) assert.equal(h.decoder.decode(pixels,640,480,symbols,now).symbols.length,3);
  assert.equal(h.attempts,16);
  assert.equal(h.fullSearches,1);
  h.decoder.decode(pixels,640,480,symbols,132);
  assert.equal(h.fullSearches,2);
  h.decoder.decode(pixels,640,480,[],140);
  assert.equal(h.fullSearches,3,"periodic discovery is never throttled");
  h.decoder.dispose();
  const lost=harness([0,1,2,3]);
  for(const now of [0,33,66]) lost.decoder.decode(pixels,640,480,symbols,now);
  assert.equal(lost.fullSearches,3);
  lost.decoder.dispose();
});
test("a missed tile keeps its own bounded ROI lifetime, without accepting failed positions", () => {
  const tracker=new MultiScanTracker();
  tracker.update({id:1,bytes:null,symbols},640,480,0);
  const initial=tracker.region(640,480);
  tracker.update({id:2,bytes:null,symbols:[symbols[0]!]},640,480,33);
  assert.equal(tracker.symbols.length,4);
  assert.deepEqual(tracker.region(640,480),initial);
  tracker.update({id:3,bytes:null,symbols:[symbols[0]!,{...symbols[1]!,bytes:new Uint8Array([9]),position:position(490)}]},640,480,600);
  assert.equal(tracker.symbols.length,4);
  tracker.update({id:4,bytes:null,symbols:[symbols[0]!]},640,480,651);
  assert.equal(tracker.symbols.length,1,"success of other tiles must not refresh missing geometry");
  tracker.update({id:3,bytes:null,symbols},640,480,652);
  assert.equal(tracker.symbols.length,1,"old replies cannot resurrect expired positions");
});
test("resolution changes discard stale geometry and three whole-frame misses release all locks", () => {
  const tracker=new MultiScanTracker();
  tracker.update({id:1,bytes:null,symbols},640,480,0);
  tracker.update({id:2,bytes:null,symbols:[symbols[0]!]},800,600,33);
  assert.equal(tracker.symbols.length,1);
  for(let id=3;id<=5;id++)tracker.update({id,bytes:null,symbols:[]},800,600,id*33);
  assert.equal(tracker.symbols.length,0);
});
