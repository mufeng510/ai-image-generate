# 技术架构设计 (ARCHITECTURE)

**项目**：豆包网页版批量生图桌面软件  
**阶段**：Phase 2 — 基础应用  
**依据**：`task.md` 三、技术架构；十四、数据库设计；十六、任务状态机

---

## 1. 整体架构

采用 **Tauri 2 + React (Vite) + TypeScript + Rust + SQLite** 架构，Node.js 作为 Tauri Sidecar 运行 Playwright 控制浏览器。

```
┌─────────────────────────────────────────────────────────────┐
│                    React 前端 (Vite + TS)                    │
│  仪表盘 / 项目管理 / 账号管理 / 任务队列 / 日志 / 设置        │
└──────────────────┬──────────────────────────────────────────┘
                   │ Tauri Commands / Events (IPC)
┌──────────────────▼──────────────────────────────────────────┐
│                 Rust 后端 (Tauri Core)                       │
│  ├─ Commands 层：项目/账号/任务/设置/国际化                  │
│  ├─ 数据库层：SQLite (rusqlite)，集中访问，事务保护          │
│  ├─ 任务调度器：状态机驱动，串行执行，支持暂停/继续/取消    │
│  └─ Sidecar 管理：启动/停止 Node.js 自动化进程               │
└──────────────────┬──────────────────────────────────────────┘
                   │ Sidecar 进程通信 (stdio)
┌──────────────────▼──────────────────────────────────────────┐
│           Node.js Sidecar (Playwright Chromium)              │
│  ├─ 启动可见 Chromium，每账号独立 userDataDir                │
│  ├─ 拦截 /chat/completion、/im/chain/single 响应              │
│  ├─ 提取 image_ori_raw 原图 URL                               │
│  ├─ 下载图片，按 Content-Type 保留扩展名                      │
│  └─ 通过 stdout 向 Rust 后端汇报进度/结果                     │
└─────────────────────────────────────────────────────────────┘
```

### 架构原则（task.md 三.1）
- 桌面 UI 与浏览器自动化逻辑分离（React vs. Node.js Sidecar）
- 任务调度与浏览器控制分离（Rust 任务调度器 vs. Playwright）
- 图片抽取与图片下载分离（抽取只产出 URL 列表，下载负责存储校验）
- 数据库访问集中管理（Rust 后端统一访问 SQLite，前端不直接操作 DB）
- 浏览器异常不导致桌面软件崩溃（Sidecar 独立进程，崩溃可重启）
- 自动化服务异常后可重新启动
- 所有耗时操作异步执行
- 前端不堆积复杂业务逻辑

---

## 2. 技术栈

| 层 | 技术 | 版本 | 用途 |
|---|---|---|---|
| 桌面框架 | Tauri 2 | 2.x | 窗口、IPC、打包、更新 |
| 前端 | React 18 + TypeScript + Vite | 最新 | UI 界面 |
| 后端 | Rust 1.99 | 1.99.1 | 业务逻辑、DB 访问、任务调度 |
| 数据库 | SQLite | rusqlite | 任务/账号/项目/日志持久化 |
| 自动化运行时 | Node.js (Sidecar) | 24.x | 运行 Playwright |
| 浏览器自动化 | Playwright Chromium | 1.64.1 | 控制豆包网页 |
| 前后端通信 | Tauri Commands / Events | - | 同步命令 / 异步事件 |
| 安装包 | Tauri 打包器 (NSIS/MSI) | - | Windows 安装程序 |
| 国际化 | fluent / 自定义 JSON | - | 中/英切换 |

---

## 3. 目录结构

