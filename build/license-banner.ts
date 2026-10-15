import type { Plugin } from "vite";
import { readFileSync } from "node:fs";

/**
 * Prepends the copyright banner to every built artifact. The repo's LICENSE
 * covers the source; this covers what people actually copy — the deployed
 * bundle and standalone files — retain legacy MIT attribution and provide
 * the combined work's AGPL license and corresponding-source link.
 *
 * JS and CSS get a `/*!` legal comment (minifiers preserve those); HTML gets
 * a comment right after the doctype (before it would parse fine in HTML5,
 * but after costs nothing and can never risk quirks mode). Binary assets
 * (wasm, images) are left alone.
 */
export function licenseBanner(version: string): Plugin {
  const text =
    `Eternal Wave v${version} — derived from Decimen Optical Transfer (` +
    `https://decimen.app) — (c) 2026 Evan Crawley (Bash Alarmist) ` +
    `& Eternal Wave contributors — SPDX-License-Identifier: AGPL-3.0-or-later`;
  const notices = ["LICENSE", "LICENSE-MIT", "vendor/decimen-codec/NOTICE.md", "vendor/decimen-codec/LICENSE.zxing-cpp"]
    .map(path => `${path}\n\n${readFileSync(new URL(`../${path}`, import.meta.url), "utf8")}`).join("\n\n");
  const escaped = notices.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const comment = `/*! ${text} */\n`;
  const htmlComment = `<!-- ${text} -->`;
  return {
    name: "license-banner",
    enforce: "post",
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === "chunk") {
          if (!output.code.startsWith(comment)) output.code = comment + output.code;
          continue;
        }
        if (typeof output.source !== "string") continue;
        if (fileName.endsWith(".js") || fileName.endsWith(".css")) {
          if (!output.source.startsWith(comment)) output.source = comment + output.source;
        } else if (fileName.endsWith(".html")) {
          if (output.source.includes(htmlComment)) continue;
          if (!/^<!doctype html>/i.test(output.source)) {
            throw new Error(`${fileName}: no leading doctype to banner after`);
          }
          output.source = output.source.replace(/^<!doctype html>/i, (m) => `${m}\n${htmlComment}`);
          output.source = output.source.replace("</footer>", `<details class="license-notices"><summary>开源许可与版权声明</summary><pre>${escaped}</pre></details></footer>`);
        }
      }
    },
  };
}
