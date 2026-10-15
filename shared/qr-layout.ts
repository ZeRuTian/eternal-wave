import type { QrRaster } from "./qr-raster";

export type QrCount = 1 | 2 | 4;
export function qrCount(value: number): QrCount { return value === 2 || value === 4 ? value : 1; }
export function qrGrid(count: QrCount): { cols: number; rows: number } {
  return { cols: count === 1 ? 1 : 2, rows: count === 4 ? 2 : 1 };
}

/** Each symbol keeps its own four-module quiet zone; no interpolation. */
export function composeQr(tiles: QrRaster[]): { pixels: Uint32Array<ArrayBuffer>; width: number; height: number } {
  if (![1, 2, 4].includes(tiles.length) || tiles.some(t => t.size !== tiles[0]!.size)) {
    throw new Error("二维码布局必须为 1、2 或 4 个等尺寸图案");
  }
  const { cols, rows } = qrGrid(tiles.length as QrCount);
  const size = tiles[0]!.size;
  const width = cols * size;
  const height = rows * size;
  const pixels = new Uint32Array(width * height);
  tiles.forEach((tile, i) => {
    for (let y = 0; y < size; y++) {
      pixels.set(tile.pixels.subarray(y * size, (y + 1) * size),
        (Math.floor(i / cols) * size + y) * width + (i % cols) * size);
    }
  });
  return { pixels, width, height };
}

export function fitQrGrid(width: number, height: number, budgetW: number, budgetH: number, dpr: number) {
  const scale = Math.max(1, Math.floor(Math.min(budgetW / width, budgetH / height) * dpr));
  // On tiny screens keep CSS within bounds even when one device pixel/module won't fit.
  const cssScale = Math.min(scale / dpr, budgetW / width, budgetH / height);
  return { width: width * scale, height: height * scale, cssWidth: width * cssScale, cssHeight: height * cssScale };
}
