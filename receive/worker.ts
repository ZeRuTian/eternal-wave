// QR decode worker: zxing-cpp compiled to WASM. (Safari has never shipped
// BarcodeDetector — WebKit bug 281848 — so WASM is the only portable way.)
// One frame in flight per worker; the main thread drops frames when all
// workers are busy. Frames are disposable — the fountain doesn't care.

import wasmUrl from "./wasm-url";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import type { ScanRegion } from "../shared/scan-feedback";
import DecimenCodec from "../vendor/decimen-codec/decimen_codec";
import codecWasmUrl from "./codec-wasm-url";
import { TrackedDecoder, type TrackingSeed } from "./tracked-decoder";

const decoder = DecimenCodec({ locateFile: path => path.endsWith(".wasm") ? codecWasmUrl : path })
  .then(module => new TrackedDecoder(module)).catch(() => null);
let codecFailed = false;

prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) =>
      path.endsWith(".wasm") ? wasmUrl : prefix + path,
  },
});

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

ctx.onmessage = async (e: MessageEvent) => {
  const { id, buf, w, h, region, fast, seeds, compatibility } = e.data as {
    id: number; buf: ArrayBuffer; w: number; h: number; region?: ScanRegion; fast?: boolean;
    seeds?: TrackingSeed[]; compatibility?: boolean;
  };
  const start = performance.now();
  try {
    const img = new ImageData(new Uint8ClampedArray(buf), w, h);
    if (!compatibility && !codecFailed) {
      const engine = await decoder;
      if (engine) {
        try {
          const decoded = engine.decode(img.data, w, h, seeds);
          if (decoded.symbols.length) {
            ctx.postMessage({ id, bytes: null, ...decoded, region, elapsedMs: performance.now() - start });
            return;
          }
        } catch {
          // A failed WASM instance must not hold the worker slot or break receive.
          codecFailed = true;
          engine.dispose();
        }
      }
    }
    const results = await readBarcodes(img, {
      formats: ["QRCode"], maxNumberOfSymbols: 4, tryHarder: !fast,
      tryInvert: !fast, tryDownscale: !fast, returnErrors: false,
    });
    const symbols = results.filter(x => x.isValid && x.bytes.length > 0)
      .map(r => ({ bytes: r.bytes, position: r.position }));
    ctx.postMessage({ id, bytes: null, symbols, engine: "compat",
      region, elapsedMs: performance.now() - start });
  } catch {
    ctx.postMessage({ id, bytes: null, region, elapsedMs: performance.now() - start });
  }
};

// warm the WASM so the first real frame doesn't pay instantiation
void readBarcodes(new ImageData(8, 8), { formats: ["QRCode"] })
  .catch(() => undefined)
  .then(() => ctx.postMessage({ id: -1, bytes: null }));
