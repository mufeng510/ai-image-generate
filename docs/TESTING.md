# Phase 7 技术验证报告

## 测试概览

| 测试类别 | 用例数 | 通过 | 失败 | 状态 |
|---|---|---|---|---|
| 图片提取器单元测试 | 15 | 15 | 0 | ✅ |
| 图片下载器单元测试 | 18 | 18 | 0 | ✅ |
| Sidecar 下载器单元测试 | 9 | 9 | 0 | ✅ |
| 随机池单元测试 | 5 | 5 | 0 | ✅ |
| Sidecar 参考图扫描器单元测试 | 7 | 7 | 0 | ✅ |
| Sidecar 遮罩关闭单元测试 | 4 | 4 | 0 | ✅ |
| Rust 单元测试 | 40 | 40 | 0 | ✅ |
| **总计** | **98** | **98** | **0** | **✅ 全部通过** |

## 测试环境

| 项目 | 版本 |
|---|---|
| 操作系统 | Windows 10/11 |
| Node.js | v24.22.2 |
| npm | 11.19.1 |
| Rust | 1.99.1 |
| Cargo | 1.99.1 |
| Tauri | 2.12.5 |
| React | 18.2.0 |
| SQLite | 0.31 (rusqlite bundled) |
| Playwright Chromium | 1.64.1 |

## 单元测试详情

### image-extractor.js (15 测试)

| 测试用例 | 结果 |
|---|---|
| normalizeImageUrl 把 &amp; 还原为 & | ✅ |
| getCreationImageInfo 从 image_ori_raw 对象提取 | ✅ |
| getCreationImageInfo 字符串形式的 image_ori_raw | ✅ |
| getCreationImageInfo 非图片 creation 返回 null | ✅ |
| getDoubaoBlockCreations 从 creation_block 提取 | ✅ |
| getDoubaoBlockCreations 从 rich_media_layout_block.media 提取 | ✅ |
| getDoubaoBlockCreations 空内容返回 [] | ✅ |
| parseStreamChunkData patch_op 形态提取图片 | ✅ |
| parseStreamChunkData event_data 形态提取图片 | ✅ |
| parseStreamChunkData 非图片创建被跳过 | ✅ |
| parseEventStreamText 逐行提取 data: 中的 image_ori | ✅ |
| parseEventStreamText 去重已见 URL | ✅ |
| parseChainSingleResponse 从 downlink_body.messages 提取 | ✅ |
| collectImagesFromValue 递归遍历未知结构 | ✅ |
| isDoubaoGenerationApi 识别生图接口 | ✅ |

### downloader.js (18 测试)

| 测试用例 | 结果 |
|---|---|
| extFromContentType image/jpeg -> .jpg | ✅ |
| extFromContentType image/png -> .png | ✅ |
| extFromContentType image/webp -> .webp | ✅ |
| extFromContentType 带参数 image/png; charset=utf-8 | ✅ |
| extFromContentType 未知类型 -> null | ✅ |
| extFromContentType 空 -> null | ✅ |
| extFromMagicBytes PNG | ✅ |
| extFromMagicBytes JPEG | ✅ |
| extFromMagicBytes WebP | ✅ |
| extFromMagicBytes GIF | ✅ |
| extFromMagicBytes 未知 -> null | ✅ |
| extFromMagicBytes 空 -> null | ✅ |
| isFileComplete 存在且大小合理 -> true | ✅ |
| isFileComplete 期望大小不匹配 -> false | ✅ |
| isFileComplete 文件过大 -> false | ✅ |
| isFileComplete 空文件 -> false | ✅ |
| isFileComplete 不存在 -> false | ✅ |
| sha256File 计算正确 | ✅ |

### sidecar/src/downloader.js (9 测试)

