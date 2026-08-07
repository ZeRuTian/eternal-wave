// 接收核心：帧 → 清单 → 逐段喷泉解码 → CRC/解密/解压 → 检查点续传 → SHA-256 验证。
//
// 纯逻辑层，不依赖 DOM。存储与 UI 通过回调/接口注入，因此单元测试可以
// 用内存 mock 完整覆盖（含恶意帧、丢帧、重启续传等场景）。
//
// 状态机：
// - NO_MANIFEST：等清单（数据帧先到则丢弃并计数）
// - READY：清单就绪，按段收集帧解码
// - DONE：全部段完成且 SHA-256 验证通过
// 任意帧若 transferId 与当前清单不符 → 视为新传输，重置状态（发送端重启）。
//
// 压缩标志策略：清单不逐段记录 gzip 标志（SPEC §1.2 布局），接收端对每段
// 解密后的数据做 gzip magic 检测（0x1f 0x8b）：合法 gzip 且解压后长度等于
// 段原始长度 → 采用；否则视为未压缩。误判率 2^-16，且解压失败会回退。

import { LTDecoder } from "./fountain";
import { FRAME_TYPE_MANIFEST, SEGMENT_COVERAGE, SEGMENT_SIZE, parseFrame, type ParsedFrame } from "./ew-protocol";
import { deriveOrigLen, joinManifestFrames, parseManifest, type TransferManifestV1 } from "./ew-manifest";
import { recoverSegment } from "./ew-segment";
import { deriveKey } from "./ew-crypto";
import type { StorageBackend } from "./ew-storage";
import type { TransferCheckpointV1 } from "./ew-checkpoint";
import { completedCount, isSegmentComplete, markSegmentComplete, newCheckpoint } from "./ew-checkpoint";
import { sessionSeed } from "./ew-sender";

export interface ReceiverCallbacks {
  /** 清单就绪（文件名、大小等），返回 true 表示接受并开始。 */
  onManifest?: (m: TransferManifestV1) => void | Promise<void>;
  /** 某段完成（index / total）。 */
  onSegmentComplete?: (index: number, total: number) => void;
  /** 帧统计（总帧数/新帧/重复帧）。 */
  onStats?: (stats: { framesSeen: number; framesNew: number; framesDup: number }) => void;
  /** 全部完成且校验通过。 */
  onComplete?: (name: string, mime: string) => void | Promise<void>;
  /** 错误（中文消息）。 */
  onError?: (message: string) => void;
  /** 需要口令时请求（返回口令；返回 null 表示用户取消）。 */
  requestPassphrase?: (name: string, reason?: string) => Promise<string | null>;
}

export class EwReceiver {
  private manifest: TransferManifestV1 | null = null;
  private manifestChunks = new Map<number, Uint8Array>();
  private decoders = new Map<number, LTDecoder>();
  /** 已完成喷泉解码、正在解密/写盘的段；与“已持久化完成”严格分开。 */
  private processingSegments = new Set<number>();
  /** 已完成段（同步跟踪，避免 checkpoint 位图异步更新窗口内重复解码）。 */
  private completedSegments = new Set<number>();
  /** 清单处理中（串行化标志，防止周期性重发的清单帧并发重复落地）。 */
  private manifestProcessing = false;
  private checkpoint: TransferCheckpointV1 | null = null;
  private backend: StorageBackend | null = null;
  private key: CryptoKey | null = null;
  private passphraseCache = new Map<string, string>(); // transferIdHex → 口令（本次会话内记忆）
  private currentTransferIdHex = "";
  private done = false;

  framesSeen = 0;
  framesNew = 0;
  framesDup = 0;
  /** 已完成段数（含续传）。 */
  completed = 0;

  constructor(private cb: ReceiverCallbacks = {}) {}

  /** 注入存储后端（接收目录/OPFS）。 */
  async attachBackend(backend: StorageBackend): Promise<void> {
    this.backend = backend;
    await backend.selectAndOpen();
    // 尝试恢复上一个检查点（同一发送会话续传）
    const cp = await backend.loadCheckpoint();
    if (cp && !this.done) {
      this.checkpoint = cp;
      this.completed = completedCount(cp);
      for (let i = 0; i < cp.segmentCount; i++) {
        if (isSegmentComplete(cp, i)) this.completedSegments.add(i);
      }
      this.currentTransferIdHex = hex(cp.transferId);
      this.cb.onStats?.({
        framesSeen: this.framesSeen,
        framesNew: this.framesNew,
        framesDup: this.framesDup,
      });
      if (this.completed >= cp.segmentCount) {
        // 上一会话已全部完成（可能校验未跑完）——等待清单帧确认后重新校验
        this.cb.onError?.("检测到上一传输的完成分片，等待发送端重新发送以完成校验");
      }
    }
  }

