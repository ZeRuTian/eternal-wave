// 单页应用入口：发送面板 + 接收面板（一体，中文 UI）。
//
// 发送：文件 → ew-sender 分段/压缩/加密 → frameStream → QR 渲染（rAF 驱动）
// 接收：摄像头 → ZXing WASM 解码 → EwReceiver 重组 → 校验 → 保存
//
// 复用上游的 QR 渲染管线（qrcode + rasterizeQr + ImageData）、worker 池与
// 摄像头调度，但协议/分段/加密/续传全部走 ew-* 核心。

import QRCode from "qrcode";
import { fitQrDisplaySize } from "../shared/display";
import { rasterizeQr } from "../shared/qr-raster";
import { formatBytes } from "../shared/format";
// 解码 worker：通过 worker-factory 创建。standalone 构建时 useInlineVariants
// 插件会在 resolve 时换成 worker-factory.inline.ts（base64 blob URL，file:// 可用）。
import { createDecodeWorker } from "../receive/worker-factory";
import { DecodeWorkerPool } from "../shared/worker-pool";
import { probeCameraCapabilities, applyAdvancedConstraint, isIOS } from "../shared/platform";
import { requestScreenWakeLock, releaseScreenWakeLock } from "../shared/wake-lock";
import { statusLine } from "../shared/status-line";
import { formatDuration } from "../shared/progress";
import { ReceiveRate, scanRegion, positionHint, type ScanPosition, type ScanReport } from "../shared/scan-feedback";
import { parseFrame } from "../shared/ew-protocol";
import { EwReceiver } from "../shared/ew-receiver";
import {
  prepareTransfer,
  frameStream,
  type PreparedTransfer,
} from "../shared/ew-sender";
import { MAX_FILE_BYTES, MAX_FILE_LABEL } from "../shared/ew-protocol";
import {
  autoSaveAndCleanup,
  createAutoBackend,
  saveThenCleanup,
  type StorageBackend,
} from "../shared/ew-storage";

const MARGIN = 4;
const LOOKAHEAD = 3;

/** 统一的错误消息提取：Error 取 message，其余 String 化。 */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------- 面板切换 ----------------
const paneSend = document.getElementById("pane-send")!;
const paneReceive = document.getElementById("pane-receive")!;
const navSend = document.getElementById("nav-send")!;
const navReceive = document.getElementById("nav-receive")!;
let currentPane: "send" | "receive" | null = null;

function showPane(pane: "send" | "receive"): void {
  if (currentPane === pane) return;
  if (currentPane === "send") {
    generation++;
    releaseScreenWakeLock();
    setStageFullscreen(false);
  } else if (currentPane === "receive") {
    stopReceiveSession();
  }
  const send = pane === "send";
  paneSend.hidden = !send;
  paneReceive.hidden = send;
  navSend.classList.toggle("current", send);
  navReceive.classList.toggle("current", !send);
  navSend.setAttribute("aria-current", send ? "page" : "false");
  navReceive.setAttribute("aria-current", send ? "false" : "page");
  currentPane = pane;
  if (send && selectedFile?.prepared) void startStream(false);
  window.scrollTo(0, 0);
}
navSend.addEventListener("click", () => showPane("send"));
navReceive.addEventListener("click", () => showPane("receive"));

// ---------------- 发送端 ----------------
const canvas = document.getElementById("qr") as HTMLCanvasElement;
const stage = document.getElementById("stage") as HTMLDivElement;
const specs = document.getElementById("specs")!;
const cfgFile = document.getElementById("cfg-file") as HTMLInputElement;
const filePickerLabel = document.getElementById("file-picker-label")!;
const filePickerButton = document.getElementById("file-picker-button")!;
const paneFile = document.getElementById("pane-file")!;
const streamSpecs = document.getElementById("stream-specs")!;
const footerHint = document.getElementById("footer-hint")!;
const cfgPassphrase = document.getElementById("cfg-passphrase") as HTMLInputElement;
const togglePassphrase = document.getElementById("toggle-passphrase") as HTMLButtonElement;
const spec = (id: string) => document.getElementById(id)!;

let selectedFile: {
  file: File;
  prepared: PreparedTransfer | null;
} | null = null;
let generation = 0;
let resizeDisplay: (() => void) | null = null;

const { setStatus, showError } = statusLine(specs);

function showStreamPanels(visible: boolean): void {
  streamSpecs.hidden = !visible;
  footerHint.hidden = !visible;
}

function setStageFullscreen(on: boolean): void {
  if (on === document.body.classList.contains("qr-full")) return;
  document.body.classList.toggle("qr-full", on);
  resizeDisplay?.();
  // 进入全屏时滚到顶部让二维码居中占满；退出时保持当前位置即可。
  if (on) window.scrollTo(0, 0);
}
stage.addEventListener("click", () => setStageFullscreen(!document.body.classList.contains("qr-full")));
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setStageFullscreen(false);
});

function updateFilePicker(): void {
  const armed = selectedFile !== null;
  paneFile.classList.toggle("has-file", armed);
  filePickerButton.textContent = armed ? "停止传输" : "选择文件";
  filePickerLabel.textContent = armed && selectedFile
    ? `已选文件：${selectedFile.file.name}`
    : `任意文件 · 最大 ${MAX_FILE_LABEL}`;
}

function stopTransfer(): void {
  releaseScreenWakeLock();
  generation++;
  selectedFile = null;
  setStageFullscreen(false);
  stage.hidden = true;
  showStreamPanels(false);
  cfgFile.value = "";
  updateFilePicker();
  setStatus("选择文件开始");
}

paneFile.addEventListener("click", (event) => {
  if (!paneFile.classList.contains("has-file")) return;
  event.preventDefault();
  const target = event.target instanceof Element ? event.target : null;
  if (target && (target.closest(".file-picker-button") || target === cfgFile)) stopTransfer();
});

async function selectFile(): Promise<void> {
  const file = cfgFile.files?.[0];
  if (!file) return;
  const selectionGeneration = ++generation;
  selectedFile = null;
  stage.hidden = true;
  setStatus(`准备 ${file.name}…`);
  try {
    if (file.size === 0) throw new Error(`${file.name} 是空文件，没有可发送的内容。`);
    if (file.size > MAX_FILE_BYTES) {
      throw new Error(`${file.name} 为 ${formatBytes(file.size)}，超过 ${MAX_FILE_LABEL} 上限。`);
    }
    if (selectionGeneration !== generation) return;
    selectedFile = { file, prepared: null };
    updateFilePicker();
    await prepareSelectedFile(true);
  } catch (error) {
    showError(errMsg(error));
    updateFilePicker();
  }
}
cfgFile.addEventListener("change", () => void selectFile());

