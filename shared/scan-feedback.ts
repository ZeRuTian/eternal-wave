import { parseFrame } from "./ew-protocol";

/** Geometry is in source-video pixels, never CSS pixels. */
export interface Point { x: number; y: number }
export interface ScanPosition { topLeft: Point; topRight: Point; bottomRight: Point; bottomLeft: Point }
export interface ScanRegion { x: number; y: number; w: number; h: number }
export interface ScanSymbol { bytes: Uint8Array; position?: ScanPosition; modules?: number }
export interface ScanReport {
  id: number;
  bytes: Uint8Array | null;
  position?: ScanPosition;
  elapsedMs?: number;
  region?: ScanRegion;
  symbols?: ScanSymbol[];
  engine?: "tracked" | "full" | "compat";
}

/** A report describes the whole captured group. Only CRC-valid EW symbols may
 * seed tracking. Full searches periodically discover new tiles; stale replies
 * must never replace a newer group. */
export class MultiScanTracker {
  symbols: { position: ScanPosition; modules: number }[] = [];
  at = -Infinity;
  private lastId = -1;
  private misses = 0;
  reset(): void { this.symbols = []; this.at = -Infinity; this.lastId = -1; this.misses = 0; }
  update(report: ScanReport, width: number, height: number, now: number): void {
    if (report.id <= this.lastId) return;
    this.lastId = report.id;
    const symbols = report.symbols ?? (report.bytes ? [{ bytes: report.bytes, position: report.position }] : []);
    const valid = symbols.slice(0, 4).flatMap(s => {
      const position = trustedScanPosition({ ...report, ...s }, width, height);
      const modules = s.modules ?? 0;
      return position ? [{ position, modules: modules >= 21 && modules <= 177 && (modules - 17) % 4 === 0 ? modules : 0 }] : [];
    });
    if (!valid.length) { if (++this.misses >= 3) this.symbols = []; return; }
    this.symbols = valid;
    this.at = now;
    this.misses = 0;
  }
  region(width: number, height: number): ScanRegion {
    const regions = this.symbols.map(s => scanRegion(s.position, width, height));
    if (!regions.length) return { x: 0, y: 0, w: width, h: height };
    const x = Math.min(...regions.map(r => r.x)), y = Math.min(...regions.map(r => r.y));
    return { x, y, w: Math.max(...regions.map(r => r.x + r.w)) - x,
      h: Math.max(...regions.map(r => r.y + r.h)) - y };
  }
}

/** Never steer capture using failed QR candidates or unrelated QR codes. */
export function trustedScanPosition(report: ScanReport, width: number, height: number): ScanPosition | null {
  if (!report.bytes || !parseFrame(report.bytes) || !report.position || width <= 0 || height <= 0) return null;
  const { topLeft, topRight, bottomRight, bottomLeft } = report.position;
  const points = [topLeft, topRight, bottomRight, bottomLeft];
  const region = report.region ?? { x: 0, y: 0, w: width, h: height };
  if (!Number.isFinite(region.x + region.y + region.w + region.h) ||
      region.x < 0 || region.y < 0 || region.w <= 0 || region.h <= 0 ||
      region.x + region.w > width || region.y + region.h > height) return null;
  if (points.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y) ||
      p.x < 0 || p.y < 0 || p.x > region.w || p.y > region.h)) return null;
  // Explicit corner order: object enumeration order is not a polygon winding.
  const edges = points.map((p, i) => ({ x: points[(i + 1) % 4]!.x - p.x, y: points[(i + 1) % 4]!.y - p.y }));
  const lengths = edges.map(p => Math.hypot(p.x, p.y));
  if (Math.min(...lengths) < 16 || Math.max(...lengths) / Math.min(...lengths) > 4) return null;
  const crosses = edges.map((p, i) => p.x * edges[(i + 1) % 4]!.y - p.y * edges[(i + 1) % 4]!.x);
  if (!crosses.every(n => n > 0) && !crosses.every(n => n < 0)) return null;
  const area = Math.abs(points.reduce((sum, p, i) => {
    const next = points[(i + 1) % 4]!;
    return sum + p.x * next.y - p.y * next.x;
  }, 0)) / 2;
  const box = bounds(report.position);
  if (area < box.w * box.h * 0.2) return null;
  const shift = (p: Point): Point => ({ x: p.x + region.x, y: p.y + region.y });
  return { topLeft: shift(topLeft), topRight: shift(topRight), bottomRight: shift(bottomRight), bottomLeft: shift(bottomLeft) };
}

/** Three misses release the ROI promptly; old/out-of-order replies cannot relock it. */
export class ScanTracker {
  position: ScanPosition | null = null;
  at = -Infinity;
  private lastId = -1;
  private misses = 0;
  reset(): void { this.position = null; this.at = -Infinity; this.lastId = -1; this.misses = 0; }
  update(report: ScanReport, width: number, height: number, now: number): void {
    if (report.id <= this.lastId) return;
    this.lastId = report.id;
    const position = trustedScanPosition(report, width, height);
    if (!position) {
      if (++this.misses >= 3) this.position = null;
      return;
    }
    this.misses = 0;
    this.position = position;
    this.at = now;
  }
}

export function bounds(position: ScanPosition): ScanRegion {
  const points = Object.values(position);
  const x = Math.min(...points.map(p => p.x));
  const y = Math.min(...points.map(p => p.y));
  return { x, y, w: Math.max(...points.map(p => p.x)) - x, h: Math.max(...points.map(p => p.y)) - y };
}

export function scanRegion(position: ScanPosition, width: number, height: number): ScanRegion {
  const b = bounds(position);
  // Keep a generous quiet zone and motion margin. Never downscale the modules.
  const margin = Math.max(24, Math.max(b.w, b.h) * 0.18);
  const x = Math.max(0, Math.floor(b.x - margin));
  const y = Math.max(0, Math.floor(b.y - margin));
  return { x, y, w: Math.min(width, Math.ceil(b.x + b.w + margin)) - x,
    h: Math.min(height, Math.ceil(b.y + b.h + margin)) - y };
}

/** Bounded rolling counter; resets on pause/session change and stops estimating on silence. */
export class ReceiveRate {
  private samples: { at: number; bytes: number }[] = [];
  private last = -Infinity;
  reset(): void { this.samples = []; this.last = -Infinity; }
  add(at: number, bytes: number): void {
    if (bytes <= 0) return;
    this.samples.push({ at, bytes });
    this.last = at;
  }
  read(now: number): { bytesPerSecond: number; stalled: boolean } {
    this.samples = this.samples.filter(s => now - s.at <= 5000);
    const stalled = now - this.last >= 3000;
    const first = this.samples[0];
    if (stalled || !first || this.samples.length < 2) return { bytesPerSecond: 0, stalled };
    // Drop first event from the interval to avoid inflating the initial estimate.
    const sum = this.samples.slice(1).reduce((n, s) => n + s.bytes, 0);
    return { bytesPerSecond: sum / (Math.max(1000, now - first.at) / 1000), stalled };
  }
}
