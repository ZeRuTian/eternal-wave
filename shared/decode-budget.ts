/** Bounded queueing estimate, not a claim about available physical cores. */
export function decodeWorkerBudget(elapsedMs: number, captureFps: number, hardwareLimit: number): number {
  const limit = Math.max(1, Math.min(4, Math.floor(hardwareLimit)));
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(captureFps)) return Math.min(2, limit);
  return Math.min(limit, Math.max(1, Math.ceil(Math.max(0, elapsedMs) * Math.max(1, captureFps) * 1.2 / 1000)));
}