| 测试用例 | 结果 |
|---|---|
| extFromMagicBytes PNG | ✅ |
| extFromMagicBytes JPEG | ✅ |
| extFromMagicBytes WebP | ✅ |
| extFromMagicBytes 未知 -> null | ✅ |
| extFromMagicBytes 空 -> null | ✅ |
| extFromUrl PNG | ✅ |
| extFromUrl JPEG | ✅ |
| extFromUrl WebP | ✅ |
| extFromUrl 无扩展名默认 .png | ✅ |

### sidecar/src/pool.js (5 测试)

| 测试用例 | 结果 |
|---|---|
| ImagePool 持久化 (usedImages) | ✅ |
| ImagePool setRoundImages / getRoundImages | ✅ |
| ImagePool clearRoundImages | ✅ |
| ImagePool reset | ✅ |
| ImagePool prune (删除图片) | ✅ |

### sidecar/src/scanner.test.js (7 测试)

| 测试用例 | 结果 |
|---|---|
| isSupportedImage：扩展名与大小写 | ✅ |
| 递归扫描只有直接包含图片的文件夹参与 | ✅ |
| 空目录/非图片不参与 | ✅ |
| 文件夹少于等于 5：先逐个夹抽一张再补足 5 张 | ✅ |
| 超过 5 个文件夹：只抽 5 个文件夹 | ✅ |
| 图片总数不足 5 时允许重复 | ✅ |
| 空输入返回 reason=no_folders | ✅ |

### sidecar/src/overlays.test.js (4 测试，2026-11-08 新增)

| 测试用例 | 结果 |
|---|---|
| hasVisibleOverlay 识别推广弹窗，干净页不误判 | ✅ |
| dismissPageOverlays 通过关闭按钮关闭推广弹窗 | ✅ |
| waitAndDismissOverlays 处理晚于 hydration 出现的弹窗 | ✅ |
| 干净页 waitAndDismissOverlays 快速返回 0 | ✅ |

（fixture 为豆包 fresh 档案推广弹窗同构 HTML：`role=dialog` 全视口固定定位 + `aria-label="关闭"` 关闭按钮；headless Chromium，不访问真实豆包页面。）

### task_scheduler.rs / schema.rs / commands.rs (40 Rust 测试，2026-11-08 死代码清理后：移除 TaskStatus/ErrorClass 枚举及其两个 Display 测试)

| 测试用例 | 结果 |
|---|---|
| test_scheduler_new | ✅ |
| 控制状态机（Running/Pause/Cancel） | ✅ |
| auto_run 闸门 | ✅ |
| is_current | ✅ |
| 输出目录命名（yyyyMMdd_HHmmss_fff / _N 冲突） | ✅ |
| schema 迁移：旧库补列 + 回填 order_index | ✅ |
| schema 迁移：幂等 + user_version 提升至 3 | ✅ |
| 参考图扫描统计（按文件夹直接图片数） | ✅ |
| 路径包含校验 / destination 解析 | ✅ |
| 账号 round-robin 轮换下标回绕 | ✅ |
| 账号阈值判断（over_threshold） | ✅ |
| 账号自动选择（跳过未登录/已达阈值） | ✅ |
| 下载结果归并（absorb_download_results） | ✅ |

---

## 集成测试（本机实测，真实豆包账号）

**2026-11-03 实测通过（1 轮）：**

| 测试项 | 预期结果 | 状态 |
|---|---|---|
| 创建项目 | 数据库新增项目记录 | ✅ 通过 |
| 添加账号 | 数据库新增账号 | ✅ 通过 |
| 创建任务 | 状态为 pending | ✅ 通过 |
| 开始任务 | 状态变为 preparing，启动 Sidecar | ✅ 通过 |
| 图片抽取 | 按文件夹独立抽取 5 张 | ✅ 通过（13 张候选/2 文件夹，抽 5 张） |
| 图片下载 | 按实际格式保存 | ✅ 通过（image_raw_hflow，2,182,327 字节 PNG） |
| 图片校验 | SHA-256 匹配 | ✅ 通过（b6b00f72475e…） |
| 登录识别 | 识别后账号状态自动更新 | ✅ 通过（login_detected → logged_in） |
| 暂停/继续 | 状态正确切换 | ✅ 已通过（2026-11-08，见下节） |
| 取消任务 | 状态变为 cancelled | 未测 |
| 软件关闭恢复 | 任务状态不丢失 | 部分验证（任务在开发期间被 tauri dev 重启打断，未重复提交） |

