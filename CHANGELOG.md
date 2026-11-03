# CHANGELOG

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