// 打包 dist-pwa/ 为 Eternal-Wave-PWA.zip（iOS 预装包）。
import { existsSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";

// 用系统的 zip 命令（macOS/Linux 都有），比 JS 实现更可靠、更快。
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname ?? ".", "..");
const pwaDir = resolve(root, "dist-pwa");
const outZip = resolve(root, "Eternal-Wave-PWA.zip");

if (!existsSync(pwaDir)) {
  console.error("dist-pwa/ 不存在——请先运行 vite build（PWA 模式）");
  process.exit(1);
}

// zip -r 保留相对路径；-X 去掉 macOS 附加元数据
rmSync(outZip, { force: true });
execFileSync("zip", ["-rX", outZip, "dist-pwa"], { cwd: root, stdio: "inherit" });
const size = statSync(outZip).size;
console.log(`Eternal-Wave-PWA.zip 已生成：${(size / 1024).toFixed(1)} KB`);
