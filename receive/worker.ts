// QR decode worker: zxing-cpp compiled to WASM. (Safari has never shipped
// BarcodeDetector — WebKit bug 281848 — so WASM is the only portable way.)
// One frame in flight per worker; the main thread drops frames when all
// workers are busy. Frames are disposable — the fountain doesn't care.

import wasmUrl from "./wasm-url";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import type { ScanRegion } from "../shared/scan-feedback";

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
  const { id, buf, w, h, region, fast } = e.data as {
    id: number; buf: ArrayBuffer; w: number; h: number; region?: ScanRegion; fast?: boolean;
  };
  const start = performance.now();
  try {
    const img = new ImageData(new Uint8ClampedArray(buf), w, h);
    const results = await readBarcodes(img, {
      formats: ["QRCode"], maxNumberOfSymbols: 1, tryHarder: !fast,
      tryInvert: !fast, tryDownscale: !fast, returnErrors: true,
    });
    const r = results.find((x) => x.isValid && x.bytes.length > 0);
    ctx.postMessage({ id, bytes: r ? r.bytes : null, position: (r ?? results[0])?.position,
      region, elapsedMs: performance.now() - start });
  } catch {
    ctx.postMessage({ id, bytes: null, region, elapsedMs: performance.now() - start });
  }
};

// warm the WASM so the first real frame doesn't pay instantiation
void readBarcodes(new ImageData(8, 8), { formats: ["QRCode"] })
  .catch(() => undefined)
  .then(() => ctx.postMessage({ id: -1, bytes: null }));
