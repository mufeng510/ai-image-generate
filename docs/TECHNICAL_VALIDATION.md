# 技术验证报告

**项目**：豆包网页版批量生图桌面软件  
**阶段**：Phase 0 — 项目与技术调研 / 技术验证  
**日期**：2026-11-02  
**编写**：Dev（技术负责人）  
**依据文档**：`task.md`（二、开发前必须完成的技术验证；三、技术架构）

---

## 1. 验证概述

本报告在正式开发前，对豆包网页版自动化核心流程进行技术验证，包括：

1. 抓取并完整阅读油猴脚本《无印豆包 - 素材提取》（版本 1.0.19，MIT 许可，作者 ihmily，源码仓库 `ihmily/doubao-nomark`）；
2. 分析脚本的图片捕获、响应解析、原图地址提取和下载流程；
3. 验证 Playwright 持久化浏览器方案（`launchPersistentContext`）；
4. 调研 Tauri Sidecar 与 Windows 打包方案；
5. 形成技术风险与推荐实现方案。

**重要约束**：本机未持有豆包账号登录凭据，因此无法执行 task.md 2.2 节要求的“使用真实浏览器和正常登录的豆包网页”进行端到端实测（登录、上传、提交生图、下载）。所有涉及登录后页面行为的结论，均基于油猴脚本源码的静态分析，标注为 **[源码分析]**；实际可运行验证的部分标注为 **[已验证]**；需要凭据才能继续的部分标注为 **[未验证 - 需凭据]**。

---

## 2. 油猴脚本分析结果

### 2.1 脚本基本信息

| 项目 | 值 |
|---|---|
| 名称 | 无印豆包 - 素材提取 |
| 版本 | 1.0.19 |
| 作者 | 无印豆包 (ihmily) |
| 许可证 | MIT |
| 主页/仓库 | https://github.com/ihmily/doubao-nomark |
| 源码路径 | `extension/tampermonkey-script/doubao-nomark.user.js`（约 124 KB） |
| 匹配页面 | `www.doubao.com/thread/*`, `/share/*`, `/chat/*`, `/creativity/canvas_workspace*`；`dola.com`；`qianwen.com` |
| 授权 | `GM_download`, `GM_xmlhttpRequest`, `unsafeWindow`；connect 到 `snssdk.com`, `douyinvod.com`, `byteintlapi.com`, `dola.com` |

MIT 许可证允许商业/内部使用、修改和分发，需保留版权声明和许可证文本。本项目可合理复用其中的**图片提取逻辑**，但**不应原样嵌入整个脚本**，应提炼为独立可维护模块（见第 7 节）。

### 2.2 核心提取机制（源码分析）

脚本在页面注入后，通过以下方式拦截网络流并提取图片：

| 机制 | 目标请求/来源 | 提取内容 | 关键代码 |
|---|---|---|---|
| `XMLHttpRequest` 拦截 | `/im/chain/single` | `downlink_body.pull_singe_chain_downlink_body.messages` | `send` 事件监听 |
| `XMLHttpRequest` 拦截 | `/creativity/canvas_workspace/doc/get` | `data.snapshot.doc.items[].asset.image_info.image_ori_raw` | `parseCanvasDocumentImages` |
| `fetch` 拦截 | `/im/chain/single` | 同上（克隆 body 解析） | `fetch` 拦截器 |
| `fetch` 拦截（EventStream） | `/chat/completion` | SSE `data:` 行中的 `image_ori` / `patch_op` / `event_data`，再解析 `creation.image.image_ori_raw` | `ReadableStream` 拦截 + `parseStreamChunk` |
| `fetch` 拦截 | `qianwen.com/api/v1/*` | 千问对话 `multi_load/iframe` 消息 | 独立分支 |
| 脚本标签数据 | `script[data-script-src="modern-run-router-data-fn"]` | 分享页初始数据，递归遍历 `creation.image.image_ori_raw` | `extractSharePageImages` / `collectSharePageMedia` |

**原图数据结构**：`creation.image.image_ori_raw` 是对象，包含 `url`、`width`、`height`。URL 需把 `&amp;` 还原为 `&`。这就是豆包提供的**原始无水印图片资源地址**，而非展示用缩略图。

### 2.3 图片下载机制（源码分析）

