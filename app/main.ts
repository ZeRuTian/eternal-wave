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
import { probeCameraCapabilities, applyAdvancedConstraint } from "../shared/platform";
import { requestScreenWakeLock } from "../shared/wake-lock";
import { statusLine } from "../shared/status-line";
import { formatDuration } from "../shared/progress";
import { EwReceiver } from "../shared/ew-receiver";
import {
  prepareTransfer,
  frameStream,
  type PreparedTransfer,
} from "../shared/ew-sender";
import { MAX_FILE_BYTES, MAX_FILE_LABEL } from "../shared/ew-protocol";
import { createAutoBackend, type StorageBackend } from "../shared/ew-storage";

const MARGIN = 4;
const LOOKAHEAD = 3;

// ---------------- 面板切换 ----------------
const paneSend = document.getElementById("pane-send")!;
const paneReceive = document.getElementById("pane-receive")!;
const navSend = document.getElementById("nav-send")!;
const navReceive = document.getElementById("nav-receive")!;

function showPane(pane: "send" | "receive"): void {
  const send = pane === "send";
  paneSend.hidden = !send;
  paneReceive.hidden = send;
  navSend.classList.toggle("current", send);
  navReceive.classList.toggle("current", !send);
  window.scrollTo(0, 0);
}
navSend.addEventListener("click", () => showPane("send"));
navReceive.addEventListener("click", () => showPane("receive"));
if (location.hash === "#receive") showPane("receive");

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
const spec = (id: string) => document.getElementById(id)!;

let selectedFile: {
  file: File;
  bytes: Uint8Array;
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
  window.scrollTo(0, on ? 0 : 0);
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
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (selectionGeneration !== generation) return;
    selectedFile = { file, bytes, prepared: null };
    updateFilePicker();
    await prepareSelectedFile(true);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
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
    const prepared = await prepareTransfer({
      name: current.file.name,
      mime: current.file.type,
      bytes: current.bytes,
      frameBytes: Number((document.getElementById("cfg-bytes") as HTMLSelectElement).value),
      passphrase: passphrase || undefined,
    });
    if (gen !== generation || selectedFile !== current) return;
    current.prepared = prepared;
    await startStream(revealStage);
  } catch (error) {
    if (gen !== generation) return;
    showError(error instanceof Error ? error.message : String(error));
  }
}

