import InlineWorker from "./encode-worker.ts?worker&inline";
export function createEncodeWorker(): Worker { return new InlineWorker(); }
