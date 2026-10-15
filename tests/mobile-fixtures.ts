// Generate local browser smoke-test images. Not shipped in either release build.
import QRCode from "qrcode";
import { mkdirSync, writeFileSync } from "node:fs";
import { prepareTransfer, frameStream } from "../shared/ew-sender.ts";

const bytes = new Uint8Array(10_000);
for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) % 251;
const prepared = await prepareTransfer({ name: "scan-smoke.bin", mime: "application/octet-stream", bytes,
  allowGzip: false, frameBytes: 1000 });
const frames = frameStream(prepared);
const images: string[] = [];
for (let i = 0; i < 70; i++) {
  const { value } = await frames.next();
  images.push(await QRCode.toDataURL([{ data: value!, mode: "byte" } as unknown as QRCode.QRCodeSegment],
    { width: 600, margin: 4, errorCorrectionLevel: "L", version: 22 }));
}
mkdirSync("artifacts/mobile", { recursive: true });
writeFileSync("artifacts/mobile/frames.json", JSON.stringify(images));
writeFileSync("artifacts/mobile/expected.bin", bytes);
console.log("Mobile QR fixture generated: 70 frames, 10000-byte payload.");
