# 任务文件夹接入 AI Image Process「生成实况图片」实施方案

状态：**已实施**（v1.6.0；输入/输出/事件/通知/清理均已接线，真实端到端待最终验收）
适用版本：`ai-image-generate` v1.6.0（Tauri 2 + React + Rust + SQLite）／`ai-image-process` v0.10.1

---

## 1. 已确认的需求

| # | 需求 | 落地方式 |
|---|------|----------|
| 1 | 处理**整个任务的所有轮次** | 传入**任务文件夹本身**（`<项目>/output/<唯一任务文件夹名>/`，从 `tasks.output_folder` 读取，旧数据回落清洗后的任务名），开启 AI Image Process 的递归扫描 `input.recurse_folders=true`，一次调用覆盖全部轮次子目录 |
| 5 | 转实况成功后任务记录消失 | AIP 0.10+ 的 `--delete-originals` 删除整个任务文件夹；软件确认 `originals_deleted>0` 且文件夹不存在后，事务清理 `task_images`/`task_rounds`/`tasks`；旧版 AIP 自动回退为保留原件 |
| 2 | AI Image Process 自带运行时，只需在设置页配置它的目录 | 新增设置项 `aip_root_dir`，从该目录解析 CLI 可执行文件；不随本软件打包 |
| 3 | 输出到 AI Image Process 自己的默认输出目录，本项目不保留实况图片 | 读取 AIP 配置里的 `output.directory` 作为 `-o` 参数；本软件不接收、不搬运产物，只在日志里报告结果 |
| 4 | 实况视频来源使用**本地动态** | 固定 `--enable-live-photo --video-source local_motion`，并在配置中锁定 `steps.live_photo.enabled=true` |

---

## 2. 可行性结论：可以实现

已在同级目录 `..\ai-image-process` 用其自带 `.venv` 做过真实验证（证据见第 9 节）：

- 对**文件夹**输入（含非图片文件 `prompt.txt`、`references.json`）执行 CLI，非图片文件被自动忽略。
- 开启递归后，子文件夹中的图片全部被收集（`planned_input_count` 正确）。
- 本地动态 Live Photo 实跑成功：`rc=0`，每张输入产出同名 `JPG + MOV` 配对，摘要 JSON 的 `outputs` 给出每个 `source → output`。
- 用 `--json-summary` 时 stdout **只有 JSON**，进度日志走 stderr，适合 Rust 解析。

因此调用形态就是：`CLI <任务输出目录> -o <AIP默认输出目录> --config <临时配置> --enable-live-photo --video-source local_motion --json-summary`。

---

## 3. 两个项目的关键事实

### 3.1 本项目（`ai-image-generate`）

- 任务队列页面：`src/pages/Execution.tsx`，表格每行是一个 **task**，不是 round。
- 任务详情页：`src/pages/RoundDetail.tsx`，展示该任务的所有轮次与选中轮次的图片；「打开目录」按钮出现在轮次列表每行与图片详情标题栏两处。**「生成实况图片」按钮放在图片详情标题栏、与「打开目录」并排**（每个任务只有一个按钮，处理整个任务的所有轮次，而不是当前选中的单轮）。
- 前端命令封装：`src/hooks/api.ts`（`invoke('...')`）；新增命令在此加函数。
- Rust 命令注册：`src-tauri/src/main.rs` 的 `generate_handler!`；命令实现在 `src-tauri/src/commands.rs`，调度器在 `task_scheduler.rs`。
- 每轮的产物目录记录在 `task_rounds.output_dir`：
  `<项目根>/output/<清洗后的任务名>/<毫秒时间戳轮次目录>/`，内含生成的图片、`prompt.txt`、`references.json`、`task.json`。
  所以**任务文件夹本身**就是 `<项目根>/output/<清洗后的任务名>/`，轮次目录是它的子目录。
  后端直接用 `tasks.name` + `projects.root_path` 调用调度器现有的 `task_output_dir()` 算出这个路径（把 `sanitize_dir_component()` / `task_output_dir()` 改为 `pub(crate)` 复用），**不绕轮次表**。
  这样做是安全的：项目里没有 `task_rename` 命令，任务名创建后不变；项目改名时 `projects.root_path` 会同步更新（`commands.rs:390`），算出的路径随之正确。
