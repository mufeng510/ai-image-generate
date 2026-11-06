# CHANGELOG

## [Unreleased]

### 新增
- 任务行对“需人工干预 / 失败”状态提供“继续执行”按钮：人工处理后点击可从页面现状继续（已有生成图则直接提取下载；提示词未发送则提示用户确认发送后再点继续；全新页面则完整重跑），绝不盲目重复提交
- sidecar 自动识别并关闭豆包页面上的广告/推广/签到遮罩层（关闭按钮 → Escape → 点击遮罩角落，多轮验证生效），打开登录页时同样生效；提交按钮点击被遮挡时也会自动关闭遮罩后重试一次

### 修复
- “继续执行”此前完全没有入口，且 `task_resume` 把状态改为 preparing 后调度器永远不会捡取，任务卡死；现暂停任务走 `paused → pending` 重跑，“继续执行”走 `resume_task` 安全恢复流程（提取/下载/校验与完整流程共用一套收尾代码）
- 修复同一次应用启动中只有第一个任务能收到 sidecar 事件（事件接收器被首个任务永久取走、sidecar 又只在首次启动时创建通道）导致后续任务误判失败/卡死的问题；事件接收器改为跨任务共享的异步锁
- 任务“已暂停”后点击“继续”此前不生效（状态被改为 preparing，调度器只捡取 pending）

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