```
ai-image-generate/
├── src-tauri/                  # Rust 后端
│   ├── Cargo.toml
│   ├── src/
│   │   ├── main.rs             # Tauri 入口，注册 commands + sidecar
│   │   ├── commands.rs         # Tauri Command 注册
│   │   ├── db.rs               # SQLite 连接池与初始化
│   │   ├── schema.rs           # 建表 + 迁移
│   │   ├── models.rs           # 数据模型 (struct + serde)
│   │   ├── project.rs          # 项目业务逻辑
│   │   ├── account.rs          # 账号业务逻辑
│   │   ├── task.rs             # 任务调度与状态机
│   │   ├── settings.rs         # 系统设置
│   │   ├── i18n.rs             # 国际化资源加载
│   │   └── sidecar.rs          # Node.js Sidecar 进程管理
│   ├── tauri.conf.json
│   └── ...
├── src/                        # React 前端
│   ├── main.tsx
│   ├── App.tsx
│   ├── i18n/                   # 语言资源 (zh-CN.json, en-US.json)
│   ├── components/             # 通用组件
│   ├── pages/                  # 页面 (Dashboard, Projects, Accounts, Tasks, Logs, Settings)
│   ├── hooks/                  # 自定义 Hook (invoke commands)
│   └── ...
├── sidecar/                    # Node.js 自动化运行时
│   ├── package.json
│   ├── src/
│   │   ├── index.js            # Sidecar 入口，监听 stdin
│   │   ├── browser.js          # Playwright 启动/控制
│   │   ├── extractor.js        # 图片提取 (image_ori_raw)
│   │   └── downloader.js       # 图片下载 + 校验
│   └── ...
├── docs/
├── prototype/                  # Phase 1 原型 (保留)
├── task.md
└── ...
```

---

## 4. 数据库设计 (SQLite)

所有表使用 `id INTEGER PRIMARY KEY AUTOINCREMENT`，关键状态更新使用事务，常用查询建立索引。

### 4.1 projects
| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 项目 ID |
| name | TEXT | 项目名称 |
| root_path | TEXT | 项目根目录 |
| prompt_path | TEXT | prompt.txt 相对路径 |
| created_at | TEXT | 创建时间 |
| updated_at | TEXT | 更新时间 |

索引：`name`

### 4.2 accounts
| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 账号 ID |
| name | TEXT | 用户自定义名称 |
| user_data_dir | TEXT | Chromium 用户数据目录路径 |
| status | TEXT | 登录状态 (logged_in/logged_out/unknown) |
| image_threshold | INTEGER | 用户自定义图片数量阈值 |
| success_count | INTEGER | 累计成功图片数 |
| submit_count | INTEGER | 提交轮数 |
| last_used_at | TEXT | 最近使用时间 |
| created_at | TEXT | 创建时间 |

索引：`name`, `status`

> 登录 Cookie/会话不存入数据库，仅保存在独立 userDataDir。

### 4.3 tasks
| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 任务 ID |
| name | TEXT | 任务名称 |
| project_id | INTEGER FK | 所属项目 |
| account_id | INTEGER FK | 当前账号 |
| status | TEXT | 任务状态 (见 6.1) |
| current_round | INTEGER | 当前轮次 |
| total_rounds | INTEGER | 计划轮数 |
| created_at | TEXT | 创建时间 |
| updated_at | TEXT | 更新时间 |
| started_at | TEXT | 开始时间 |
| completed_at | TEXT | 完成时间 |

索引：`project_id`, `account_id`, `status`, `updated_at`

### 4.4 task_rounds
| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 轮次 ID |
| task_id | INTEGER FK | 所属任务 |
| round_number | INTEGER | 轮次编号 |
| prompt_snapshot | TEXT | 本轮提示词快照 |
| references_json | TEXT | 参考图片列表 (JSON) |
| status | TEXT | 轮次状态 |
| submitted_at | TEXT | 提交时间 |
| completed_at | TEXT | 完成时间 |
| success_count | INTEGER | 成功图片数 |
| failure_reason | TEXT | 失败原因 |

索引：`task_id`, `status`

