# CHANGELOG

## [Unreleased]

### 修复

- 修复 fresh 浏览器档案首次访问豆包弹出「下载电脑版」推广弹窗（Radix `role=dialog`，全视口固定定位）拦截提示词输入框、导致 `locator.click` 30s 超时的问题（task #16 首轮失败）：遮罩关闭逻辑抽取为 `sidecar/src/overlays.js`；新增 `waitAndDismissOverlays`——持续关闭并轮询直到连续 `stableMs` 内页面无可见遮罩（覆盖弹窗晚于 hydration 出现的时序）；应用在打开新对话页、输入提示词前、提示词已输入后均改为该等待式关闭；输入框点击增加「关闭遮罩后重试一次」兜底（与发送按钮一致）；Radix 关闭按钮选择器补充 `[data-slot="dialog-close"]` / `[data-slot="alert-dialog-close"]`
- 修复 dev 模式 vite watch 误扫 scratch 构建目录 `target3/` 导致启动崩溃（EBUSY）：`vite.config.ts` watch.ignored 增加 `**/target3/**`，`.gitignore` 忽略 `target3/`

### 验证

- 2026-11-08 B5 多项目队列串行压测（task #15/#16，镊子 vs 奶瓶收纳盒测试项目，各 1 轮，auto 选号）：按创建顺序串行执行（`ORDER BY created_at ASC`），#15（doubao-main）21:39 完成 8/8 verified，#16（doubao-second）被自动拣取；#16 首轮因豆包 fresh 档案推广弹窗（「下载电脑版」Radix 对话框遮挡输入框）30s locator 超时落 `needs_manual_intervention`（未提交），人工清障后「继续执行」经 fresh 探测完整重跑并完成（1/1 verified）。9/9 图 SHA-256 与 DB 一致；accounts 计数回写；rotation cursor 2→4。验收 #13 ✅、#7 ✅
- 新增 `sidecar/src/overlays.test.js`（headless Chromium 离线夹具，4 项：识别/关闭推广弹窗、晚于 hydration 出现弹窗的关闭、干净页不误判/快速返回），已接入 `scripts/run-tests.ps1`

## [v1.1.0] - 2026-11-08

### 新增

- 设置页新增「自动拣取队列中的待执行任务」开关（`scheduler_auto_run_get` / `scheduler_auto_run_set`）：关闭后调度主循环停止自动拣取 pending 任务，新任务需手动点「开始」；不影响正在执行和已排队的任务；应用重启后默认关闭

### 清理

- 移除死代码与未使用项（构建现 0 warning）：`TaskStatus` / `ErrorClass` 枚举（仅被测试使用，实际状态机用字符串）及其 Display 测试、`Scheduler::stop_sidecar`、`sha256_hex`（仅测试用，标记 `#[cfg(test)]`）、前端从未调用的原型 IPC 命令 `task_create_round` / `task_add_image` / `task_update_round` 及其注册与 payload 结构
- 验证：`cargo build --offline` 0 warning；`cargo test` 40 项全过（原 42，减 2 个被删测试）；`npx tsc --noEmit` 通过；`scripts/run-tests.ps1` 离线全绿

### 修复

