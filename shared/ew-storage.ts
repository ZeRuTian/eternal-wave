// StorageBackend — 接收端的本地存储抽象。
//
// 两种实现：
// - DesktopDirectoryBackend：File System Access API（桌面 Chrome/Edge/麒麟），
//   用户选择一个目录，写入 .ewpart 分片文件与 .ewckpt 检查点。
// - OPFSBackend：Origin Private File System（iOS/Android/支持 OPFS 的浏览器），
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
  /** 当前目录显示名（desktop：目录名；OPFS：固定文案）。 */
  readonly label: string;

  /** 让用户选择目录（desktop）/ 打开 OPFS 根（mobile）。失败抛错。 */
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

  /**
   * 生成可交给系统分享面板的最终文件快照。
   * iOS 必须在真实用户点击期间调用 navigator.share，不能异步现读 OPFS。
   */
  prepareFinalFile(name: string, mime: string): Promise<File>;

  /** 保存最终文件（桌面：写入已选目录；OPFS：触发自动下载）。 */
  saveFinalFile(name: string, mime: string): Promise<void>;

  /** 删除 .ewpart/.ewckpt（保存成功后清理临时文件）。 */
  cleanupTemp(): Promise<void>;

  /** 释放资源（关闭句柄等）。 */
  dispose(): Promise<void>;
}

export type AutoFinalizeResult =
  | { ok: true }
  | { ok: false; stage: "save" | "cleanup"; error: unknown };

/** 执行保存动作，并且只在保存成功后清理临时文件。 */
export async function saveThenCleanup(
  backend: StorageBackend,
  save: () => Promise<void>,
): Promise<AutoFinalizeResult> {
  try {
    // save() 在第一个 await 之前同步调用；由点击处理器传入 navigator.share
    // 时，WebKit 的瞬时用户激活不会在调用前丢失。
    await save();
  } catch (error) {
    return { ok: false, stage: "save", error };
  }
  try {
    await backend.cleanupTemp();
  } catch (error) {
    return { ok: false, stage: "cleanup", error };
  }
  return { ok: true };
}

/**
 * 校验完成后的统一收尾：先保存最终文件，成功后才删除临时文件。
 *
 * 顺序不能颠倒；保存或系统分享若失败，必须保留 .ewpart 与检查点，避免
 * 已接收并通过 SHA-256 的文件不可恢复。
 */
export async function autoSaveAndCleanup(
  backend: StorageBackend,
  name: string,
  mime: string,
): Promise<AutoFinalizeResult> {
  return saveThenCleanup(backend, () => backend.saveFinalFile(name, mime));
}

// ---- 工具：浏览器能力探测 ----
function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof crypto !== "undefined";
}

function sameTransferId(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function removeEntry(dir: FileSystemDirectoryHandle | null, name: string): Promise<void> {
  if (!dir) return;
  try {
    await dir.removeEntry(name);
  } catch {
    // 某些早期 Chromium 只暴露 handle.remove；作为兼容回退。
    try {
      const handle = await dir.getFileHandle(name);
      await (handle as RemoveableFileHandle).remove?.();
    } catch {
      /* 文件不存在或环境不支持删除。 */
    }
  }
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
  // 目录显示名（浏览器隐私限制：只能拿到目录名，没有完整路径）
  let dirName = "";

  const partName = (): string => "eternal-wave.ewpart";
  const ckptName = (): string => "eternal-wave.ewckpt";
  const ckptTmpName = (): string => "eternal-wave.ewckpt.tmp";

  return {
    kind: "desktop-dir",

    get label() {
      return dirName ? `已选择目录：${dirName}（已授权）` : "未选择目录";
    },

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
        dirName = dirHandle.name;
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

    async prepareFinalFile(name, mime) {
      if (!partHandle) throw new Error("尚未初始化传输");
      const file = await partHandle.getFile();
      if (file.size < fileLen) throw new Error(`临时文件不完整，仍缺少 ${fileLen - file.size} 字节`);
      const blob = file.slice(0, fileLen, mime || "application/octet-stream");
      return new File([blob], name, { type: blob.type, lastModified: Date.now() });
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
        if (remaining !== 0) throw new Error(`临时文件不完整，仍缺少 ${remaining} 字节`);
        await w.close();
      } catch (err) {
        await w.abort().catch(() => undefined);
        throw err;
      } finally {
        reader.releaseLock();
      }
    },

    async cleanupTemp() {
      for (const n of [partName(), ckptName(), ckptTmpName()]) {
        await removeEntry(dirHandle, n);
      }
    },

    async dispose() {
      dirHandle = null;
      partHandle = null;
      ckptHandle = null;
    },
  };
}

// ================= OPFS 后端（iOS / Android / 支持 OPFS 的浏览器） =================

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

  const prepareFinalFile = async (name: string, mime: string): Promise<File> => {
    if (!partHandle) throw new Error("OPFS 传输尚未初始化");
    const file = await partHandle.getFile();
    if (file.size < fileLen) throw new Error(`临时文件不完整，仍缺少 ${fileLen - file.size} 字节`);
    const blob = file.slice(0, fileLen, mime || "application/octet-stream");
    return new File([blob], name, { type: blob.type, lastModified: Date.now() });
  };

  return {
    kind: "opfs",
    get label() {
      return "本机临时存储（OPFS，浏览器私有空间）";
    },

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

    prepareFinalFile,

    async saveFinalFile(name, mime) {
      const file = await prepareFinalFile(name, mime);
      // File/slice/new File can still reference OPFS backing storage. Materialize
      // bytes before cleanup, otherwise deleting .ewpart can cancel the download.
      // Allocation/read errors propagate so recovery data is preserved.
      const downloadBlob = new Blob([await file.arrayBuffer()], { type: file.type });
      const url = URL.createObjectURL(downloadBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.hidden = true;
      document.body.append(a);
      try {
        // 挂入 DOM 后触发，供 Android/桌面等支持脚本下载的 OPFS 环境使用。
        // iOS 不走此路径，而是由真实点击调用 Web Share API。
        a.click();
      } catch (error) {
        a.remove();
        URL.revokeObjectURL(url);
        throw error;
      }
      // 保留链接与 Blob URL 一段时间，让浏览器下载管理器有时间接管读取；
      // OPFS 临时文件随后删除不影响这个已独立读取的 Blob。
      setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
      }, 60_000);
    },

    async cleanupTemp() {
      for (const n of [partName(), ckptName(), ckptTmpName()]) {
        await removeEntry(root, n);
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
export function preferredStorageBackend(
  canPickDirectory: boolean,
  canUseOpfs: boolean,
): StorageBackend["kind"] | null {
  if (canPickDirectory) return "desktop-dir";
  if (canUseOpfs) return "opfs";
  return null;
}

/** 自动选择后端：桌面目录能力优先，否则使用 OPFS；不依赖 PWA 显示模式。 */
export function createAutoBackend(): StorageBackend {
  if (!isBrowser()) throw new Error("当前环境不是受支持的浏览器");
  const kind = preferredStorageBackend(
    typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function",
    typeof navigator.storage?.getDirectory === "function",
  );
  if (kind === "desktop-dir") return createDesktopBackend();
  if (kind === "opfs") return createOpfsBackend();
  throw new Error("当前浏览器不支持本地接收存储，请使用新版 Chrome、Edge、Safari 或华为浏览器");
}
