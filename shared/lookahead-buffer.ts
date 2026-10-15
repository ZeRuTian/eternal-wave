/** Bounded, single-producer buffer. Refill continues after transient stalls;
 * no overlapping generation, polling or unbounded stale frame queue. */
export class LookaheadBuffer<T> {
  private queue: T[] = [];
  private filling = false;
  private stopped = false;
  constructor(private readonly capacity: number, private readonly produce: () => Promise<T>,
    private readonly onError: (error: unknown) => void) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Invalid buffer capacity");
  }
  get size(): number { return this.queue.length; }
  start(): void { void this.fill(); }
  take(): T | undefined {
    const item = this.queue.shift();
    void this.fill();
    return item;
  }
  dispose(): void { this.stopped = true; this.queue = []; }
  private async fill(): Promise<void> {
    if (this.filling || this.stopped) return;
    this.filling = true;
    try {
      while (!this.stopped && this.queue.length < this.capacity) {
        const value = await this.produce();
        if (!this.stopped) this.queue.push(value);
      }
    } catch (error) {
      if (!this.stopped) { this.dispose(); this.onError(error); }
    } finally { this.filling = false; }
  }
}
