# 豆包批量生图桌面软件

豆包网页版批量生图桌面软件 — 自动化完成多项目批量生图，保存原始无水印图片。

## 功能特性

- **多项目管理**：独立管理多个生图项目，每个项目包含提示词和参考图片
- **文件夹独立抽取**：按文件夹独立抽取参考图片，每轮固定抽取 5 张
- **多账号独立登录**：每个豆包账号使用独立 Chromium 用户数据目录，登录状态持久化
- **多项目任务队列**：串行执行多个项目任务，支持暂停、继续、取消
- **原始图片提取**：直接提取豆包网页返回的原始无水印图片 URL，保留实际格式（JPG/PNG/WEBP 等）
- **下载校验**：SHA-256 哈希校验，文件大小和内容完整性验证
- **任务状态机**：支持 pending/preparing/selecting_images/uploading/submitting/generating/downloading/verifying/completed/paused/failed/cancelled/needs_manual_intervention 等状态
- **异常恢复**：登录失效、验证码、网页结构变化等异常处理，暂停并等待人工处理
- **国际化**：支持简体中文和英文

## 代码签名政策（Code signing policy）

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

- **Team roles**
  - Committers and reviewers: [mufeng510](https://github.com/mufeng510)（项目作者与维护者）
  - Approvers: [mufeng510](https://github.com/mufeng510)
- **Privacy policy**: This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it. 所有参考图片、提示词、豆包登录会话均保留在用户本机（`%LOCALAPPDATA%\DoubaoBatchImage` 与项目目录），不上传任何数据。
- **Uninstallation**: 卸载程序位于安装目录，或使用 Windows"设置 → 应用"卸载；应用不会修改用户系统配置，也不会驻留后台服务。


## 技术架构

- **桌面框架**：Tauri 2 (Rust + React)
- **自动化运行时**：Node.js + Playwright Chromium（Sidecar 模式）
- **数据库**：SQLite
- **通信**：Tauri Commands / Events

## 快速开始

### 环境要求

- Node.js >= 20
- Rust >= 1.70
- Windows 10/11

### 安装与运行

```bash
# 克隆仓库
git clone <repository-url>
cd ai-image-generate

# 安装前端依赖
npm install

# 前端构建
npm run build

# Rust 后端检查
cargo check --manifest-path src-tauri/Cargo.toml

# 启动开发模式
cargo tauri dev
```

## 项目结构

```
ai-image-generate/
├── docs/                 # 技术文档
├── prototype/            # Phase 1 原型（Node.js + Playwright）
├── src/                  # React 前端
├── src-tauri/            # Rust 后端（Tauri 2）
├── sidecar/              # Node.js 自动化运行时
├── task.md               # 开发任务书
└── README.md
```

## 开发阶段

- Phase 0: 技术调研与验证报告
- Phase 1: 最小可行性原型
- Phase 2: 基础应用（Tauri + React + Rust + SQLite）
- Phase 3: 图片和任务系统
- Phase 4: 结果管理
- Phase 5: 完善界面
- Phase 6: 安装和更新
- Phase 7: 完整测试

## 许可证

MIT License