**实测发现并修复的问题：**
1. 调度器阻塞：stdout/stderr reader 用 tokio::spawn 包同步 I/O，耗尽 async 工作线程，任务启动后全部饿死 → 改 spawn_blocking
2. 无水印原图误抽：DOM 扫描抓到聊天头像（320x320 rounded-full）→ 改为解析页面 JSON 的 image_ori_raw（/rc_gen_image/ + image_raw_hflow），并修复尾部转义反斜杠导致的 403
3. Tauri IPC 参数不匹配：前端 snake_case 与后端默认 camelCase 不一致 → 全部命令 rename_all snake_case
4. App 启动崩溃：tokio::spawn → tauri::async_runtime::spawn
5. 前端空白：App 未包 I18nProvider → 修复
6. taskStart 参数类型错误（对象传给 number），任务页无创建入口 → 修复并删除死代码 Tasks.tsx

### 2026-11-08 实测通过（1 轮，用户监督，人工确认 + 继续执行全链路）：

| 测试项 | 预期结果 | 状态 |
|---|---|---|
| 创建任务 | 任务队列显示待处理，名称自动生成 | ✅ 通过 |
| 图片抽取 | 按文件夹独立抽取 5 张（仅 references/，不含 output/） | ✅ 通过（13 张/2 文件夹） |
| 切换图像生成模式 | 进入图像生成 tab | ✅ 通过 |
| 上传参考图 | 5 张全部上传成功 | ✅ 通过 |
| 填写提示词 | prompt.txt 内容填入对话框 | ✅ 通过 |
| 提交前暂停 | waiting_confirmation，等待人工确认 | ✅ 通过 |
| 继续执行 | 点击发送按钮 ×1，不重复提交 | ✅ 通过（修复后；修复前“提交了个寂寞”） |
| 生图完成识别 | 页面出现生成图后稳定检测 | ✅ 通过（2 张图片） |
| 原始图片提取 | DOM/流式提取 rc_gen_image | ✅ 通过（001.png / 002.png） |
| 图片下载 | 按实际格式保存 | ✅ 通过（001.png 135,631 B；002.png 2,122,835 B） |
| 图片校验 | SHA-256 与 DB 记录一致 | ✅ 通过（task_images.download_status='verified'） |

