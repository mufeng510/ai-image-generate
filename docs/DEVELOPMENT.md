# 开发文档

## 开发环境

- Node.js >= 20
- Rust >= 1.70
- Windows 10/11

## 项目结构

```
ai-image-generate/
├── docs/                 # 技术文档
├── prototype/            # Phase 1 原型（Node.js + Playwright）
├── src/                  # React 前端
├── src-tauri/            # Rust 后端（Tauri 2）
├── sidecar/              # Node.js 自动化运行时
└── task.md               # 开发任务书
```

## 前端开发

### 启动开发服务器

```bash
npm install
npm run dev
```

### 生产构建

```bash
npm run build
```

输出目录：`src-tauri/gen/dist/`

## 后端开发

### 编译检查

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

### 运行应用

```bash
cargo tauri dev
```

### 打包安装包

```bash
cargo tauri build
```

## 侧边车（Sidecar）

`sidecar/` 目录下是 Node.js 自动化运行时，负责 Playwright Chromium 浏览器控制。

- `index.js`: 主入口，stdin/stdout JSON 行协议通信
- `extractor.js`: DOM 图片提取
- `downloader.js`: 图片下载与校验
- `scanner.js`: 递归图片扫描
- `pool.js`: 持久化随机池

## 数据库

使用 SQLite，表结构见 `src-tauri/src/schema.rs`。

主要表：
- projects: 项目
- accounts: 账号
- tasks: 任务
- task_rounds: 任务轮次
- task_images: 任务图片
- image_pool_records: 图片池记录
- execution_logs: 执行日志
- app_settings: 应用设置

## 国际化

使用 `src/i18n/index.tsx` 管理多语言文本，目前支持简体中文和英文。

## 代码规范

- Rust: 使用 `cargo fmt` 格式化
- TypeScript: 使用 ESLint + Prettier
- 提交信息：使用 Conventional Commits