  get isDone(): boolean {
    return this.done;
  }

  get hasManifest(): boolean {
    return this.manifest !== null;
  }

  get manifestInfo(): TransferManifestV1 | null {
    return this.manifest;
  }

  get completedIndexes(): readonly number[] {
    return Array.from(this.completedSegments).sort((a, b) => a - b);
  }

  /** 供 UI 使用的连续进度；已完成段 + 正在解码段的唯一帧比例。 */
  get progressInfo(): { fraction: number; completed: number; total: number } | null {
    if (!this.manifest) return null;
    if (this.done) return { fraction: 1, completed: this.manifest.segmentCount, total: this.manifest.segmentCount };
    let segmentUnits = this.completedSegments.size;
    for (const [index, dec] of this.decoders) {
      if (this.completedSegments.has(index)) continue;
      const expectedFrames = Math.max(dec.k + 1, Math.ceil(dec.k * SEGMENT_COVERAGE));
      segmentUnits += Math.min(0.99, dec.framesNew / expectedFrames);
    }
    return {
      fraction: Math.min(0.99, segmentUnits / this.manifest.segmentCount),
      completed: this.completed,
      total: this.manifest.segmentCount,
    };
  }

  /** 输入一帧原始字节（QR 解码产物）。任何异常都被捕获并转成 onError。 */
  handleFrame(frameBytes: Uint8Array): void {
    if (this.done) return;
    const parsed = parseFrame(frameBytes);
    if (!parsed) return; // 帧头/CRC 非法 → 丢弃
    this.framesSeen++;
    this.handleParsed(parsed).catch((err) => {
      this.cb.onError?.(err instanceof Error ? err.message : String(err));
    });
  }

  private async handleParsed(frame: ParsedFrame): Promise<void> {
    const h = frame.header;
    if (h.frameType === FRAME_TYPE_MANIFEST) {
      await this.handleManifestFrame(h.transferId, h.segmentIndex, h.segmentCount, frame.payload);
      return;
    }
    // 数据帧
    if (!this.manifest) return; // 清单未到：丢弃
    if (hex(h.transferId) !== this.currentTransferIdHex) {
      this.resetForNewTransfer(h.transferId); // 发送端重启 → 新传输
      return;
    }
    if (this.done) return;
    // 已完成段：忽略（同步判断，防异步 checkpoint 更新窗口内重复解码）
    if (this.completedSegments.has(h.segmentIndex)) {
      this.framesDup++;
      return;
    }
    if (this.checkpoint && isSegmentComplete(this.checkpoint, h.segmentIndex)) {
      this.framesDup++;
      return; // 已完成段：忽略
    }
    if (this.processingSegments.has(h.segmentIndex)) {
      this.framesDup++;
      return;
    }
    const segParam = this.manifest.segmentParams[h.segmentIndex];
    if (!segParam) return;
    // 帧头与清单一致性校验（防御伪造帧）
    if (h.segmentCount !== this.manifest.segmentCount) return;
    if (h.fileLen !== this.manifest.fileLen) return;
    if (h.segmentLen !== segParam.encodedLen) return;
    const expectedK = Math.max(1, Math.ceil(segParam.encodedLen / h.blockLen));
    if (h.k !== expectedK) return;

    let dec = this.decoders.get(h.segmentIndex);
    if (!dec) {
      dec = new LTDecoder(h.k, h.blockLen, sessionSeed(h.transferId), segParam.encodedLen);
      this.decoders.set(h.segmentIndex, dec);
    }
    const newBefore = dec.framesNew;
    const dupBefore = dec.framesDup;
    dec.addFrame(h.seq, frame.payload);
    this.framesNew += dec.framesNew - newBefore;
    this.framesDup += dec.framesDup - dupBefore;
    if (dec.isComplete) {
      // “正在处理”不能冒充“已经落盘”。旧实现提前写入 completedSegments，
      // 一旦口令错误或写盘失败，后续帧会永久被忽略，传输只能卡死。
      this.processingSegments.add(h.segmentIndex);
      const envelope = dec.assemble()!;
      const origLen = deriveOrigLen(h.segmentIndex, this.manifest.fileLen, SEGMENT_SIZE);
      try {
        const recovered = await this.recoverWithPassphraseRetry(
          envelope,
          segParam,
          h.segmentIndex,
          origLen,
        );
        if (!recovered) return;
        await this.persistSegment(h.segmentIndex, recovered);
        this.decoders.delete(h.segmentIndex);
      } finally {
        this.processingSegments.delete(h.segmentIndex);
      }
    }
    this.cb.onStats?.({
      framesSeen: this.framesSeen,
      framesNew: this.framesNew,
      framesDup: this.framesDup,
    });
  }