1. 优先使用 `GM_download({ url, name, saveAs: false })`（篡改猴 API，自带 Cookie 凭据）；
2. 回退为 `fetch(url)` → `response.blob()` → `URL.createObjectURL` → 创建 `<a download>` 点击下载；
3. 批量下载时先 `fetchImageBlob` 取字节，再自行打包 ZIP（`buildStoredZip`，STORED 方式，不压缩）；
4. 扩展名由 `getBatchFileExtension` 根据响应 `Content-Type`（`image/jpeg`→jpg, `image/png`→png, `image/webp`→webp 等）或 URL 路径后缀判断，默认 `png`，**不统一转格式**。

**对本项目的启示**：在 Node.js + Playwright 环境中，`GM_*` API 不可用，应改用 Playwright 的 `page.route`/响应拦截或浏览器原生 `fetch`（携带持久化上下文的 Cookie）来下载原图，并按实际 `Content-Type` 保留扩展名，再用文件魔数（file signature）校验格式。

### 2.4 哪些逻辑可复用，哪些需重写

| 模块 | 可复用性 | 处理方式 |
|---|---|---|
| 图片提取逻辑（`image_ori_raw`） | 高 | 提炼为 Node.js 独立模块，在 Playwright 页面中通过 `page.evaluate` 或响应拦截提取 |
| XHR/fetch 拦截器 | 中 | Playwright 原生 `page.on('response')` / `page.route` 可替代，无需在页面内猴补丁 |
| 视频 `key_seed` AES-CBC 解密 | 低（本项目只做生图） | 暂不实现，任务范围仅为图片 |
| `GM_download` / `GM_xmlhttpRequest` | 无 | 替换为 Playwright/Node `fetch` + `fs` 写文件 |
| 界面（浮动按钮、模态框、ZIP 打包） | 无 | 桌面软件自有 UI，不复用 |
| 页面 DOM 选择器（如 `data-testid="message_image_content"`） | 低 | 选择器属内部实现，易变更，**不应硬编码依赖**，以网络层提取为主 |

---

## 3. 豆包网页自动化可行性

### 3.1 可行性结论：可行，但强依赖登录会话与网络层提取

基于脚本源码分析，豆包网页版的生图流程完全通过浏览器网络请求完成，且**原图 URL 直接包含在响应数据中**（`image_ori_raw.url`），无需反演签名或破解加密。因此自动化可行。

关键可行点：
- 登录状态可通过 Chromium 持久化用户数据目录保留（`launchPersistentContext`），无需每次重新输入密码；
- 生图提交后，服务端通过 EventStream（SSE）流式返回创建结果，`creation.image.image_ori_raw` 携带原图 URL；
- 图片下载可直接对原图 URL 发起带凭据的请求，保留实际格式（JPG/PNG/WEBP 等）。

### 3.2 不可控/高风险因素

| 风险 | 说明 | 应对 |
|---|---|---|
| 页面 DOM 结构变化 | 脚本大量依赖 `data-testid`、`className`（如 `DBX_BUTTON_CLASS`）等内部选择器，豆包更新后可能失效 | **以网络层响应提取为主，DOM 选择器仅作为辅助**；结构变化时立即停止并保存诊断信息（task.md 15 节） |
| 接口路径/字段变更 | `/im/chain/single`、`/chat/completion`、`image_ori_raw` 等为内部契约，随时可能变更 | 保留断点与诊断日志，遇到未知结构不盲目尝试新选择器 |
| 验证码/风控/额度耗尽 | 平台可能触发人机验证或账号限制 | 暂停任务、提示用户人工处理，**严禁自动切换账号绕过** |
| 登录失效 | 持久化上下文的会话会过期 | 检测登录态，失效后暂停并要求用户在可见浏览器中手动登录 |

---

## 4. 参考图片上传验证结果

**[未验证 - 需凭据]**

上传参考图片发生在登录后的生图对话页，需要真实账号才能进入该页面并操作文件上传 `<input type="file">`。脚本本身不涉及上传（它只做提取），故无法从脚本中获取上传选择器。

基于常规网页行为及 Playwright 能力：
- Playwright 支持 `page.setInputFiles()` 上传多个本地文件，可一次上传 5 张图片；
- 需在页面可见、未被遮挡时定位上传输入框，建议结合 `page.waitForSelector` 与超时重试。

**结论**：技术上可行，但必须在拥有登录凭据后，于真实豆包对话页完成上传实测，才能确认选择器与交互流程。

---

## 5. 生图提交和状态识别验证结果

**[源码分析]**

