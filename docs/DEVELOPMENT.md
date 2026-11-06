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

安装包输出在 `src-tauri/target/release/bundle/`（NSIS `.exe` / MSI）。

安装包内置 sidecar：`src-tauri/tauri.conf.json` 的 `bundle.resources` 将 `sidecar/src`、`sidecar/package.json`、`sidecar/node_modules` 复制到安装目录的 `sidecar/` 下，Rust 端 `resolve_sidecar_index` 优先从 `resource_dir()/sidecar/src/index.js` 解析。安装版仍依赖用户机器上的 Node.js（`node` 在 PATH 或 `NODE_EXE` 环境变量）和 Playwright Chromium（`npx playwright install chromium`）。

## 发布（Release）与签名

### 更新签名（ed25519，免费，必需）

用于自动更新时验证更新包完整性。私钥已生成并存放于 `C:\Users\mi\.tauri\ai-image-generate.key`（**勿提交、勿泄露、务必备份**）；对应公钥已写入 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`。

本地验证更新签名：

```bash
# PowerShell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$env:USERPROFILE\.tauri\ai-image-generate.key" -Raw
npx tauri build
```

### GitHub Actions 自动发布

仓库内置 `.github/workflows/release.yml`：推送 `v*` tag 时自动构建 Windows 安装包并发布 Release（含 `update.json` 与签名），供应用内更新检查使用。

需要在 GitHub 仓库 Settings → Secrets and variables → Actions 配置：

- `TAURI_SIGNING_PRIVATE_KEY` = `C:\Users\mi\.tauri\ai-image-generate.key` 的**文件完整内容**（私钥未设密码）

发布步骤：

```bash
git tag v0.1.1
git push origin v0.1.1
```

### Windows 代码签名（Authenticode，消除“未知发布者”）

计划通过 **SignPath Foundation**（免费开源代码签名）签名：

- 仓库已公开，并已添加 MIT LICENSE（符合其开源项目准入前提）
- 私钥与更新签名无关，由 SignPath 签发/托管，需自行向 SignPath Foundation 提交申请并通过审核
- 审核通过前，安装包会显示“未知发布者”提示，用户需手动选择“仍要运行”

（若 SignPath 未通过或未申请，可考虑 Microsoft Store 上架（平台代签）或购买 OV/EV 证书。）

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