  /** 口令只在首个加密段上得到真实性验证；失败时允许原地重试一次。 */
  private async recoverWithPassphraseRetry(
    envelope: Uint8Array,
    params: TransferManifestV1["segmentParams"][number],
    index: number,
    origLen: number,
  ): Promise<Uint8Array | null> {
    try {
      return await recoverSegment(envelope, params, index, { key: this.key, origLen });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!this.manifest?.encrypted || !message.includes("解密失败")) throw err;
      this.passphraseCache.delete(this.currentTransferIdHex);
      const pass = await this.cb.requestPassphrase?.(
        this.manifest.name,
        "口令不正确或数据无法认证，请重新输入。",
      );
      if (!pass || !this.manifest.salt) {
        this.pauseForPassphrase();
        this.cb.onError?.("已暂停加密传输，等待下一次清单后重新输入口令");
        return null;
      }
      const retryKey = await deriveKey(pass, this.manifest.salt, this.manifest.pbkdf2Iterations);
      try {
        const recovered = await recoverSegment(envelope, params, index, {
          key: retryKey,
          origLen,
        });
        this.key = retryKey;
        this.passphraseCache.set(this.currentTransferIdHex, pass);
        return recovered;
      } catch (retryErr) {
        this.passphraseCache.delete(this.currentTransferIdHex);
        this.pauseForPassphrase();
        throw retryErr;
      }
    }
  }

  /** 放弃当前清单/解码器但保留已落盘检查点，等待周期性清单重新开始。 */
  private pauseForPassphrase(): void {
    this.manifest = null;
    this.manifestChunks.clear();
    this.decoders.clear();
    this.key = null;
  }

  private async handleManifestFrame(
    transferId: Uint8Array,
    index: number,
    total: number,
    payload: Uint8Array,
  ): Promise<void> {
    const idHex = hex(transferId);
    if (this.manifest && idHex !== this.currentTransferIdHex) {
      this.resetForNewTransfer(transferId);
    } else if (this.currentTransferIdHex && !this.manifest && idHex !== this.currentTransferIdHex) {
      // attachBackend() 可能已从磁盘恢复旧传输的位图，但清单尚未到达。
      // 清空旧 completedSegments，否则新传输的同序号分段会被误判为“已完成”并永久忽略。
      this.completedSegments.clear();
      this.completed = 0;
      this.currentTransferIdHex = idHex;
    }
    if (index >= total || total > 64) return; // 防御：分片数上限
    this.manifestChunks.set(index, payload);
    if (this.manifestChunks.size < total) return;
    const joined = joinManifestFrames(this.manifestChunks, total);
    if (!joined) return;
    let m: TransferManifestV1;
    try {
      m = parseManifest(joined);
    } catch (err) {
      this.manifestChunks.clear();
      this.cb.onError?.(err instanceof Error ? err.message : String(err));
      return;
    }
    if (this.manifest && idHex === this.currentTransferIdHex) return; // 同一清单重复
    // 串行化：同一时间只处理一份清单。清单帧周期性重发，并发处理会重复
    // 触发 onManifest/重复初始化存储；第一个处理中的清单会发布 manifest，
    // 其余帧在此被拦截。
    if (this.manifestProcessing) return;
    this.manifestProcessing = true;
    try {
      await this.applyManifest(m, transferId, idHex);
    } finally {
      this.manifestProcessing = false;
    }
  }

  /** 清单校验通过后的落地逻辑：密钥派生 → 发布 → 存储初始化。 */
  private async applyManifest(
    m: TransferManifestV1,
    transferId: Uint8Array,
    idHex: string,
  ): Promise<void> {
    // 加密传输：请求口令（本次会话内缓存）。注意：在发布 manifest 之前
    // 完成密钥派生，否则数据帧会看到"有清单但无密钥"的中间状态，导致
    // 未解密直接恢复段（竞态）。
    let key: CryptoKey | null = null;
    if (m.encrypted) {
      const cached = this.passphraseCache.get(idHex);
      let pass = cached ?? null;
      if (!pass && this.cb.requestPassphrase) {
        pass = await this.cb.requestPassphrase(m.name);
        if (pass) this.passphraseCache.set(idHex, pass);
      }
      if (pass && m.salt) {
        key = await deriveKey(pass, m.salt, m.pbkdf2Iterations);
      } else {
        this.cb.onError?.("该传输已加密，需要口令才能接收");
        this.manifestChunks.clear();
        return;
      }
    }

    // 全部就绪后再发布
    this.manifest = m;
    this.currentTransferIdHex = idHex;
    this.key = key;
    this.manifestChunks.clear();

    // 空间检查 + 初始化存储
    if (this.backend) {
      let ok: boolean;
      try {
        ok = await this.backend.ensureTransfer(transferId, m.fileLen);
      } catch (err) {
        // 初始化失败（如目录无写权限）：撤销 manifest 与已完成段标记，
        // 否则数据帧会继续解码但写盘失败，表现为"99% 卡住"。
        this.manifest = null;
        this.completedSegments.clear();
        this.decoders.clear();
        this.checkpoint = null;
        this.cb.onError?.(err instanceof Error ? err.message : String(err));
        return;
      }
      if (!ok) {
        this.cb.onError?.("存储空间不足（需要 文件大小×1.25 + 16 MiB 以上），拒绝开始");
        this.manifest = null;
        this.completedSegments.clear();
        return;
      }
      this.checkpoint = newCheckpoint(transferId, m.segmentCount, m.fileLen);
      // 续传：若磁盘检查点属于同一传输（transferId 相同），沿用其完成位图
      const disk = await this.backend.loadCheckpoint();
      if (disk && hex(disk.transferId) === this.currentTransferIdHex) {
        this.checkpoint = disk;
        for (let i = 0; i < disk.segmentCount; i++) {
          if (isSegmentComplete(disk, i)) this.completedSegments.add(i);
        }
      }
      await this.backend.saveCheckpoint(this.checkpoint);
    } else {
      // 无后端（纯内存测试/调试）：仍可解码，但完成时不保存
      this.checkpoint = newCheckpoint(transferId, m.segmentCount, m.fileLen);
    }

    this.completed = completedCount(this.checkpoint);
    await this.cb.onManifest?.(m);
  }

  private async persistSegment(index: number, bytes: Uint8Array): Promise<void> {
    if (this.backend) {
      await this.backend.writeSegment(index, bytes);
    }
    if (this.checkpoint) {
      markSegmentComplete(this.checkpoint, index);
      if (this.backend) await this.backend.saveCheckpoint(this.checkpoint);
    }
    this.completedSegments.add(index);
    this.completed = this.checkpoint ? completedCount(this.checkpoint) : this.completed + 1;
    this.cb.onSegmentComplete?.(index, this.manifest?.segmentCount ?? 0);
    if (this.checkpoint && completedCount(this.checkpoint) >= this.checkpoint.segmentCount) {
      await this.finish();
    }
  }

  /** 全部段完成：流式 SHA-256 验证 → onComplete。 */
  private async finish(): Promise<void> {
    if (!this.manifest || !this.checkpoint || this.done) return;
    if (completedCount(this.checkpoint) < this.checkpoint.segmentCount) return;
    if (!this.backend) {
      // 无后端：无法验证/保存，仅标记完成（测试场景）
      this.done = true;
      await this.cb.onComplete?.(this.manifest.name, this.manifest.mime);
      return;
    }
    const actual = await this.backend.streamSha256();
    const expected = this.manifest.fileSha256;
    if (actual.length !== expected.length || !actual.every((v, i) => v === expected[i])) {
      this.cb.onError?.("文件校验失败：SHA-256 与发送端不一致，请重试");
      return;
    }
    this.done = true;
    await this.cb.onComplete?.(this.manifest.name, this.manifest.mime);
  }

  private resetForNewTransfer(transferId: Uint8Array): void {
    this.manifest = null;
    this.manifestChunks.clear();
    this.decoders.clear();
    this.processingSegments.clear();
    this.completedSegments.clear();
    this.checkpoint = null;
    this.key = null;
    this.completed = 0;
    this.framesNew = 0;
    this.framesDup = 0;
    this.framesSeen = 0;
    this.currentTransferIdHex = hex(transferId);
  }

  /** 放弃当前传输（用户点击停止/重新开始）。 */
  reset(): void {
    this.resetForNewTransfer(new Uint8Array(16));
    this.done = false;
  }

  /** 清理临时文件（保存成功后）。 */
  async cleanup(): Promise<void> {
    await this.backend?.cleanupTemp();
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