- 设置项存 `app_settings` 表，通过 `settings_get` / `settings_set` 读写；前端已有 `@tauri-apps/plugin-dialog` 的目录选择器用法（`Projects.tsx`）。
- 现有 Node sidecar 已提供 Windows 隐藏窗口启动外部进程的范式：`task_scheduler.rs:30` 的 `CREATE_NO_WINDOW`、`resolve_sidecar_index()` 的开发/安装双路径解析。本方案沿用同一范式。

### 3.2 AI Image Process（`ai-image-process`）

- CLI 入口：
  - 发行包/便携包：`<AIP目录>/AI-Image-Process-CLI(.exe)`（**必须**用 `-CLI` 入口；GUI 入口传参不会执行，只会弹窗后退出）。
  - 源码仓库：`<AIP目录>/.venv/Scripts/python.exe`，参数前缀 `-m app cli`，工作目录设为 `<AIP目录>`。
- 默认配置路径：便携模式 `<AIP目录>/config/config.json`；普通安装 `%APPDATA%/AI-Image-Process/config.json`。其中 `output.directory` 就是用户在 AIP 图形界面里配置的「默认输出目录」。
- 预检（`rc=2`，零产出）的高发原因：
  - `steps.hidden_image.enabled` 默认为 `true`，未配置素材库会直接拒绝。**本方案不强制关闭它**，而是沿用用户在 AIP 里的设置；一旦因此失败，按 AIP 的 `preflight_error` 原样报错（用户要求）。
  - **输出目录不能位于递归输入目录之内**，否则预检拒绝 → 本方案显式检查并报错。
  - 非 JPG 输入如果没有重编码步骤会被拒；默认 `reencode.enabled=true`，可满足。
- 摘要 JSON（`--json-summary`）：`success` / `failed` / `preflight_failed` / `preflight_error` / `outputs[{source,output}]` / `failures[{file,error}]`。
  退出码：`0` 全成功、`1` 部分失败、`2` 预检失败（仍需读 `failed` 字段确认）。
- 产物恒为大写 `.JPG`，Live Photo 配对为同名 `.MOV`（爱思助手要求）。
- 配置是**局部覆盖**；为使覆盖可预测，生成的临时配置显式写 `config_version: 2`（否则迁移逻辑会按 v1 规则注入 `enabled:false` 的旧默认值）。

---

## 4. 总体设计

```
RoundDetail.tsx（任务详情页）[生成实况图片] 按钮
        │ invoke('live_photo_generate', { task_id })
        ▼
Rust commands.rs
  1. 读设置 aip_root_dir → 解析 CLI  exe / venv-python
  2. 查 tasks.name + projects.root_path → 用 `task_output_dir()` 直接算出任务文件夹（输入目录）
  3. 读 AIP config.json → 取 output.directory（用户默认输出目录，必填）
  4. 合并出临时配置 JSON（递归开、本地动态、禁止删原件；隐藏图等沿用 AIP 原配置）
  5. spawn_blocking 启动 CLI（CREATE_NO_WINDOW，stdout/stderr 管道）
     ├─ stderr 行 → emit('live-photo-progress', {...}) → 详情页状态行
     └─ stdout JSON → 解析摘要 → emit('live-photo-finished', {...})
        + notification_create(...) 软件内通知
        + 删除临时配置文件
```

- **不改变任务状态机**：本功能是对已完成图片的后期处理，不写 `tasks.status`。
- **不新增数据库表**：只复用 `app_settings`（新增一个键）和 `notifications`（复用现有通知）。
- **并发保护**：进程级 `AtomicBool` 闸门，同时只允许一个实况任务；前端按钮在运行中禁用。

---

## 5. 后端详细改动

### 5.1 新文件 `src-tauri/src/live_photo.rs`（建议独立模块，避免 `commands.rs` 继续膨胀）

职责与函数：

