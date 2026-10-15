import { createEncodeWorker } from "./encode-worker-factory";
import type { EncodeBatch, encodeBatch } from "./encode";

/** One job in flight; sender's bounded lookahead supplies backpressure. */
export class QrEncoder {
  private worker = createEncodeWorker();
  private reject: ((error: Error) => void) | null = null;
  encode(batch: EncodeBatch): Promise<ReturnType<typeof encodeBatch>> {
    if (this.reject) return Promise.reject(new Error("Encoder already busy"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error("二维码生成超时，请停止后重试")), 15000);
      const cleanup = () => { clearTimeout(timer); this.reject = null; };
      const fail = (error: Error) => { cleanup(); reject(error); };
      this.reject = fail;
      this.worker.onerror = () => fail(new Error("二维码生成线程不可用，请重新打开应用"));
      this.worker.onmessage = e => {
        cleanup();
        if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data);
      };
      // Do not detach generator-owned buffers: manifests may be reused.
      this.worker.postMessage(batch);
    });
  }
  dispose(): void { this.worker.terminate(); this.reject?.(new Error("发送已停止")); }
}