**2026-11-08 真实 E2E 发现并修复的问题：**
1. resume 路径 `countGeneratedImages` 把参考图附件也数成“已生成图片”，导致「继续执行」从不点击发送、直接提取失败（no_generated_images）→ 只统计 `img[src*=rc_gen_image]`
2. sidecar scanner 扫描项目 root（含 `output/` 产物目录），历史生图结果被当参考图 → `pick_scan_root`：存在 references/ 只扫它（2 项单元测试）
3. Windows verbatim 路径（`\\?\C:\...`）直接传给 Node，`lstat 'C:'` EISDIR → spawn 前剥离 `\\?\` 前缀（`canonicalize_path`）；额外写 `DoubaoBatchImage/sidecar-spawn.log`（resolved 路径+cwd）
4. dev 资源优先级使用陈旧 packaged 副本 → dev 树优先，打包副本兜底
5. 人工干预 UX 无提示 → `task-status-changed` 事件携带 `reason`；任务行日志与通知中心显示“原因：...”

**注意：** 开发期间编辑 src-tauri 会触发 tauri dev 自动重启并杀死正在运行的任务——任务运行中不要改 Rust 代码。

### 2026-11-08 实测通过（3 轮多轮 E2E + 暂停/继续，真实账号 doubao-main，任务 #10）

环境：HEAD @ 0e281f4（dev 实例本次重启后运行，确保包含该修复）；执行模式 `auto`（轮间不暂停，默认）；账号 #1 doubao-main（显式选择）；项目 #1「奶瓶收纳盒测试项目」；confirm_before_submit=false。

| 测试项 | 预期结果 | 状态 |
|---|---|---|
| 创建 3 轮任务 | 任务 #10，进度 0/3，total_rounds=3 | ✅ 通过 |
| 第 1 轮提交后「暂停」（生成等待中） | 任务立即 paused；轮次 #1 标记 paused，reason="生成等待阶段被中断"；日志"任务已暂停（已保存当前进度）" | ✅ 通过 |
| 暂停后停止推进 | 不下载、不重复提交、不进入第 2 轮 | ✅ 通过 |
| 点击「继续」 | resume 探测页面状态 → 识别已生成 2 张 → 提取下载，**无重复提交** | ✅ 通过 |
| 第 2 轮自动执行 | 抽图(2 文件夹)→上传→提交→约 46s 后「生成完成」→下载 2/2 | ✅ 通过 |
| 第 3 轮自动执行 | 同上，约 51s | ✅ 通过 |
| 任务整体完成 | status=completed，current_round=3/3，累计下载 6 张 | ✅ 通过 |
| 图片校验 | task_images.download_status='verified' ×6；本地重算 SHA-256 6/6 一致 | ✅ 通过 |
| 图片内容抽查 | 001/002.png 为真实产品图（豆包水印原图，180,696 B / 1,938,726 B 等） | ✅ 通过（人工查看） |

暂停测试时序（UTC，本地 +8）：06:53:30 已提交 → 06:54:11 暂停（生成等待中）→ 06:54:24 继续 → 06:54:25 识别"生成完成，提取图片 URL"→ 06:54:25 round 1 完成（2/2）→ 06:55:11 round 2 完成 → 06:56:02 round 3 完成、任务完成。

**实测发现 → 已修复（2026-11-08，同日跟进修复）：**
1. 轮次失败原因残留：round 1 `failure_reason='生成等待阶段被中断'` 在恢复完成后未清空 → 修复：`finish_after_generation` 成功分支写入 `failure_reason = NULL`；并回填清空已完成轮次中的陈旧值（task_rounds 1 行）。
2. 账号状态未回写：doubao-main 三轮成功后 `accounts.status` 仍为 `login_pending` → 修复：生成/提取成功（进入校验事务）即置 `logged_in` 并累计 `success_count`；`submit_count` 于成功提交点（含人工确认节点「继续执行」代点发送）累加；`resume` 页面探测路径不重复计数。历史数据回填：doubao-main → `logged_in`、`success_count=5`（按 verified 轮次重算；`submit_count` 无法可靠回溯，从修复后开始累计）。
3. 账号阈值暂停路径已实测通过（任务 #11，见下节）。
4. 复验（任务 #12，1 轮真实生图）：任务完成、2/2 `verified`、SHA-256 一致；`accounts` 实测回写——doubao-main `submit_count` 0→1、`success_count` 5→6、`status='logged_in'`。另观察到：本实例中「开始」打开的 auto_run 闸门（`Scheduler::auto_run`，进程级，一旦启用不再关闭）导致后续新建的 pending 任务无需再点「开始」即被主循环自动拣取执行——属有设计意味的行为（「开始」=为本实例启用自动执行）。**跟进（同日确认）**：已新增设置页「自动拣取队列中的待执行任务」开关（`scheduler_auto_run_get` / `scheduler_auto_run_set`），关闭后停止自动拣取 pending 任务（已在执行的任务不受影响），应用重启后默认关闭。

### 2026-11-08 重启恢复 + 元数据抽查（B1/B2）

**B1 重启恢复（本机，dev + 装机版）**：关闭→重启两次，未完成任务均未被自动执行；#8 显示「需人工处理 上次： 提交前」；任务队列其他行（#9–#12）状态正确显示；无任务进入 running 态。

**B2 元数据抽查（只读）**：全部 5 个已完成轮次目录（task #9/#10×3/#12）含 `prompt.txt` / `references.json` / `task.json`；`references.json` 与 DB `task_rounds.references_json` 逐字段一致；6/6 已下载图 `download_status='verified'` 且本地重算 SHA-256 与 `task_images.sha256` 一致。

### 2026-11-08 B3/B4：多账号轮换（部分）+ 真实生图中取消（task #13/#14）

**B3 轮换**：#13（项目 #1，自动选择账号）→ 任务自动选 doubao-main（列表顺序第一个），2 张图完成、doubao-main 回写 `submit_count` 1→2、`last_used_at` 更新；游标推进到 1；#14（下一个 auto 任务）自动落到 **doubao-second**，证明列表顺序轮换生效。doubao-second 完成一次真实提交链路（见 B4）。剩余：B5 连续两个任务观察 second 直接使用情况并闭合验收 #7。（B5 已于 2026-11-08 完成：#15→doubao-main、#16→doubao-second 两任务串行全链路跑通，见下节；验收 #7 闭合。）

**B4 真实生图中取消（task #14，doubao-second）**：创建→自动选 doubao-second→提交生图→生成等待中点「取消」→20s 内干净中止（abort 生效，未下载文件产生）→任务落 `cancelled`、日志「任务已取消（已保留已下载图片）」、**不重复提交**；doubao-second `submit_count` 保持 0（提交未获确认，不计提交——符合「不确定不计入」原则）。注意：豆包页面上这次生图可能已被提交并在服务端执行完（客户端不重发、不下载），属取消语义。

附带观察：本实例中「开始」启用 auto_run 闸门后，新建的 pending 任务（#14）无需再点「开始」即被主循环自动捡取执行（v1.1.0 起设置页可关闭该闸门）。

### 2026-11-08 B5：多项目队列串行压测（task #15/#16）

环境：dev 实例（HEAD `8aa727c`）；镊子项目（id=2）与奶瓶收纳盒测试项目（id=1）各建 1 轮任务，账号 auto 自动选择，`account_rotation_cursor` 2 → 4。时间均为本地（UTC+8）；DB `created_at` 为 UTC。

| 测试项 | 预期 | 结果 |
|---|---|---|
| 队列创建顺序 | #15（镊子）先建、#16（奶瓶收纳盒）后建 | ✅ 两任务 `created_at` 顺序与建单顺序一致 |
| auto 选号 | 第一个落 doubao-main（cursor 2→3）、第二个落 doubao-second（cursor 3→4） | ✅ DB 实测 #15 `account_id=1`、#16 `account_id=2`；cursor 落点 3→4 |
| 串行执行 | `ORDER BY created_at ASC LIMIT 1` 拣取，同时仅一个任务占用浏览器/sidecar | ✅ #15 于 21:39:02（点开始）执行、21:39:53 完成；#16 于 21:39:53.48 被自动拣取（紧随 #15 完成时刻），无并发段 |
| resume 恢复 | 任务 `needs_manual_intervention` 后「继续执行」可安全恢复，不重复提交 | ✅ #16 首轮因推广弹窗 30s 超时落 needs_manual_intervention（未提交）；人工清障后 resume 探测 fresh → 完整重跑 → 21:56:10 completed（1/1 verified） |
| 输出目录/账号归属 | 各项目独立 output，账号归属与任务一致 | ✅ #15：`C:\Users\mi\Pictures\参考图\镊子\output\20261108_213904_489\`（8 张图，账号 1）；#16：`…\20261108_215610_028\`（1/1 图，账号 2）；failed round 目录 `20261108_213954_069` 保留（仅 prompt.txt/references.json，无 task.json） |
| 产物与校验 | SHA-256 与 DB 一致、`verified` | ✅ 9/9 图 verified；本地重算 SHA-256 与 `task_images.sha256` 全部一致；`references.json`/`task.json`/`prompt.txt` 齐备 |
| 元数据 | 任务/轮次状态最终落 `completed`、`current_round=1` | ✅ #15 round completed（8 张）；#16 round 1 failed → 手动清障后 retry round 1 completed（1 张） |

**#16 首轮失败（真实账号首次访问 fresh 档案弹窗，非模拟）**：doubao-second 浏览器档案为全新档案，首次访问豆包弹出「下载电脑版 使用完整功能」推广弹窗（Radix `radix-:modern-js-r192:`），恰好位于提示词输入框上方；5 张参考图已成功上传，随后 `locator.click('textarea,[contenteditable="true"]')` 30s 超时（`subtree intercepts pointer events`）→ 轮次 `failed`、任务 `needs_manual_intervention`（**未提交、无重复提交风险**）；同一窗口还同时存在「Chromium 未正确关闭」恢复气泡。用户监督下人工关闭两个遮罩后，任务行点「继续执行」→ resume 探测页面为 fresh（`state=fresh`）→ 日志「页面为全新对话，未提交任何内容，转完整流程重新执行」→ 完整重跑（重新导航 `https://www.doubao.com/chat/`、重新扫描、重新抽 5 张、上传、提交）→ 21:56 完成、下载 1/1 `verified`。doubao-second `submit_count` 0→1、`success_count` 0→1、`last_used_at` 已回写。

