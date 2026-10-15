/** Bounded queueing estimate, not a claim about available physical cores. */
export function decodeWorkerBudget(elapsedMs: number, captureFps: number, hardwareLimit: number): number {
  const limit = Math.max(1, Math.min(4, Math.floor(hardwareLimit)));
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(captureFps)) return Math.min(2, limit);
  return Math.min(limit, Math.max(1, Math.ceil(Math.max(0, elapsedMs) * Math.max(1, captureFps) * 1.2 / 1000)));
}

export interface DecodeSample {
  now: number;
  workers: number;
  usefulBytes: number;
  captures: number;
  drops: number;
  decodeMs: number;
  limit: number;
}

/** Trial one slot at a time and judge ONLY newly accepted data. Decode latency
 * suggests a trial; actual throughput decides whether it survives. */
export class AdaptiveDecodeTuner {
  private anchor: DecodeSample | null = null;
  private trial: { from: number; to: number; baseline: number; started: boolean } | null = null;
  private cooldownUntil = 0;
  private blocked = new Map<string, number>();
  reset(): void { this.anchor = null; this.trial = null; this.cooldownUntil = 0; this.blocked.clear(); }
  observe(sample: DecodeSample): number | null {
    const { now, workers } = sample;
    const limit = Math.max(1, Math.min(4, sample.limit));
    const trial = this.trial;
    if (trial && !trial.started) {
      // Deferred shrinking may take time. Never mix measurements from two sizes.
      this.anchor = { ...sample };
      if (workers === trial.to) trial.started = true;
      return null;
    }
    const anchor = this.anchor;
    if (!anchor || now < anchor.now || sample.usefulBytes < anchor.usefulBytes || sample.captures < anchor.captures) {
      this.anchor = { ...sample };
      this.trial = null;
      return null;
    }
    if (now - anchor.now < 4000) return null;
    this.anchor = { ...sample };
    const elapsed = (now - anchor.now) / 1000;
    const bytes = sample.usefulBytes - anchor.usefulBytes;
    const captures = sample.captures - anchor.captures;
    const rate = bytes / elapsed;
    if (trial) {
      this.trial = null;
      // A silent/duplicate-only window is not evidence that extra/fewer slots help.
      const keep = captures > 0 && bytes > 0 && rate >= trial.baseline * (trial.to > trial.from ? 1.03 : 0.98);
      this.cooldownUntil = now + 12000;
      if (!keep) {
        this.blocked.set(`${trial.from}:${trial.to}`, now + 60000);
        this.anchor = null;
        return trial.from;
      }
      return null;
    }
    if (now < this.cooldownUntil || captures <= 0 || bytes <= 0 || workers < 1) return null;
    const drops = Math.max(0, sample.drops - anchor.drops) / captures;
    const needed = decodeWorkerBudget(sample.decodeMs, captures / elapsed, limit);
    let target = workers;
    if (drops >= 0.1 && workers < limit) target++;
    else if (drops <= 0.02 && needed < workers) target--;
    if (target === workers || now < (this.blocked.get(`${workers}:${target}`) ?? 0)) return null;
    this.trial = { from: workers, to: target, baseline: rate, started: false };
    return target;
  }
}
