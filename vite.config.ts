import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { viteSingleFile } from "vite-plugin-singlefile";
import { VitePWA } from "vite-plugin-pwa";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MAX_FILE_LABEL } from "./shared/ew-protocol";
import { TX_FPS_OPTIONS, FRAME_BYTES_OPTIONS, DEFAULT_TX_FPS, DEFAULT_FRAME_BYTES } from "./shared/ew-sender";
import { htmlTokens } from "./build/html-tokens";
import { inlineZxingWasm } from "./build/inline-zxing-wasm";
import { useInlineVariants } from "./build/use-inline-variants";
import { emitAs } from "./build/emit-as";
import { rootPwaHead } from "./build/root-pwa-head";
import { licenseBanner } from "./build/license-banner";
import { ewStandaloneCsp } from "./build/ew-standalone-csp";
import { ewPwaAssets } from "./build/ew-pwa-assets";

// Eternal Wave — 单页构建。
//
// Modes:
//   (default)    开发 / 站点模式（PWA）
//   standalone   一个自包含 Eternal-Wave.html（桌面主产物，file:// 双击即用）
//   pwa          dist-pwa/ 部署包（iOS 预装用，vite-plugin-pwa）

const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")) as {
  version: string;
};

function buildId(): string {
  const git = (cmd: string) =>
    execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  try {
    const hash = git("git rev-parse --short HEAD");
    return git("git status --porcelain").length > 0 ? `${hash}-dirty` : hash;
  } catch {
    return "unknown";
  }
}

const selectOptions = (values: readonly number[], selected: number) =>
  values
    .map((v) => (v === selected ? `<option selected>${v}</option>` : `<option>${v}</option>`))
    .join("");

const TOKENS = {
  MAX_FILE_LABEL,
  TX_FPS_OPTIONS: selectOptions(TX_FPS_OPTIONS, DEFAULT_TX_FPS),
  FRAME_BYTES_OPTIONS: selectOptions(FRAME_BYTES_OPTIONS, DEFAULT_FRAME_BYTES),
  APP_VERSION: pkg.version,
  BUILD_ID: buildId(),
};

export default defineConfig(({ mode }) => {
  const standalone = mode === "standalone";
  const outDir = "dist";

  if (standalone) {
    return {
      base: "./",
      publicDir: false,
      plugins: [
        htmlTokens(TOKENS),
        useInlineVariants(__dirname),
        inlineZxingWasm(),
        ewStandaloneCsp(),
        viteSingleFile(),
        licenseBanner(pkg.version),
        emitAs(outDir, "app/index.html", "Eternal-Wave.html"),
      ],
      worker: { format: "iife", plugins: () => [useInlineVariants(__dirname), inlineZxingWasm()] },
      build: {
        outDir,
        emptyOutDir: true,
        assetsInlineLimit: Number.MAX_SAFE_INTEGER,
        rollupOptions: { input: resolve(__dirname, "app/index.html") },
      },
    };
  }

  return {
    root: resolve(__dirname, "app"),
    base: "./",
    publicDir: false,
    plugins: [
      htmlTokens(TOKENS),
      basicSsl(),
      VitePWA({
        registerType: "autoUpdate",
        injectRegister: false,
        manifest: {
          name: "Eternal Wave 动态二维码文件传输",
          short_name: "Eternal Wave",
          description: "用屏幕和摄像头传输文件，不经过网络。支持最大 256 MB。",
          theme_color: "#070a11",
          background_color: "#070a11",
          lang: "zh-CN",
          display: "standalone",
          start_url: "./",
          icons: [
            { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
            { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
            { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          ],
        },
        workbox: {
          clientsClaim: true,
          maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
          globPatterns: ["**/*.{js,css,html,wasm,png,svg}"],
        },
      }),
      rootPwaHead(),
      licenseBanner(pkg.version),
      ewPwaAssets(__dirname),
    ],
    build: {
      outDir: resolve(__dirname, "dist-pwa"),
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, "app/index.html"),
        },
      },
    },
    server: { host: true },
    preview: { host: true },
  };
});