脚本显示生图提交完成后，服务端通过 `POST /chat/completion` 返回 EventStream（SSE）。客户端拦截该流，逐行解析 `data: ` 开头的 JSON，判定：
- 包含 `image_ori` 或 `fallback_api` 字段 → 有图片生成结果；
- `data.event_data` 或 `data.patch_op` → 进度/完成事件，通过 `parseStreamChunk` 解析出 `creation.image.image_ori_raw`。

**状态识别依据**：
- 生成中：SSE 流持续产生数据块；
- 生成完成：流结束（`done`）或出现 `event:complete`；
- 图片列表：累计所有 `creation.image.image_ori_raw.url`，去重后即为本轮全部图片。

**结论**：状态识别可通过网络层 EventStream 稳定实现，无需依赖 DOM 状态文本。实测需登录后完成一次生图才能确认具体字段与流结束标志。

---

## 6. 原始图片提取验证结果

**[源码分析]**

脚本明确优先保存“原始无水印”图片，数据来源为 `creation.image.image_ori_raw.url`，并按实际 `Content-Type`（`image/jpeg`/`image/png`/`image/webp`/…）保留扩展名，不强制转码。这与 task.md 2.3 节要求一致。

**需要在实测中验证的点（需凭据）**：
- 原图分辨率、实际格式、文件大小；
- 是否存在水印（脚本宣称无水印，需实际下载对比确认）；
- 下载后文件完整性（SHA-256、文件魔数校验）；
- 避免将缩略图误当原图（脚本取 `image_ori_raw` 而非展示页 `img.src`，符合要求）。

**结论**：提取思路正确且与任务要求一致，但原图属性（分辨率/格式/水印）必须在登录后真实生图并下载时校验。

---

## 7. 浏览器持久化登录验证结果

**[已验证 - 技术可行性]**

Playwright 支持 `browserType.launchPersistentContext(userDataDir, { headless: false, ... })`，创建独立的 Chromium 用户数据目录，Cookie、本地存储、会话均持久化于该目录。不同账号使用不同目录，即可实现独立登录状态。

验证方法（本机已可执行）：
```js
const { chromium } = require('playwright');
const context = await chromium.launchPersistentContext('./user-data/account1', { headless: false });
const page = await context.newPage();
await page.goto('https://www.doubao.com/chat/');
// 用户在此可见窗口中手动登录，关闭后会话保留在 user-data/account1
await context.close();
```

注意事项：
- 必须 `headless: false`，且浏览器始终对用户可见（task.md 3.3）；
- 同一用户数据目录不能同时被多个浏览器实例占用，需加锁/占用检查；
- 不得使用用户日常 Chrome/Edge 默认用户数据目录，避免干扰用户浏览器。

**结论**：持久化登录方案技术可行，本机可直接验证 Playwright 启动；持久化后的登录态是否被豆包接受，需登录后实测确认。

---

## 8. 多账号独立会话验证结果

**[设计方案，未端到端实测]**

每个豆包账号对应：
- 一个独立的 Chromium 用户数据目录（`user-data/<account-id>/`）；
- 一组账号统计信息（存储于 SQLite，不含 Cookie/会话明文，符合 task.md 7.1）；
- 串行执行：同一时间只有一个浏览器实例占用一个目录，避免并发冲突。

账号切换即切换 `userDataDir` 启动/复用对应持久化上下文。由于 Playwright 同一进程可管理多个 `BrowserContext`，但 Chromium 进程与用户数据目录是独占关系，推荐**每个账号一个独立的 Chromium 实例、串行调度**。

**结论**：方案清晰，需配合任务队列的串行执行与上下文生命周期管理；多账号并发不在本项目初期支持范围。

---

## 9. Windows 打包验证结果

**[方案调研，未编译打包]**

推荐架构（task.md 三节）：Tauri 2（桌面框架）+ React（前端）+ Rust（后端）+ Node.js（自动化运行时，作为 Sidecar）+ Playwright Chromium。

### 9.1 Node.js 运行时打包
方案：将 Node.js 可执行文件（`node.exe`）及所需依赖作为 Tauri Sidecar 打包进安装包，或随安装包内置一份 Node.js 运行时。用户无需自行安装 Node.js。

### 9.2 Playwright + Chromium 打包
方案：将 Playwright 依赖的 Chromium 浏览器二进制随安装包打包（或首次启动后在应用内目录下载）。通过 `PLAYWRIGHT_BROWSERS_PATH` / `executablePath` 指向内置 Chromium，避免用户手动安装。

