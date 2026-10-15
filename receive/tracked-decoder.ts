import type { DecimenModule, DecimenResult } from "../vendor/decimen-codec/decimen_codec";
import type { ScanPosition, ScanSymbol } from "../shared/scan-feedback";
import { parseFrame } from "../shared/ew-protocol";

export interface TrackingSeed { position: ScanPosition; modules: number }

/** Each worker owns one WASM heap and reuses its RGBA allocation. */
export class TrackedDecoder {
  private ptr = 0;
  private capacity = 0;
  constructor(private readonly codec: DecimenModule) {}
  dispose(): void { if (this.ptr) this.codec._free(this.ptr); this.ptr = 0; this.capacity = 0; }
  decode(pixels: Uint8ClampedArray, width: number, height: number, seeds: TrackingSeed[] = []) {
    const c = this.codec;
    if (pixels.byteLength !== width * height * 4) throw new Error("Invalid image dimensions");
    if (pixels.byteLength > this.capacity) {
      this.dispose();
      this.ptr = c._malloc(pixels.byteLength);
      if (!this.ptr) throw new Error("Decoder allocation failed");
      this.capacity = pixels.byteLength;
    }
    c.HEAPU8.set(pixels, this.ptr);
    const copy = (r: DecimenResult): ScanSymbol => ({ bytes: r.bytes.slice(), position: r.position, modules: r.modules });
    const tracked: ScanSymbol[] = [];
    for (const seed of seeds.slice(0, 4)) {
      const d = seed.modules;
      if (d < 21 || d > 177 || (d - 17) % 4 !== 0) break;
      const p = seed.position;
      const r = c.readTracked(this.ptr, width, height, d,
        p.topLeft.x, p.topLeft.y, p.topRight.x, p.topRight.y,
        p.bottomRight.x, p.bottomRight.y, p.bottomLeft.x, p.bottomLeft.y);
      if (!r.valid || !parseFrame(r.bytes)) break;
      tracked.push(copy(r));
    }
    if (seeds.length > 0 && tracked.length === seeds.length) {
      return { symbols: tracked, engine: "tracked" as const };
    }
    // Reacquire on the SAME image; do not wait for the next camera frame.
    const results = c.readFull(this.ptr, width, height, true, 4, false);
    const symbols: ScanSymbol[] = [];
    try {
      for (let i = 0; i < results.size(); i++) {
        const r = results.get(i);
        if (r.valid && r.bytes.length) symbols.push(copy(r));
      }
    } finally { results.delete(); }
    return { symbols, engine: "full" as const };
  }
}