### 4.5 task_images
| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 图片 ID |
| task_round_id | INTEGER FK | 所属轮次 |
| image_index | INTEGER | 图片编号 (001, 002...) |
| original_url | TEXT | 原始图片 URL |
| saved_path | TEXT | 保存路径 |
| sha256 | TEXT | 文件哈希 |
| file_size | INTEGER | 文件大小 |
| format | TEXT | 实际格式 (jpg/png/webp...) |
| download_status | TEXT | 下载状态 |

索引：`task_round_id`, `image_index`

### 4.6 image_pool_records
| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 记录 ID |
| project_id | INTEGER FK | 所属项目 |
| image_path | TEXT | 参考图片路径 |
| sha256 | TEXT | 图片哈希 |
| last_used_at | TEXT | 上次使用时间 |
| use_count | INTEGER | 使用次数 |

索引：`project_id`, `sha256`

### 4.7 execution_logs
| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 日志 ID |
| task_id | INTEGER FK | 关联任务 (可空) |
| level | TEXT | info/warn/error |
| message | TEXT | 日志内容 (脱敏) |
| created_at | TEXT | 时间 |

索引：`task_id`, `created_at`, `level`

### 4.8 app_settings
| 字段 | 类型 | 说明 |
|---|---|---|
| key | TEXT PK | 设置键 |
| value | TEXT | 设置值 |

---

## 5. 前后端通信 (Tauri Commands / Events)

### 5.1 Commands (前端 → 后端)

| Command | 说明 | 参数 | 返回 |
|---|---|---|---|
| `project_list` | 列出项目 | - | `Vec<Project>` |
| `project_create` | 创建项目 | `name, path` | `Project` |
| `project_import` | 导入项目 | `path` | `Project` |
| `project_delete` | 删除项目 | `id` | `Result` |
| `project_update` | 修改项目名称 | `id, name` | `Result` |
| `project_prompt_save` | 保存提示词 | `project_id, content` | `Result` |
| `account_list` | 列出账号 | - | `Vec<Account>` |
| `account_add` | 添加账号 | `name` | `Account` |
| `account_delete` | 删除账号 | `id` | `Result` |
| `account_reorder` | 调整顺序 | `ids` | `Result` |
| `account_set_threshold` | 设置阈值 | `id, threshold` | `Result` |
| `task_create` | 创建任务 | `name, project_id, account_id` | `Task` |
| `task_start` | 开始任务 | `id` | `Result` |
| `task_pause` | 暂停任务 | `id` | `Result` |
| `task_resume` | 继续任务 | `id` | `Result` |
| `task_cancel` | 取消任务 | `id` | `Result` |
| `task_list` | 列出任务 | - | `Vec<Task>` |
| `task_detail` | 任务详情 | `id` | `TaskDetail` |
| `settings_get` | 获取设置 | `key` | `String` |
| `settings_set` | 设置设置 | `key, value` | `Result` |
| `lang_switch` | 切换语言 | `lang` | `Result` |

### 5.2 Events (后端 → 前端)

| Event | 说明 | 载荷 |
|---|---|---|
| `task-status-changed` | 任务状态变更 | `{task_id, status}` |
| `task-progress` | 任务进度 | `{task_id, round, total, current}` |
| `task-log` | 执行日志 | `{task_id, level, message}` |
| `task-completed` | 任务完成 | `{task_id}` |
| `task-error` | 任务错误 | `{task_id, error}` |
| `account-login-required` | 需要登录 | `{account_id}` |
| `download-progress` | 下载进度 | `{round_id, current, total}` |

> 日志中不得输出 Cookie、密码、完整授权头等敏感信息。

---

## 6. 任务状态机 (task.md 十六)

