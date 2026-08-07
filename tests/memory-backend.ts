import type { StorageBackend } from "../shared/ew-storage.ts";
import { sha256Once } from "../shared/ew-sha256.ts";
import type { TransferCheckpointV1 } from "../shared/ew-checkpoint.ts";

/** 内存版 StorageBackend（模拟 .ewpart/.ewckpt 语义），供接收端/链路测试使用。 */
export class MemoryBackend implements StorageBackend {
  readonly kind = "desktop-dir" as const;
  parts = new Map<number, Uint8Array>();
  checkpoints: Uint8Array[] = [];
  selected = false;
  ensureOk = true;
  shaResult: Uint8Array | null = null;
  checkpoint: TransferCheckpointV1 | null = null;

  async selectAndOpen() {
    this.selected = true;
  }
  async ensureTransfer(_tid: Uint8Array, _fileLen: number) {
    return this.ensureOk;
  }
  async loadCheckpoint() {
    return this.checkpoint;
  }
  async saveCheckpoint(_cp: unknown) {
    this.checkpoints.push(new Uint8Array(0));
  }
  async writeSegment(index: number, bytes: Uint8Array) {
    this.parts.set(index, bytes.slice());
  }
  async readSegment(index: number) {
    return this.parts.get(index) ?? null;
  }
  async streamSha256() {
    if (this.shaResult) return this.shaResult;
    // 按段序拼接后整体哈希
    const segs = [...this.parts.entries()].sort((a, b) => a[0] - b[0]);
    const total = segs.reduce((n, [, b]) => n + b.length, 0);
    const buf = new Uint8Array(total);
    let off = 0;
    for (const [, b] of segs) {
      buf.set(b, off);
      off += b.length;
    }
    return sha256Once(buf);
  }
  async saveFinalFile() {}
  async cleanupTemp() {}
  async dispose() {}
}