观察与欠账：
- sidecar `dismissPageOverlays` 未能消化该 fresh 档案的推广弹窗（可能出现时序晚于 dismiss 或容器选择器未匹配该 Radix 对话框）；2026-11-08 已修复：遮罩逻辑抽取为 `sidecar/src/overlays.js`，新增 `waitAndDismissOverlays`（持续关闭直到连续 stableMs 无可见遮罩，覆盖晚于 hydration 出现的弹窗），goto / 输入框 / 提示词已输入后三处改为等待式关闭，输入框点击失败时「关闭遮罩后重试一次」（test #16 事故路径的直接修复），新增 4 项离线回归测试。
-「已提交，等待生成完成」日志行在 `send_sidecar_cmd` 成功后即写入（约提前几十毫秒，生图尚未真实提交）；#16 失败时日志同时出现「已提交」与 30s 后的 locator 超时，诊断时可能误导。建议改为「已发送生图命令，等待生成完成」或延后到 sidecar 确认提交后写入。
- 项目 1 的 13 张参考图已被历史轮次用尽（pool 中全部 `last_used_at` < 本轮，0 张未用），failed 轮内 `005.jpg` 出现两次属于「池耗尽洗牌允许重复」的设计行为；completed round 重新抽出的 5 张全不同。
- 恢复后本实例 `auto_run` 闸门仍开启（v1.1.0 起可在设置页关闭，重启默认关闭）。