| 函数 | 说明 |
|------|------|
| `resolve_cli(aip_root: &Path) -> Result<ResolvedCli, String>` | 依次尝试 `<root>/AI-Image-Process-CLI.exe`、`<root>/AI-Image-Process-CLI`、`<root>/dist/AI-Image-Process-CLI.exe`；再尝试 `<root>/.venv/Scripts/python.exe`（或 `bin/python`）且存在 `app/main_cli.py` 时返回 `{ program, pre_args: ["-m","app","cli"], cwd: root }` |
| `load_aip_config(aip_root: &Path) -> Result<serde_json::Value, String>` | 优先 `<root>/config/config.json`，否则 `%APPDATA%/AI-Image-Process/config.json`（用 `std::env::var("APPDATA")`），读为 `Value` |
| `task_input_dir(task_id) -> Result<PathBuf, String>` | `SELECT t.name, t.output_folder, p.root_path ...`；优先用 `tasks.output_folder`，旧数据回落清洗后的任务名；目录不存在则报错「该任务尚无输出目录」 |
| `apply_run_overrides` / `build_run_config` | 深拷贝 AIP 配置，强制覆盖下表字段，写 `config_version: 2`；删除原件由命令行开关控制，不写进配置 |
| `read_delete_source_setting` / `detect_delete_support` | 读 `live_photo_delete_source`（默认开）；探测 AIP `--version`，`>=0.10` 才传 `--delete-originals`，旧版回退 `--no-delete-originals` 并提示 |
| `cleanup_task_records(task_id, input_dir, deleted)` | 仅在 `deleted>0` 且目录不存在时，刷新账号统计后事务删三张表；否则保留记录并回显原因 |
| `spawn_and_wait(cli, input_dir, output_dir, cfg_path, app) -> Result<Summary, String>` | `std::process::Command` + `CREATE_NO_WINDOW` + `Stdio::piped()`；设置 `PYTHONIOENCODING=utf-8`；逐行读 stderr 发事件；读完整 stdout 后按 UTF-8 解析 JSON；返回摘要与退出码 |
| `verify_path_safety(input_dir, output_dir) -> Result<(), String>` | 输出目录若在输入目录内（或相等）直接拒绝，错误信息引用 AIP 的预检规则 |

**必须强制覆盖的配置**（写进临时 JSON，合并进用户 AIP 配置）：

```jsonc
{
  "config_version": 2,
  "input": {
    "recurse_folders": true              // 一次覆盖所有轮次
    // 不再写 delete_originals_after_run：由 --delete-originals / --no-delete-originals 显式控制
  },
  "output": {
    "use_source_directory": false        // 安全：不往输入目录写
  },
  "steps": {
    "live_photo": { "enabled": true, "video_source": "local_motion" }
  }
}
```

> 命令行参数形态：`CLI <任务文件夹> -o <AIP默认目录> --config <临时配置> --enable-live-photo --video-source local_motion --delete-originals（或 --no-delete-originals） --json-summary`。摘要 JSON 新增 `originals_deleted` / `originals_failed`。
>
> `steps.hidden_image` 等其他步骤**不覆盖**，沿用用户在 AIP 中的配置；若隐藏图素材不足等原因导致预检失败，直接把 AIP 的 `preflight_error` 报给用户，不静默降级。

- 临时配置写到本软件数据目录（复用 `app_data_dir()`），文件名带 `job_id` 或时间戳，避免并发冲突；`finally` 删除。
- `PYTHONIOENCODING=utf-8` 保证中文预检错误不乱码（实测 Windows 控制台默认编码会乱码）。
- 若用户 AIP 配置里 `output.directory` 为空 → 返回清晰错误：「请先在 AI Image Process 中设置默认输出目录」。
- 若 AIP 配置缺失（首次安装）→ 用默认配置，但 `output.directory` 为空时同样报错，不擅自替用户选目录。

### 5.2 命令与事件

在 `commands.rs` 新增：

```rust
#[tauri::command(rename_all = "snake_case")]
pub async fn live_photo_generate(app: AppHandle, task_id: i64) -> Result<String, String>
```

- 立即返回 `job_id`（形如 `lp-<毫秒>-<随机>`），后台线程执行；闸门占用期间重复调用返回「已有实况图片任务在运行」。
- 在 `main.rs` 的 `generate_handler!` 注册。

事件（遵循现有 kebab-case 命名）：

| 事件 | 载荷 | 用途 |
|------|------|------|
| `live-photo-progress` | `{task_id, job_id, line}` | CLI stderr 进度/日志 → 前端日志区 |
| `live-photo-finished` | `{task_id, job_id, ok, success, failed, preflight_failed, preflight_error, output_dir, error?}` | 终态（成功/部分失败/失败） |

