export function createEncodeWorker(): Worker {
  return new Worker(new URL("./encode-worker.ts", import.meta.url), { type: "module" });
}