async function prepareSelectedFile(revealStage = false): Promise<void> {
  if (!selectedFile) return;
  const current = selectedFile;
  const gen = ++generation;
  current.prepared = null;
  stage.hidden = true;
  showStreamPanels(false);
  setStatus(`正在准备 ${current.file.name}…`);
  try {
    const passphrase = cfgPassphrase.value.trim();
    const mode = (document.getElementById("cfg-mode") as HTMLSelectElement).value;
    const prepared = await prepareTransfer({
      name: current.file.name,
      mime: current.file.type,
      bytes: current.file,
      frameBytes: Number((document.getElementById("cfg-bytes") as HTMLSelectElement).value),
      passphrase: passphrase || undefined,
      coverage: mode === "fast" ? 1.2 : 1.35,
      onPrepareProgress: (completed, total) => {
        if (gen !== generation) return;
        setStatus(`正在分析 ${current.file.name}… ${completed}/${total} 段`);
      },
    });
    if (gen !== generation || selectedFile !== current) return;
    current.prepared = prepared;
    await startStream(revealStage);
  } catch (error) {
    if (gen !== generation) return;
    showError(errMsg(error));
  }
}

async function startStream(revealStage = false): Promise<void> {
  const gen = ++generation;
  resizeDisplay = null;
  showStreamPanels(false);
  if (!selectedFile?.prepared) {
    releaseScreenWakeLock();
    setStatus("选择文件开始");
    return;
  }
  const { file, prepared } = selectedFile;
  const name = file.name;
  const fileSize = file.size;
  if (gen !== generation) return;
  const txFps = Number((document.getElementById("cfg-fps") as HTMLSelectElement).value);
  const frameBytes = prepared.blockLen + 48;
  void requestScreenWakeLock();
  const ecc = (document.getElementById("cfg-ecc") as HTMLSelectElement).value as "L" | "M" | "Q" | "H";

  const blockLen = prepared.blockLen;
  const stream = frameStream(prepared);

  // 清单帧通常很短，若用第一帧自动决定版本，后续完整数据帧会因容量不足而失败。
  // 先用最大帧长度探测固定 QR 版本，保证整个流（含清单）尺寸不跳变。
  const probe = (() => {
    try {
      return QRCode.create(
        [{ data: new Uint8Array(frameBytes), mode: "byte" } as unknown as QRCode.QRCodeSegment],
        { errorCorrectionLevel: ecc, maskPattern: 4 },
      );
    } catch {
      return null;
    }
  })();
  if (!probe) {
    stage.hidden = true;
    showStreamPanels(false);
    showError(`每帧 ${frameBytes} 字节无法使用纠错级别 ${ecc}；请降低每帧字节数或纠错级别。`);
    return;
  }
  const version = probe.version;
  const modules = probe.modules.size;
  let announced = false;
  let renderedFrameIndex = 0;
  let scale = 1;
  const staging = document.createElement("canvas");
  const queue: ImageData[] = [];
  stage.hidden = false;

  const sizeCanvas = () => {
    const displayPx = Number((document.getElementById("cfg-size") as HTMLInputElement).value);
    const dpr = window.devicePixelRatio || 1;
    const total = modules + 2 * MARGIN;
    let cssBudget: number;
    if (document.body.classList.contains("qr-full")) {
      cssBudget = Math.min(window.innerWidth, window.innerHeight);
    } else {
      const containerWidth = stage.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
      cssBudget = fitQrDisplaySize(window.innerWidth, window.innerHeight, containerWidth, displayPx);
    }
    scale = Math.max(1, Math.floor((cssBudget * dpr) / total));
    staging.width = total;
    staging.height = total;
    canvas.width = total * scale;
    canvas.height = total * scale;
    canvas.style.width = `${(total * scale) / dpr}px`;
    canvas.style.height = `${(total * scale) / dpr}px`;
  };
  sizeCanvas();
  resizeDisplay = sizeCanvas;

  const makeFrame = async (): Promise<ImageData> => {
    const next = await stream.next();
    if (next.done || !next.value) throw new Error("发送帧流意外结束");
    const bytes = next.value;
    // K=1 的小文件每个喷泉块内容相同，只有帧头 seq 在变化。固定 QR mask
    // 时肉眼几乎看不出动态，用户也难以判断手机 Safari 的 rAF 是否仍在运行。
    // 在两个合法 mask 间交替，不改协议字节。每个 mask 保持 4 帧，30 fps
    // 下约 7.5 Hz：肉眼能明确看见闪动，摄像头也有足够时间捕获完整图案。
    const maskPattern = Math.floor(renderedFrameIndex++ / 4) % 2 === 0 ? 4 : 6;
    const qr = QRCode.create([{ data: bytes, mode: "byte" } as unknown as QRCode.QRCodeSegment], {
      errorCorrectionLevel: ecc,
      version,
      maskPattern,
    });
    if (!announced) {
      announced = true;
      if (revealStage) {
        stage.scrollIntoView({ behavior: "auto", block: "start" });
      }
      spec("spec-fps").textContent = `${txFps} fps`;
      spec("spec-frame").textContent = `${frameBytes} 字节`;
      spec("spec-qr").textContent = `V${qr.version} · ECC ${ecc} · 动态掩码`;
      spec("spec-payload").textContent = `${name} · ${formatBytes(fileSize)}`;
      spec("spec-compression").textContent = prepared.manifest.allowGzip ? "按段自动（仅缩小时）" : "—";
      spec("spec-mode").textContent = prepared.coverage < 1.3 ? "高速（冗余 1.2）" : "稳健（冗余 1.35）";
      spec("spec-k").textContent = `段内 K = ${Math.ceil(prepared.manifest.segmentParams[0]!.encodedLen / blockLen)}`;
      spec("spec-segments").textContent = `${prepared.manifest.segmentCount} 段 · 每段 4 MiB`;
      showStreamPanels(true);
      setStatus(`正在发送 ${name} — ${prepared.manifest.encrypted ? "已加密 · " : ""}等待接收端扫描`);
    }
    const raster = rasterizeQr(qr.modules.size, qr.modules.data, MARGIN);
    return new ImageData(new Uint8ClampedArray(raster.pixels.buffer), raster.size, raster.size);
  };

  let generatorFailed = false;
  let pumping = false;
  const pump = async (max = LOOKAHEAD): Promise<void> => {
    if (pumping || generatorFailed || gen !== generation) return;
    pumping = true;
    try {
      for (let n = 0; n < max && queue.length < LOOKAHEAD; n++) {
        const image = await makeFrame();
        if (gen !== generation) return;
        queue.push(image);
      }
    } catch (err) {
      generatorFailed = true;
      showError(errMsg(err));
    } finally {
      pumping = false;
    }
  };
  void pump();

  const interval = 1000 / txFps;
  let nextAt = performance.now();
  const tick = (now: number) => {
    if (gen !== generation || generatorFailed) return;
    requestAnimationFrame(tick);
    if (now < nextAt) return;
    const img = queue.shift();
    void pump(1);
    if (!img) {
      nextAt = now + interval;
      return;
    }
    staging.getContext("2d")!.putImageData(img, 0, 0);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(staging, 0, 0, canvas.width, canvas.height);
    nextAt += interval;
    if (now - nextAt > 3 * interval) nextAt = now + interval;
  };
  requestAnimationFrame(tick);
}