同时用 `notification_create(kind="live_photo", ...)` 写一条软件内通知；成功时标题含成功张数，失败时含 `preflight_error` 或解析错误。

### 5.3 退出码判定

| CLI rc | 处理 |
|--------|------|
| 0 | 成功；仍以摘要 `failed==0 && outputs.len()>0` 复核，空产物视为失败 |
| 1 | 部分失败；`ok=false`，日志列出 `failures[]` |
| 2 | 预检失败；`ok=false`，展示 `preflight_error` |
| 其他/无法解析 JSON | `ok=false`，附 stderr 尾部片段 |

---

## 6. 前端详细改动

### 6.1 `src/hooks/api.ts`

```ts
export interface LivePhotoFinished {
  task_id: number
  job_id: string
  ok: boolean
  success: number
  failed: number
  preflight_failed: boolean
  preflight_error: string | null
  output_dir: string | null
  error?: string | null
}

export async function livePhotoGenerate(task_id: number): Promise<string> {
  return invoke('live_photo_generate', { task_id })
}
```

### 6.2 `src/pages/RoundDetail.tsx`（任务详情页）

- 在**图片详情标题栏**、与「打开目录」按钮并排处增加「生成实况图片」按钮（有轮次时显示，每任务一个）；运行中禁用并显示「生成中…」。
- 点击后：`await livePhotoGenerate(taskId)`，记录 `job_id`，并在按钮旁的状态行显示最近一条进度。
- 用独立 `useEffect` 注册 `listen('live-photo-progress')` 与 `listen('live-photo-finished')`，只响应 `task_id === taskId` 的事件：
  - progress → 更新状态行为 CLI 的进度行。
  - finished → 解除禁用，状态行显示成功张数或失败原因（含 AIP 的 `preflight_error`）；失败同时由后端写入软件内通知。
- 卸载时 `unlisten`。`src/pages/Execution.tsx`（任务队列页）不再放该按钮。

### 6.3 `src/pages/Settings.tsx`

- 新增「AI Image Process」分组：
  - 文本框：AI Image Process 安装/解压目录（设置键 `aip_root_dir`）。
  - 「浏览…」按钮：`openDialog({ directory: true })`（参照 `Projects.tsx`）。
  - 「测试」按钮（可选，建议）：调用新命令 `live_photo_probe()` 校验目录里能找到 CLI、能读到默认输出目录，并把结果回显；便于用户自查。
  - 说明文案：实况图片输出到 AI Image Process 自己配置的默认目录；本软件不复制、不保留产物；目录里需包含 `AI-Image-Process-CLI.exe`（发行包）或 `.venv`（源码运行）。

### 6.4 `src/i18n/index.tsx`

在 `zh-CN` 与 `en-US` 两个字典里补齐：

- `btn.generateLivePhoto` / `btn.generatingLivePhoto`
- `tasks.livePhotoHint`、`tasks.livePhotoStarted`、`tasks.livePhotoDone`、`tasks.livePhotoFailed`
- `settings.aipRootDir`、`settings.aipRootDirHint`、`settings.aipProbe`、`settings.aipProbeOk`、`settings.aipProbeFail`

（现有代码禁止硬编码 UI 文案，见 `docs/ARCHITECTURE.md` §9。）

---

## 7. 错误处理与边界清单

1. 未配置 `aip_root_dir` / 目录不存在 → 命令直接报错，前端提示去设置页配置。
2. 目录里既没有 CLI exe 也没有 `.venv` python → 报错并列出尝试过的路径。
3. 任务文件夹不存在（还没生成过任何轮次）→ 报错「该任务尚无输出目录」。
4. AIP 默认输出目录为空 → 报错「请先在 AI Image Process 中设置默认输出目录」。
5. 输出目录位于任务输入目录内 → 拒绝（AIP 会 `rc=2`，提前给出更易懂的提示）。
6. 删除原件不可逆：设置页 `live_photo_delete_source` 默认开启并有明确警示；AIP 0.10+ 用 `--delete-originals` 显式开启，旧版自动 `--no-delete-originals` 并提示；只有 `originals_deleted>0` 且文件夹已不存在才清理 DB 记录，CLI 因安全规则跳过时保留任务记录并回显原因。
7. 跨轮次内容相同的图片会被 AIP 去重合并成一张 → 属预期行为，在界面提示里说明。
8. `--seed` 不保证字节级复现 → 不把校验和用于判断成功。
9. CLI 进程随软件退出而残留 → v1 先接受；v2 可增加「关闭软件时终止子进程」的清理逻辑。
10. 多个任务并发点击 → 进程级闸门 + 按钮禁用双保险。

