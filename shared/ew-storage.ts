// StorageBackend — 接收端的本地存储抽象。
//
// 两种实现：
// - DesktopDirectoryBackend：File System Access API（桌面 Chrome/Edge/麒麟），
//   用户选择一个目录，写入 .ewpart 分片文件与 .ewckpt 检查点。
// - OPFSBackend：Origin Private File System（iOS PWA / 支持 OPFS 的浏览器），
//   固定使用虚拟根目录，实现相同检查点语义。
//
// 接口全部异步、与 UI 无关，便于单元测试用 mock 实现替换。
// 本模块只在浏览器环境可用；Node 测试环境调用工厂函数会抛中文错误。

import { SEGMENT_SIZE } from "./ew-protocol";
import type { TransferCheckpointV1 } from "./ew-checkpoint";
import { encodeCheckpoint, parseCheckpoint } from "./ew-checkpoint";
import { Sha256 } from "./ew-sha256";

// FileSystemFileHandle.remove 是较新的规范（Chrome 110+），不在当前 lib.dom
// 类型中；统一用扩展类型访问，运行时不存在的环境会安全跳过。
type RemoveableFileHandle = FileSystemFileHandle & { remove?: () => Promise<void> };
type WritableData = string | BufferSource | Blob;

const toChunk = (bytes: Uint8Array): WritableData => bytes as unknown as WritableData;

export interface StorageBackend {
  readonly kind: "desktop-dir" | "opfs";

  /** 让用户选择目录（desktop）/ 打开 OPFS 根（PWA）。失败抛错。 */
  selectAndOpen(): Promise<void>;

  /**
   * 收到清单后建立传输上下文（.ewpart + .ewckpt）。
   * 先做空间检查：可用空间必须 ≥ fileLen × 1.25 + 16 MiB，不足返回 false
   * （拒绝开始，避免传输末尾失败）。已存在同传输检查点时直接复用。
   */
  ensureTransfer(transferId: Uint8Array, fileLen: number): Promise<boolean>;

  /** 读取检查点；损坏/不存在返回 null。 */
  loadCheckpoint(): Promise<TransferCheckpointV1 | null>;

  /** 原子写检查点（临时文件 + rename）。 */
  saveCheckpoint(cp: TransferCheckpointV1): Promise<void>;

  /** 把某段编码后字节写入 .ewpart 的对应偏移（index × SEGMENT_SIZE）。 */
  writeSegment(index: number, bytes: Uint8Array): Promise<void>;

  /** 读回某段（供校验/恢复使用）。 */
  readSegment(index: number): Promise<Uint8Array | null>;

  /** 流式计算 .ewpart 全部字节的 SHA-256（增量，不整载入内存）。 */
  streamSha256(): Promise<Uint8Array>;

  /** 保存最终文件（桌面：另存为；PWA：触发下载）。 */
  saveFinalFile(name: string, mime: string): Promise<void>;

  /** 删除 .ewpart/.ewckpt（保存成功后清理临时文件）。 */
  cleanupTemp(): Promise<void>;

  /** 释放资源（关闭句柄等）。 */
  dispose(): Promise<void>;
}

// ---- 工具：浏览器能力探测 ----
function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof crypto !== "undefined";
}