for (const el of ["cfg-fps", "cfg-ecc"]) {
  document.getElementById(el)!.addEventListener("change", () => void startStream());
}
document.getElementById("cfg-size")!.addEventListener("input", () => resizeDisplay?.());
const preset = document.getElementById("cfg-preset") as HTMLSelectElement;
preset.addEventListener("change", () => {
  const profiles: Record<string, [string, string, string]> = {
    camera: ["30", "2331", "robust"], easy: ["24", "1465", "robust"], screen: ["60", "2953", "fast"],
  };
  const values = profiles[preset.value];
  if (!values) return;
  ["cfg-fps", "cfg-bytes", "cfg-mode"].forEach((id, i) => {
    (document.getElementById(id) as HTMLSelectElement).value = values[i]!;
  });
  (document.getElementById("cfg-ecc") as HTMLSelectElement).value = "L";
  if (selectedFile) void prepareSelectedFile();
});
for (const id of ["cfg-fps", "cfg-bytes", "cfg-mode", "cfg-ecc"]) {
  document.getElementById(id)!.addEventListener("change", () => { preset.value = "custom"; });
}
document.getElementById("cfg-bytes")!.addEventListener("change", () => void prepareSelectedFile());
document.getElementById("cfg-mode")!.addEventListener("change", () => {
  if (selectedFile) void prepareSelectedFile();
});
cfgPassphrase.addEventListener("change", () => {
  if (selectedFile) void prepareSelectedFile();
});
togglePassphrase.addEventListener("click", () => {
  const reveal = cfgPassphrase.type === "password";
  cfgPassphrase.type = reveal ? "text" : "password";
  togglePassphrase.textContent = reveal ? "隐藏" : "显示";
  togglePassphrase.setAttribute("aria-pressed", String(reveal));
});

// ---------------- 接收端 ----------------
const startBtn = document.getElementById("start") as HTMLButtonElement;
const pickDirBtn = document.getElementById("pick-dir") as HTMLButtonElement;
const dirLabel = document.getElementById("dir-label")!;
const preview = document.getElementById("preview") as HTMLDivElement;
const video = document.getElementById("video") as HTMLVideoElement;
const result = document.getElementById("result") as HTMLDivElement;
const progressStatus = document.getElementById("progress-status") as HTMLDivElement;
const progressEl = document.getElementById("progress") as HTMLDivElement;
const progressLabel = document.getElementById("progress-label") as HTMLElement;
const etaLabel = document.getElementById("eta-label") as HTMLElement;
const bar = document.getElementById("bar") as HTMLDivElement;
const segmentGrid = document.getElementById("segment-grid") as HTMLDivElement;
const diagnosticsEl = document.getElementById("diagnostics") as HTMLDetailsElement;
const metricsEl = document.getElementById("metrics") as HTMLDivElement;
const cfgCamera = document.getElementById("cfg-camera") as HTMLSelectElement;
const cfgWidth = document.getElementById("cfg-width") as HTMLSelectElement;
const cfgCapFps = document.getElementById("cfg-capfps") as HTMLSelectElement;
const cfgWorkers = document.getElementById("cfg-workers") as HTMLSelectElement;
const cameraActual = document.getElementById("camera-actual")!;
const noSignalToast = document.getElementById("no-signal")!;
const noSignalDialog = document.getElementById("no-signal-dialog") as HTMLDialogElement;
const noSignalTips = document.getElementById("no-signal-tips")!;
const scanFeedback = document.getElementById("scan-feedback")!;
const receiveSetup = document.querySelector<HTMLElement>(".receive-setup")!;
const scanHint = document.getElementById("scan-hint")!;
const liveRate = document.getElementById("live-rate")!;
const liveEta = document.getElementById("live-eta")!;
const pauseBtn = document.getElementById("pause-receive") as HTMLButtonElement;
const scanOverlay = document.getElementById("scan-overlay")!;
const scanOutline = document.getElementById("scan-outline")!;
const scanGuide = document.getElementById("scan-guide")!;
const receiveRate = new ReceiveRate();
let paused = false;
let pausedAt = 0;
let pausedByVisibility = false;
let lastSignalAt = -Infinity;
let lastPositionAt = -Infinity;
let lastPosition: ScanPosition | null = null;
let lastReportId = -1;
let decodeMs = 0;
let busyDrops = 0;
let fallbackAt = 0;

let backend: StorageBackend | null = null;
let receiver: EwReceiver | null = null;
let stream: MediaStream | null = null;
let captureGen = 0;
let statsTimer: ReturnType<typeof setInterval> | undefined;
let settingsWired = false;
let done = false;
let receiveSessionId = 0;
const captureTimes: number[] = [];
const decodeTimes: number[] = [];
let pool: DecodeWorkerPool;

const recvStatus = statusLine(document.getElementById("stats")!);

// 加密口令使用页内对话框；避免 window.prompt 在 PWA/企业浏览器中被拦截，
// 也让错误口令可以在同一已解码分段上原地重试。
const receivePassphraseDialog = document.getElementById("receive-passphrase-dialog") as HTMLDialogElement;
const receivePassphraseForm = document.getElementById("receive-passphrase-form") as HTMLFormElement;
const receivePassphraseInput = document.getElementById("receive-passphrase") as HTMLInputElement;
const receivePassphraseCopy = document.getElementById("receive-passphrase-copy")!;
const receivePassphraseError = document.getElementById("receive-passphrase-error")!;
let resolvePassphrase: ((value: string | null) => void) | null = null;

