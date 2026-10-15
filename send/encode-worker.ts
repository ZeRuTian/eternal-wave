import { encodeBatch, type EncodeBatch } from "./encode";
const ctx = self as unknown as { onmessage: (e: MessageEvent) => void; postMessage(data: unknown, transfer?: Transferable[]): void };
ctx.onmessage = (e: MessageEvent<EncodeBatch>) => {
  try {
    const image = encodeBatch(e.data);
    ctx.postMessage(image, [image.pixels.buffer]);
  } catch (error) {
    ctx.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
