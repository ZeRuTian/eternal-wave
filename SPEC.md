# Eternal Wave — 实施规格 (Implementation Spec)

派生自 [Decimen Optical Transfer](https://github.com/bashalarmistalt/decimen-optical-transfer) (MIT, Copyright (c) 2026 Evan Crawley (Bash Alarmist))。
本派生保留上游 MIT LICENSE 与作者署名。协议与 Decimen 不兼容。

## 0. 派生范围

- 保留上游 Vite + TypeScript 工程骨架、`shared/fountain.ts` 的确定性喷泉码（dlog/solitonCdf/frameIndices/LTEncoder/LTDecoder 是跨引擎 wire format，禁止改动）、`build/` 插件链（inline-zxing-wasm、viteSingleFile、license-banner、html-tokens、standalone-csp、emit-as、use-inline-variants、rewrite-standalone-links）。
- 重写 `shared/protocol.ts` 为 Eternal Wave Protocol v1（见 §1）；新增分段、清单、加密、检查点、存储后端模块。
- 主产物改为单页 `Eternal-Wave.html`（发送/接收一体，中文 UI），替代上游 send/receive 双页。
- 文件上限从 64 MB 提升到 256 MB。
- 工程目录结构：
  ```
  shared/
    ew-protocol.ts     # 48B 帧头、帧打包/解析、CRC32、分片工具
    ew-manifest.ts     # TransferManifestV1 编解码、校验、分段参数表
    ew-segment.ts      # SegmentEnvelopeV1（段信封：压缩/加密/CRC）
    ew-crypto.ts       # PBKDF2-HMAC-SHA-256 + AES-256-GCM 封装
    ew-checkpoint.ts   # TransferCheckpointV1 编解码、位图
    ew-storage.ts      # StorageBackend 接口 + DesktopDirectoryBackend(File System Access) + OPFSBackend
    ew-receiver.ts     # 接收端核心：帧 → 段 → 文件（纯逻辑，可单测）
    ew-sender.ts       # 发送端核心：文件 → 段 → 帧流（纯逻辑，可单测）
    fountain.ts        # 上游原样保留
    frame-capacity.ts  # 适配新 HEADER_LEN
    format.ts          # 保留
    platform.ts        # 保留
    status-line.ts     # 保留
    wake-lock.ts       # 保留
    worker-pool.ts     # 保留（接收解码 worker）
  send/main.ts         # 发送 UI（中文）
  receive/main.ts      # 接收 UI（中文）
  app/main.ts          # 单页入口：发送/接收一体化切换（新）
  app/index.html       # 单页（新）
  tests/               # 单测 + 恶意帧测试
  build/               # 上游保留 + 调整
  ```

## 1. Eternal Wave Protocol v1 — 帧格式

所有多字节字段 **little-endian**。每帧 QR 载荷 = 48 字节帧头 + payload。

### 1.1 统一帧头（48 字节）

```
Offset  Size  Field
0       1     magic0 = 0xE7
1       1     magic1 = 0x57
2       1     version = 1
3       1     frameType  (1=manifest, 2=data)
4       16    transferId  128-bit 随机，发送端每次启动新生成
20      4     segmentIndex (u32)  data: 段序号; manifest: 分片序号
24      4     segmentCount (u32)  data: 段总数; manifest: 分片总数
28      4     seq          (u32)  data: 喷泉帧序号; manifest: 恒 0
32      2     k            (u16)  data: 本段源块数; manifest: 恒 0
34      2     blockLen     (u16)  data: 每帧 payload 字节数; manifest: 本片长度
36      4     segmentLen   (u32)  data: 本段编码后(压缩+加密后)总长度; manifest: 清单总长
40      4     fileLen      (u32)  原始文件字节数（两种帧都有，恒等于清单 fileLen）
44      4     crc32        (u32)  payload 的 CRC32（IEEE 802.3，初始 0xFFFFFFFF，异或 0xFFFFFFFF 输出）
```

- 数据帧 payload = 喷泉编码块（`blockLen` 字节，可小于 blockLen？不——固定 `blockLen`，不足位补 0，与上游一致；最后一块的字节由 `segmentLen` 截断）。
- 清单帧 payload = 清单分片（`blockLen` 字节内）。

### 1.2 TransferManifestV1（payload 布局，分片后级联）

```
Offset  Size  Field
0       1     protocolVersion = 1
1       1     flags: bit0 = 加密, bit1 = 允许压缩(auto)
2       2     nameLen (u16), 后跟 nameLen 字节 UTF-8 文件名（发送端已 safeFileName 净化）
…       2     mimeLen (u16), 后跟 mimeLen 字节 UTF-8 MIME
…       4     fileLen (u32) 原始文件字节数
…       4     segmentSize (u32) 固定 4194304 (4 MiB)
…       2     segmentCount (u16)
…       1     compressionMode (0=none, 1=gzip-auto)
…       1     cryptoMode (0=none, 1=aes-256-gcm)
…       4     pbkdf2Iterations (u32) 加密时 = 600000，否则 0
…       16    salt (仅加密时存在；未加密时省略)
…       16    fileSha256 完整原始文件 SHA-256
…       N     segmentParams 表，N = segmentCount，每项：
              u32  encodedLen  本段编码后总长（含 GCM tag 16B，若加密）
              u32  segCrc32    本段编码后数据的 CRC32
              u8[8] noncePrefix 仅加密时存在；未加密时省略（每段 8B 随机前缀）
…       4     manifestCrc32 对整个 payload（含本字段之前所有字节）的 CRC32
```

- 未加密时每段参数 8 字节；加密时 16 字节。
- 段原始长度推导：`origLen(i) = min(segmentSize, fileLen - i*segmentSize)`。
- 清单必须能整体装入一个 QR 帧（256 MB → 64 段 → 加密时 ≤ 64×16+~100 ≈ 1124 B < 2331 B payload），分片机制仅作防御保留：发送端仍按单帧发送清单，接收端支持分片重组以防未来扩展。

### 1.3 分段

- 文件固定按 4 MiB 分段（`SEGMENT_SIZE = 4 * 1024 * 1024`），最后一段可不满。
- 每段处理链：`原始段 → [gzip] → [AES-256-GCM 加密] → 编码后段(segmentEnvelope)`。
- gzip 仅在 `压缩后长度 + 64 < 原始长度` 时采用（压缩按段独立判断，逐段决定，非整文件）。
- 加密：`key = PBKDF2-HMAC-SHA-256(passphrase, salt=16B随机, iterations=600000, 32B)`；每段 `nonce = noncePrefix(8B随机) ‖ u32LE(segmentIndex)` = 12B GCM nonce；输出 = ciphertext ‖ 16B tag。
- 口令不写入二维码、检查点、日志。

### 1.4 发送调度

1. 开始：连续发送清单帧 3 次。
2. 此后每 120 个数据帧后重发 1 次清单帧（计数器含所有帧）。
3. 数据帧：按段推进，每段发送 `ceil(1.35 × k)` 个不同 seq 帧（seq 从 0 递增，不重置），发完切下一段；全部段发完一轮后回到段 0 继续循环。
4. seq 全局递增（不按段重置），保证同段内 seq 唯一。段切换由接收端按 segmentIndex 区分。
5. 默认发送配置：frameBytes=2331（blockLen=2283）、30 FPS。选项：10/15/20/24/30/60 FPS；500/1000/1465/1850/2331/2953 字节/帧。

### 1.5 接收端逻辑（ew-receiver.ts）

1. 解析帧 → 校验 magic/version/frameType/crc32。
2. 数据帧：须先有匹配清单（transferId、segmentCount、blockLen、k、segmentLen、fileLen 全一致），否则丢弃并提示"等待清单"。
3. 段完成（LTDecoder 解码全部 k 块）→ 校验 `segCrc32` → 若加密先解密（口令错误 → GCM 认证失败报"口令错误"）→ 若压缩解压（输出上限 = 段原始长度，超限即拒绝，防压缩炸弹）→ 长度必须等于推导的 `origLen` → 写入 `.ewpart` 偏移 `i × SEGMENT_SIZE` → 更新检查点位图。
4. 全部段完成 → 流式读取 `.ewpart` 计算 SHA-256 → 与清单 `fileSha256` 比对 → 通过后才进入保存/下载流程。
5. 接收页刷新/摄像头中断 → 用户重选同一目录 → 加载检查点 → 跳过已完成段。

### 1.6 TransferCheckpointV1（.ewckpt 文件，版本化）

```
Offset  Size  Field
0       4     magic "EWCP"
4       2     version = 1
6       16    transferId
22      4     segmentCount (u32)
26      4     fileLen (u32)
30      4     segmentSize (u32)
34      M     完成位图：ceil(segmentCount/8) 字节，bit i = 段 i 已完成
34+M    4     crc32（对之前所有字节）
```

- 损坏/版本不符 → 视为无检查点，从零开始（保留 .ewpart，仅提示）。
- 写入策略：段完成时立即持久化；检查点写入用临时文件 + 原子 rename。

### 1.7 StorageBackend 接口

```ts
interface StorageBackend {
  readonly kind: "desktop-dir" | "opfs";
  selectAndOpen(): Promise<void>;            // 用户选择目录（desktop）或打开 OPFS 根（PWA）
  ensureTransfer(manifest: TransferManifestV1): Promise<boolean>;  // 建 .ewpart/.ewckpt，返回是否继续（空间检查失败返回 false）
  freeSpaceSufficient(needBytes: number): Promise<boolean>;        // 需要 ≥ fileLen*1.25+16MiB
  loadCheckpoint(): Promise<TransferCheckpointV1 | null>;
  saveCheckpoint(cp: TransferCheckpointV1): Promise<void>;
  writeSegment(index: number, bytes: Uint8Array): Promise<void>;   // 写 .ewpart 偏移 index*SEGMENT_SIZE
  readSegment(index: number): Promise<Uint8Array | null>;          // 续传时读回已写段（用于调试/校验）
  streamSha256(): Promise<Uint8Array>;       // 流式 .ewpart 全文件 SHA-256
  prepareFinalFile(name: string, type: string): Promise<File>;     // iOS 分享前准备快照
  saveFinalFile(name: string, type: string): Promise<void>;        // 保存/下载最终文件
  cleanupTemp(): Promise<void>;              // 删除 .ewpart/.ewckpt
  dispose(): Promise<void>;
}
```

- desktop-dir：File System Access API（showDirectoryPicker）。iOS 与无目录选择能力的安卓/华为浏览器：OPFSBackend（固定私有根目录）；选择依据是能力探测，不依赖 PWA 显示模式。
- `ensureTransfer` 在收到清单后调用：先 `freeSpaceSufficient(fileLen)`，不足则拒绝开始。

## 2. 单页应用（app/）

- `app/index.html`：单页。顶部两个入口按钮：「发送文件」「接收文件」，切换主面板。中文界面。
- 发送面板：文件选择、文件信息（名称/大小/类型）、FPS 与帧字节配置、预计耗时、二维码画布（全屏按钮）、状态行、停止按钮、加密口令输入（可选）。
- 接收面板：摄像头授权、设备选择（内置/USB）、自动对焦/分辨率设置、进度（总进度 + 分段状态网格 + 已收帧/总帧 + 速度 + 剩余时间）、目录选择（桌面）/OPFS 自动、iOS 最终系统导出按钮及中文故障提示；不提供单独清理按钮。
- 风格：深色，跟随上游 CSS 变量体系（`shared/style.css` 保留，微调文案）。
- 单页构建模式（`mode: "standalone"`）：只构建 app/index.html → `dist/Eternal-Wave.html`。

## 3. 加密模块（ew-crypto.ts）

```ts
export const PBKDF2_ITERATIONS = 600_000;
export async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey>;
export async function encryptSegment(plain: Uint8Array, key: CryptoKey, segIndex: number): Promise<{ data: Uint8Array; noncePrefix: Uint8Array }>;
export async function decryptSegment(cipher: Uint8Array, key: CryptoKey, segIndex: number, noncePrefix: Uint8Array): Promise<Uint8Array>; // 失败抛错
```
- Web Crypto：`crypto.subtle.deriveKey({name:"PBKDF2", salt, iterations, hash:"SHA-256"}, material, {name:"AES-GCM", length:256}, false, ["encrypt","decrypt"])`。
- 口令字节：`new TextEncoder().encode(passphrase)` 直接作为 PBKDF2 材料（不哈希口令）。

## 4. 恶意帧防护（§测试对应）

所有解析路径遵守：**先校验全部字段关系与上限，再分配内存**。硬上限：
- `MAX_FILE_BYTES = 256 * 1024 * 1024`
- `MAX_SEGMENTS = ceil(MAX_FILE_BYTES / SEGMENT_SIZE)` = 64
- `MAX_SEGMENT_ENCODED = 8 * 1024 * 1024`（压缩+加密后单段上限，原始 4MiB + 开销余量）
- `k ≤ MAX_SOURCE_BLOCKS = 0xffff`；`blockLen ≤ 4096`；`blockLen ≥ 1`
- 清单 `nameLen ≤ 1024`、`mimeLen ≤ 512`
- 解压输出上限 = 推导段原始长度（防压缩炸弹）
- `segmentLen`、`fileLen`、`segmentCount`、`k`、`blockLen` 之间的算术关系在分配前逐项验证（如 `segmentCount*SEGMENT_SIZE` 与 `fileLen` 兼容、`segIndex < segmentCount`、`k*blockLen ≥ segmentLen` 且 `(k-1)*blockLen < segmentLen`）
- CRC32 不符即丢帧（不计入 seen，避免攻击者用错误帧消耗 seen 集合——注意：seen 以 seq 为键，攻击者无法预知有效 seq，因此 seen 膨胀风险有限；仍按段完成即清理）。

## 5. 构建与产物

- 保留上游 `build/` 插件，新增/调整：
  - `vite.config.ts`：standalone 模式输入改为 `app/index.html`，输出 `Eternal-Wave.html`（emitAs）。
  - PWA 模式（`npm run build:pwa`）：构建 `dist-pwa/`（含 service worker、manifest、图标），再 zip 成 `Eternal-Wave-PWA.zip`。
- 产物固定：
  - `dist/Eternal-Wave.html` — 桌面主产物
  - `dist-pwa/` + `Eternal-Wave-PWA.zip` — iOS 预装包
  - `SHA256SUMS.txt`（对以上产物）
  - `LICENSE`（上游 MIT 完整保留 + 本派生版权行：Copyright (c) 2026 Eternal Wave contributors）
  - `README.md` 中文使用说明（安装、发送、接收、加密、续传、故障排查、iOS PWA 步骤）
- 单文件构建检查：`Eternal-Wave.html` 不含 `http://`/`https://` 外链、`<link>`、外部字体、fetch/XHR 调用。

## 6. 测试（tests/）

沿用上游 `node --import tsx --test tests/*.test.ts`。

- `ew-protocol.test.ts`：帧头黄金向量（固定字段序列 → 精确字节断言）、CRC32 黄金向量（"123456789" → 0xCBF43926）、payload 篡改 → CRC 拒绝、长度不匹配拒绝、非法 magic/version/frameType 拒绝、所有上限校验。
- `ew-manifest.test.ts`：清单编解码往返、加密/未加密两种布局、超长文件名/MIME 拒绝、manifestCrc32 篡改拒绝、段参数表一致性。
- `ew-segment.test.ts`：段处理链往返（原始→压缩→加密→解密→解压→原始）、压缩仅在缩小 64B 以上时启用、边界（1B、4MiB-1、4MiB、4MiB+1、64MiB、256MB 文件用随机/确定性数据）、错误口令 → 解密失败、密文篡改 1 字节 → GCM 失败。
- `ew-fountain-segment.test.ts`：LTEncoder/LTDecoder 在分段模式下乱序/重复/丢 30% 帧仍还原；`1.35×k` 覆盖足够；seq 跨段连续。
- `ew-checkpoint.test.ts`：往返、位图边界（1/64/65 段）、损坏 magic/version/crc → null、原子写入语义。
- `ew-receiver.test.ts`：恶意帧（伪造 fileLen、segmentCount、blockLen、k、压缩炸弹、超长元数据）全部拒绝且不分配大内存（用固定上限常量断言）；段 CRC 不符拒绝；清单后无数据可解；丢帧+重启（新 transferId 重置）场景。
- `ew-e2e.test.ts`：**模拟链路端到端**——发送端核心生成帧序列（随机丢 30%、乱序、重复注入）→ 接收端核心重组 → 文件字节与 SHA-256 完全一致；覆盖 1 字节、4 MiB 边界、64 MB；加密与未加密两遍；中途"重启"（新 transferId）验证重置。
- 保留上游其余测试（fountain/frame-capacity/format 等），适配 HEADER_LEN 变化。

## 7. 验收清单（本机可执行部分）

1. `npm run test` 全绿（含恶意帧与 e2e）。
2. `npm run build` 产出 `dist/Eternal-Wave.html`；grep 确认无外链；文件可 `open` 于 Chrome 从 `file://` 加载，发送面板可生成二维码（无摄像头依赖）。
3. `npm run build:pwa` 产出 `dist-pwa/` 与 `Eternal-Wave-PWA.zip`。
4. `SHA256SUMS.txt` 内容与 `shasum -a 256` 一致。
5. 摄像头光学链路与 Windows/麒麟/iPhone 实机矩阵需真机验收（本机无法完成，按 PLAN.md §测试与验收 由用户执行）。