function settlePassphrase(value: string | null): void {
  const resolve = resolvePassphrase;
  resolvePassphrase = null;
  receivePassphraseInput.value = "";
  if (receivePassphraseDialog.open) receivePassphraseDialog.close();
  resolve?.(value);
}

function requestReceivePassphrase(name: string, reason?: string): Promise<string | null> {
  if (resolvePassphrase) settlePassphrase(null);
  receivePassphraseCopy.textContent = `“${name}” 已加密，请输入发送端设置的口令。`;
  receivePassphraseError.hidden = !reason;
  receivePassphraseError.textContent = reason ?? "";
  receivePassphraseDialog.showModal();
  queueMicrotask(() => receivePassphraseInput.focus());
  return new Promise((resolve) => {
    resolvePassphrase = resolve;
  });
}

receivePassphraseForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = receivePassphraseInput.value;
  if (!value) return;
  settlePassphrase(value);
});
document.getElementById("receive-passphrase-cancel")!.addEventListener("click", () => settlePassphrase(null));
receivePassphraseDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  settlePassphrase(null);
});

// 无信号提示
const NO_SIGNAL_FIRST_MS = 5000;
let noSignalTimer: ReturnType<typeof setTimeout> | undefined;
function noSignalStart() {
  clearTimeout(noSignalTimer);
  noSignalTimer = setTimeout(() => {
    noSignalToast.hidden = false;
  }, NO_SIGNAL_FIRST_MS);
}
function noSignalDismiss() {
  clearTimeout(noSignalTimer);
  noSignalToast.hidden = true;
}
document.getElementById("no-signal-help")!.addEventListener("click", () => noSignalDialog.showModal());
document.getElementById("no-signal-dismiss")!.addEventListener("click", noSignalDismiss);
document.getElementById("no-signal-close")!.addEventListener("click", () => noSignalDialog.close());
noSignalDialog.addEventListener("close", noSignalDismiss);
for (const line of [
  "在发送端把「每帧字节数」降到 1465，帧率降到 24。",
  "让二维码充满画面（点击二维码可全屏），手机尽量固定——手抖导致对焦反复是常见原因。",
  "把发送端屏幕亮度调到最高。",
  "同机互传请选择「屏幕捕获」，在弹出的窗口列表里选中发送端窗口。",
]) {
  const item = document.createElement("li");
  item.textContent = line;
  noSignalTips.append(item);
}

async function pickDirectory(): Promise<void> {
  try {
    if (!backend) backend = createAutoBackend();
    updateStorageButton();
    await backend.selectAndOpen();
    dirLabel.textContent = backend.label;
    dirLabel.classList.add("ready");
  } catch (err) {
    dirLabel.textContent = errMsg(err);
    dirLabel.classList.remove("ready");
  }
}
pickDirBtn.addEventListener("click", () => void pickDirectory());

function updateStorageButton(): void {
  pickDirBtn.textContent = backend?.kind === "opfs" ? "准备本机存储" : "选择保存目录";
}

// 输入源：摄像头 / 屏幕捕获（同机互传）
function currentSource(): "camera" | "screen" {
  const checked = document.querySelector<HTMLInputElement>('input[name="recv-source"]:checked');
  return checked?.value === "screen" ? "screen" : "camera";
}

// 解码线程：按硬件核数生成选项（min(核数-1, 5)，至少 1），默认取推荐值；
// 屏幕捕获场景帧率更高，默认多给 1 个线程。
const HARDWARE_CONCURRENCY = navigator.hardwareConcurrency || 4;
const MAX_WORKERS = Math.max(1, Math.min(HARDWARE_CONCURRENCY - 1, 5));
function populateWorkerChoices(): void {
  cfgWorkers.textContent = "";
  const recommend = currentSource() === "screen" ? Math.min(MAX_WORKERS + 1, 5) : Math.min(MAX_WORKERS, 2);
  for (let i = 1; i <= Math.max(MAX_WORKERS, recommend); i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `${i}${i === recommend ? "（推荐）" : ""}`;
    if (i === recommend) opt.selected = true;
    cfgWorkers.append(opt);
  }
}
populateWorkerChoices();

function updateStartButton(): void {
  startBtn.textContent = currentSource() === "screen" ? "开始屏幕接收" : "开始接收";
}
// 屏幕捕获提示：发送端与接收端在不同窗口/不同机器，无法跨实例自动改
// 发送端设置，因此在接收端给出操作提示（用户到发送端窗口手动调整）。
const SCREEN_RECOMMEND_BYTES = "2953";
function applyScreenRecommendations(): void {
  if (currentSource() !== "screen") return;
  recvStatus.setStatus(
    `屏幕捕获已就绪。提速要点：① 发送端「每帧字节数」调到 ${SCREEN_RECOMMEND_BYTES}（+27%）；② 发送端「帧率」与接收端采集一致（采集帧率见上方状态）。`,
  );
}

for (const input of document.querySelectorAll<HTMLInputElement>('input[name="recv-source"]')) {
  input.addEventListener("change", () => {
    updateStartButton();
    populateWorkerChoices();
    applyScreenRecommendations();
    if (!stream) return;
    // 切换输入源时一并释放旧流、解码 worker 与计时器，等待用户重新启动。
    stopReceiveSession();
    recvStatus.setStatus("输入源已切换，请重新开始接收。");
  });
}

function offerRetry(message: string): void {
  stopReceiveSession();
  startBtn.disabled = false;
  startBtn.style.display = "";
  updateStartButton();
  pickDirBtn.disabled = false;
  preview.style.display = "none";
  metricsEl.style.display = "none";
  if (diagnosticsEl) diagnosticsEl.style.display = "none";
  recvStatus.showError(message);
}