---

## 8. 实施顺序与验收

1. **Rust 后端**：新增 `live_photo.rs`，实现路径解析、配置生成、子进程、事件、通知；注册命令；加单元测试（CLI 候选解析、配置覆盖、路径安全、摘要解析）。
2. **前端 API 与按钮**：`api.ts` + `RoundDetail.tsx`（任务详情页，与「打开目录」并排）+ i18n，事件监听与状态展示。
3. **设置页**：`aip_root_dir` 输入框、目录选择、可选测试按钮。
4. **文档同步**：`docs/ARCHITECTURE.md` §5 命令/事件表、`README.md` 功能特性、`docs/USER_GUIDE.md` 操作步骤。
5. **测试**：`cargo test --manifest-path src-tauri/Cargo.toml`；`npm run build`；手工 E2E（见下）。
6. **手工 E2E 验收**：
   - 在开发环境准备一个含 ≥2 轮的任务（复用现有 output 目录结构即可）。
   - 设置页填入 `C:\Users\jerry\Documents\ai-image-process`（源码目录）或发行包解压目录。
   - 点击「生成实况图片」：日志区出现进度，结束后提示成功 N 张。
   - 到 AIP 配置的默认输出目录确认存在 `*.JPG + *.MOV` 配对；本项目 `output/` 下**不产生**任何实况文件。开启删除时任务文件夹被 AIP 整目录永久删除，软件确认 `originals_deleted>0` 且目录不存在后清理 DB 记录；关闭删除时原图与任务记录均保留。
   - 负向用例：清空 AIP 输出目录设置、把输出目录指到任务目录内、AIP 隐藏图素材不足（沿用用户配置，不强制关闭），均应得到明确错误且零产出。

---

## 9. 实测证据（本次方案调研）

全部在 `C:\Users\jerry\Documents\ai-image-process` 下用 `.venv\Scripts\python.exe` 执行，临时目录位于 `C:\Users\jerry\AppData\Local\Temp\opencode\`：

| 验证项 | 命令/条件 | 结果 |
|--------|-----------|------|
| CLI 可用 | `-m app cli --version` / `--list-steps` | 调研时 `ai-image-process 0.9.2`；本次接线核实仓库已到 `0.10.1`（提交 `940f28d`），新增 `--delete-originals` 与安全删除模块 |
| 目录输入 + 非图片文件 | `aip-probe/` 放 3 张 PNG + `prompt.txt` + `references.json`，配置关闭隐藏图后验证目录扫描行为 | `--dry-run`：`planned_input_count=3`，`preflight_failed=false`，`rc=0` |
| 本地动态实况实跑 | 同上，`--enable-live-photo --video-source local_motion --json-summary` | `rc=0`，`success=3`，产出 `001.JPG+001.MOV`、`002...`、`003...`；`result.json` 的 `outputs` 列出 source→output |
| 递归子目录 | `aip-recurse/round1/`、`round2/` 各放图，`input.recurse_folders=true` | 输出目录在输入目录**之外**时 `rc=0`、`planned_input_count=2`（另 2 张因内容相同被去重）；输出目录在输入目录**之内**时 `rc=2`，错误明确提示「输出目录位于递归扫描的输入文件夹之内」 |
| 配置覆盖语义 | 用户真实 AIP 配置 + 运行时覆盖 + `config_version:2`（`live_photo.rs` 实际逻辑） | 递归=true、live_photo=true/local_motion、delete_originals=false、use_source_directory=false；隐藏图等沿用用户原值；`--dry-run` 用真实配置 `preflight_failed=false`、`rc=0`、递归收集 6 张 |

---

## 10. 范围外（v1 不做，可后续迭代）

- 实况任务取消 / 断点续跑 / 失败自动重试。
- 把实况结果导入本项目的数据库或回写到轮次记录（用户明确「本项目不需要保留」）。
- 把 AI Image Process 随本软件打包（Python + 依赖 + FFmpeg + ExifTool 体积过大，且用户已有独立安装）。
- `ai_video` 视频来源（用户已选定本地动态）。
