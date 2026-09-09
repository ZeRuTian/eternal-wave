let wanted = false;
let pending = false;
let lock: WakeLockSentinel | null = null;

/** Reacquire when visible; release explicitly when the transfer ends. */
export async function requestScreenWakeLock(): Promise<void> {
  wanted = true;
  if (pending || lock || document.hidden) return;
  pending = true;
  try {
    const acquired = await navigator.wakeLock?.request("screen");
    if (!acquired) return;
    if (!wanted || document.hidden) { await acquired.release(); return; }
    lock = acquired;
    acquired.addEventListener("release", () => { if (lock === acquired) lock = null; });
  } catch {
    // OS may deny a wake lock. Camera and transfer still work while visible.
  } finally { pending = false; }
}

export function releaseScreenWakeLock(): void {
  wanted = false;
  const previous = lock;
  lock = null;
  void previous?.release().catch(() => undefined);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && wanted) void requestScreenWakeLock();
  });
}