async function start() {
  if (startBtn.disabled) return;
  const sessionId = ++receiveSessionId;
  const source = currentSource();
  if (source === "screen" && !navigator.mediaDevices?.getDisplayMedia) {
    recvStatus.showError("当前浏览器不支持屏幕捕获（需要 Chrome/Edge 109+）。");
    return;
  }
  if (source === "camera" && !navigator.mediaDevices?.getUserMedia) {
    recvStatus.showError("摄像头需要安全上下文：本页必须通过 https 或 file:// 使用摄像头。");
    return;
  }
  startBtn.disabled = true;
  paused = false;
  pausedByVisibility = false;
  receiveRate.reset();
  captureTimes.length = 0;
  decodeTimes.length = 0;
  busyDrops = 0;
  decodeMs = 0;
  lastPosition = null;
  lastSignalAt = lastPositionAt = -Infinity;
  lastReportId = -1;
  startBtn.textContent = "准备接收…";
  result.textContent = "";
  segmentGrid.hidden = true;
  progressStatus.style.display = "none";
  bar.style.width = "0%";
  progressEl.setAttribute("aria-valuenow", "0");
  if (!backend) {
    try {
      backend = createAutoBackend();
      updateStorageButton();
    } catch (err) {
      offerRetry(errMsg(err));
      return;
    }
  }
  // 桌面目录选择必须发生在用户点击事件的激活窗口内；如果用户已提前选择，
  // StorageBackend 的幂等实现会直接返回，不会重复弹窗。
  try {
    await backend.selectAndOpen();
    if (sessionId !== receiveSessionId || currentPane !== "receive") return;
    dirLabel.textContent = backend.label;
    dirLabel.classList.add("ready");
  } catch (err) {
    offerRetry(errMsg(err));
    return;
  }
  const captureWidth = Number(cfgWidth.value);
  const captureFps = Number(cfgCapFps.value);
  startBtn.textContent = "启动中…";
  pickDirBtn.disabled = true;
  let acquiredStream: MediaStream;
  try {
    if (source === "screen") {
      // 屏幕捕获（同机互传）：浏览器弹出源选择，选发送端窗口/屏幕即可。
      // 与摄像头共用同一解码管线；无对焦/摩尔纹问题，吞吐通常更高。
      acquiredStream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        // 不人为限制帧率上限：请求用户设定值（ideal），系统支持则按
        // 60fps 采集（屏幕捕获在多数桌面环境可达 60），不支持时浏览器
        // 会自动降到实际值并在状态行显示。
        video: { frameRate: { ideal: captureFps } },
      });
    } else {
      const base: MediaTrackConstraints = {
        ...(cfgCamera.value
          ? { deviceId: { exact: cfgCamera.value } }
          : { facingMode: "environment" as const }),
        width: { ideal: captureWidth },
        height: { ideal: Math.round((captureWidth * 3) / 4) },
      };
      try {
        acquiredStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { ...base, frameRate: { exact: captureFps } },
        });
      } catch {
        acquiredStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { ...base, frameRate: { ideal: captureFps } },
        });
      }
    }
  } catch (err) {
    const denied =
      err instanceof DOMException &&
      (err.name === "NotAllowedError" || err.name === "AbortError" || err.name === "PermissionDeniedError");
    offerRetry(
      denied
        ? source === "screen"
          ? "屏幕捕获被取消或拒绝——请重新选择发送端窗口。"
          : "摄像头权限被拒绝——请允许后重新启动。"
        : `${source === "screen" ? "屏幕捕获" : "摄像头"}错误：${errMsg(err)}`,
    );
    return;
  }

  // 目录/媒体权限弹窗期间用户可能已经切换面板或重启会话；此时立即释放
  // 刚拿到的媒体流，不能让旧的异步启动流程在后台复活。
  if (sessionId !== receiveSessionId || currentPane !== "receive") {
    acquiredStream.getTracks().forEach((track) => track.stop());
    return;
  }
  stream = acquiredStream;
  if (source === "screen") {
    // 用户在浏览器共享指示条上点“停止”时结束接收会话。
    acquiredStream.getVideoTracks()[0]?.addEventListener("ended", () => {
      if (stream === acquiredStream) {
        stream = null;
        offerRetry("屏幕共享已停止。");
      }
    });
  }

  startBtn.style.display = "none";
  preview.style.display = "";
  metricsEl.style.display = "grid";
  if (diagnosticsEl) diagnosticsEl.style.display = "block";
  video.srcObject = stream;
  await video.play().catch(() => undefined);
  if (sessionId !== receiveSessionId) return;
  scanFeedback.hidden = false;
  receiveSetup.hidden = true;
  pauseBtn.textContent = "暂停接收";
  pauseBtn.disabled = false;
  if (source === "camera") await populateCameraChoices();
  const settings = stream.getVideoTracks()[0]?.getSettings();
  recvStatus.setStatus(
    source === "screen"
      ? `屏幕捕获 ${settings?.width}×${settings?.height}@${settings?.frameRate} — 正在寻找信号…`
      : `摄像头 ${settings?.width}×${settings?.height}@${settings?.frameRate} — 正在寻找信号…`,
  );

  // 接收核心：优先使用已选目录的后端，否则自动创建
  if (!backend) backend = createAutoBackend();
  done = false;
  receiver = new EwReceiver({
    onManifest: async (m) => {
      receiveRate.reset();
      recvStatus.setStatus(`收到清单：${m.name} · ${formatBytes(m.fileLen)}${m.encrypted ? " · 加密" : ""}`);
      buildSegmentGrid(m.segmentCount);
      progressStatus.style.display = "";
      progressLabel.textContent = `0% · 分段 ${receiver?.completed ?? 0}/${m.segmentCount}`;
      etaLabel.textContent = "估算剩余时间…";
      for (const index of receiver?.completedIndexes ?? []) updateSegmentGrid(index, m.segmentCount);
    },
    onSegmentComplete: (index, total) => {
      updateSegmentGrid(index, total);
      refreshProgress();
    },
    onStats: () => {
      // 统计由定时器驱动，避免每帧更新 DOM
    },
    onComplete: async (name, mime) => {
      done = true;
      stopReceiveSession(true);
      progressStatus.style.display = "";
      bar.style.width = "100%";
      progressEl.setAttribute("aria-valuenow", "100");
      preview.style.display = "none";
      if (!backend) {
        progressStatus.style.display = "none";
        showResult(`${name} 已通过校验，但存储后端不可用，临时文件未清理。`, false);
        return;
      }

      const activeBackend = backend;
      if (isIOS && activeBackend.kind === "opfs") {
        progressLabel.textContent = "100% · 正在准备系统保存";
        etaLabel.textContent = "文件已校验，临时文件仍安全保留…";
        await offerIOSFileExport(activeBackend, name, mime);
        progressStatus.style.display = "none";
        return;
      }

      progressLabel.textContent = "100% · 正在自动保存";
      etaLabel.textContent = "保存后将自动清理临时文件…";
      const outcome = await autoSaveAndCleanup(activeBackend, name, mime);
      progressStatus.style.display = "none";
      if (outcome.ok) {
        const where = activeBackend.kind === "opfs" ? "已自动触发下载" : "已自动保存到所选目录";
        showResult(`传输完成！${name} 已通过校验，${where}，临时文件已自动清理。`, true);
        // 收尾完成后直接恢复为可开始下一次接收的状态，不再等待保存/清理按钮。
        stopReceiveSession();
        return;
      }
      if (outcome.stage === "save") {
        showResult(
          `${name} 已通过校验，但自动保存失败：${errMsg(outcome.error)}。临时文件已保留，避免数据丢失。`,
          false,
        );
      } else {
        showResult(
          `${name} 已保存，但临时文件自动清理失败：${errMsg(outcome.error)}。`,
          false,
        );
      }
    },
    onError: (message) => {
      recvStatus.showError(message);
    },
    requestPassphrase: requestReceivePassphrase,
  });
  try {
    await receiver.attachBackend(backend);
  } catch (err) {
    offerRetry(errMsg(err));
    return;
  }

  pool = decodePool();
  pool.resize(Number(cfgWorkers.value));

  reportCameraSettings();
  void applyCameraExtras();
  if (!settingsWired) {
    settingsWired = true;
    for (const el of [cfgWidth, cfgCapFps, cfgWorkers]) {
      el.addEventListener("change", () => void applyReceiveSettings());
    }
    // 摄像头选择仅在摄像头模式下有意义
    cfgCamera.addEventListener("change", () => {
      if (currentSource() === "screen") return;
      void restartCamera();
    });
  }
  noSignalStart();
  captureGen++;
  scheduleFrame(captureGen);
  statsTimer = setInterval(refreshProgress, 500);
  startTsRef.current = performance.now();
  await requestScreenWakeLock();
}