- 修复「继续执行」从不点击发送的缺陷：resume 路径的已生成图片探测误将参考图附件缩略图计入，直接跳过提交并提取失败；现只统计 `rc_gen_image` 生成产物
- 修复参考图抽取越权：sidecar 扫描项目根目录（含 `output/` 产物）导致历史生图结果被当作参考图；现优先扫描 `references/`（不存在则回落项目根）
- 修复 dev/打包环境下 sidecar 无法被 Node 执行的问题：spawn 前剥离 Windows `\\?\` 前缀（`lstat 'C:' EISDIR` 根因）
- 重试路径的等待/轮询同步只统计真实生成产物
- 任务状态通知携带失败原因（日志行与通知中心气泡/列表显示「原因：...」，如 `upload_input_not_found`）
- 轮次恢复完成后清空 `failure_reason`（暂停阶段写入的中断原因不再残留在已 `completed` 的轮次上）
- 账号状态与计数回写：生成/提取成功即视为账号会话有效，自动置 `logged_in`（避免 auto 选号把可用账号当未登录跳过）；`submit_count` 在每次成功提交（含人工确认节点的「继续执行」代点发送）时累加；`success_count` 在轮次完成且成功下载 ≥1 张时累加（resume 页面探测路径不重复计数提交）

### 验证

- 2026-11-08 真实账号单轮全链路实测通过（任务 #9）：创建 → 扫描 references/ → 上传 → 提示词 → 提交前确认暂停 →「继续执行」→ 发送 → 生图 → 提取 → 下载 → 校验，产物 `001.png`/`002.png` 均 `download_status='verified'`。
- 2026-11-08 真实账号 3 轮多轮 E2E + 暂停/继续（任务 #10，HEAD 0e281f4）：创建 3 轮 → 生成等待中点击暂停（任务/轮次正确落 `paused`）→「继续」经页面状态探测识别已生成 2 张图并提取下载、**无重复提交** → 第 2/3 轮按 `run_rounds_loop` 自动完成 → 6/6 张 `verified`，本地重算 SHA-256 全部一致；输出目录命名规范、`task_rounds` 3/3 `completed`。
- 2026-11-08 账号自定义阈值暂停实测（任务 #11，threshold=1，账号 #1 已有 9 张 verified 图）：任务在第 1 轮开始前即暂停（`needs_manual_intervention`，`interrupted_status='account_threshold_reached'`），通知中心与执行日志均有记录，全程未消耗生图额度；测后阈值恢复为 0、任务已取消。
- 2026-11-08 修复复验（任务 #12，1 轮）：修复后构建完成一轮真实生图（2/2 `verified`，SHA-256 一致）；`accounts` 计数实测回写——doubao-main `submit_count` 0→1、`success_count` 5→6、`status='logged_in'`。注意：任务创建后无需点「开始」即开始执行——本实例中「开始」启用的 auto_run 闸门在任务 #11 时已打开（v1.1.0 起可在设置页关闭，重启后默认关闭）。
- 2026-11-08 1.0.0 安装包装机冒烟（本机 Win10 IoT LTSC）：MSI 安装 1.0.0 → 安装目录内置 runtime 独立可运行（node v22.20.0、ms-playwright 718MB）→ 净化 PATH 启动 UI 正常、版本显示 1.0.0 ✓。
- 历史数据回填（随上述修复）：doubao-main 置为 `logged_in`、`success_count=5`（按 verified 轮次重算）；`task_rounds` 中已完成轮次的陈旧 `failure_reason` 已清空（任务 #10 round 1）。

## [v1.0.0] - 2026-11-07

### 新增

- 安装包内置完整运行时：随附 Node.js v22（`runtime/node/win-x64/node.exe`）与 Playwright Chromium（`runtime/ms-playwright/`），用户无需安装 Node.js/Playwright/Chromium
- 生图参数：模型/比例/风格三组经真实豆包页面验证的枚举（模型 4 种、比例 9 种、风格 33 种），支持全局默认、项目级覆盖、缺省继承；参数仅在用户手动开启 apply 时写入页面
- 启动不自动恢复上次任务：上次中断任务被标记为需人工处理并保留上次状态，由用户手动「继续执行」
- 安全暂停/取消：暂停/取消真正中断正在执行的自动化（等待生成、上传前、提交前、下载循环均支持中止）；继续执行不重复提交
- 多轮生图：任务可设置轮数（1–999），逐轮串行执行，每轮重新抽图与读取 `prompt.txt`
- 输出目录规范：`output/yyyyMMdd_HHmmss_fff`（同名 `_N` 递增）；图片 `001.png` 起（保留真实扩展名）；每轮目录写 `prompt.txt` / `references.json` / `task.json`
- 人工确认模式：抽图后暂停 / 提交前暂停两个开关；`waiting_confirmation` 状态落地 + 安全继续
- 项目管理补全：导入已有项目、重命名、打开目录、`prompt.txt` 在线编辑、参考图统计与文件夹布局、生成历史、参考图管理器（预览/新增/删除/详情/打开所在目录/SHA-256 校验）
- 账号管理补全：行首拖动排序、按列表顺序自动轮换（跳过未登录或已达自定义阈值的账号）、图片阈值编辑、成功图片数/完成轮次/最近使用时间真实统计、单次任务指定账号、已达阈值暂停保护
- 重试机制：`max_retries` 生效；扫描超时/下载失败可自动重试（下载只重传未完成文件）；超限暂停并通知（`retry-exhausted` 事件）
- 日志筛选导出：按任务/账号/级别/时间区间筛选并导出 CSV；日志自动脱敏（Cookie/Token 等替换为 `[REDACTED]`）
- 通知中心：右上角铃铛 + 未读角标 + 气泡通知，覆盖任务开始/完成/失败/需人工处理/阈值/最大重试；设置页可开启系统通知
- 默认执行模式：「自动连续执行」或「每轮结束后暂停，手动继续」
- 设置页：软件版本、通知开关接线、界面语言持久化（zh-CN/English）、执行模式设置、每轮参考图固定 5 张说明
- 国际化：全部 UI 文案双语（简体中文/English）
- 数据库迁移版本机制（`user_version`）；关键写入（task_images / task_rounds / accounts）单事务
- Playwright Trace 开关（每轮保存 `trace.zip`，仅调试用，默认关闭）
- 失败诊断：保留截图 + HTML + 页面 URL（`extract_*.json`）
- 任务行对「需人工干预 / 失败」状态提供「继续执行」按钮：人工处理后点击可从页面现状继续（已有生成图则直接提取下载；提示词未发送则提示用户确认发送后再点继续；全新页面则完整重跑），绝不盲目重复提交
- sidecar 自动识别并关闭豆包页面上的广告/推广/签到遮罩层（关闭按钮 → Escape → 点击遮罩角落，多轮验证生效），打开登录页时同样生效；提交按钮点击被遮挡时也会自动关闭遮罩后重试一次
- 创建任务不再需要输入任务名称，软件自动以「项目名-日期」生成（如：奶瓶收纳盒生图-2026-11-06）

### 修复

- 「继续执行」此前完全没有入口，且 `task_resume` 把状态改为 preparing 后调度器永远不会捡取，任务卡死；现暂停任务走 `paused → pending` 重跑，「继续执行」走 `resume_task` 安全恢复流程（提取/下载/校验与完整流程共用一套收尾代码）
- 修复同一次应用启动中只有第一个任务能收到 sidecar 事件（事件接收器被首个任务永久取走、sidecar 又只在首次启动时创建通道）导致后续任务误判失败/卡死的问题；事件接收器改为跨任务共享的异步锁
- 任务「已暂停」后点击「继续」此前不生效（状态被改为 preparing，调度器只捡取 pending）
- 安装版应用点击「创建任务」报「未找到 sidecar 入口」：安装包此前未随附 sidecar，且 Rust 端只从环境变量和 `%LOCALAPPDATA%\DoubaoBatchImage\sidecar` 查找（该位置从未被任何脚本写入）。现将 sidecar（src + node_modules）作为 Tauri bundle 资源随安装包部署，`resolve_sidecar_index` 优先从安装目录的 `resource_dir()/sidecar/src/index.js` 解析；环境变量 `SIDECAR_INDEX` 和旧的本地数据目录路径保留为兜底，报错信息列出所有已尝试位置
- sidecar 启动失败时，若缺少 Node.js（spawn 报 NotFound），日志明确提示需要 Node.js >= 20 及 `NODE_EXE` 设置方式

## [v0.1.0] - 2026-11-03

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
