# Eternal Wave 项目进度（自动定时汇报源）

更新时间：2026-08-06

## 当前状态：核心协议层实施中（Phase A/B）

### 已完成
- ✅ 派生基础：decimen-optical-transfer v0.3.0（MIT 保留署名），SPEC.md 实施规格
- ✅ 协议核心 8 模块（tsc 编译通过）：
  - ew-protocol：48B 帧头 v1、CRC32、硬上限校验（256MB/64段/先校验后分配）
  - ew-manifest：清单编解码、分片、文件名净化
  - ew-crypto：PBKDF2(600k)+AES-256-GCM 逐段加密
  - ew-segment：分段压缩链 + gzip 炸弹防护
  - ew-checkpoint：位图检查点、原子写入
  - ew-storage：桌面目录 + OPFS 双后端
  - ew-sha256：流式增量哈希（256MB 文件内存安全）
  - ew-sender / ew-receiver：收发核心（纯逻辑、可单测）
- ✅ 测试套件 137 项：协议黄金向量/恶意帧/加密/边界/检查点/SHA-256
- ✅ e2e 模拟链路：30% 丢帧、乱序、重复帧、发送端重启、加密、500B 帧
  - 已修复：manifest segmentSize u16→u32（协议根因）、e2e 内存峰值 OOM（流式喂帧 + 事件循环让出）

### 进行中
- ⏳ e2e 测试最后验证（后台运行中）
- ⏳ 单页中文 UI（发送/接收一体、进度/速度/全屏二维码/故障提示）
- ⏳ 构建：dist/Eternal-Wave.html 单文件（零外部请求）
- ⏳ PWA 包 dist-pwa + Eternal-Wave-PWA.zip
- ⏳ SHA256SUMS.txt / LICENSE 派生署名 / 中文使用说明

### 下一步
1. e2e 全绿确认
2. UI 单页 + QR 渲染（2331B/30FPS 默认，10-60FPS 可选）
3. 摄像头接收集成（ZXing WASM inline，摄像头枚举/自动对焦）
4. singlefile 构建 + 断网 file:// 验证
5. PWA + 产物打包

### 验收（需真机）
- Windows 10/11、银河麒麟 V10 SP1 x86_64/ARM64、Ubuntu 24.04 实机矩阵
- iPhone iOS 17+ PWA 离线接收 256MB
- 摄像头光学链路、256MB 传输堆 ≤192MB