/** 统一释放摄像头/屏幕捕获、worker 和计时器；keepDone 用于完成后的保存阶段。 */
function stopReceiveSession(keepDone = false): void {
  releaseScreenWakeLock();
  receiveSessionId++;
  captureGen++;
  if (resolvePassphrase) settlePassphrase(null);
  noSignalDismiss();
  clearInterval(statsTimer);
  statsTimer = undefined;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  pool?.resize(0);
  preview.style.display = "none";
  scanFeedback.hidden = true;
  receiveSetup.hidden = false;
  paused = false;
  pausedByVisibility = false;
  if (!keepDone) {
    done = false;
    receiver = null;
    startBtn.style.display = "";
    startBtn.disabled = false;
    pickDirBtn.disabled = false;
    updateStartButton();
  }
}

// 解码 worker：由 receive/worker-factory 提供（见文件顶部注释）
function decodePool(): DecodeWorkerPool {
  return new DecodeWorkerPool(createDecodeWorker, (bytes) => {
    decodeTimes.push(performance.now());
    if (done || paused || !receiver) return;
    if (!parseFrame(bytes)) return;
    lastSignalAt = performance.now();
    noSignalDismiss();
    const before = receiver.usefulBytes;
    receiver.handleFrame(bytes);
    receiveRate.add(performance.now(), receiver.usefulBytes - before);
  }, handleScanReport);
}

function handleScanReport(report: ScanReport): void {
  if (done || paused || report.id <= lastReportId) return;
  lastReportId = report.id;
  decodeMs = report.elapsedMs ?? 0;
  if (!report.position) return;
  const points = Object.values(report.position);
  if (points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return;
  const region = report.region ?? { x: 0, y: 0 };
  lastPosition = Object.fromEntries(Object.entries(report.position).map(([key, p]) =>
    [key, { x: p.x + region.x, y: p.y + region.y }])) as unknown as ScanPosition;
  lastPositionAt = performance.now();
}

function pauseReceiving(): void {
  if (!stream || done || paused) return;
  paused = true;
  pausedAt = performance.now();
  captureGen++;
  releaseScreenWakeLock();
  stream.getVideoTracks().forEach(t => { t.enabled = false; });
  pool?.resize(0);
  noSignalDismiss();
  pauseBtn.textContent = "继续接收";
  scanHint.textContent = "已暂停，当前页面的接收进度已保留";
  liveEta.textContent = "暂停期间不估算剩余时间";
  liveRate.textContent = "已暂停";
}

async function resumeReceiving(): Promise<void> {
  if (!paused || !stream || done || pauseBtn.disabled) return;
  pauseBtn.disabled = true;
  const session = receiveSessionId;
  try {
    if (stream.getVideoTracks().some(t => t.readyState === "ended")) {
      if (currentSource() === "screen") throw new Error("屏幕共享已结束，请重新开始屏幕接收");
      const recovered = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
        ...(cfgCamera.value ? { deviceId: { exact: cfgCamera.value } } : { facingMode: "environment" }),
        width: { ideal: Number(cfgWidth.value) }, frameRate: { ideal: Number(cfgCapFps.value) },
      } });
      if (session !== receiveSessionId) { recovered.getTracks().forEach(t => t.stop()); return; }
      stream = recovered;
      video.srcObject = stream;
    }
    stream.getVideoTracks().forEach(t => { t.enabled = true; });
    await video.play();
    if (session !== receiveSessionId) return;
    startTsRef.current += performance.now() - pausedAt;
    paused = false;
    receiveRate.reset();
    captureTimes.length = decodeTimes.length = 0;
    lastPosition = null;
    lastSignalAt = -Infinity;
    pool.resize(Number(cfgWorkers.value));
    pauseBtn.textContent = "暂停接收";
    scheduleFrame(++captureGen);
    await requestScreenWakeLock();
  } catch (error) {
    scanHint.textContent = `恢复摄像头失败：${errMsg(error)}。进度已保留，请点击继续重试。`;
  } finally {
    if (session === receiveSessionId) pauseBtn.disabled = false;
  }
}
pauseBtn.addEventListener("click", () => {
  pausedByVisibility = false;
  if (paused) void resumeReceiving(); else pauseReceiving();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && stream && !paused && !done) {
    pausedByVisibility = true;
    pauseReceiving();
  } else if (!document.hidden && pausedByVisibility) {
    pausedByVisibility = false;
    void resumeReceiving();
  }
});