### 2026-11-08 账号自定义阈值暂停实测（task #11）

环境：账号 #1 已有 9 张 verified 图；将其 `image_threshold` 临时设为 1 → 创建 1 轮任务并开始（显式选择账号 #1）→ 任务在第 1 轮开始前即暂停：

| 预期 | 结果 |
|---|---|
| 任务不进入生图，状态 needs_manual_intervention | ✅ interrupted_status=`account_threshold_reached` |
| 轮次不创建（不消耗生图额度） | ✅ task_rounds 为空，0 提交 |
| 通知中心产生「账号已达自定义阈值」通知 | ✅ kind=account_threshold_reached |
| 执行日志与 UI 原因展示 | ✅「账号 1 已达到用户自定义图片阈值，已暂停」 |
| 测后清理 | ✅ 阈值恢复 0；任务点击取消 → cancelled |

### 手动测试步骤

```bash
# 1. 进入项目目录
cd C:\workspace\ai-image-generate

# 2. 安装依赖
npm install

# 3. 前端构建
npm run build

# 4. Rust 编译检查
cargo check --manifest-path src-tauri/Cargo.toml

# 5. 运行原型离线测试
cd prototype
node src/validate-extractor.js
node src/validate-downloader.js
cd ..

# 6. 运行 Sidecar 离线测试
cd sidecar
node src/downloader.js
node src/pool.js
node src/scanner.test.js
cd ..

# 6b. 一键运行全部离线检查（不启动应用/不触发浏览器）
powershell -NoProfile -File scripts/run-tests.ps1

# 7. 运行 Rust 单元测试
cargo test --manifest-path src-tauri/Cargo.toml

# 8. 启动应用（需真实豆包账号）
cargo tauri dev

# 9. 构建 Windows 安装包
cargo tauri build
```

