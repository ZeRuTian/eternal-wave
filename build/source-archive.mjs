// Complete Corresponding Source: include pinned nested submodules, never .git,
// node_modules, local artifacts or untracked personal files.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const state = execFileSync("git", ["submodule", "status", "--recursive"], { cwd: root, encoding: "utf8" });
if (/^[-+U]/m.test(state)) throw new Error("Initialize and pin all source submodules before packaging");
const tracked = execFileSync("git", ["ls-files", "--recurse-submodules", "-z"], { cwd: root, encoding: "utf8" });
// Generated checksums include this archive; excluding them avoids a circular hash.
const files = Buffer.from(tracked.split("\0").filter(path => path && path !== "SHA256SUMS.txt").join("\0") + "\0");
if (!files.includes(Buffer.from("third_party/decimen-codec/wrapper/decimen_codec.cpp"))) throw new Error("Codec source missing");
execFileSync("tar", ["--null", "-T", "-", "-czf", resolve(root, "Eternal-Wave-Source.tar.gz")], {cwd: root, input: files});
console.log("Eternal-Wave-Source.tar.gz includes the application and pinned codec sources.");