async function startStream(revealStage = false): Promise<void> {
  const gen = ++generation;
  resizeDisplay = null;
  showStreamPanels(false);
  if (!selectedFile?.prepared) {
    setStatus("选择文件开始");
    return;
  }
  const { file, prepared } = selectedFile;
  const name = file.name;
  const fileSize = file.size;
  if (gen !== generation) return;
  const txFps = Number((document.getElementById("cfg-fps") as HTMLSelectElement).value);
  const frameBytes = prepared.blockLen + 48;
  const ecc = (document.getElementById("cfg-ecc") as HTMLSelectElement).value as "L" | "M" | "Q" | "H";
  const displayPx = Number((document.getElementById("cfg-size") as HTMLInputElement).value);

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
  let scale = 1;
  const staging = document.createElement("canvas");
  const queue: ImageData[] = [];
  stage.hidden = false;

  const sizeCanvas = () => {
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

  const makeFrame = (): ImageData => {
    const bytes = stream.next().value as Uint8Array;
    const qr = QRCode.create([{ data: bytes, mode: "byte" } as unknown as QRCode.QRCodeSegment], {
      errorCorrectionLevel: ecc,
      version,
      maskPattern: 4,
    });
    if (!announced) {
      announced = true;
      if (revealStage) {
        stage.scrollIntoView({ behavior: "auto", block: "start" });
      }
      spec("spec-fps").textContent = `${txFps} fps`;
      spec("spec-frame").textContent = `${frameBytes} 字节`;
      spec("spec-qr").textContent = `V${qr.version} · ECC ${ecc}`;
      spec("spec-payload").textContent = `${name} · ${formatBytes(fileSize)}`;
      spec("spec-compression").textContent = prepared.manifest.allowGzip ? "按段自动（仅缩小时）" : "—";
      spec("spec-k").textContent = `段内 K = ${Math.ceil(prepared.segments[0]!.length / blockLen)}`;
      spec("spec-segments").textContent = `${prepared.manifest.segmentCount} 段 · 每段 4 MiB`;
      showStreamPanels(true);
      setStatus(`正在发送 ${name} — ${prepared.manifest.encrypted ? "已加密 · " : ""}等待接收端扫描`);
    }
    const raster = rasterizeQr(qr.modules.size, qr.modules.data, MARGIN);
    return new ImageData(new Uint8ClampedArray(raster.pixels.buffer), raster.size, raster.size);
  };

  let generatorFailed = false;
  const pump = (max = LOOKAHEAD) => {
    if (generatorFailed || gen !== generation) return;
    try {
      for (let n = 0; n < max && queue.length < LOOKAHEAD; n++) queue.push(makeFrame());
    } catch (err) {
      generatorFailed = true;
      showError(err instanceof Error ? err.message : String(err));
    }
  };
  pump();

  const interval = 1000 / txFps;
  let nextAt = performance.now();
  const tick = (now: number) => {
    if (gen !== generation || generatorFailed) return;
    requestAnimationFrame(tick);
    if (now < nextAt) return;
    const img = queue.shift();
    pump(1);
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

for (const el of ["cfg-fps", "cfg-ecc", "cfg-size"]) {
  document.getElementById(el)!.addEventListener("change", () => void startStream());
}
document.getElementById("cfg-bytes")!.addEventListener("change", () => void prepareSelectedFile());
cfgPassphrase.addEventListener("change", () => {
  if (selectedFile) void prepareSelectedFile();
});

// ---------------- 接收端 ----------------
const startBtn = document.getElementById("start") as HTMLButtonElement;
const pickDirBtn = document.getElementById("pick-dir") as HTMLButtonElement;
const dirLabel = document.getElementById("dir-label")!;
const preview = document.getElementById("preview") as HTMLDivElement;
const video = document.getElementById("video") as HTMLVideoElement;
const result = document.getElementById("result") as HTMLDivElement;
const progressStatus = document.getElementById("progress-status") as HTMLDivElement;
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

let backend: StorageBackend | null = null;
let receiver: EwReceiver | null = null;
let stream: MediaStream | null = null;
let captureGen = 0;
let statsTimer: ReturnType<typeof setInterval> | undefined;
let settingsWired = false;
let done = false;
const captureTimes: number[] = [];
const decodeTimes: number[] = [];
let pool: DecodeWorkerPool;

function statusLineForRecv() {
  const el = document.getElementById("stats")!;
  let current = "";
  return {
    setStatus(text: string) {
      current = text;
      el.textContent = text;
    },
    showError(text: string) {
      current = text;
      el.textContent = text;
      el.classList.add("error");
    },
    get text() {
      return current;
    },
  };
}
const recvStatus = statusLineForRecv();

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
    await backend.selectAndOpen();
    dirLabel.textContent = `已选择目录：${backend.kind === "opfs" ? "PWA 存储" : "已授权"}`;
  } catch (err) {
    dirLabel.textContent = err instanceof Error ? err.message : String(err);
  }
}
pickDirBtn.addEventListener("click", () => void pickDirectory());

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
  const recommend = currentSource() === "screen" ? Math.min(MAX_WORKERS + 1, 5) : MAX_WORKERS;
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
  startBtn.textContent = currentSource() === "screen" ? "开始屏幕捕获" : "启动摄像头";
}
// 屏幕捕获提示：发送端与接收端在不同窗口/不同机器，无法跨实例自动改
// 发送端设置，因此在接收端给出操作提示（用户到发送端窗口手动调整）。
const SCREEN_RECOMMEND_FPS = "60";
const SCREEN_RECOMMEND_BYTES = "2953";
function applyScreenRecommendations(): void {
  if (currentSource() !== "screen") return;
  recvStatus.setStatus(
    `屏幕捕获已就绪。如需提速，请在发送端窗口将「帧率」调为 ${SCREEN_RECOMMEND_FPS}、「每帧字节数」调为 ${SCREEN_RECOMMEND_BYTES}。`,
  );
}

