import type { Plugin } from "vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** 只把 Eternal Wave PWA 实际使用的图标写入产物，避免复制上游演示截图。 */
export function ewPwaAssets(rootDir: string): Plugin {
  const files = [
    "apple-touch-icon.png",
    "icon-192.png",
    "icon-512.png",
    "icon-maskable-512.png",
  ] as const;
  return {
    name: "ew-pwa-assets",
    generateBundle() {
      for (const fileName of files) {
        this.emitFile({
          type: "asset",
          fileName,
          source: readFileSync(resolve(rootDir, "public", fileName)),
        });
      }
    },
  };
}
