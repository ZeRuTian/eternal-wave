# Eternal Wave 项目进度（自动定时汇报源）

更新时间：2026-08-07 01:14 CST

## 当前状态：自动化与浏览器离线验收通过 ✅，等待真机光学链路验收

### 已完成
- ✅ 派生基础：decimen-optical-transfer v0.3.0；完整保留上游 MIT 许可证与 Evan Crawley（Bash Alarmist）署名，并加入 Eternal Wave contributors 版权行
- ✅ 协议核心：帧协议、清单、加密、分段压缩、检查点、桌面目录/OPFS、流式 SHA-256、喷泉码
- ✅ 类型检查：`app/` 已纳入 `tsconfig.json`；应用与构建脚本 TypeScript 检查通过
- ✅ 全量测试：**148/148 通过，0 失败**
  - 覆盖 1B、4 MiB、4 MiB+1、64 MB、丢帧/重复/乱序、加密与错误口令、检查点损坏、压缩炸弹、发送端重启和 SHA-256
  - “发送端重启”测试已改用确定性高熵数据并按真实帧输入节奏让出事件循环；专项连续 5 次通过
- ✅ 接收与续传：不同 transferId 不混流；旧检查点仅在 transferId/fileLen 一致时复用，否则清空旧 `.ewpart`；目录选择幂等
- ✅ UI：中文发送/接收一体；进度、速率、ETA、分段状态、摄像头选择、保存失败重试已接入
- ✅ QR 发送修复：按最大数据帧预探测并固定 QR 版本，避免短清单帧把版本锁低后导致数据帧容量不足
- ✅ 构建：单文件和 PWA 构建均通过；PWA 入口为根目录 `index.html`，ZIP 不残留旧文件
- ✅ 中文 `README.md`、`SHA256SUMS.txt`、发布验证脚本和许可证横幅已完成

### 发布产物
- `dist/Eternal-Wave.html` — 约 1358.0 KiB，桌面 `file://` 双击使用
- `dist-pwa/` — HTTPS 部署目录，含 Service Worker、ZXing WASM、解码 worker 和 PWA 图标
- `Eternal-Wave-PWA.zip` — 约 488.9 KiB，共 14 个条目
- `SHA256SUMS.txt` — 单文件与 PWA ZIP 的 SHA-256

### 自动验证结果
- `npm test`：148 passed / 0 failed
- `npm run build:all`：通过
- `npm run verify:release`：通过
- `shasum -a 256 -c SHA256SUMS.txt`：两个产物均 OK
- `git diff --check`：通过
- `file://` 真实浏览器：
  - 页面、发送/接收切换和样式正常
  - 外部脚本 0、外部样式表 0、资源网络请求 0、控制台错误 0
  - 默认 2331 字节/帧可生成 `V36 · ECC L` 动态二维码
  - 修改口令会重新加密和生成传输；修改每帧字节数会重新分段
  - 不可容纳的 QR 参数组合会显示中文错误，不产生未捕获异常
- PWA 真实浏览器：
  - Service Worker 注册并控制页面
  - 10 个运行资源进入预缓存
  - 关闭本地服务器并确认端口不可访问后，页面仍可重新打开，控制台错误 0

### 仍需真机完成
- 桌面屏幕 → 手机摄像头的完整发送/接收与最终文件比对
- 1B、4 MiB、4 MiB+1、64 MB、256 MB 真机传输
- 内置/USB 摄像头选择、弱光/反光/抖动、24/30/60 FPS 实测
- Windows 10/11、银河麒麟 V10 SP1 x86_64/ARM64、Ubuntu 24.04
- iOS 17+ PWA：HTTPS 预装、飞行模式冷启动、256 MB、空间不足、切后台及续传

### 真机验收通过后
- 提交当前工作区改动
- 创建 `v0.3.0` 标签和 GitHub Release
- 上传 `Eternal-Wave.html`、`Eternal-Wave-PWA.zip`、`SHA256SUMS.txt`、`LICENSE`
