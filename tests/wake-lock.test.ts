import test from "node:test";
import assert from "node:assert/strict";

test("wake lock deduplicates, resumes when visible, and stays released after stop", async () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const oldWakeLock = Object.getOwnPropertyDescriptor(navigator, "wakeLock");
  const documentStub = Object.assign(new EventTarget(), { hidden: false });
  class Lock extends EventTarget {
    released = false;
    async release() { this.released = true; this.dispatchEvent(new Event("release")); }
  }
  const locks: Lock[] = [];
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentStub });
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: {
    async request() { const lock = new Lock(); locks.push(lock); return lock; },
  } });
  try {
    const { requestScreenWakeLock, releaseScreenWakeLock } = await import("../shared/wake-lock.ts");
    await Promise.all([requestScreenWakeLock(), requestScreenWakeLock()]);
    assert.equal(locks.length, 1);
    documentStub.hidden = true;
    await locks[0]!.release(); // OS releases the lock when the page is hidden.
    documentStub.hidden = false;
    documentStub.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    assert.equal(locks.length, 2);
    releaseScreenWakeLock();
    assert.equal(locks[1]!.released, true);
    documentStub.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    assert.equal(locks.length, 2);
    // Stop while the request promise is still pending: do not leak the new lock.
    const pending = requestScreenWakeLock();
    releaseScreenWakeLock();
    await pending;
    assert.equal(locks[2]!.released, true);
  } finally {
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
    else Reflect.deleteProperty(globalThis, "document");
    if (oldWakeLock) Object.defineProperty(navigator, "wakeLock", oldWakeLock);
    else Reflect.deleteProperty(navigator, "wakeLock");
  }
});