function sameTransferId(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// ================= 桌面目录后端 =================

export function createDesktopBackend(): StorageBackend {
  if (!isBrowser() || typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker !== "function") {
    throw new Error("当前环境不支持 File System Access API（需要桌面版 Chrome/Edge 109+）");
  }

  let dirHandle: FileSystemDirectoryHandle | null = null;
  let partHandle: FileSystemFileHandle | null = null;
  let ckptHandle: FileSystemFileHandle | null = null;
  let fileLen = 0;

  const partName = (): string => "eternal-wave.ewpart";
  const ckptName = (): string => "eternal-wave.ewckpt";
  const ckptTmpName = (): string => "eternal-wave.ewckpt.tmp";

  return {
    kind: "desktop-dir",

    async selectAndOpen() {
      // 复用已有句柄前先确认读写权限：旧版本可能只授予了只读权限，
      // 直接复用会在后续写入时报错。queryPermission 不需要用户手势。
      if (dirHandle) {
        try {
          const perm = await (dirHandle as FileSystemDirectoryHandle & {
            queryPermission?: (o?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
          }).queryPermission?.({ mode: "readwrite" });
          if (perm === "granted") {
            // 权限足够，复用；子句柄稍后由 ensureTransfer 重建
            ckptHandle = null;
            partHandle = null;
            return;
          }
        } catch {
          /* 降级：重新弹窗选择 */
        }
        dirHandle = null;
      }
      try {
        // 必须请求 readwrite 权限：接收端要创建/写入 .ewpart 与 .ewckpt。
        // 只读权限（showDirectoryPicker 默认）会在后续无用户手势的异步
        // 解码流程里被 getFileHandle 拒绝（User activation required）。
        dirHandle = await (
          window as unknown as {
            showDirectoryPicker(options?: { mode?: "read" | "readwrite" }): Promise<FileSystemDirectoryHandle>;
          }
        ).showDirectoryPicker({ mode: "readwrite" });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          throw new Error("已取消选择接收目录");
        }
        throw new Error(`无法选择接收目录：${err instanceof Error ? err.message : String(err)}`);
      }
      ckptHandle = null;
      partHandle = null;
    },

    async ensureTransfer(transferId: Uint8Array, fileLen_: number) {
      if (!dirHandle) throw new Error("尚未选择接收目录");
      fileLen = fileLen_;
      // 空间检查（尽力而为：File System Access API 没有目录配额查询，
      // 用 OPFS 配额做近似，失败则放行，由写入错误兜底）
      try {
        const est = await navigator.storage.estimate();
        const quota = est.quota ?? 0;
        const usage = est.usage ?? 0;
        const need = fileLen * 1.25 + 16 * 1024 * 1024;
        if (quota > 0 && quota - usage < need) return false;
      } catch {
        /* 忽略，放行 */
      }
      const existingCheckpoint = await this.loadCheckpoint();
      // .ewpart 是否已存在（不带 create 探测：存在则成功，否则抛 NotFoundError）
      let hasExistingPart = false;
      try {
        await dirHandle.getFileHandle(partName());
        hasExistingPart = true;
      } catch {
        hasExistingPart = false;
      }
      const canResume =
        hasExistingPart &&
        existingCheckpoint !== null &&
        sameTransferId(existingCheckpoint.transferId, transferId) &&
        existingCheckpoint.fileLen === fileLen;
      try {
        partHandle = await dirHandle.getFileHandle(partName(), { create: true });
        ckptHandle = await dirHandle.getFileHandle(ckptName(), { create: true });
      } catch (err) {
        // 权限不足或句柄失效：清空句柄，避免留下"半初始化"状态让后续
        // writeSegment 报"尚未初始化传输"而不是给出可操作的提示。
        partHandle = null;
        ckptHandle = null;
        throw new Error(
          `无法在所选目录写入临时文件（需要读写权限）。请重新选择目录并确认授权：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!canResume) {
        // 新传输必须清空旧 .ewpart；否则较短文件会把旧尾部带入 SHA-256。
        const w = await partHandle.createWritable();
        await w.truncate(0);
        await w.close();
      }
      return true;
    },

    async loadCheckpoint() {
      if (!dirHandle) return null;
      try {
        if (!ckptHandle) ckptHandle = await dirHandle.getFileHandle(ckptName());
        const file = await ckptHandle.getFile();
        if (file.size === 0) return null;
        return parseCheckpoint(new Uint8Array(await file.arrayBuffer()));
      } catch {
        return null;
      }
    },

    async saveCheckpoint(cp) {
      if (!dirHandle) throw new Error("尚未选择接收目录");
      const bytes = encodeCheckpoint(cp);
      // 原子写：先写 .tmp，再 rename（File System Access API 的 move 支持改名）
      const tmpHandle = await dirHandle.getFileHandle(ckptTmpName(), { create: true });
      const w = await tmpHandle.createWritable();
      await w.write(toChunk(bytes));
      await w.close();
      if (ckptHandle) {
        await (ckptHandle as RemoveableFileHandle).remove?.().catch(() => undefined);
      }
      ckptHandle = await dirHandle.getFileHandle(ckptName(), { create: true });
      const w2 = await ckptHandle.createWritable();
      await w2.write(toChunk(bytes));
      await w2.close();
      await (tmpHandle as RemoveableFileHandle).remove?.().catch(() => undefined);
    },

    async writeSegment(index, bytes) {
      if (!partHandle) throw new Error("尚未初始化传输");
      const w = await partHandle.createWritable({ keepExistingData: true });
      await w.write({ type: "write", position: index * SEGMENT_SIZE, data: toChunk(bytes) });
      await w.close();
    },

    async readSegment(index) {
      if (!partHandle) return null;
      try {
        const file = await partHandle.getFile();
        const start = index * SEGMENT_SIZE;
        const blob = file.slice(start, start + SEGMENT_SIZE);
        return new Uint8Array(await blob.arrayBuffer());
      } catch {
        return null;
      }
    },

    async streamSha256() {
      if (!partHandle) throw new Error("尚未初始化传输");
      const file = await partHandle.getFile();
      const hash = new Sha256();
      const reader = file.stream().getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      }
      return hash.digest();
    },

    async saveFinalFile(name, mime) {
      if (!dirHandle || !partHandle) throw new Error("尚未初始化传输");
      // 直接写入用户所选目录（而不是 a[download] 到浏览器默认下载目录）。
      // 从 .ewpart 流式复制前 fileLen 字节，避免大文件全载入内存。
      const partFile = await partHandle.getFile();
      const outHandle = await dirHandle.getFileHandle(name, { create: true });
      const w = await outHandle.createWritable();
      const reader = partFile.stream().getReader();
      let remaining = fileLen;
      try {
        for (;;) {
          if (remaining <= 0) break;
          const { done, value } = await reader.read();
          if (done) break;
          const take = Math.min(remaining, value.byteLength);
          await w.write(toChunk(new Uint8Array(value.buffer, value.byteOffset, take)));
          remaining -= take;
        }
      } finally {
        reader.releaseLock();
      }
      await w.close();
    },

    async cleanupTemp() {
      for (const n of [partName(), ckptName(), ckptTmpName()]) {
        try {
          await dirHandle?.getFileHandle(n).then((h) => (h as RemoveableFileHandle).remove?.());
        } catch {
          /* 忽略 */
        }
      }
    },

    async dispose() {
      dirHandle = null;
      partHandle = null;
      ckptHandle = null;
    },
  };
}

// ================= OPFS 后端（iOS PWA / 支持 OPFS 的浏览器） =================

export function createOpfsBackend(): StorageBackend {
  if (!isBrowser() || typeof navigator.storage?.getDirectory !== "function") {
    throw new Error("当前环境不支持 OPFS（需要 Chromium 109+ 或 iOS Safari 15.2+）");
  }

  let root: FileSystemDirectoryHandle | null = null;
  let partHandle: FileSystemFileHandle | null = null;
  let ckptHandle: FileSystemFileHandle | null = null;
  let fileLen = 0;

  const partName = (): string => "eternal-wave.ewpart";
  const ckptName = (): string => "eternal-wave.ewckpt";
  const ckptTmpName = (): string => "eternal-wave.ewckpt.tmp";

  return {
    kind: "opfs",

    async selectAndOpen() {
      if (root) return;
      root = await navigator.storage.getDirectory();
      try {
        ckptHandle = await root.getFileHandle(ckptName());
      } catch {
        ckptHandle = null;
      }
      try {
        partHandle = await root.getFileHandle(partName());
      } catch {
        partHandle = null;
      }
    },

    async ensureTransfer(transferId: Uint8Array, fileLen_: number) {
      if (!root) throw new Error("OPFS 尚未初始化");
      fileLen = fileLen_;
      const est = await navigator.storage.estimate();
      const quota = est.quota ?? 0;
      const usage = est.usage ?? 0;
      const need = fileLen * 1.25 + 16 * 1024 * 1024;
      if (quota > 0 && quota - usage < need) return false;
      const existingCheckpoint = await this.loadCheckpoint();
      // .ewpart 是否已存在（不带 create 探测）
      let hasExistingPart = false;
      try {
        await root.getFileHandle(partName());
        hasExistingPart = true;
      } catch {
        hasExistingPart = false;
      }
      const canResume =
        hasExistingPart &&
        existingCheckpoint !== null &&
        sameTransferId(existingCheckpoint.transferId, transferId) &&
        existingCheckpoint.fileLen === fileLen;
      partHandle = await root.getFileHandle(partName(), { create: true });
      ckptHandle = await root.getFileHandle(ckptName(), { create: true });
      if (!canResume) {
        const w = await partHandle.createWritable();
        await w.truncate(0);
        await w.close();
      }
      return true;
    },

    async loadCheckpoint() {
      if (!root) return null;
      try {
        if (!ckptHandle) ckptHandle = await root.getFileHandle(ckptName());
        const file = await ckptHandle.getFile();
        if (file.size === 0) return null;
        return parseCheckpoint(new Uint8Array(await file.arrayBuffer()));
      } catch {
        return null;
      }
    },

    async saveCheckpoint(cp) {
      if (!root) throw new Error("OPFS 尚未初始化");
      const bytes = encodeCheckpoint(cp);
      const tmpHandle = await root.getFileHandle(ckptTmpName(), { create: true });
      const w = await tmpHandle.createWritable();
      await w.write(toChunk(bytes));
      await w.close();
      if (ckptHandle) await (ckptHandle as RemoveableFileHandle).remove?.().catch(() => undefined);
      ckptHandle = await root.getFileHandle(ckptName(), { create: true });
      const w2 = await ckptHandle.createWritable();
      await w2.write(toChunk(bytes));
      await w2.close();
      await (tmpHandle as RemoveableFileHandle).remove?.().catch(() => undefined);
    },

    async writeSegment(index, bytes) {
      if (!partHandle) throw new Error("OPFS 传输尚未初始化");
      const w = await partHandle.createWritable({ keepExistingData: true });
      await w.write({ type: "write", position: index * SEGMENT_SIZE, data: toChunk(bytes) });
      await w.close();
    },

    async readSegment(index) {
      if (!partHandle) return null;
      try {
        const file = await partHandle.getFile();
        const start = index * SEGMENT_SIZE;
        const blob = file.slice(start, start + SEGMENT_SIZE);
        return new Uint8Array(await blob.arrayBuffer());
      } catch {
        return null;
      }
    },

    async streamSha256() {
      if (!partHandle) throw new Error("OPFS 传输尚未初始化");
      const file = await partHandle.getFile();
      const hash = new Sha256();
      const reader = file.stream().getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      }
      return hash.digest();
    },

    async saveFinalFile(name, mime) {
      if (!partHandle) throw new Error("OPFS 传输尚未初始化");
      const file = await partHandle.getFile();
      const blob = file.slice(0, fileLen, mime || "application/octet-stream");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },

    async cleanupTemp() {
      for (const n of [partName(), ckptName(), ckptTmpName()]) {
        try {
          await root?.getFileHandle(n).then((h) => (h as RemoveableFileHandle).remove?.());
        } catch {
          /* 忽略 */
        }
      }
    },

    async dispose() {
      root = null;
      partHandle = null;
      ckptHandle = null;
    },
  };
}

// ---- 工厂：按环境自动选择 ----
/** 自动选择后端：PWA/支持 OPFS 时用 OPFS，否则尝试桌面目录。 */
export function createAutoBackend(): StorageBackend {
  const isPwa =
    typeof window !== "undefined" &&
    (window.matchMedia?.("(display-mode: standalone)").matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true);
  try {
    if (isPwa) return createOpfsBackend();
  } catch {
    /* fall through */
  }
  return createDesktopBackend();
}
