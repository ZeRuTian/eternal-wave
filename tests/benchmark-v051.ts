// Paired CPU regression benchmark against the immutable v0.5.0 implementation.
// Not a phone/camera throughput claim. Run manually after correctness tests.
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import ts from "typescript";
import QRCode from "qrcode";
import DecimenCodec from "../vendor/decimen-codec/decimen_codec.js";
import { TrackedDecoder } from "../receive/tracked-decoder.ts";
import { encodeBatch } from "../send/encode.ts";
import { prepareTransfer, frameStream } from "../shared/ew-sender.ts";
import assert from "node:assert/strict";

const baseline = "2eac520caf4688dd0461d5b576722925126d1178";
const original = execFileSync("git", ["show", `${baseline}:receive/tracked-decoder.ts`], { encoding: "utf8" })
  .replace('"../shared/ew-protocol"', JSON.stringify(new URL("../shared/ew-protocol.ts", import.meta.url).href));
const javascript = ts.transpileModule(original, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const OldDecoder = (await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`)).TrackedDecoder as typeof TrackedDecoder;
const wasm = readFileSync(new URL("../vendor/decimen-codec/decimen_codec.wasm", import.meta.url));
const create = () => DecimenCodec({instantiateWasm(imports, done) {
  const module=new WebAssembly.Module(wasm); done(new WebAssembly.Instance(module,imports),module); return {};
}});
const median = (values:number[])=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)]!;
const results=[];
for(const frameBytes of [2331,2953]) for(const count of [1,2,4] as const) {
  const prepared=await prepareTransfer({name:"bench.bin",mime:"application/octet-stream",bytes:Uint8Array.from({length:64000},(_,i)=>(i*31+(i>>>4))%251),frameBytes,allowGzip:false});
  const stream=frameStream(prepared);for(let i=0;i<3;i++)await stream.next();
  const packets=[];for(let i=0;i<count;i++)packets.push((await stream.next()).value!);
  const version=QRCode.create([{data:new Uint8Array(frameBytes),mode:"byte"} as any],{errorCorrectionLevel:"L"}).version;
  const image=encodeBatch({packets,version,ecc:"L",frame:0});
  const width=image.width*3+60,height=image.height*3+60;
  const clean=new Uint32Array(width*height).fill(0xffffffff);
  for(let y=0;y<image.height*3;y++)for(let x=0;x<image.width*3;x++)clean[(y+20)*width+x+20]=image.pixels[Math.floor(y/3)*image.width+Math.floor(x/3)]!;
  for(const partial of count===4?[false,true]:[false]) {
    const imagePixels=clean.slice();
    if(partial) {
      const tile=image.width/2*3;
      for(let y=20;y<20+tile;y++)imagePixels.fill(0xffffffff,y*width+20+tile,y*width+20+2*tile);
    }
    const pixels=new Uint8ClampedArray(imagePixels.buffer);
    const a=new OldDecoder(await create()),b=new TrackedDecoder(await create());
    const seeds=b.decode(new Uint8ClampedArray(clean.buffer),width,height).symbols.map(s=>({position:s.position!,modules:s.modules!}));
    const actual={old:0,current:0};
    const times={old:[] as number[],current:[] as number[]};
    let clock=0;
    const run=(decoder:TrackedDecoder,key:"old"|"current",measured:boolean)=>{
      const start=performance.now();let decoded=0;
      for(let i=0;i<5;i++) {
        const r=decoder.decode(pixels,width,height,seeds,clock+=33);
        assert.equal(r.symbols.length,partial?3:count);
        decoded+=r.symbols.length;
      }
      if(measured){times[key].push((performance.now()-start)/5);actual[key]+=decoded;}
    };
    run(a,"old",false);run(b,"current",false);
    for(let repeat=0;repeat<11;repeat++) {
      if(repeat%2){run(b,"current",true);run(a,"old",true);}else{run(a,"old",true);run(b,"current",true);}
    }
    assert.equal(actual.current,actual.old);
    const oldMs=median(times.old),currentMs=median(times.current);
    const result={frameBytes,count,scenario:partial?"one tile obscured":"stable tracking",oldMs,currentMs,speedRatio:oldMs/currentMs,decodedSymbols:actual.current};
    results.push(result);console.log(JSON.stringify(result));a.dispose();b.dispose();
  }
}
mkdirSync("artifacts/performance",{recursive:true});
writeFileSync("artifacts/performance/v051.json",JSON.stringify({baseline,scope:"paired synthetic CPU decode; excludes optical capture and file reassembly",results},null,2));
