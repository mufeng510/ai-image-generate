# CHANGELOG

## [Unreleased]

### 2026-11-07

### 新增

- 安装包内置完整运行时：随附 Node.js v22（`runtime/node/win-x64/node.exe`）与 Playwright Chromium（`runtime/ms-playwright/`），用户无需安装 Node.js/Playwright/Chromium
- 启动不自动恢复上次任务：上次中断任务被标记为需人工处理并保留上次状态，由用户手动「继续执行」
- 安全暂停/取消：暂停/取消真正中断正在执行的自动化（等待生成、上传前、提交前、下载循环均支持中止）；继续执行不重复提交
- 多轮生图：任务可设置轮数（1–999），逐轮串行执行，每轮重新抽图与读取 prompt.txt
- 输出目录规范：`output/yyyyMMdd_HHmmss_fff`（同名 `_N` 递增）；图片 `001.png` 起（保留真实扩展名）；每轮目录写 `prompt.txt` / `references.json` / `task.json`
- 人工确认模式：抽图后暂停 / 提交前暂停两个开关；waiting_confirmation 状态落地 + 安全继续
- 项目管理补全：导入已有项目、重命名、打开目录、`prompt.txt` 在线编辑、参考图统计与文件夹布局、生成历史、参考图管理器（预览/新增/删除/详情/打开所在目录/SHA-256 校验）
- 账号管理补全：行首拖动排序、按列表顺序自动轮换（跳过未登录或已达自定义阈值的账号）、图片阈值编辑、成功图片数/完成轮次/最近使用时间真实统计、单次任务指定账号、已达阈值暂停保护
- 重试机制：`max_retries` 生效；扫描超时/下载失败可自动重试（下载只重传未完成文件）；超限暂停并通知（`retry-exhausted` 事件）
- 日志筛选导出：按任务/账号/级别/时间区间筛选并导出 CSV；日志自动脱敏（Cookie/Token 等替换为 `[REDACTED]`）
- 通知中心：右上角铃铛 + 未读角标 + 气泡通知，覆盖任务开始/完成/失败/需人工处理/阈值/最大重试；设置页可开启系统通知
- 默认执行模式：「自动连续执行」或「每轮结束后暂停，手动继续」
- 设置页：软件版本、通知开关接线、界面语言持久化（zh-CN/English）、剧本化执行模式说明、每轮参考图固定 5 张说明
- 国际化：全部 UI 文案双语（简体中文/English）
- 数据库迁移版本机制（`user_version`）；关键写入（task_images / task_rounds / accounts）单事务
- Playwright Trace 开关（每轮保存 trace.zip，仅调试用，默认关闭）
- 失败诊断：保留截图 + HTML + 页面 URL（`extract_*.json`）

## [Unreleased - 2026-11-06 (partial)]

### 新增
- 任务行对“需人工干预 / 失败”状态提供“继续执行”按钮：人工处理后点击可从页面现状继续（已有生成图则直接提取下载；提示词未发送则提示用户确认发送后再点继续；全新页面则完整重跑），绝不盲目重复提交
- sidecar 自动识别并关闭豆包页面上的广告/推广/签到遮罩层（关闭按钮 → Escape → 点击遮罩角落，多轮验证生效），打开登录页时同样生效；提交按钮点击被遮挡时也会自动关闭遮罩后重试一次
- 创建任务不再需要输入任务名称，软件自动以“项目名-日期”生成（如：奶瓶收纳盒生图-2026-11-06）

### 修复
- “继续执行”此前完全没有入口，且 `task_resume` 把状态改为 preparing 后调度器永远不会捡取，任务卡死；现暂停任务走 `paused → pending` 重跑，“继续执行”走 `resume_task` 安全恢复流程（提取/下载/校验与完整流程共用一套收尾代码）
- 修复同一次应用启动中只有第一个任务能收到 sidecar 事件（事件接收器被首个任务永久取走、sidecar 又只在首次启动时创建通道）导致后续任务误判失败/卡死的问题；事件接收器改为跨任务共享的异步锁
- 任务“已暂停”后点击“继续”此前不生效（状态被改为 preparing，调度器只捡取 pending）

### 修复
- 安装版应用点击“创建任务”报“未找到 sidecar 入口”：安装包此前未随附 sidecar，且 Rust 端只从环境变量和 `%LOCALAPPDATA%\DoubaoBatchImage\sidecar` 查找（该位置从未被任何脚本写入）。现将 sidecar（src + node_modules）作为 Tauri bundle 资源随安装包部署，`resolve_sidecar_index` 优先从安装目录的 `resource_dir()/sidecar/src/index.js` 解析；环境变量 `SIDECAR_INDEX` 和旧的本地数据目录路径保留为兜底，报错信息列出所有已尝试位置
- sidecar 启动失败时，若缺少 Node.js（spawn 报 NotFound），日志明确提示需要 Node.js >= 20 及 `NODE_EXE` 设置方式

## [v1.0.0] - 2026-11-03

### 新增
- 豆包批量生图桌面软件初始版本
- Tauri 2 + React + Rust + SQLite 桌面架构
- Node.js + Playwright Chromium 自动化运行时（Sidecar）
- 多项目管理：创建、导入、删除、编辑
- 多账号管理：独立 Chromium 用户数据目录，登录状态持久化
- 参考图片递归扫描，文件夹独立抽取，每轮固定 5 张
- 持久化随机池，避免批次内重复
- 任务状态机：pending/preparing/selecting_images/waiting_confirmation/uploading/submitting/generating/downloading/verifying/completed/paused/failed/cancelled/needs_manual_intervention
- 任务暂停、继续、取消，支持异常恢复
- 原始图片提取（image_ori_raw），按实际格式保存
- 图片下载与 SHA-256 完整性校验
- 每轮元数据保存：prompt.txt、references.json、task.json
- 国际化：简体中文、英文
- 执行日志：完整记录任务执行过程
- Windows 安装包打包配置（Tauri）
- 更新检查机制（tauri-plugin-updater）

### 技术栈
- 桌面框架：Tauri 2
- 前端：React + TypeScript
- 后端：Rust
- 数据库：SQLite
- 自动化：Playwright Chromium (Node.js Sidecar)