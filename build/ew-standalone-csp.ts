import type { Plugin } from "vite";

/**
 * Eternal Wave 单页 CSP：默认全禁，仅放开单页确实用到的源。
 *
 * 目标是把"零网络请求"从意图变成可强制：zxing-wasm 默认 locateFile 指向
 * jsdelivr 的字符串会编译进产物（虽然运行时被覆盖），任何库升级或初始化
 * 顺序变化都可能让断网机器悄悄联网。default-src 'none' 且无任何 http(s)
 * 源意味着浏览器直接拒绝，而不是页面静默外联。
 *
 * 说明：
 * - 'unsafe-inline' 对 script 不可避免——整个 bundle 就是内联脚本；它无法
 *   重新启用网络源，因此无成本。
 * - 'wasm-unsafe-eval' 必须有，否则 CSP 一出现 WebAssembly.instantiate 即被
 *   整体拦截，解码器无法启动。
 * - wasm 以 data: URI 到达且由 Emscripten fetch，因此 connect-src 需放行
 *   data:；解码 worker 是 blob: URL。
 * - 接收端需要摄像头（media-src mediastream:）与本地目录读取（无需额外源）。
 */
export function ewStandaloneCsp(): Plugin {
  const policy = [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:",
    "worker-src blob:",
    "connect-src data: blob:",
    "img-src data: blob:",
    "media-src blob: mediastream:",
    "style-src 'unsafe-inline'",
    "font-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return {
    name: "ew-standalone-csp",
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: {
            "http-equiv": "Content-Security-Policy",
            content: policy,
          },
          injectTo: "head-prepend",
        },
      ];
    },
  };
}