```
pending ──▶ preparing ──▶ selecting_images ──▶ waiting_confirmation
   │              │                    │               │
   │              │                    │               ▼
   │              │                    │          uploading ──▶ submitting
   │              │                    │               │           │
   │              │                    │               ▼           ▼
   │              │                    │           generating ──▶ downloading
   │              │                    │               │           │
   │              │                    │               ▼           ▼
   │              │                    │           verifying ──▶ completed
   │              │                    │               │
   │              │                    │               ▼
   │              └───────────────────┴────▶ paused ◀──────────┘
   │                                       │         │
   │                                       ▼         ▼
   │                                    failed   cancelled
   │                                       │
   │                                       ▼
   │                                 needs_manual_intervention
   │                                       │
   └───────────────────────────────────────┘
```

### 状态转换条件
- `pending → preparing`: 任务创建后，开始准备
- `preparing → selecting_images`: 项目和账号就绪，开始抽图
- `selecting_images → waiting_confirmation`: 抽图完成，等待人工确认（自动模式直接进入 uploading）
- `waiting_confirmation → uploading`: 用户确认后开始上传
- `uploading → submitting`: 5 张参考图上传完成
- `submitting → generating`: 生图任务提交成功，服务端开始生成
- `generating → downloading`: 检测到生成完成，全部图片已提取
- `downloading → verifying`: 全部图片下载完成
- `verifying → completed`: 完整性校验通过
- `任何状态 → paused`: 用户暂停
- `paused → preparing`: 用户继续，从中断点恢复
- `任何状态 → cancelled`: 用户取消
- `任何状态 → failed`: 出现不可恢复错误
- `任何状态 → needs_manual_intervention`: 登录失效/验证码/网页结构变化

### 状态特殊说明
- 已提交 ≠ 正在生成：submitting 已发送请求，generating 服务端确认开始生成
- 已生成 ≠ 已下载：generating 完成，downloading 正在下载，completed 全部校验通过
- 不得将“已提交”直接重新提交，状态不明确时暂停并要求人工检查

---

## 7. 失败处理与恢复

| 错误类型 | 处理 |
|---|---|
| 临时网络错误 | 自动重试 (最大重试次数可配置) |
| 下载中断 | 重新下载未完成文件 |
| 登录失效 | 暂停任务，等待人工登录，继续前重新检查页面状态 |
| 验证码 | 暂停任务，等待人工处理 |
| 账号限制/额度耗尽 | 暂停整个队列，提示用户 |
| 网页结构变化 | 停止任务，保存截图和诊断信息，提示用户 |
| 生图提交状态不明确 | 不允许直接重新提交 |
| 文件校验失败 | 重新下载 |

软件关闭后不自动恢复任务，下次启动展示未完成任务，允许用户手动恢复。

---

## 8. 安全与隐私

- 登录 Cookie/会话仅保存在独立 Chromium userDataDir，不写入 SQLite
- 日志中不输出 Cookie、密码、完整授权头
- 诊断数据（截图、HTML）脱敏后保存
- 图片文件和数据库记录保持一致
- 数据库使用事务保护关键状态更新

---

## 9. 国际化 (i18n)

- 支持简体中文 (zh-CN) 和英文 (en-US)
- 所有 UI 文案使用国际化资源文件，禁止硬编码
- 设置中可切换语言

---

## 10. Phase 2 验收标准

- Tauri 项目可正常编译和运行 (Windows)
- React 前端可正常渲染主界面（左侧导航 + 右侧工作区）
- 能创建、导入、删除项目
- 能添加、删除、调整账号顺序
- 数据库表创建正确，迁移机制可用
- Tauri Commands 可正常调用，前端不直接操作数据库
- 支持中/英文切换
- 基础设置可读写

---

## 11. 后续阶段衔接

- Phase 3：图片扫描、文件夹独立抽取、持久化随机池、多轮生图、任务队列、暂停/继续/取消、错误分类、任务恢复
- Phase 4：生成结果识别、原始图片提取、下载、完整性校验、图片预览
- Phase 5：完善界面 (仪表盘、日志、通知等)
- Phase 6：Windows 安装包与更新
