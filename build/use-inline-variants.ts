import type { Plugin } from "vite";
import { resolve } from "node:path";

/**
 * Standalone builds need the worker and the wasm embedded rather than fetched.
 * Doing that with a runtime branch does not work: both inline forms have
 * module-scope side effects, so Rollup keeps them even when the branch is dead.
 * Swapping the module at resolve time means the other variant is never parsed.
 *
 * `rootDir` is the repo root — passed in from vite.config.ts so the swap
 * targets stay anchored there no matter where this file lives.
 */
export function useInlineVariants(rootDir: string): Plugin {
  return {
    name: "use-inline-variants",
    enforce: "pre",
    resolveId(source) {
      if (source.endsWith("/encode-worker-factory")) return resolve(rootDir, "send/encode-worker-factory.inline.ts");
      if (source.endsWith("/codec-wasm-url")) return resolve(rootDir, "receive/codec-wasm-url.inline.ts");
      // 按文件名后缀匹配：无论调用方用什么相对路径（./worker-factory、
      // ../receive/worker-factory），都替换为 inline 变体。
      if (source === "./worker-factory" || source.endsWith("/worker-factory")) {
        return resolve(rootDir, "receive/worker-factory.inline.ts");
      }
      if (source === "./wasm-url" || source.endsWith("/wasm-url")) {
        return resolve(rootDir, "receive/wasm-url.inline.ts");
      }
      return null;
    },
  };
}
