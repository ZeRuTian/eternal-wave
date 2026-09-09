/** Geometry is in source-video pixels, never CSS pixels. */
export interface Point { x: number; y: number }
export interface ScanPosition { topLeft: Point; topRight: Point; bottomRight: Point; bottomLeft: Point }
export interface ScanRegion { x: number; y: number; w: number; h: number }
export interface ScanReport {
  id: number;
  bytes: Uint8Array | null;
  position?: ScanPosition;
  elapsedMs?: number;
  region?: ScanRegion;
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

export function positionHint(position: ScanPosition, width: number, height: number): string {
  const b = bounds(position);
  const edge = Math.min(width, height) * 0.025;
  if (b.x < edge || b.y < edge || b.x + b.w > width - edge || b.y + b.h > height - edge)
    return "二维码接近画面边缘，请稍微远离并保留完整白边";
  if (Math.min(b.w, b.h) / Math.min(width, height) < 0.45)
    return "二维码偏小，可稍微靠近，或放大发送端二维码";
  return "二维码已定位，保持完整白边，正在检测接收质量";
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
