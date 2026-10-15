// Fixed-slot pool of decode workers.
//
// The subtle part is slot identity: every worker's message handler closes over
// its own index, so growing and shrinking the pool has to leave the surviving
// workers' indices alone. Shrinking from the end is what makes that true, and
// it is why this is worth having on its own rather than inline in the receiver.
//
// Each worker holds its own ~940 KB zxing WASM instance, so the pool is also
// how the receiver reclaims that memory the moment the last frame is in.

export interface PoolWorker {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
}

import type { ScanReport } from "./scan-feedback";

export class DecodeWorkerPool {
  private readonly workers: PoolWorker[] = [];
  private readonly busy: boolean[] = [];
  private pendingSize: number | null = null;

  constructor(
    private readonly create: () => PoolWorker,
    private readonly onDecoded: (bytes: Uint8Array) => void,
    private readonly onReport?: (report: ScanReport) => void,
  ) {}

  get size(): number {
    return this.workers.length;
  }

  get busyCount(): number {
    return this.busy.filter(Boolean).length;
  }

  /** Grow or shrink in place. Terminating a busy worker just drops the frame it
   *  held, which the fountain absorbs like any other miss. */
  resize(count: number): void {
    this.pendingSize = null;
    while (this.workers.length > Math.max(0, count)) {
      this.workers.pop()!.terminate();
      this.busy.pop();
    }
    while (this.workers.length < count) {
      const slot = this.workers.length;
      const worker = this.create();
      worker.onmessage = (event: MessageEvent) => {
        if (this.workers[slot] !== worker) return;
        const { id, bytes } = event.data as ScanReport;
        if (id === -1) return; // warm-up ping, no frame attached
        this.busy[slot] = false;
        this.onReport?.(event.data as ScanReport);
        const symbols = (event.data as ScanReport).symbols;
        if (symbols) { for (const symbol of symbols) this.onDecoded(symbol.bytes); }
        else if (bytes) this.onDecoded(bytes);
        if (this.pendingSize !== null) this.resizeWhenIdle(this.pendingSize);
      };
      this.workers.push(worker);
      this.busy.push(false);
    }
  }

  /** Automatic tuning must never terminate an in-flight decode. Manual stop
   * and explicit settings still use resize() for immediate cancellation. */
  resizeWhenIdle(count: number): boolean {
    count = Math.max(0, Math.floor(count));
    if (count < this.size && this.busy.slice(count).some(Boolean)) {
      this.pendingSize = count;
      return false;
    }
    this.resize(count);
    return true;
  }

  /** Hand a frame to a free worker. False when every worker is busy — the
   *  caller drops the frame rather than queueing it, because a stale frame is
   *  worth less than the next one. */
  submit(message: unknown, transfer: Transferable[]): boolean {
    const slot = this.busy.indexOf(false);
    if (slot === -1) return false;
    this.busy[slot] = true;
    this.workers[slot]!.postMessage(message, transfer);
    return true;
  }
}
