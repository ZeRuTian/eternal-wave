# Eternal Wave 项目进度（自动定时汇报源）

更新时间：2026-08-07 上午

## 当前状态：本机可执行部分全部完成 ✅，待真机验收

### 已完成（全部）
- ✅ 协议核心 8 模块 + 发送/接收核心，**测试 148/148 全绿**
- ✅ e2e 模拟链路：30% 丢帧/乱序/重复/重启续传/加密/64MB 全过
- ✅ 单页中文 UI（发送/接收一体、加密口令、分段网格、故障排查）
- ✅ **dist/Eternal-Wave.html 单文件构建成功（1.39 MB，内联 QR 库 + ZXing WASM + worker）**
- ✅ **浏览器 file:// 实测**：
  - 页面零 JS 错误零警告加载
  - 发送链路实测通过（注入 5KB 文件 → 二维码渲染 507×507 → 动态变化）
  - 接收面板切换正常、blob worker 可用、WASM 已内联
  - **零外部资源请求**（resourceCount=0）+ CSP 实测拦截外部 fetch
- ✅ PWA 包：dist-pwa/（sw.js + manifest + icons + wasm）+ Eternal-Wave-PWA.zip（488.9 KB）
- ✅ SHA256SUMS.txt（校验通过）、LICENSE（上游 MIT + 派生署名）、README 中文使用说明

### 关键修复（已固化测试）
1. manifest segmentSize u16→u32（4MiB 溢出根因）
2. e2e OOM（流式喂帧 + 周期让出事件循环）
3. 段完成重复解码（同步 completedSegments 跟踪）
4. 加密清单/密钥派生竞态（先派生后发布 + 串行化）
5. worker inline 变体后缀匹配（单文件内联成功）

### 待真机验收（本机无法完成）
- Windows 10/11、银河麒麟 V10 SP1 x86_64/ARM64、Ubuntu 24.04 实机矩阵
- 摄像头光学链路（本机无摄像头环境）
- iPhone iOS 17+ PWA：HTTPS 安装 → 飞行模式 → 冷启动 → 接收 256MB
- 空间不足/系统切后台/续传恢复场景
- 256MB 传输期间桌面接收端 JS 堆 ≤ 192MB
- 断网环境 file:// 全流程（1B/4MiB/64MB/256MB 普通/压缩/加密）

### 使用方式
- 桌面：U 盘拷贝 dist/Eternal-Wave.html，Chrome/Edge 109+ 双击打开
- iPhone：dist-pwa/ 部署到 HTTPS，Safari 添加到主屏幕后离线使用
