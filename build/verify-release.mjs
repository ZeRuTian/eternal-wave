import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const standalonePath = resolve(root, "dist/Eternal-Wave.html");
const pwaDir = resolve(root, "dist-pwa");
const zipPath = resolve(root, "Eternal-Wave-PWA.zip");
const checksumsPath = resolve(root, "SHA256SUMS.txt");

function check(condition, message) {
  if (!condition) throw new Error(message);
}

for (const path of [standalonePath, pwaDir, zipPath, checksumsPath]) {
  check(existsSync(path), `缺少发布产物：${path}`);
}

const standalone = readFileSync(standalonePath, "utf8");
const standaloneNormalized = standalone
  .replaceAll("&#39;", "'")
  .replaceAll("&quot;", '"');
check(standalone.includes("Eternal Wave contributors"), "单文件缺少 Eternal Wave 派生版权横幅");
check(standalone.includes("Evan Crawley (Bash Alarmist)"), "单文件缺少上游作者署名");
check(/Content-Security-Policy/i.test(standalone), "单文件缺少 CSP");
check(/default-src 'none'/.test(standaloneNormalized), "单文件 CSP 未设置 default-src 'none'");
check(/connect-src data: blob:/.test(standaloneNormalized), "单文件 CSP 未限制 connect-src");
check(!/<script\b[^>]*\bsrc\s*=/i.test(standalone), "单文件仍含外部 script src");
check(!/<link\b[^>]*rel=["']stylesheet["']/i.test(standalone), "单文件仍含外部样式表");
check(!/(?:src|href)=["']https?:\/\//i.test(standalone), "单文件仍含 HTTP(S) 资源引用");

const manifest = JSON.parse(readFileSync(resolve(pwaDir, "manifest.webmanifest"), "utf8"));
check(manifest.start_url === "./", "PWA start_url 必须为 ./");
check(manifest.scope === "./", "PWA scope 必须为 ./");
check(manifest.lang === "zh-CN", "PWA lang 必须为 zh-CN");

const requiredPwaFiles = [
  "index.html",
  "manifest.webmanifest",
  "sw.js",
  "apple-touch-icon.png",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
];
for (const file of requiredPwaFiles) {
  check(existsSync(resolve(pwaDir, file)), `PWA 缺少 ${file}`);
}
check(!existsSync(resolve(pwaDir, "app/index.html")), "PWA 入口不应位于 app/index.html");
check(!readdirSync(pwaDir).some((name) => /^success|decimen_logo/.test(name)), "PWA 混入上游演示图片");

execFileSync("unzip", ["-tqq", zipPath], { stdio: "pipe" });
const zipEntries = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" })
  .trim()
  .split(/\r?\n/);
for (const file of requiredPwaFiles) {
  check(zipEntries.includes(`dist-pwa/${file}`), `PWA ZIP 缺少 ${file}`);
}
check(!zipEntries.some((name) => /success|decimen_logo|dist-pwa\/app\//.test(name)), "PWA ZIP 含陈旧文件");

const checksumLines = readFileSync(checksumsPath, "utf8").trim().split(/\r?\n/);
const expectedChecksumFiles = ["dist/Eternal-Wave.html", "Eternal-Wave-PWA.zip"];
for (const relative of expectedChecksumFiles) {
  const line = checksumLines.find((item) => item.endsWith(`  ${relative}`));
  check(line, `SHA256SUMS.txt 缺少 ${relative}`);
  const expected = line.slice(0, 64);
  const actual = createHash("sha256").update(readFileSync(resolve(root, relative))).digest("hex");
  check(actual === expected, `${relative} 的 SHA-256 不匹配`);
}

const license = readFileSync(resolve(root, "LICENSE"), "utf8");
check(license.includes("Copyright (c) 2026 Evan Crawley (Bash Alarmist)"), "LICENSE 缺少上游版权行");
check(license.includes("Copyright (c) 2026 Eternal Wave contributors"), "LICENSE 缺少派生版权行");
const readme = readFileSync(resolve(root, "README.md"), "utf8");
check(
  readme.includes("## 快速开始（桌面）") && readme.includes("## iPhone / iPad（PWA 预装）"),
  "README 中文使用说明不完整",
);

console.log(`standalone=${(statSync(standalonePath).size / 1024).toFixed(1)} KiB`);
console.log(`pwa_zip=${(statSync(zipPath).size / 1024).toFixed(1)} KiB`);
console.log(`zip_entries=${zipEntries.length}`);
console.log("release_verification=passed");