## 已知未覆盖项（后续）

- 真实浏览器 E2E（Doubao 页面全流程）：2026-11-03 单轮通过；2026-11-08 3 轮多轮（task #10）+ 生成等待中暂停/继续 全部通过（详见上节）。
- 取消任务 / 软件关闭恢复：2026-11-08 已覆盖——取消：B4（task #14，生成等待中取消 20s 内干净中止）+ B5 期间 failed 轮的恢复路径；关闭恢复：B1（dev 与装机版重启后未完成任务不自动执行）。
- 多项目队列串行：2026-11-08 B5 已测（#15→#16，两项目串行全链路完成，详见 B5 节）。
- 账号阈值暂停（image_threshold）：已测（task #11）；auto 选号跳过 login_pending 的行为未在真实环境复测（账号现已回写 logged_in）。
- 参数继承（P0-4：全局默认 → 项目覆盖 → 继承）：已完成真实页面参数验证与单元测试覆盖（`merge_gen_params`），「全局 → 项目 → 继承」解析链离线已测；「apply 写入豆包页面」的真实 E2E 未单独验证（gen_params 默认仅记录不下发）。
- 集成级任务状态机测试（require 真实 Doubao），当前以 `wait_result` 超时→失败路径的 `cargo test` 级别覆盖，计时路径缺少确定性测试。

## 测试覆盖率统计

| 模块 | 测试文件 | 测试数 | 通过率 |
|---|---|---|---|
| 图片提取逻辑 | prototype/src/validate-extractor.js | 15 | 100% |
| 图片下载器 | prototype/src/validate-downloader.js | 18 | 100% |
| Sidecar 下载器 | sidecar/src/downloader.js | 9 | 100% |
| 持久化随机池 | sidecar/src/pool.js | 5 | 100% |
| 参考图扫描与抽取 | sidecar/src/scanner.test.js | 7 | 100% |
| 遮罩关闭逻辑 | sidecar/src/overlays.test.js | 4 | 100% |
| Rust 调度/迁移/命令 | src-tauri/Cargo | 40 | 100% |
| **总计** | - | **98** | **100%** |

## 文档完整性检查

| 文档文件 | 状态 |
|---|---|
| README.md | ✅ 已创建 |
| README_EN.md | ✅ 已创建 |
| docs/ARCHITECTURE.md | ✅ 已存在 |
| docs/TECHNICAL_VALIDATION.md | ✅ 已存在 |
| docs/DEVELOPMENT.md | ✅ 已创建 |
| docs/TESTING.md | ✅ 已创建 |
| docs/USER_GUIDE.md | ✅ 已创建 |
| CHANGELOG.md | ✅ 已创建 |

全部 8 个必需文档文件齐全。

---

*测试报告更新时间：2026-11-08（含 3 轮多轮 E2E + 暂停/继续 + 阈值暂停 + B1/B3/B4/B5 实测）*
*适用版本：v1.0.0*
