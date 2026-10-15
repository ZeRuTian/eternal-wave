import QRCode from "qrcode";
import { composeQr } from "../shared/qr-layout";
import { rasterizeQr } from "../shared/qr-raster";

export interface EncodeBatch { packets: Uint8Array[]; version: number; ecc: "L" | "M" | "Q" | "H"; frame: number }
export function encodeBatch({ packets, version, ecc, frame }: EncodeBatch) {
  return composeQr(packets.map(bytes => {
    const qr = QRCode.create([{ data: bytes, mode: "byte" } as unknown as QRCode.QRCodeSegment],
      { version, errorCorrectionLevel: ecc, maskPattern: Math.floor(frame / 4) % 2 === 0 ? 4 : 6 });
    return rasterizeQr(qr.modules.size, qr.modules.data, 4);
  }));
}