for (const input of document.querySelectorAll<HTMLInputElement>('input[name="recv-source"]')) {
  input.addEventListener("change", () => {
    updateStartButton();
    populateWorkerChoices();
    applyScreenRecommendations();
    if (!stream) return;
    // 切换输入源时停止旧流，等待用户重新点击启动
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
    preview.style.display = "none";
    startBtn.style.display = "";
    startBtn.disabled = false;
    updateStartButton();
  });
}

function offerRetry(message: string): void {
  startBtn.disabled = false;
  startBtn.style.display = "";
  startBtn.textContent = "启动摄像头";
  preview.style.display = "none";
  metricsEl.style.display = "none";
  if (diagnosticsEl) diagnosticsEl.style.display = "none";
  recvStatus.showError(message);
}

async function start() {
  const source = currentSource();
  if (source === "screen" && !navigator.mediaDevices?.getDisplayMedia) {
    recvStatus.showError("当前浏览器不支持屏幕捕获（需要 Chrome/Edge 109+）。");
    return;
  }
  if (source === "camera" && !navigator.mediaDevices?.getUserMedia) {
    recvStatus.showError("摄像头需要安全上下文：本页必须通过 https 或 file:// 使用摄像头。");
    return;
  }
  if (!backend) {
    try {
      backend = createAutoBackend();
    } catch (err) {
      offerRetry(err instanceof Error ? err.message : String(err));
      return;
    }
  }
  // 桌面目录选择必须发生在用户点击事件的激活窗口内；如果用户已提前选择，
  // StorageBackend 的幂等实现会直接返回，不会重复弹窗。
  try {
    await backend.selectAndOpen();
    dirLabel.textContent = `已选择目录：${backend.kind === "opfs" ? "PWA 存储" : "已授权"}`;
  } catch (err) {
    offerRetry(err instanceof Error ? err.message : String(err));
    return;
  }
  const captureWidth = Number(cfgWidth.value);
  const captureFps = Number(cfgCapFps.value);
  startBtn.disabled = true;
  startBtn.textContent = "启动中…";
  try {
    if (source === "screen") {
      // 屏幕捕获（同机互传）：浏览器弹出源选择，选发送端窗口/屏幕即可。
      // 与摄像头共用同一解码管线；无对焦/摩尔纹问题，吞吐通常更高。
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        video: { frameRate: { ideal: Math.min(captureFps, 30) } },
      });
      stream = displayStream;
      // 用户在浏览器共享指示条上点"停止"时结束接收会话
      displayStream.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (stream === displayStream) {
          stream = null;
          offerRetry("屏幕共享已停止。");
        }
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
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { ...base, frameRate: { exact: captureFps } },
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
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
        : `${source === "screen" ? "屏幕捕获" : "摄像头"}错误：${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  startBtn.style.display = "none";
  preview.style.display = "";
  metricsEl.style.display = "grid";
  if (diagnosticsEl) diagnosticsEl.style.display = "block";
  video.srcObject = stream;
  await video.play().catch(() => undefined);
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
      recvStatus.setStatus(`收到清单：${m.name} · ${formatBytes(m.fileLen)}${m.encrypted ? " · 加密" : ""}`);
      buildSegmentGrid(m.segmentCount);
      progressStatus.style.display = "";
      progressLabel.textContent = `0% · 分段 ${receiver?.completed ?? 0}/${m.segmentCount}`;
      etaLabel.textContent = "估算剩余时间…";
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
      captureGen++;
      stream?.getTracks().forEach((t) => t.stop());
      clearInterval(statsTimer);
      statsTimer = undefined;
      progressStatus.style.display = "";
      progressLabel.textContent = "保存文件…";
      bar.style.width = "99%";
      preview.style.display = "none";
      pool?.resize(0);

      const save = async (): Promise<void> => {
        try {
          await backend?.saveFinalFile(name, mime);
          progressStatus.style.display = "none";
          const where =
            backend?.kind === "opfs" ? "已触发下载" : "已保存到所选目录";
          showResult(`传输完成！${name} 已通过校验，${where}。`, true);
          const cleanupBtn = document.createElement("button");
          cleanupBtn.type = "button";
          cleanupBtn.className = "secondary-button";
          cleanupBtn.textContent = "清理临时文件";
          cleanupBtn.addEventListener("click", () => {
            void backend?.cleanupTemp().then(() => showResult("临时文件已清理。", true));
          });
          result.append(cleanupBtn);
        } catch (error) {
          progressStatus.style.display = "none";
          showResult(
            `文件已通过校验，但保存未完成：${error instanceof Error ? error.message : String(error)}`,
            false,
          );
          const retryBtn = document.createElement("button");
          retryBtn.type = "button";
          retryBtn.className = "secondary-button";
          retryBtn.textContent = "重新保存";
          retryBtn.addEventListener("click", () => void save());
          result.append(retryBtn);
        }
      };
      await save();
    },
    onError: (message) => {
      recvStatus.showError(message);
    },
    requestPassphrase: async () => {
      const pass = window.prompt("该传输已加密，请输入口令：");
      return pass && pass.length > 0 ? pass : null;
    },
  });
  try {
    await receiver.attachBackend(backend);
  } catch (err) {
    offerRetry(err instanceof Error ? err.message : String(err));
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
  await requestScreenWakeLock();
}

// 解码 worker：由 receive/worker-factory 提供（见文件顶部注释）
function decodePool(): DecodeWorkerPool {
  return new DecodeWorkerPool(createDecodeWorker, (bytes) => {
    decodeTimes.push(performance.now());
    if (done || !receiver) return;
    noSignalDismiss();
    receiver.handleFrame(bytes);
  });
}

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
  captureGen++;
  noSignalDismiss();
  clearInterval(statsTimer);
  statsTimer = undefined;
  pool?.resize(0);
  stream.getTracks().forEach((track) => track.stop());
  stream = null;
  startBtn.style.display = "";
  startBtn.disabled = false;
  preview.style.display = "none";
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
  if (done) return;
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
  if (done || gen !== captureGen) return;
  const v = video as VideoRVFC;
  const next = () => {
    if (done || gen !== captureGen) return;
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
  captureTimes.push(performance.now());
  if (pool.busyCount === pool.size) return;
  if (grab.width !== vw || grab.height !== vh) {
    grab.width = vw;
    grab.height = vh;
  }
  const ctx = grab.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0);
  const img = ctx.getImageData(0, 0, vw, vh);
  pool.submit({ id: frameId++, buf: img.data.buffer, w: vw, h: vh }, [img.data.buffer]);
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

function refreshProgress(): void {
  const now = performance.now();
  const capWindow = captureTimes.filter((t) => now - t < 2000);
  const decWindow = decodeTimes.filter((t) => now - t < 2000);
  const capFps = capWindow.length / 2;
  const decFps = decWindow.length / 2;
  document.getElementById("m-cap")!.textContent = capFps.toFixed(1);
  document.getElementById("m-dec")!.textContent = decFps.toFixed(1);
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
  if (info && info.total > 0) {
    const pct = Math.round(info.fraction * 100);
    bar.style.width = `${pct}%`;
    progressLabel.textContent = `${pct}% · 分段 ${info.completed}/${info.total}`;
    progressStatus.style.display = "";
    // 估算 ETA：用全传输帧到达率近似
    const totalFrames = r.framesNew + r.framesDup;
    const elapsedS = (now - (startTsRef.current || now)) / 1000;
    if (r.manifestInfo && totalFrames > 3 && elapsedS > 1 && info.fraction > 0 && info.fraction < 1) {
      const ratePerS = totalFrames / elapsedS;
      const remainingFrames = totalFrames * ((1 - info.fraction) / info.fraction);
      const etaS = remainingFrames / ratePerS;
      etaLabel.textContent = `剩余约 ${formatDuration(etaS)}`;
      // 有效速率按完成比例近似，包含当前正在解码的分段，且不会把最后一段按 4 MiB 高估。
      const bytesReceived = info.fraction * r.manifestInfo.fileLen;
      const rateKBps = elapsedS > 0 ? bytesReceived / elapsedS / 1024 : 0;
      document.getElementById("m-rate")!.textContent = rateKBps > 0 ? `${rateKBps.toFixed(1)} KB/s` : "—";
    }
  }
}

const startTsRef = { current: 0 };

// 初始按钮文案跟随默认输入源（摄像头）
updateStartButton();

startBtn.addEventListener("click", () => {
  startTsRef.current = performance.now();
  void start();
});

// ---------------- 收尾 ----------------
if (import.meta.hot) import.meta.hot.accept();