function reportCameraSettings(): void {
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  const s = track.getSettings();
  const askedFps = Number(cfgCapFps.value);
  const gotFps = Math.round(s.frameRate ?? 0);
  const fpsNote = gotFps && gotFps !== askedFps ? `（请求 ${askedFps}，实际 ${gotFps}）` : "";
  const label = currentSource() === "screen" ? "屏幕捕获" : "摄像头";
  cameraActual.textContent =
    `${label} ${s.width}×${s.height} @ ${gotFps} fps${fpsNote} · ${pool?.size ?? 0} 个解码线程 · 修改即时生效`;
}

async function populateCameraChoices(): Promise<void> {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const requested = cfgCamera.value;
  const cameras = (await navigator.mediaDevices.enumerateDevices()).filter(
    (device) => device.kind === "videoinput",
  );
  cfgCamera.textContent = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "自动选择";
  cfgCamera.append(auto);
  cameras.forEach((camera, index) => {
    const option = document.createElement("option");
    option.value = camera.deviceId;
    option.textContent = camera.label || `摄像头 ${index + 1}`;
    cfgCamera.append(option);
  });
  if (requested && cameras.some((camera) => camera.deviceId === requested)) {
    cfgCamera.value = requested;
  }
}

async function restartCamera(): Promise<void> {
  if (!stream || done) return;
  stopReceiveSession();
  recvStatus.setStatus("正在切换摄像头…");
  await start();
}

async function applyCameraExtras(): Promise<void> {
  // 屏幕捕获源没有对焦/闪光灯概念，getCapabilities 可能返回空——跳过
  if (currentSource() !== "camera") return;
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  const caps = probeCameraCapabilities(track);
  if (caps.continuousFocus) {
    await applyAdvancedConstraint(track, { focusMode: "continuous" });
  }
  if (caps.maxFrameRate) {
    for (const option of Array.from(cfgCapFps.options)) {
      option.disabled = Number(option.value) > caps.maxFrameRate;
    }
  }
}

async function applyReceiveSettings(): Promise<void> {
  if (done || paused) return;
  pool?.resize(Number(cfgWorkers.value));
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  // 屏幕捕获的分辨率/帧率由系统共享配置决定，不做实时调整
  if (currentSource() === "screen") {
    reportCameraSettings();
    return;
  }
  const width = Number(cfgWidth.value);
  try {
    await track.applyConstraints({
      width: { ideal: width },
      height: { ideal: Math.round((width * 3) / 4) },
      frameRate: { ideal: Number(cfgCapFps.value) },
    });
  } catch {
    cameraActual.textContent = "摄像头拒绝实时调整——重启后生效";
    return;
  }
  reportCameraSettings();
}

type VideoRVFC = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };

function scheduleFrame(gen: number): void {
  if (done || paused || gen !== captureGen) return;
  const v = video as VideoRVFC;
  const next = () => {
    if (done || paused || gen !== captureGen) return;
    captureFrame();
    scheduleFrame(gen);
  };
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(next);
  else requestAnimationFrame(next);
}

const grab = document.createElement("canvas");
let frameId = 0;