### 9.3 Tauri Sidecar
Tauri v2 支持 Sidecar（`externalBin` / `binaries`），Windows 下生成 `.exe` 子进程。Rust 后端通过 `tauri-plugin-shell` 启动 Node.js Sidecar，前后端通过 Tauri Commands/Events 通信。Node.js Sidecar 内再启动 Playwright 控制 Chromium。

### 9.4 匹配与更新
- Playwright 版本与内置 Chromium 版本必须匹配；
- 应用更新时随同更新自动化运行时，避免版本不一致；
- 更新需签名验证，且不得删除项目图片与账号浏览器数据。

**结论**：Windows 打包方案清晰，但属于工程验证，需在 Phase 6 进行完整打包与安装测试。Phase 0 确认方案可行，不构成阻塞。

---

## 10. 主要技术风险

1. **豆包页面结构/内部接口随时变更**：`/im/chain/single`、`/chat/completion`、`image_ori_raw` 等为非公开契约，一旦变更，自动化失效。需保留诊断信息并停止任务（task.md 15 节）。
2. **登录态与风控**：持久化上下文可被豆包识别为自动化，可能触发验证码或账号限制；必须人工介入，禁止自动绕过。
3. **无凭据无法端到端实测**：本阶段未完成登录/上传/生图/下载的真实闭环，Phase 1 原型的登录后环节需用户提供凭据后续验证。
4. **Chromium 用户数据目录独占**：同一目录不能被多个实例占用，需设计锁机制，避免崩溃。
5. **文件格式判断**：不可仅凭扩展名判断图片格式，需根据响应头 + 文件魔数校验。

---

## 11. 暂时无法实现的功能

| 功能 | 原因 | 替代/后续计划 |
|---|---|---|
| 登录、上传、提交生图、下载的完整闭环实测 | 本机无豆包账号凭据 | 由用户提供凭据后，于 Phase 1 原型上完成真实页面验证 |
| 端到端多账号并发 | Chromium 用户数据目录独占，且平台禁止规避额度 | 默认单账号串行；多账号按顺序轮换 |
| 视频下载与 `key_seed` 解密 | 任务范围仅为图片 | 暂不实现 |
| 无凭据的自动登录 | 会涉及绕过登录，违反平台规则 | 用户在可见浏览器中手动登录，状态持久化 |

---

## 12. 推荐的技术实现方案

### 12.1 整体架构
- **桌面框架**：Tauri 2（Rust 后端 + React 前端）
- **自动化运行时**：Node.js 作为 Tauri Sidecar（内置 node.exe + Playwright）
- **浏览器**：Playwright Chromium，`headless: false`，每账号独立 `userDataDir`
- **前后端通信**：Tauri Commands / Events（前端不直接操作数据库，不堆积业务逻辑）
- **数据库**：SQLite（任务状态、账号、项目、日志，迁移机制、事务、索引）
- **图片提取**：在 Node.js Sidecar 中，通过 Playwright 响应拦截捕获 `/chat/completion` EventStream，提取 `image_ori_raw.url`
- **图片下载**：Node.js `fetch`（携带上下文 Cookie）或 Playwright 请求，按 `Content-Type` 保留扩展名，文件魔数 + SHA-256 校验
- **安装包**：Windows NSIS/MSI 安装程序，内置全部运行时，支持签名验证更新

### 12.2 分层职责（任务架构要求）
1. 桌面 UI 与浏览器自动化逻辑分离（Tauri 前端 vs. Node.js Sidecar）；
2. 任务调度与浏览器控制分离（Rust 后端调度 vs. Playwright 控制）；
3. 图片抽取与图片下载分离（提取模块只产出 URL 列表，下载模块负责存储与校验）；
4. 数据库访问集中管理（Rust 后端统一访问 SQLite）；
5. 浏览器异常不导致桌面软件崩溃（Sidecar 独立进程，崩溃可重启）；
6. 所有耗时操作异步。

### 12.3 Phase 0 结论

核心技术路线**可行**：
- 油猴脚本已提供成熟的图片提取思路（`image_ori_raw` 原图 URL），可合理复用并改写为 Node.js 模块；
- Playwright 持久化浏览器 + Tauri Sidecar + Windows 打包方案均有明确实现路径；
- 生图状态识别通过 EventStream 网络层进行，鲁棒性高于 DOM 选择器。

**阻塞项**：缺少豆包账号凭据，无法完成登录后页面的端到端实测。建议用户提供测试账号，或由用户在真实登录会话下完成 Phase 1 的登录/上传/生图/下载验证。

报告生成完毕，可进入 Phase 1（最小可行性原型）。