function captureFrame(): void {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  const now = performance.now();
  captureTimes.push(now);
  if (pool.busyCount === pool.size) { busyDrops++; return; }
  // Refresh the full-frame search regularly and immediately after a lost lock.
  const useRegion = lastPosition && now - lastPositionAt < 1000 && now - fallbackAt < 1500;
  const region = useRegion ? scanRegion(lastPosition!, vw, vh) : { x: 0, y: 0, w: vw, h: vh };
  if (!useRegion) fallbackAt = now;
  if (region.w <= 0 || region.h <= 0) { lastPosition = null; return; }
  if (grab.width !== region.w || grab.height !== region.h) {
    grab.width = region.w;
    grab.height = region.h;
  }
  const ctx = grab.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(video, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
  const img = ctx.getImageData(0, 0, region.w, region.h);
  pool.submit({ id: frameId++, buf: img.data.buffer, w: region.w, h: region.h, region,
    fast: !!useRegion && now - lastSignalAt < 1000 }, [img.data.buffer]);
}

function buildSegmentGrid(count: number): void {
  segmentGrid.hidden = false;
  segmentGrid.textContent = "";
  for (let i = 0; i < count; i++) {
    const cell = document.createElement("span");
    cell.className = "ew-seg";
    cell.title = `分段 ${i + 1}`;
    segmentGrid.append(cell);
  }
}
function updateSegmentGrid(index: number, total: number): void {
  const cells = segmentGrid.children;
  if (index < cells.length) cells[index]!.classList.add("done");
  void total;
}

function showResult(message: string, ok: boolean): void {
  result.textContent = "";
  const p = document.createElement("p");
  p.className = ok ? "hint" : "error-text";
  p.textContent = message;
  result.append(p);
}

type FileShareData = { files: File[]; title?: string; text?: string };
type FileShareNavigator = Navigator & {
  canShare?: (data: FileShareData) => boolean;
  share?: (data: FileShareData) => Promise<void>;
};

function isShareCancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * iOS 安全导出：WebKit 不允许在异步接收回调中可靠地自动下载 Blob。
 * 先把 OPFS 数据准备为 File，再由一次真实点击同步调用 navigator.share；
 * 分享成功后才清理，取消或失败均保留可恢复的完整临时文件。
 */
async function offerIOSFileExport(activeBackend: StorageBackend, name: string, mime: string): Promise<void> {
  let finalFile: File;
  try {
    finalFile = await activeBackend.prepareFinalFile(name, mime);
  } catch (error) {
    showResult(`${name} 已通过校验，但准备系统保存失败：${errMsg(error)}。临时文件已保留。`, false);
    return;
  }

  const shareNavigator = navigator as FileShareNavigator;
  const shareData: FileShareData = { files: [finalFile], title: name };
  let canShare = typeof shareNavigator.share === "function";
  if (canShare && typeof shareNavigator.canShare === "function") {
    try {
      canShare = shareNavigator.canShare(shareData);
    } catch {
      canShare = false;
    }
  }
  if (!canShare) {
    showResult(
      `${name} 已通过校验，但当前 iOS 版本不支持文件系统分享。请升级 iOS 后重新打开本应用，临时文件已保留。`,
      false,
    );
    return;
  }

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "receive-start mobile-save-button";

  const renderPrompt = (message: string, ok: boolean): void => {
    showResult(message, ok);
    saveButton.disabled = false;
    saveButton.textContent = "存储到“文件”…";
    result.append(saveButton);
  };

  renderPrompt(
    `${name} 已接收并通过校验。点击下方按钮，然后在系统面板中选择“存储到‘文件’”；保存成功后临时分片会自动清理。`,
    true,
  );

  saveButton.addEventListener("click", async () => {
    saveButton.disabled = true;
    saveButton.textContent = "正在打开系统面板…";
    const outcome = await saveThenCleanup(activeBackend, () => shareNavigator.share!(shareData));
    if (outcome.ok) {
      showResult(`${name} 已完成系统导出，临时文件已自动清理。`, true);
      stopReceiveSession();
      return;
    }
    if (outcome.stage === "cleanup") {
      showResult(`${name} 已完成系统导出，但临时文件自动清理失败：${errMsg(outcome.error)}。`, false);
      stopReceiveSession();
      return;
    }
    renderPrompt(
      isShareCancelled(outcome.error)
        ? `已取消系统保存，${name} 的临时文件仍完整保留，可再次尝试。`
        : `系统保存失败：${errMsg(outcome.error)}。临时文件仍完整保留，可再次尝试。`,
      false,
    );
  });
}

/** 丢弃早于窗口的时间戳并原地裁剪数组，返回窗口内数量。
 *  captureTimes/decodeTimes 每帧 push，若只过滤不裁剪，长传输（数十万帧）
 *  会让这两个数组无限增长——这里在每次刷新时就地压缩，保持 O(窗口帧数)。 */
function trimWindow(times: number[], now: number, windowMs: number): number {
  let keep = 0;
  for (let i = 0; i < times.length; i++) {
    if (now - times[i]! < windowMs) times[keep++] = times[i]!;
  }
  times.length = keep;
  return keep;
}

function refreshProgress(): void {
  const now = performance.now();
  if (paused) return;
  const capFps = trimWindow(captureTimes, now, 2000) / 2;
  const decFps = trimWindow(decodeTimes, now, 2000) / 2;
  document.getElementById("m-cap")!.textContent = capFps.toFixed(1);
  document.getElementById("m-dec")!.textContent = decFps.toFixed(1);
  document.getElementById("m-decode-ms")!.textContent = `${decodeMs.toFixed(0)} ms`;
  document.getElementById("m-busy")!.textContent = String(busyDrops);
  const r = receiver;
  if (!r) {
    document.getElementById("m-frames")!.textContent = "—";
    document.getElementById("m-segments")!.textContent = "—";
    document.getElementById("m-rate")!.textContent = "—";
    document.getElementById("m-time")!.textContent = "—";
    return;
  }
  document.getElementById("m-frames")!.textContent =
    `${r.framesNew}/${r.framesDup}`;
  document.getElementById("m-segments")!.textContent =
    r.manifestInfo ? `${r.completed}/${r.manifestInfo.segmentCount}` : "—";
  const elapsed = (now - (startTsRef.current || now)) / 1000;
  document.getElementById("m-time")!.textContent = elapsed > 0 ? `${elapsed.toFixed(1)} s` : "—";

  const info = r.progressInfo;
  const rate = receiveRate.read(now);
  const signalLost = now - lastSignalAt >= 3000;
  const located = lastPosition && now - lastPositionAt < 1500;
  scanOverlay.setAttribute("viewBox", `0 0 ${video.videoWidth || 4} ${video.videoHeight || 3}`);
  if (video.videoWidth && video.videoHeight) {
    const box = video.parentElement!;
    box.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    box.style.maxHeight = "none";
  }
  scanGuide.style.display = located ? "none" : "";
  scanOutline.setAttribute("points", located ? Object.values(lastPosition!).map(p => `${p.x},${p.y}`).join(" ") : "");
  const geometryHint = located ? positionHint(lastPosition!, video.videoWidth, video.videoHeight) : "";
  if (geometryHint.includes("偏小") || geometryHint.includes("边缘")) {
    scanHint.textContent = geometryHint;
  } else if (!r.hasManifest && !signalLost) {
    scanHint.textContent = "已找到传输二维码，正在等待文件信息，请保持对准";
  } else if (located && signalLost) {
    scanHint.textContent = positionHint(lastPosition!, video.videoWidth, video.videoHeight) + "；若一直无法读取，请检查对焦或使用大码低速预设";
  } else if (signalLost) {
    scanHint.textContent = r.hasManifest ? "信号中断，请将完整二维码和白边重新放入框内；已收分段保留"
      : "将整个二维码和白边放入框内，保持清晰；看不清时放大发送端二维码";
  } else if (rate.stalled) {
    scanHint.textContent = "二维码信号正常，正在等待未收齐分段的补帧";
  } else {
    scanHint.textContent = "正在接收 · " + (located ? positionHint(lastPosition!, video.videoWidth, video.videoHeight) : "二维码信号正常");
  }
  const rateText = rate.bytesPerSecond > 0 ? `${(rate.bytesPerSecond / 1024).toFixed(1)} KiB/s · 有效新数据` : "暂无新增数据";
  document.getElementById("m-rate")!.textContent = rateText;
  liveRate.textContent = rateText;
  let eta = !r.hasManifest ? "等待文件信息" : signalLost ? "信号中断，暂不估时" : rate.stalled ? "等待补帧，暂不估时" : "正在测量速度…";
  if (r.hasManifest && !signalLost && !rate.stalled && rate.bytesPerSecond > 0) {
    const seconds = r.remainingEncodedBytes / rate.bytesPerSecond;
    eta = `剩余约 ${formatDuration(seconds)}–${formatDuration(seconds * 1.5)}（不含补帧轮转等待）`;
  }
  liveEta.textContent = eta;
  etaLabel.textContent = eta;
  if (info && info.total > 0) {
    const pct = Math.round(info.fraction * 100);
    bar.style.width = `${pct}%`;
    progressEl.setAttribute("aria-valuenow", String(pct));
    progressLabel.textContent = `${pct}% · 分段 ${info.completed}/${info.total}`;
    progressStatus.style.display = "";
  }
}

const startTsRef = { current: 0 };

// 初始按钮文案跟随默认输入源（摄像头）
updateStartButton();

startBtn.addEventListener("click", () => void start());

// ---------------- 收尾 ----------------
// 所有状态变量与清理函数均已初始化后再决定首屏，避免初始化阶段访问暂时性死区。
showPane(location.hash === "#receive" ? "receive" : "send");
if (import.meta.hot) import.meta.hot.accept();
