/**
 * src-tauri/src/task_scheduler.rs
 *
 * 任务调度器（基于 task.md 第八节、十六节）。
 *
 * 特点：
 *   - 状态机驱动：pending → preparing → selecting_images → waiting_confirmation →
 *     uploading → submitting → generating → downloading → verifying → completed
 *     / paused / failed / cancelled / needs_manual_intervention
 *   - 串行执行：同一时间只有一个任务占用浏览器会话，避免多个生成任务互相干扰
 *   - 错误分类处理：临时网络错误可重试、登录失效/验证码暂停等待人工、账号限制暂停整个队列
 *   - Sidecar 进程管理：启动/停止 Node.js + Playwright 自动化进程，通过 stdin/stdout JSON 行协议通信
 *   - 浏览器异常不导致桌面软件崩溃：Sidecar 独立进程，崩溃可重启
 *   - 所有耗时操作异步，状态转换写入数据库和日志
 */

use chrono::Utc;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;
use tokio::time::{sleep, Duration};

use crate::db::get_connection;
use crate::models::Task;

/** 任务状态 */
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum TaskStatus {
    Pending,
    Preparing,
    SelectingImages,
    WaitingConfirmation,
    Uploading,
    Submitting,
    Generating,
    Downloading,
    Verifying,
    Completed,
    Paused,
    Failed,
    Cancelled,
    NeedsManualIntervention,
}

impl std::fmt::Display for TaskStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TaskStatus::Pending => write!(f, "pending"),
            TaskStatus::Preparing => write!(f, "preparing"),
            TaskStatus::SelectingImages => write!(f, "selecting_images"),
            TaskStatus::WaitingConfirmation => write!(f, "waiting_confirmation"),
            TaskStatus::Uploading => write!(f, "uploading"),
            TaskStatus::Submitting => write!(f, "submitting"),
            TaskStatus::Generating => write!(f, "generating"),
            TaskStatus::Downloading => write!(f, "downloading"),
            TaskStatus::Verifying => write!(f, "verifying"),
            TaskStatus::Completed => write!(f, "completed"),
            TaskStatus::Paused => write!(f, "paused"),
            TaskStatus::Failed => write!(f, "failed"),
            TaskStatus::Cancelled => write!(f, "cancelled"),
            TaskStatus::NeedsManualIntervention => write!(f, "needs_manual_intervention"),
        }
    }
}

/** 错误分类 */
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum ErrorClass {
    TempNetwork,
    DownloadInterrupted,
    LoginExpired,
    Captcha,
    AccountLimit,
    PageStructureChanged,
    SubmissionUnclear,
    FileCheckFailed,
    Other,
}

impl std::fmt::Display for ErrorClass {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ErrorClass::TempNetwork => write!(f, "temp_network"),
            ErrorClass::DownloadInterrupted => write!(f, "download_interrupted"),
            ErrorClass::LoginExpired => write!(f, "login_expired"),
            ErrorClass::Captcha => write!(f, "captcha"),
            ErrorClass::AccountLimit => write!(f, "account_limit"),
            ErrorClass::PageStructureChanged => write!(f, "page_structure_changed"),
            ErrorClass::SubmissionUnclear => write!(f, "submission_unclear"),
            ErrorClass::FileCheckFailed => write!(f, "file_check_failed"),
            ErrorClass::Other => write!(f, "other"),
        }
    }
}

/** 任务控制指令（暂停/取消） */
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ControlState {
    Running,
    PauseRequested,
    CancelRequested,
}

/** 调度器全局状态 */
pub struct Scheduler {
    /** 当前正在执行的任务 ID（串行，None 表示空闲） */
    current_task: Mutex<Option<i64>>,
    /** 任务控制状态（暂停/取消） */
    control: Mutex<std::collections::HashMap<i64, ControlState>>,
    /** 是否允许调度器自动拣取 pending 任务。启动时为 false，用户点击「开始」后才启用。 */
    auto_run: Mutex<bool>,
    /** Sidecar 子进程 stdin（用于发送命令） */
    sidecar_stdin: Mutex<Option<ChildStdin>>,
    /** Sidecar 事件发送通道（stdout 读取线程 -> 调度器） */
    sidecar_event_tx: Mutex<Option<mpsc::UnboundedSender<serde_json::Value>>>,
    /** Sidecar 事件接收通道（供执行任务接收提取/下载结果；异步锁，整个任务期间持有） */
    sidecar_event_rx: tokio::sync::Mutex<Option<mpsc::UnboundedReceiver<serde_json::Value>>>,
    /** 调度器运行标志 */
    running: Mutex<bool>,
}

/** 规范化并剥离 Windows `\\?\` 前缀；Node 无法正确处理 verbatim 路径（会把 `C:` 误当目录） */
fn canonicalize_path(p: std::path::PathBuf) -> std::path::PathBuf {
    let canonical = std::fs::canonicalize(&p).unwrap_or(p);
    let text = canonical.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    {
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return std::path::PathBuf::from(format!(r"\\{}", rest));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return std::path::PathBuf::from(rest);
        }
    }
    canonical
}

impl Scheduler {
    pub fn new() -> Self {
        Scheduler {
            current_task: Mutex::new(None),
            control: Mutex::new(std::collections::HashMap::new()),
            auto_run: Mutex::new(false),
            sidecar_stdin: Mutex::new(None),
            sidecar_event_tx: Mutex::new(None),
            sidecar_event_rx: tokio::sync::Mutex::new(None),
            running: Mutex::new(false),
        }
    }

    /** 启动 Sidecar 进程（Node.js + Playwright Chromium） */
    pub async fn start_sidecar(&self, app: &AppHandle) -> Result<(), String> {
        let index_js = canonicalize_path(resolve_sidecar_index(app)?);
        if let Ok(dir) = crate::task_scheduler::app_data_dir() {
            let _ = std::fs::write(
                dir.join("sidecar-spawn.log"),
                format!(
                    "node={:?}\nentry={:?}\nbrowsers={:?}\ncwd={:?}\n",
                    which_node(app).ok().map(canonicalize_path),
                    &index_js,
                    playwright_browsers_path(app).map(canonicalize_path),
                    std::env::current_dir().ok(),
                ),
            );
        }

        let mut child = {
            let mut stdin_guard = self.sidecar_stdin.lock().map_err(|e| e.to_string())?;
            if stdin_guard.is_some() {
                return Ok(()); // 已启动
            }

            let node_exe = canonicalize_path(which_node(app)?);
            let mut cmd = Command::new(&node_exe);
            cmd.arg(&index_js)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            // 内置 Chromium（resources/runtime/ms-playwright）存在时注入路径，
            // 否则回落到系统 Playwright 缓存目录（%LOCALAPPDATA%\\ms-playwright）。
            if let Some(browsers) = playwright_browsers_path(app) {
                cmd.env("PLAYWRIGHT_BROWSERS_PATH", canonicalize_path(browsers));
            }
            let mut child = cmd
                .spawn()
                .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    format!(
                        "未找到 Node.js 运行时（sidecar 需要 Node.js >= 20）。请安装 Node.js，或设置 NODE_EXE 环境变量指向 node.exe 的完整路径。（尝试启动: {}，入口: {}）",
                        node_exe.display(),
                        index_js.display()
                    )
                } else {
                    format!("启动 sidecar 失败: {} (入口: {})", e, index_js.display())
                }
            })?;

            let stdin = child.stdin.take().ok_or("无法获取 sidecar stdin")?;
            *stdin_guard = Some(stdin);
            child
        };

        // 创建 sidecar 事件通道，供执行任务接收提取/下载结果
        let (event_tx, event_rx) = mpsc::unbounded_channel::<serde_json::Value>();
        {
            let mut tx_guard = self.sidecar_event_tx.lock().map_err(|e| e.to_string())?;
            *tx_guard = Some(event_tx.clone());
        }
        {
            let mut rx_guard = self.sidecar_event_rx.lock().await;
            *rx_guard = Some(event_rx);
        }

        // 启动 stdout 读取线程，将 sidecar 事件转发为 Tauri Event 并发送到事件通道
        // 注意：必须使用 spawn_blocking —— 该线程内是同步阻塞的 std::io 读取，
        // 若用 tokio::spawn 会永久占住异步工作线程，饿死整个调度器。
        let app_handle = app.app_handle().clone();
        let stdout = child.stdout.take().ok_or("无法获取 sidecar stdout")?;
        tauri::async_runtime::spawn_blocking(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        if line.trim().is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<serde_json::Value>(&line) {
                            Ok(event) => {
                                // 登录检测事件：更新账号状态为 logged_in 并写日志
                                if event.get("event").and_then(|v| v.as_str()) == Some("login_detected") {
                                    let account_id = event.get("account_id").and_then(|v| v.as_i64());
                                    if let Some(id) = account_id {
                                        if let Ok(conn) = crate::db::get_connection() {
                                            let _ = conn.execute(
                                                "UPDATE accounts SET status = 'logged_in', last_used_at = ?1 WHERE id = ?2",
                                                rusqlite::params![Utc::now().to_rfc3339(), id],
                                            );
                                            let _ = db_write_log(&conn, None, "info", &format!("账号 {} 登录已识别", id));
                                        }
                                        let _ = app_handle.emit("login-detected", serde_json::json!({ "account_id": id }));
                                    }
                                }
                                let _ = app_handle.emit("sidecar-event", event.clone());
                                // 同时发送到事件通道，供 execute_task 接收
                                let _ = event_tx.send(event);
                            }
                            Err(_) => {
                                let _ = app_handle.emit(
                                    "sidecar-log",
                                    serde_json::json!({
                                        "level": "info",
                                        "message": line,
                                    }),
                                );
                            }
                        }
                    }
                    Err(err) => {
                        let _ = app_handle.emit(
                            "sidecar-log",
                            serde_json::json!({
                                "level": "error",
                                "message": format!("读取 sidecar 输出失败: {}", err),
                            }),
                        );
                    }
                }
            }
        });

        // 启动 stderr 读取线程（同样使用 spawn_blocking，避免饿死异步运行时）
        let app_handle_err = app.app_handle().clone();
        let stderr = child.stderr.take().ok_or("无法获取 sidecar stderr")?;
        tauri::async_runtime::spawn_blocking(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line) = line {
                    if !line.trim().is_empty() {
                        let _ = app_handle_err.emit(
                            "sidecar-log",
                            serde_json::json!({
                                "level": "warn",
                                "message": format!("[sidecar stderr] {}", line),
                            }),
                        );
                    }
                }
            }
        });

        // 保存子进程句柄，防止被提前 drop
        std::mem::forget(child);

        Ok(())
    }

    /** 向 sidecar 发送一条 JSON 命令 */
    pub fn send_sidecar_cmd(&self, cmd: serde_json::Value) -> Result<(), String> {
        let mut guard = self.sidecar_stdin.lock().map_err(|e| e.to_string())?;
        let stdin = guard.as_mut().ok_or("sidecar 未启动")?;
        writeln!(stdin, "{}", serde_json::to_string(&cmd).unwrap()).map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())?;
        Ok(())
    }

    /** 停止 sidecar 进程 */
    pub fn stop_sidecar(&self) -> Result<(), String> {
        let mut guard = self.sidecar_stdin.lock().map_err(|e| e.to_string())?;
        if let Some(stdin) = guard.take() {
            drop(stdin); // 关闭 stdin，sidecar 会退出
        }
        Ok(())
    }

    /** 尝试领取调度器执行权（串行锁） */
    pub fn try_acquire(&self, task_id: i64) -> bool {
        let mut guard = self.current_task.lock().unwrap();
        if guard.is_some() {
            return false;
        }
        *guard = Some(task_id);
        true
    }

    /** 释放调度器执行权 */
    pub fn release(&self) {
        let mut guard = self.current_task.lock().unwrap();
        *guard = None;
    }

    /** 当前是否有任务在执行 */
    pub fn is_running(&self) -> bool {
        self.current_task.lock().unwrap().is_some()
    }

    /** 指定任务是否正在占用执行权（sidecar 是串行资源，只有它才需要发送 abort） */
    pub fn is_current(&self, task_id: i64) -> bool {
        *self.current_task.lock().unwrap() == Some(task_id)
    }

    /** 请求暂停任务 */
    pub fn request_pause(&self, task_id: i64) {
        self.control
            .lock()
            .unwrap()
            .insert(task_id, ControlState::PauseRequested);
    }

    /** 请求取消任务 */
    pub fn request_cancel(&self, task_id: i64) {
        self.control
            .lock()
            .unwrap()
            .insert(task_id, ControlState::CancelRequested);
    }

    /** 读取任务控制状态 */
    pub fn control_state(&self, task_id: i64) -> ControlState {
        *self
            .control
            .lock()
            .unwrap()
            .get(&task_id)
            .unwrap_or(&ControlState::Running)
    }

    /** 清除任务控制状态（开始/继续时调用） */
    pub fn clear_control(&self, task_id: i64) {
        self.control.lock().unwrap().remove(&task_id);
    }

    /** 允许调度器自动拣取 pending 任务 */
    pub fn enable_auto_run(&self) {
        *self.auto_run.lock().unwrap() = true;
    }

    /** 启动后默认不自动执行任何任务，必须由用户点击「开始」启用 */
    pub fn is_auto_run(&self) -> bool {
        *self.auto_run.lock().unwrap()
    }
}

impl Default for Scheduler {
    fn default() -> Self {
        Self::new()
    }
}

/** 从哪里获取 node 可执行文件路径 */
/**
 * 解析 sidecar 使用的 Node 可执行文件路径，优先级：
 *   1. 环境变量 NODE_EXE（显式覆盖）；
 *   2. 打包环境：安装包内置的 runtime/node/win-x64/node.exe；
 *   3. 开发树：仓库下的 runtime/node/win-x64/node.exe；
 *   4. 系统 PATH 的 node。
 */
fn which_node(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    if let Ok(p) = std::env::var("NODE_EXE") {
        let path = std::path::PathBuf::from(&p);
        if path.exists() {
            return Ok(path);
        }
        return Err(format!("NODE_EXE 指向的文件不存在: {}", p));
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let packaged = resource_dir
            .join("runtime")
            .join("node")
            .join("win-x64")
            .join("node.exe");
        if packaged.exists() {
            return Ok(packaged);
        }
    }
    let dev_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("runtime")
        .join("node")
        .join("win-x64")
        .join("node.exe");
    if dev_path.exists() {
        return Ok(dev_path);
    }
    Ok(std::path::PathBuf::from("node"))
}

/** 打包/开发树内置 Chromium 的路径（存在时注入 PLAYWRIGHT_BROWSERS_PATH） */
fn playwright_browsers_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let packaged = resource_dir.join("runtime").join("ms-playwright");
        if packaged.is_dir() {
            return Some(packaged);
        }
    }
    let dev_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("runtime")
        .join("ms-playwright");
    if dev_path.is_dir() {
        return Some(dev_path);
    }
    None
}

/**
 * 解析 sidecar 入口 src/index.js 的路径。
 *
 * 优先级：
 *   1. 环境变量 SIDECAR_INDEX（显式指定）；
 *   2. 打包环境：安装目录下的 bundle 资源 sidecar/src/index.js（随安装包部署）；
 *   3. 开发环境：CARGO_MANIFEST_DIR/../sidecar/src/index.js（源码树，便于本机测试）；
 *   4. 旧部署约定：本地数据目录 DoubaoBatchImage/sidecar/src/index.js（兼容早期安装方式）。
 *
 * 全部尝试失败时，错误信息中列出所有已尝试的路径，便于用户排查。
 */
fn resolve_sidecar_index(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let mut tried: Vec<String> = Vec::new();

    if let Ok(p) = std::env::var("SIDECAR_INDEX") {
        let path = std::path::PathBuf::from(&p);
        if path.exists() {
            return Ok(path);
        }
        tried.push(format!("SIDECAR_INDEX={}（该路径不存在）", p));
    }

    // 开发树优先（本机调试代码必须即时生效，现成 packaged 副本只用于打包产物做对照）
    let dev_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("sidecar")
        .join("src")
        .join("index.js");
    if dev_path.exists() {
        return Ok(dev_path);
    }
    tried.push(dev_path.display().to_string());

    // 打包环境：安装目录下的 bundle 资源
    if let Ok(resource_dir) = app.path().resource_dir() {
        let packaged = resource_dir
            .join("sidecar")
            .join("src")
            .join("index.js");
        if packaged.exists() {
            return Ok(packaged);
        }
        tried.push(packaged.display().to_string());
    } else {
        tried.push("（无法获取资源目录 resource_dir）".to_string());
    }

    // 开发树：src-tauri/../sidecar/src/index.js
    tried.push(dev_path.display().to_string());

    // 旧部署约定（本地数据目录）
    if let Some(data_dir) = dirs::data_local_dir() {
        let legacy = data_dir
            .join("DoubaoBatchImage")
            .join("sidecar")
            .join("src")
            .join("index.js");
        if legacy.exists() {
            return Ok(legacy);
        }
        tried.push(legacy.display().to_string());
    }

    Err(format!(
        "未找到 sidecar 入口。已尝试以下位置：{}。请重新安装应用（安装包应随附 sidecar），或设置 SIDECAR_INDEX 环境变量显式指定入口。",
        tried.join("；")
    ))
}

/** 本地数据目录（DoubaoBatchImage），用于账号数据目录根 */
pub fn app_data_dir() -> Result<std::path::PathBuf, String> {
    Ok(dirs::data_local_dir()
        .ok_or("无法获取本地数据目录")?
        .join("DoubaoBatchImage"))
}

/** 数据库：更新任务状态 */
fn db_update_task_status(conn: &Connection, task_id: i64, status: &str) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE tasks SET status = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![status, now, task_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/** 数据库：写入执行日志 */
fn db_write_log(conn: &Connection, task_id: Option<i64>, level: &str, message: &str) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO execution_logs (task_id, level, message, created_at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![task_id, level, message, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/**
 * 启动恢复（task.md 8.5）：
 *   - 不自动执行任何未完成任务；
 *   - 把上次处于执行中状态的任务转为 needs_manual_intervention，并保留原状态；
 *   - 由用户在任务列表点击「继续执行」后，再走 resume_task 的页面状态检查流程。
 */
pub fn recover_interrupted_tasks() -> Result<(), String> {
    let conn = get_connection()?;
    let now = Utc::now().to_rfc3339();
    let active_states = [
        "preparing",
        "selecting_images",
        "waiting_confirmation",
        "uploading",
        "submitting",
        "generating",
        "downloading",
        "verifying",
    ];
    let mut interrupted: Vec<(i64, String)> = Vec::new();
    {
        let placeholders = vec!["?"; active_states.len()].join(",");
        let sql = format!(
            "SELECT id, status FROM tasks WHERE status IN ({})",
            placeholders
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let params: Vec<rusqlite::types::Value> = active_states
            .iter()
            .map(|s| rusqlite::types::Value::Text((*s).to_string()))
            .collect();
        let rows = stmt
            .query_map(rusqlite::params_from_iter(params), |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for r in rows {
            if let Ok(v) = r {
                interrupted.push(v);
            }
        }
    }
    for (task_id, previous) in &interrupted {
        // waiting_confirmation 的原节点（confirm_selection / confirm_before_submit）保存在
        // interrupted_status 中，恢复时必须保留，否则重启后无法判断从哪个节点继续。
        conn.execute(
            "UPDATE tasks SET status = 'needs_manual_intervention',
                interrupted_status = CASE
                    WHEN interrupted_status IS NOT NULL AND interrupted_status != '' THEN interrupted_status
                    ELSE ?1 END,
                updated_at = ?2
             WHERE id = ?3",
            rusqlite::params![previous, now, task_id],
        )
        .map_err(|e| e.to_string())?;
        // 未完成的轮次同步标记为暂停，避免详情页一直显示「生成中」
        let _ = conn.execute(
            "UPDATE task_rounds SET status = 'paused', failure_reason = '应用重启，执行被中断（需人工确认后继续）' WHERE task_id = ?1 AND status != 'completed'",
            rusqlite::params![task_id],
        );
        let _ = db_write_log(
            &conn,
            Some(*task_id),
            "warn",
            &format!(
                "检测到上次未完成任务（原状态：{}），已暂停执行。请检查浏览器页面后点击「继续执行」",
                previous
            ),
        );
    }
    Ok(())
}

/** 调度器主循环：从数据库读取 pending 任务并串行执行 */
pub async fn scheduler_loop(app: AppHandle, scheduler: Arc<Scheduler>) {
    {
        let mut guard = scheduler.running.lock().unwrap();
        if *guard {
            return;
        }
        *guard = true;
    } // guard dropped here, before any .await

    eprintln!("[调度器] 启动");

    loop {
        // 为本次循环克隆 Arc，避免原 scheduler 被 move
        let scheduler = scheduler.clone();

        // 启动后不自动执行：必须由用户点击「开始」启用
        if !scheduler.is_auto_run() {
            sleep(Duration::from_millis(1000)).await;
            continue;
        }

        // 若当前有任务在执行，等待
        if scheduler.is_running() {
            sleep(Duration::from_millis(1000)).await;
            continue;
        }

        // 从数据库取下一个 pending 任务
        let conn = match get_connection() {
            Ok(c) => c,
            Err(msg) => {
                eprintln!("[调度器] 打开数据库失败: {}", msg);
                sleep(Duration::from_secs(5)).await;
                continue;
            }
        };

        let next_task: Option<Task> = conn
            .prepare("SELECT id, name, project_id, account_id, status, interrupted_status, current_round, total_rounds, created_at, updated_at, started_at, completed_at FROM tasks WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1")
            .and_then(|mut stmt| {
                stmt.query_row([], |row| {
                    Ok(Task {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        project_id: row.get(2)?,
                        account_id: row.get(3)?,
                        status: row.get(4)?,
                        interrupted_status: row.get(5)?,
                        current_round: row.get(6)?,
                        total_rounds: row.get(7)?,
                        created_at: row.get(8)?,
                        updated_at: row.get(9)?,
                        started_at: row.get(10)?,
                        completed_at: row.get(11)?,
                    })
                })
            })
            .ok();

        drop(conn);

        let task = match next_task {
            Some(t) => t,
            None => {
                sleep(Duration::from_secs(2)).await;
                continue;
            }
        };

        // 尝试领取调度器
        if !scheduler.try_acquire(task.id.expect("task id")) {
            continue;
        }

        let scheduler_clone = scheduler.clone();
        let app_clone = app.clone();
        let scheduler_for_release = scheduler_clone.clone();
        tokio::spawn(async move {
            let _ = execute_task(app_clone, scheduler_clone, task).await;
            scheduler_for_release.release();
        });
    }
}

/** 等待结果的三类结局：正常结果 / 超时 / 被暂停或取消中断 */
enum WaitOutcome {
    Result(serde_json::Value),
    Timeout,
    Interrupted,
}

/** 生成一次性 request_id（每次 send 一个新的），用于把 sidecar 的迟到结果与当前等待关联 */
fn new_request_id() -> String {
    static REQUEST_SEQ: AtomicU64 = AtomicU64::new(0);
    format!("req-{}", REQUEST_SEQ.fetch_add(1, Ordering::Relaxed) + 1)
}

/** 等待某个 result 命令的结果（带超时，并响应暂停/取消）；request_id 用于忽略迟到的旧结果 */
async fn wait_result(
    rx: &mut mpsc::UnboundedReceiver<serde_json::Value>,
    cmd: &str,
    request_id: &str,
    timeout_s: u64,
    scheduler: &Scheduler,
    task_id: i64,
) -> WaitOutcome {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_s);
    loop {
        if scheduler.control_state(task_id) != ControlState::Running {
            return WaitOutcome::Interrupted;
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return WaitOutcome::Timeout;
        }
        match tokio::time::timeout(remaining.min(Duration::from_secs(1)), rx.recv()).await {
            Ok(Some(ev)) => {
                let t = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let c = ev.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
                let rid = ev.get("request_id").and_then(|v| v.as_str()).unwrap_or("");
                if (t == "result" || t == "error") && c == cmd && rid == request_id {
                    // 结果返回前用户已请求暂停/取消：不执行后续步骤
                    if scheduler.control_state(task_id) != ControlState::Running {
                        return WaitOutcome::Interrupted;
                    }
                    return WaitOutcome::Result(ev);
                }
            }
            Ok(None) => return WaitOutcome::Timeout,
            Err(_) => continue,
        }
    }
}

/** 处理暂停/取消中断：写任务与轮次状态，保留已完成的下载文件 */
fn finish_interrupted(
    scheduler: &Scheduler,
    task_id: i64,
    round_id: Option<i64>,
    reason: &str,
) {
    let (task_status, round_status, message) = match scheduler.control_state(task_id) {
        ControlState::PauseRequested => ("paused", "paused", "任务已暂停（已保存当前进度）"),
        ControlState::CancelRequested => ("cancelled", "cancelled", "任务已取消（已保留已下载图片）"),
        ControlState::Running => return,
    };
    if let Some(rid) = round_id {
        if let Ok(conn) = get_connection() {
            let _ = conn.execute(
                "UPDATE task_rounds SET status = ?1, failure_reason = ?2, completed_at = ?3 WHERE id = ?4",
                rusqlite::params![round_status, reason, Utc::now().to_rfc3339(), rid],
            );
        }
    }
    set_task_status_status_only(task_id, task_status);
    if let Ok(conn) = get_connection() {
        let _ = db_write_log(&conn, Some(task_id), "warn", message);
    }
}

/** 只更新任务状态与日志，不触发额外的业务副作用 */
fn set_task_status_status_only(task_id: i64, status: &str) {
    if let Ok(conn) = get_connection() {
        let _ = db_update_task_status(&conn, task_id, status);
    }
}

/** 读取布尔型应用设置（"true"/"1" 视为开启，缺省关闭） */
fn setting_enabled(key: &str) -> bool {
    get_connection()
        .ok()
        .and_then(|conn| {
            conn.query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                [key],
                |row| row.get::<_, String>(0),
            )
            .ok()
        })
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false)
}

/** 读取字符串型应用设置；空串视为未设置 */
fn setting_string(key: &str) -> Option<String> {
    get_connection()
        .ok()
        .and_then(|conn| {
            conn.query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                [key],
                |row| row.get::<_, String>(0),
            )
            .ok()
        })
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/** 纯函数：项目覆盖 > 全局默认；全空为 None（便于单元测试） */
fn merge_gen_params(
    project_json: Option<&str>,
    global_model: Option<String>,
    global_ratio: Option<String>,
    global_style: Option<String>,
) -> Option<serde_json::Value> {
    let mut model = global_model.unwrap_or_default();
    let mut ratio = global_ratio.unwrap_or_default();
    let mut style = global_style.unwrap_or_default();

    if let Some(json) = project_json {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(json) {
            if let Some(m) = value.get("model").and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
                model = m;
            }
            if let Some(r) = value.get("ratio").and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
                ratio = r;
            }
            if let Some(s) = value.get("style").and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
                style = s;
            }
        }
    }

    let mut object = serde_json::Map::new();
    if !model.is_empty() {
        object.insert("model".into(), serde_json::Value::String(model));
    }
    if !ratio.is_empty() {
        object.insert("ratio".into(), serde_json::Value::String(ratio));
    }
    if !style.is_empty() {
        object.insert("style".into(), serde_json::Value::String(style));
    }
    if object.is_empty() {
        None
    } else {
        Some(serde_json::Value::Object(object))
    }
}

/**
 * 解析本轮有效的图像生成参数：项目级覆盖（projects.gen_params_json） > 全局默认（app_settings 的 gen_model/gen_ratio/gen_style）。
 * 三者全部为空时返回 None；部分非空时返回含非空字段的对象。
 */
fn resolve_gen_params(project_id: i64) -> Option<serde_json::Value> {
    let global_model = setting_string("gen_model");
    let global_ratio = setting_string("gen_ratio");
    let global_style = setting_string("gen_style");

    let project_json: Option<String> = get_connection().ok().and_then(|conn| {
        conn.query_row(
            "SELECT gen_params_json FROM projects WHERE id = ?1",
            [project_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    });

    merge_gen_params(
        project_json.as_deref(),
        global_model,
        global_ratio,
        global_style,
    )
}

/** 默认执行模式：`step` 表示每轮完成后暂停，等待用户手动「继续执行」；其余为 `auto` */
fn setting_execution_mode() -> String {
    get_connection()
        .ok()
        .and_then(|conn| {
            conn.query_row(
                "SELECT value FROM app_settings WHERE key = 'execution_mode'",
                [],
                |row| row.get::<_, String>(0),
            )
            .ok()
        })
        .unwrap_or_else(|| "auto".to_string())
}

/** 进入人工确认节点：写入 waiting_confirmation 与中断原因，等待用户点击「继续执行」 */
fn enter_confirmation_node(app: &AppHandle, tid: i64, round_id: i64, reason: &str, message: &str) {
    if let Ok(conn) = get_connection() {
        let now = Utc::now().to_rfc3339();
        let _ = conn.execute(
            "UPDATE task_rounds SET status = 'waiting_confirmation' WHERE id = ?1",
            [round_id],
        );
        let _ = conn.execute(
            "UPDATE tasks SET status = 'waiting_confirmation', interrupted_status = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![reason, now, tid],
        );
        let _ = db_write_log(&conn, Some(tid), "info", message);
    }
    set_task_status(app, tid, "waiting_confirmation", message);
}

/** 从项目读取提示词（prompt.txt 优先，其次项目记录的 prompt_path） */
fn read_prompt(project_root: &std::path::Path, prompt_path: Option<&str>) -> String {
    let mut candidates: Vec<std::path::PathBuf> = vec![project_root.join("prompt.txt")];
    if let Some(p) = prompt_path {
        if !p.is_empty() {
            candidates.push(std::path::PathBuf::from(p));
        }
    }
    for c in candidates {
        if let Ok(text) = std::fs::read_to_string(&c) {
            if !text.trim().is_empty() {
                return text.trim().to_string();
            }
        }
    }
    String::new()
}

/** 更新任务状态 + 写日志 + 广播事件 */
fn set_task_status(app: &AppHandle, tid: i64, status: &str, msg: &str) {
    match get_connection() {
        Ok(conn) => {
            if let Err(e) = db_update_task_status(&conn, tid, status) {
                eprintln!("[调度器] 更新任务状态失败 ({}): {}", status, e);
            }
            let _ = db_write_log(&conn, Some(tid), "info", msg);
        }
        Err(e) => eprintln!("[调度器] 打开数据库失败（状态未写入 {}）: {}", status, e),
    }
    let _ = app.emit("task-status-changed", serde_json::json!({
        "task_id": tid,
        "status": status,
        "reason": msg,
    }));
}

/** 任务上下文（项目根目录、账号、提示词路径） */
struct TaskContext {
    project_root: std::path::PathBuf,
    account_id: i64,
    user_data_dir: String,
    prompt_path: Option<String>,
}

/** 读取任务上下文：项目根目录、账号 id、账号 user_data_dir、提示词路径 */
fn load_task_context(tid: i64) -> Result<TaskContext, String> {
    let conn = get_connection()?;
    let ctx: Result<(String, Option<i64>, String, Option<String>), rusqlite::Error> = conn.query_row(
        "SELECT p.root_path, t.account_id, COALESCE(a.user_data_dir, ''), p.prompt_path
         FROM tasks t
         JOIN projects p ON t.project_id = p.id
         LEFT JOIN accounts a ON t.account_id = a.id
         WHERE t.id = ?1",
        [tid],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    );
    let (project_root, account_id, user_data_dir, prompt_path) = ctx.map_err(|e| e.to_string())?;
    let account_id = account_id.ok_or("任务未绑定账号")?;
    if user_data_dir.trim().is_empty() {
        // 账号已被删除或浏览器资料目录遗失：拒绝在空资料目录启动自动化
        return Err("任务绑定的账号不存在或已被删除，请绑定其他账号后创建任务".to_string());
    }
    Ok(TaskContext {
        project_root: std::path::PathBuf::from(&project_root),
        account_id,
        user_data_dir,
        prompt_path,
    })
}

/** 读取任务本身 */
fn load_task_by_id(tid: i64) -> Result<Task, String> {
    let conn = get_connection()?;
    let mut stmt = conn
        .prepare("SELECT id, name, project_id, account_id, status, interrupted_status, current_round, total_rounds, created_at, updated_at, started_at, completed_at FROM tasks WHERE id = ?1")
        .map_err(|e| e.to_string())?;
    stmt.query_row([tid], |row| {
        Ok(Task {
            id: row.get(0)?,
            name: row.get(1)?,
            project_id: row.get(2)?,
            account_id: row.get(3)?,
            status: row.get(4)?,
            interrupted_status: row.get(5)?,
            current_round: row.get(6)?,
            total_rounds: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
            started_at: row.get(10)?,
            completed_at: row.get(11)?,
        })
    })
    .map_err(|e| e.to_string())
}

/** 读取任务最新一轮（id, round_number, status）；无轮次返回 None */
fn load_latest_round(tid: i64) -> Result<Option<(i64, i64, String)>, String> {
    let conn = get_connection()?;
    let mut stmt = conn
        .prepare("SELECT id, round_number, COALESCE(status, '') FROM task_rounds WHERE task_id = ?1 ORDER BY round_number DESC, id DESC LIMIT 1")
        .map_err(|e| e.to_string())?;
    match stmt.query_row([tid], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
        ))
    }) {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/** 依据失败原因决定任务状态与提示 */
fn classify_gen_failure(reason: &str) -> (&'static str, &'static str) {
    match reason {
        "login_required" => ("needs_manual_intervention", "登录失效，请在可见浏览器中手动登录后继续"),
        "upload_input_not_found" | "submit_button_not_found" | "textbox_not_found" | "submit_click_failed" => {
            ("needs_manual_intervention", "未找到页面关键元素或点击被遮挡，请关闭页面中的遮罩后继续")
        }
        "goto_failed" | "generation_timeout" => ("failed", "网络或生成超时"),
        "no_reference_images" | "empty_prompt" => ("failed", "缺少参考图片或提示词"),
        _ => ("needs_manual_intervention", "生图失败，需人工确认"),
    }
}

/** 执行单个任务（完整状态机） */
async fn execute_task(app: AppHandle, scheduler: Arc<Scheduler>, task: Task) {
    let tid = task.id.expect("task id");

    // 1. preparing：启动 sidecar
    set_task_status(&app, tid, "preparing", "任务准备中");
    if let Err(e) = scheduler.start_sidecar(&app).await {
        set_task_status(&app, tid, "failed", &format!("启动自动化侧车失败: {}", e));
        scheduler.release();
        return;
    }

    // 锁定 sidecar 事件接收器（整个任务期间持有；任务串行执行，无竞争）
    let mut rx_guard = scheduler.sidecar_event_rx.lock().await;
    let event_rx = match rx_guard.as_mut() {
        Some(rx) => rx,
        None => {
            set_task_status(&app, tid, "failed", "sidecar 事件通道未初始化");
            scheduler.release();
            return;
        }
    };

    // 读取任务上下文：项目根目录、账号 id、账号 user_data_dir、提示词
    let ctx = match load_task_context(tid) {
        Ok(c) => c,
        Err(e) => {
            set_task_status(&app, tid, "failed", &format!("读取任务上下文失败: {}", e));
            scheduler.release();
            return;
        }
    };
    let account_id = ctx.account_id;
    let user_data_dir = ctx.user_data_dir.clone();
    let project_root = ctx.project_root.clone();
    let prompt_path = ctx.prompt_path.clone();

    // 2. 启动可见浏览器（每账号独立 userDataDir）
    set_task_status(&app, tid, "preparing", "启动可见浏览器…");
    eprintln!("[调度器] 任务 {} 启动可见浏览器…", tid);
    eprintln!("[调度器] 发送 start_browser 命令 (account_id={})…", account_id);
    let start_request_id = new_request_id();
    let start_cmd = serde_json::json!({
        "cmd": "start_browser",
        "task_id": tid,
        "request_id": start_request_id,
        "account_id": account_id,
        "user_data_dir": user_data_dir,
    });
    if let Err(e) = scheduler.send_sidecar_cmd(start_cmd) {
        set_task_status(&app, tid, "failed", &format!("发送启动浏览器命令失败: {}", e));
        scheduler.release();
        return;
    }
    eprintln!("[调度器] 等待 start_browser 响应 (最长 90 秒)…");
    let res = match wait_result(event_rx, "start_browser", &start_request_id, 90, &scheduler, tid).await {
        WaitOutcome::Result(v) => v,
        WaitOutcome::Timeout => {
            set_task_status(&app, tid, "failed", "启动浏览器超时");
            scheduler.release();
            return;
        }
        WaitOutcome::Interrupted => {
            finish_interrupted(&scheduler, tid, None, "启动浏览器阶段被中断");
            scheduler.release();
            return;
        }
    };
    eprintln!("[调度器] start_browser 响应: {:?}", res);
    // 任务真正进入执行流程，供通知中心提示
    let _ = app.emit("task-started", serde_json::json!({ "task_id": tid }));

    // 3~8. 按轮执行：每轮重新抽图、读取提示词、生成、提取、下载、校验
    let total_rounds = task.total_rounds.unwrap_or(0).max(1);
    let first_round = task.current_round.unwrap_or(0) + 1;
    if first_round > total_rounds {
        set_task_status(&app, tid, "completed", "任务已完成全部轮次");
        scheduler.release();
        return;
    }
    run_rounds_loop(
        &app,
        &scheduler,
        event_rx,
        tid,
        task.project_id.unwrap_or(0),
        account_id,
        &project_root,
        prompt_path.as_deref(),
        first_round,
        total_rounds,
    )
    .await;
    scheduler.release();
}

/**
 * 新轮次输出目录：output/yyyyMMdd_HHmmss_fff（冲突时递增 _1、_2…）。
 * 返回目录路径（不负责创建，下载时由 sidecar/本函数创建）。
 */
fn allocate_round_dir(output_root: &std::path::Path) -> std::path::PathBuf {
    let base = chrono::Local::now().format("%Y%m%d_%H%M%S_%3f").to_string();
    let mut candidate = output_root.join(&base);
    let mut n = 1;
    while candidate.exists() {
        candidate = output_root.join(format!("{}_{}", base, n));
        n += 1;
    }
    candidate
}

/**
 * 选择本轮扫描根目录：项目内若存在 references/ 子目录，只从该目录抽取（用户的参考图约定）；
 * 否则回落到项目根目录（兼容旧的平铺目录布局）。
 * 绝不能让 output/ 等产物目录混入参考图池。
 */
fn pick_scan_root(project_root: &std::path::Path) -> std::path::PathBuf {
    let refs = project_root.join("references");
    if refs.is_dir() {
        refs
    } else {
        project_root.to_path_buf()
    }
}

/** 处理一次下载结果：与 pending 按顺序一一对应（sidecar 按请求顺序返回）。
 *  - 成功项放入 `merged`（保留原始 index 用于文件命名 / image_index）；
 *  - 失败项放入返回值（需要在仍未超过重试上限时重新提交）；
 *  - 达到重试上限且仍有失败项时，失败项也写入 `merged`（供校验与日志），但调用方必须暂停任务。 */
fn absorb_download_results(
    merged: &mut Vec<serde_json::Value>,
    pending: &[serde_json::Value],
    results: &[serde_json::Value],
    attempt: i64,
    max_retries: i64,
) -> Vec<serde_json::Value> {
    let mut still = Vec::new();
    for (i, item) in pending.iter().enumerate() {
        match results.get(i) {
            Some(res) => {
                if res.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                    merged.push(res.clone());
                } else {
                    still.push(item.clone());
                    if attempt >= max_retries {
                        // 最后一次尝试仍失败：保留失败结果供校验与记录
                        merged.push(res.clone());
                    }
                }
            }
            None => still.push(item.clone()),
        }
    }
    still
}

/** 读取用户设置的最大重试次数（0–10；缺省 3） */
fn read_max_retries() -> i64 {
    if let Ok(conn) = get_connection() {
        let raw: Option<String> = conn
            .query_row("SELECT value FROM app_settings WHERE key = 'max_retries'", [], |r| {
                r.get(0)
            })
            .ok();
        if let Some(raw) = raw {
            if let Ok(n) = raw.trim().parse::<i64>() {
                return n.clamp(0, 10);
            }
        }
    }
    3
}

/** 账号阈值的纯函数形式，便于单元测试 */
fn over_threshold(verified_images: i64, threshold: &Option<i64>) -> bool {
    match threshold {
        Some(t) => *t > 0 && verified_images >= *t,
        None => false,
    }
}

/** 轮换选择器：按顺序取 `cursor` 个位置，回绕 */
fn pick_cursor_index(eligible_len: usize, cursor: i64) -> usize {
    if eligible_len == 0 {
        return 0;
    }
    cursor.rem_euclid(eligible_len as i64) as usize
}

fn account_verified_images(conn: &rusqlite::Connection, account_id: i64) -> i64 {
    conn.query_row(
        "SELECT COUNT(*)
           FROM task_images ti
           JOIN task_rounds tr ON ti.task_round_id = tr.id
           JOIN tasks t ON tr.task_id = t.id
          WHERE t.account_id = ?1 AND ti.download_status = 'verified'",
        [account_id],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

fn account_image_threshold(conn: &rusqlite::Connection, account_id: i64) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT image_threshold FROM accounts WHERE id = ?1",
        [account_id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/** 账号存在且已达到用户自定义阈值 */
fn account_over_threshold(conn: &rusqlite::Connection, account_id: i64) -> bool {
    match account_image_threshold(conn, account_id) {
        Ok(threshold) => over_threshold(account_verified_images(conn, account_id), &threshold),
        Err(_) => false,
    }
}

/** 生图成功提交后累计账号提交次数（不重复计数 resume 的页面探测路径） */
fn bump_account_submit_count(account_id: i64) {
    if let Ok(conn) = get_connection() {
        let _ = conn.execute(
            "UPDATE accounts SET submit_count = COALESCE(submit_count, 0) + 1 WHERE id = ?1",
            rusqlite::params![account_id],
        );
    }
}

/** 自动选择：排除未登录与已达自定义阈值的账号，按列表顺序回绕轮换（整个选择在一个 IMMEDIATE 事务内完成） */
pub(crate) fn auto_pick_account_id(conn: &rusqlite::Connection) -> Result<i64, String> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("开始轮换事务失败：{}", e))?;
    let result = auto_pick_account_id_tx(conn);
    match result {
        Ok(id) => {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
            Ok(id)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

fn auto_pick_account_id_tx(conn: &rusqlite::Connection) -> Result<i64, String> {
    let mut stmt = conn
        .prepare(
            "SELECT a.id, a.image_threshold,
                    (SELECT COUNT(*) FROM task_images ti
                       JOIN task_rounds tr ON ti.task_round_id = tr.id
                       JOIN tasks t ON tr.task_id = t.id
                      WHERE t.account_id = a.id AND ti.download_status = 'verified')
               FROM accounts a
              WHERE a.status = 'logged_in'
              ORDER BY a.order_index ASC, a.id ASC",
        )
        .map_err(|e| e.to_string())?;
    let eligible: Vec<i64> = stmt
        .query_map([], |row| {
            let id: i64 = row.get(0)?;
            let threshold: Option<i64> = row.get(1)?;
            let verified: i64 = row.get(2)?;
            Ok((id, threshold, verified))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .filter(|(_, threshold, verified)| !over_threshold(*verified, threshold))
        .map(|(id, _, _)| id)
        .collect();

    if eligible.is_empty() {
        return Err("没有可用账号：全部未登录或已达用户自定义阈值，请调整阈值或登录账号".to_string());
    }

    let cursor: i64 = conn
        .query_row("SELECT value FROM app_settings WHERE key = 'account_rotation_cursor'", [], |r| {
            r.get::<_, String>(0)
        })
        .ok()
        .and_then(|s| s.trim().parse::<i64>().ok())
        .unwrap_or(0);

    let index = pick_cursor_index(eligible.len(), cursor);
    let chosen = eligible[index];
    let next = cursor.wrapping_add(1);
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES ('account_rotation_cursor', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [next.to_string()],
    )
    .map_err(|e| e.to_string())?;
    Ok(chosen)
}

/** 账号已达用户自定义阈值时暂停当前任务，返回 true 表示已暂停 */
fn pause_if_account_threshold_reached(app: &AppHandle, tid: i64, account_id: i64) -> bool {
    if let Ok(conn) = get_connection() {
        if account_over_threshold(&conn, account_id) {
            set_task_status(
                app,
                tid,
                "needs_manual_intervention",
                &format!("账号 {} 已达到用户自定义图片阈值，已暂停。可调整阈值后点「继续执行」", account_id),
            );
            let _ = conn.execute(
                "UPDATE tasks SET interrupted_status = 'account_threshold_reached' WHERE id = ?1",
                [tid],
            );
            let _ = db_write_log(
                &conn,
                Some(tid),
                "warn",
                "账号已达到用户自定义图片阈值，任务已暂停（不是平台额度，仅用户个人管理规则）",
            );
            let _ = app.emit(
                "account-threshold-reached",
                serde_json::json!({ "task_id": tid, "account_id": account_id }),
            );
            return true;
        }
    }
    false
}

/** 多轮循环：逐轮执行，全部成功后才标记任务完成 */
#[allow(clippy::too_many_arguments)]
async fn run_rounds_loop(
    app: &AppHandle,
    scheduler: &Scheduler,
    event_rx: &mut mpsc::UnboundedReceiver<serde_json::Value>,
    tid: i64,
    project_id: i64,
    account_id: i64,
    project_root: &std::path::Path,
    prompt_path: Option<&str>,
    first_round: i64,
    total_rounds: i64,
) -> bool {
    let mut round_number = first_round;
    while round_number <= total_rounds {
        // 账号阈值检查：达到用户自定义阈值时暂停当前任务（不是平台额度限制）
        if pause_if_account_threshold_reached(app, tid, account_id) {
            return false;
        }
        match run_single_round(
            app,
            scheduler,
            event_rx,
            tid,
            project_id,
            account_id,
            project_root,
            prompt_path,
            round_number,
        )
        .await
        {
            Ok(n) if n > 0 => {}
            Ok(_) => {
                set_task_status(app, tid, "failed", "本轮未成功下载任何图片");
                return false;
            }
            Err(()) => return false,
        }
        // step 模式：每轮完成后暂停，等待用户手动进行下一轮
        if round_number < total_rounds && setting_execution_mode() == "step" {
            set_task_status(
                app,
                tid,
                "needs_manual_intervention",
                &format!("第 {} 轮已完成，点击「继续执行」开始第 {} 轮", round_number, round_number + 1),
            );
            let _ = app.emit(
                "task-round-completed",
                serde_json::json!({ "task_id": tid, "round_number": round_number }),
            );
            return false;
        }
        round_number += 1;
    }

    complete_task(app, tid);
    true
}

/** 标记任务完成（写入完成时间与汇总日志，广播事件） */
fn complete_task(app: &AppHandle, tid: i64) {
    let now = Utc::now().to_rfc3339();
    if let Ok(conn) = get_connection() {
        let _ = conn.execute(
            "UPDATE tasks SET status = 'completed', completed_at = ?1, updated_at = ?1, interrupted_status = NULL WHERE id = ?2",
            rusqlite::params![now, tid],
        );
        let rounds: i64 = conn
            .query_row("SELECT current_round FROM tasks WHERE id = ?1", [tid], |r| r.get(0))
            .unwrap_or(0);
        let images: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(success_count), 0) FROM task_rounds WHERE task_id = ?1",
                [tid],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let _ = db_write_log(
            &conn,
            Some(tid),
            "info",
            &format!("任务完成：共 {} 轮，累计成功下载 {} 张图片", rounds, images),
        );
    }
    set_task_status(app, tid, "completed", "任务完成");
    let _ = app.emit("task-completed", serde_json::json!({ "task_id": tid }));
}

/** 执行单个轮次：抽图 → 建轮次与输出目录 → 生成 → 提取/下载/校验 */
#[allow(clippy::too_many_arguments)]
async fn run_single_round(
    app: &AppHandle,
    scheduler: &Scheduler,
    event_rx: &mut mpsc::UnboundedReceiver<serde_json::Value>,
    tid: i64,
    project_id: i64,
    account_id: i64,
    project_root: &std::path::Path,
    prompt_path: Option<&str>,
    round_number: i64,
) -> Result<i64, ()> {
    // 每轮开始重新读取提示词，本轮内固定
    let prompt = read_prompt(project_root, prompt_path);

    // 3. selecting_images：扫描参考图 + 文件夹独立抽取 5 张
    // 超时/网络类失败可自动重试（页面扫描是安全操作，不触碰生图提交）；其他失败原样落地
    let max_retries = read_max_retries();
    let state_dir = app_data_dir()
        .map(|d| d.join("pool").join(format!("project_{}", project_id)))
        .unwrap_or_else(|_| project_root.join(".doubao"));
    let units_file = state_dir.join(format!("round_{}.units.json", round_number));
    let mut scan_attempts = 0i64;
    let scan_res = loop {
        if scan_attempts > 0 {
            set_task_status(
                app,
                tid,
                "selecting_images",
                &format!("参考图扫描重试中（第 {} 次）", scan_attempts),
            );
        } else {
            set_task_status(app, tid, "selecting_images", "扫描参考图片并抽取本轮图片");
        }
        eprintln!("[调度器] 发送 scan_images 命令…");
        let scan_request_id = new_request_id();
        let scan_root = pick_scan_root(project_root);
        let scan_cmd = serde_json::json!({
            "cmd": "scan_images",
            "task_id": tid,
            "request_id": scan_request_id,
            "root_path": scan_root.to_string_lossy(),
            "round_number": round_number,
            "state_dir": state_dir.to_string_lossy(),
            "units_file": units_file.to_string_lossy(),
            "count": 5,
        });
        if let Err(e) = scheduler.send_sidecar_cmd(scan_cmd) {
            scan_attempts += 1;
            if let Ok(conn) = get_connection() {
                let _ = db_write_log(&conn, Some(tid), "warn",
                    &format!("发送扫描命令失败（第 {} 次）：{}", scan_attempts, e));
            }
            if scan_attempts > max_retries {
                set_task_status(app, tid, "needs_manual_intervention",
                    &format!("发送扫描命令失败，已达最大重试次数（{}），已暂停", max_retries));
                let _ = app.emit("retry-exhausted", serde_json::json!({ "task_id": tid, "stage": "scan", "max_retries": max_retries }));
                return Err(());
            }
            continue;
        }
        match wait_result(event_rx, "scan_images", &scan_request_id, 120, scheduler, tid).await {
            WaitOutcome::Result(v) => break v,
            WaitOutcome::Timeout => {
                scan_attempts += 1;
                if let Ok(conn) = get_connection() {
                    let _ = db_write_log(&conn, Some(tid), "warn",
                        &format!("参考图扫描超时（第 {} 次），将重试", scan_attempts));
                }
                if scan_attempts > max_retries {
                    set_task_status(app, tid, "needs_manual_intervention",
                        &format!("参考图扫描达到最大重试次数（{}），已暂停。检查网络后点「继续执行」", max_retries));
                    let _ = app.emit("retry-exhausted", serde_json::json!({ "task_id": tid, "stage": "scan", "max_retries": max_retries }));
                    return Err(());
                }
            }
            WaitOutcome::Interrupted => {
                finish_interrupted(scheduler, tid, None, "抽取参考图阶段被中断");
                return Err(());
            }
        }
    };
    eprintln!("[调度器] scan_images 响应: {:?}", scan_res);
    let scan_ok = scan_res.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if !scan_ok {
        let reason = scan_res.get("reason").and_then(|v| v.as_str()).unwrap_or("unknown");
        set_task_status(app, tid, "failed", &format!("参考图片抽取失败: {}", reason));
        return Err(());
    }
    let selected: Vec<serde_json::Value> = scan_res
        .get("selected").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    if selected.is_empty() {
        set_task_status(app, tid, "failed", "本轮未抽取到任何参考图片");
        return Err(());
    }

    // 持久化 image_pool_records + 写日志
    {
        if let Ok(conn) = get_connection() {
            let total_images = scan_res.get("total_images").and_then(|v| v.as_i64()).unwrap_or(0);
            let folder_count = scan_res.get("folders").and_then(|v| v.as_i64()).unwrap_or(0);
            for item in &selected {
                let path = item.get("path").and_then(|v| v.as_str()).unwrap_or("");
                let sha = item.get("sha256").and_then(|v| v.as_str()).unwrap_or("");
                let _ = conn.execute(
                    "INSERT INTO image_pool_records (project_id, image_path, sha256, last_used_at, use_count) VALUES (?1, ?2, ?3, ?4, 1)",
                    rusqlite::params![project_id, path, sha, Utc::now().to_rfc3339()],
                );
            }
            let _ = db_write_log(&conn, Some(tid), "info",
                &format!("第 {} 轮抽取 {} 张参考图（共 {} 张候选、{} 个文件夹）", round_number, selected.len(), total_images, folder_count));
        }
    }

    // 本轮输出目录 + 元数据文件（prompt.txt / references.json）
    let output_dir = allocate_round_dir(&project_root.join("output"));
    if let Err(e) = std::fs::create_dir_all(&output_dir) {
        set_task_status(app, tid, "failed", &format!("创建输出目录失败: {}", e));
        return Err(());
    }
    if let Err(e) = std::fs::write(output_dir.join("prompt.txt"), &prompt) {
        eprintln!("[调度器] 写入 prompt.txt 失败: {}", e);
    }
    let refs_json = serde_json::to_string_pretty(&selected).unwrap_or_else(|_| "[]".to_string());
    if let Err(e) = write_references_json(&output_dir, tid, project_id, round_number, &selected) {
        eprintln!("[调度器] 写入 references.json 失败: {}", e);
    }

    // 创建本轮记录（使用新输出目录命名）
    let round_id = {
        let conn = match get_connection() {
            Ok(c) => c,
            Err(e) => {
                set_task_status(app, tid, "failed", &format!("打开数据库失败: {}", e));
                return Err(());
            }
        };
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO task_rounds (task_id, round_number, prompt_snapshot, references_json, output_dir, status, submitted_at) VALUES (?1, ?2, ?3, ?4, ?5, 'selecting_images', ?6)",
            rusqlite::params![tid, round_number, prompt.clone(), refs_json, output_dir.to_string_lossy(), now],
        ).unwrap();
        conn.last_insert_rowid()
    };

    // 人工确认节点 1：抽图后确认（设置 confirm_selection=true 时启用）
    if setting_enabled("confirm_selection") {
        enter_confirmation_node(
            app,
            tid,
            round_id,
            "confirm_selection",
            "已抽取本轮参考图，等待人工确认后继续上传",
        );
        return Err(());
    }

    // 4. uploading/submitting/generating：通过 sidecar 上传、提交、等待生成
    set_task_status(app, tid, "uploading", "上传参考图片并提交生图");
    let refs_paths: Vec<String> = selected.iter()
        .filter_map(|v| v.get("path").and_then(|s| s.as_str()).map(|s| s.to_string()))
        .collect();
    let generate_request_id = new_request_id();
    let mut gen_cmd = serde_json::json!({
        "cmd": "generate_images",
        "task_id": tid,
        "request_id": generate_request_id,
        "account_id": account_id,
        "project_root": project_root.to_string_lossy(),
        "refs": refs_paths,
        "prompt": prompt,
        "pause_before_submit": setting_enabled("confirm_before_submit"),
        "trace": setting_enabled("playwright_trace"),
        "round_dir": output_dir.to_string_lossy(),
    });
    if let Some(params) = resolve_gen_params(project_id) {
        gen_cmd["gen_params"] = params;
        gen_cmd["apply_gen_params"] = serde_json::Value::Bool(setting_enabled("gen_params_apply"));
    }
    if let Err(e) = scheduler.send_sidecar_cmd(gen_cmd) {
        set_task_status(app, tid, "failed", &format!("发送生图命令失败: {}", e));
        return Err(());
    }
    set_task_status(app, tid, "submitting", "已提交，等待生成完成");
    let gen_res = match wait_result(event_rx, "generate_images", &generate_request_id, 300, scheduler, tid).await {
        WaitOutcome::Result(v) => v,
        WaitOutcome::Timeout => {
            if let Ok(conn) = get_connection() {
                let _ = conn.execute(
                    "UPDATE task_rounds SET status = 'failed', failure_reason = 'generation_timeout', completed_at = ?1 WHERE id = ?2",
                    rusqlite::params![Utc::now().to_rfc3339(), round_id],
                );
            }
            set_task_status(app, tid, "failed", "等待生图超时（已提交，可能仍在生成）");
            return Err(());
        }
        WaitOutcome::Interrupted => {
            finish_interrupted(scheduler, tid, Some(round_id), "生成等待阶段被中断");
            return Err(());
        }
    };
    // 人工确认节点 2/3：上传完成且提示词已填，等待确认后再提交
    if gen_res.get("state").and_then(|v| v.as_str()) == Some("awaiting_confirmation") {
        enter_confirmation_node(
            app,
            tid,
            round_id,
            "confirm_before_submit",
            "参考图已上传、提示词已填写，等待人工确认后提交",
        );
        return Err(());
    }
    let gen_ok = gen_res.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if !gen_ok {
        let reason = gen_res.get("reason").and_then(|v| v.as_str()).unwrap_or("unknown");
        let msg = gen_res.get("message").and_then(|v| v.as_str()).unwrap_or("");
        let (status, log) = classify_gen_failure(reason);
        if let Ok(conn) = get_connection() {
            let _ = conn.execute(
                "UPDATE task_rounds SET status = 'failed', failure_reason = ?1, completed_at = ?2 WHERE id = ?3",
                rusqlite::params![format!("{}: {}", reason, msg), Utc::now().to_rfc3339(), round_id],
            );
            let _ = db_write_log(&conn, Some(tid), "error", &format!("生图未完成（{}）: {} {}", reason, msg, log));
        }
        set_task_status(app, tid, status, &format!("生图未完成（{}）: {} {}", reason, msg, log));
        return Err(());
    }

    // 生图已确认提交（generate_images 成功）：累计账号提交次数
    bump_account_submit_count(account_id);

    // 5~8. 提取 → 下载 → 校验
    match finish_after_generation(
        app,
        scheduler,
        event_rx,
        tid,
        project_id,
        account_id,
        round_number,
        project_root,
        &output_dir,
        round_id,
        &prompt,
    )
    .await
    {
        Some(n) => Ok(n),
        None => Err(()),
    }
}

/** 写入 references.json：本轮参考图完整记录 */
fn write_references_json(
    output_dir: &std::path::Path,
    tid: i64,
    project_id: i64,
    round_number: i64,
    selected: &[serde_json::Value],
) -> Result<(), String> {
    let payload = serde_json::json!({
        "task_id": tid,
        "project_id": project_id,
        "round_number": round_number,
        "selected_at": Utc::now().to_rfc3339(),
        "prompt_file": "prompt.txt",
        "images": selected,
    });
    let text = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    std::fs::write(output_dir.join("references.json"), text).map_err(|e| e.to_string())
}

/** 写入 task.json：本轮任务信息与下载结果 */
fn write_task_json(
    output_dir: &std::path::Path,
    tid: i64,
    project_id: i64,
    round_number: i64,
    round_id: i64,
    prompt: &str,
    download_results: &[serde_json::Value],
) {
    let images: Vec<serde_json::Value> = download_results
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let path = item.get("path").and_then(|v| v.as_str()).unwrap_or("");
            serde_json::json!({
                "index": item.get("index").and_then(|v| v.as_i64()).unwrap_or((i as i64) + 1),
                "file": std::path::Path::new(path).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
                "path": path,
                "url": item.get("url").and_then(|v| v.as_str()).unwrap_or(""),
                "ok": item.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
                "size": item.get("size").and_then(|v| v.as_i64()).unwrap_or(0),
                "sha256": item.get("sha256").and_then(|v| v.as_str()).unwrap_or(""),
                "ext": item.get("ext").and_then(|v| v.as_str()).unwrap_or(""),
                "error": item.get("error").and_then(|v| v.as_str()).unwrap_or(""),
            })
        })
        .collect();
    let payload = serde_json::json!({
        "task_id": tid,
        "project_id": project_id,
        "round_id": round_id,
        "round_number": round_number,
        "prompt": prompt,
        "prompt_file": "prompt.txt",
        "references_file": "references.json",
        "finished_at": Utc::now().to_rfc3339(),
        "images": images,
    });
    match serde_json::to_string_pretty(&payload) {
        Ok(text) => {
            if let Err(e) = std::fs::write(output_dir.join("task.json"), text) {
                eprintln!("[调度器] 写入 task.json 失败: {}", e);
            }
        }
        Err(e) => eprintln!("[调度器] 序列化 task.json 失败: {}", e),
    }
}

/**
 * 生成完成后的收尾流程：提取 → 下载 → 校验。
 * 完整流程（execute_task）与人工干预后的继续流程（resume_task）共用，
 * 调用方负责领取/释放调度器执行权，本函数不释放。
 * 返回 Some(成功下载数)；None 表示已暂停/取消/失败，状态已写入，调用方应停止。
 */
#[allow(clippy::too_many_arguments)]
async fn finish_after_generation(
    app: &AppHandle,
    scheduler: &Scheduler,
    event_rx: &mut mpsc::UnboundedReceiver<serde_json::Value>,
    tid: i64,
    project_id: i64,
    account_id: i64,
    round_number: i64,
    project_root: &std::path::Path,
    round_dir: &std::path::Path,
    round_id: i64,
    prompt: &str,
) -> Option<i64> {
    let max_retries = read_max_retries();
    // 5. generating → 提取：DOM 扫描生成图片 URL
    set_task_status(app, tid, "generating", "生成完成，提取图片 URL");
    let extract_request_id = new_request_id();
    let extract_cmd = serde_json::json!({
        "cmd": "extract_images",
        "task_id": tid,
        "request_id": extract_request_id,
        "account_id": account_id,
        "project_root": project_root.to_string_lossy(),
    });
    if let Err(e) = scheduler.send_sidecar_cmd(extract_cmd) {
        set_task_status(&app, tid, "failed", &format!("发送提取命令失败: {}", e));
        return None;
    }
    let extract_res = match wait_result(event_rx, "extract_images", &extract_request_id, 180, scheduler, tid).await {
        WaitOutcome::Result(v) => v,
        WaitOutcome::Timeout => {
            if let Ok(conn) = get_connection() {
                let _ = conn.execute(
                    "UPDATE task_rounds SET status = 'failed', failure_reason = 'extract_timeout', completed_at = ?1 WHERE id = ?2",
                    rusqlite::params![Utc::now().to_rfc3339(), round_id],
                );
            }
            set_task_status(app, tid, "failed", "提取生成图片超时");
            return None;
        }
        WaitOutcome::Interrupted => {
            finish_interrupted(scheduler, tid, Some(round_id), "提取生成图片阶段被中断");
            return None;
        }
    };
    let extract_ok = extract_res.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let raw_images: Vec<serde_json::Value> = extract_res
        .get("images").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    if !extract_ok || raw_images.is_empty() {
        let reason = extract_res.get("reason").and_then(|v| v.as_str()).unwrap_or("unknown");
        if let Ok(conn) = get_connection() {
            let _ = conn.execute(
                "UPDATE task_rounds SET status = 'failed', failure_reason = ?1, completed_at = ?2 WHERE id = ?3",
                rusqlite::params![reason, Utc::now().to_rfc3339(), round_id],
            );
        }
        set_task_status(&app, tid, "needs_manual_intervention", &format!("未提取到生成图片（{}），请查看诊断信息", reason));
        return None;
    }

    // 6. downloading：下载到本轮输出目录
    // 失败文件只重传未完成的，最多 max_retries 次；不触发任何生图提交
    set_task_status(&app, tid, "downloading", "下载生成图片");
    let download_items: Vec<serde_json::Value> = raw_images.iter().enumerate().map(|(idx, img)| {
        serde_json::json!({
            "url": img.get("url").and_then(|v| v.as_str()).unwrap_or(""),
            "index": idx,
        })
    }).collect();
    let mut pending: Vec<serde_json::Value> = download_items.clone();
    let mut download_results: Vec<serde_json::Value> = Vec::new();
    let mut download_attempts = 0i64;
    let mut download_retry_exhausted = false;
    loop {
        if pending.is_empty() {
            break;
        }
        let download_request_id = new_request_id();
        let download_cmd = serde_json::json!({
            "cmd": "download_images",
            "task_id": tid,
            "request_id": download_request_id,
            "account_id": account_id,
            "round_id": round_id,
            "round_dir": round_dir.to_string_lossy(),
            "images": pending,
        });
        if let Err(e) = scheduler.send_sidecar_cmd(download_cmd) {
            download_attempts += 1;
            if let Ok(conn) = get_connection() {
                let _ = db_write_log(&conn, Some(tid), "warn",
                    &format!("发送下载命令失败（第 {} 次）：{}", download_attempts, e));
            }
            if download_attempts > max_retries {
                download_retry_exhausted = true;
                break;
            }
            continue;
        }
        let dl_res = match wait_result(event_rx, "download_images", &download_request_id, 300, scheduler, tid).await {
            WaitOutcome::Result(v) => v,
            WaitOutcome::Timeout => {
                download_attempts += 1;
                if let Ok(conn) = get_connection() {
                    let _ = db_write_log(&conn, Some(tid), "warn",
                        &format!("下载等待超时（第 {} 次），将重试未完成文件", download_attempts));
                }
                if download_attempts > max_retries {
                    download_retry_exhausted = true;
                    break;
                }
                continue;
            }
            WaitOutcome::Interrupted => {
                finish_interrupted(scheduler, tid, Some(round_id), "下载生成图片阶段被中断");
                return None;
            }
        };
        let results: Vec<serde_json::Value> = dl_res
            .get("results").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let still_pending = absorb_download_results(
            &mut download_results,
            &pending,
            &results,
            download_attempts,
            max_retries,
        );
        if still_pending.is_empty() {
            break;
        }
        download_attempts += 1;
        if download_attempts > max_retries {
            download_retry_exhausted = true;
            break;
        }
        set_task_status(
            &app,
            tid,
            "downloading",
            &format!("下载失败，重试未完成文件（第 {} 次）：还剩 {} 张", download_attempts, still_pending.len()),
        );
        if let Ok(conn) = get_connection() {
            let _ = db_write_log(&conn, Some(tid), "warn",
                &format!("下载失败，将重试未完成文件：第 {} 次，还剩 {} 张", download_attempts, still_pending.len()));
        }
        pending = still_pending;
    }
    // 失败与成功混合时按原始顺序回写（文件命名顺序与下载顺序一致，便于 001.png 对应 task_images.image_index）
    let mut download_results = download_results;
    download_results.sort_by_key(|r| {
        r.get("index").and_then(|v| v.as_i64()).unwrap_or(i64::MAX)
    });

    // 7. verifying：写入图片记录、计算成功数（单事务：未全部提交前没有任务能读到本轮半成品）
    let mut success_count = 0i64;
    {
        let conn = match get_connection() {
            Ok(c) => c,
            Err(e) => {
                set_task_status(&app, tid, "failed", &format!("打开数据库失败: {}", e));
                return None;
            }
        };
        let tx = match conn.unchecked_transaction() {
            Ok(t) => t,
            Err(e) => {
                set_task_status(&app, tid, "failed", &format!("开始校验事务失败: {}", e));
                return None;
            }
        };
        for (i, item) in download_results.iter().enumerate() {
            let ok = item.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
            let path = item.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let size = item.get("size").and_then(|v| v.as_i64()).unwrap_or(0);
            let sha256 = item.get("sha256").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let ext = item.get("ext").and_then(|v| v.as_str()).unwrap_or("png").to_string();
            let url = item.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let image_index = item
                .get("index")
                .and_then(|v| v.as_i64())
                .unwrap_or_else(|| (i as i64) + 1);
            if ok { success_count += 1; }
            let _ = tx.execute(
                "INSERT INTO task_images (task_round_id, image_index, original_url, saved_path, sha256, file_size, format, download_status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    round_id,
                    image_index,
                    url,
                    path,
                    if sha256.is_empty() { None } else { Some(sha256) },
                    size,
                    ext,
                    if ok { "verified" } else { "failed" },
                ],
            );
        }

        let total = download_results.len() as i64;
        let round_status = if download_retry_exhausted {
            "needs_manual_intervention"
        } else if success_count > 0 {
            "completed"
        } else {
            "failed"
        };
        let now_round = Utc::now().to_rfc3339();
        let _ = if download_retry_exhausted {
            tx.execute(
                "UPDATE task_rounds SET status = ?1, success_count = ?2, failure_reason = 'download_retries_exhausted', completed_at = ?3 WHERE id = ?4",
                rusqlite::params![round_status, success_count, now_round, round_id],
            )
        } else {
            tx.execute(
                "UPDATE task_rounds SET status = ?1, success_count = ?2, failure_reason = NULL, completed_at = ?3 WHERE id = ?4",
                rusqlite::params![round_status, success_count, now_round, round_id],
            )
        };
        // 提取/生成成功即证明账号会话有效：回写 logged_in 与轮次计数，避免 auto 选号跳过可用账号
        let _ = tx.execute(
            "UPDATE accounts SET last_used_at = ?1, status = 'logged_in', success_count = COALESCE(success_count, 0) + ?2 WHERE id = ?3",
            rusqlite::params![now_round, if success_count > 0 { 1i64 } else { 0i64 }, account_id],
        );
        let _ = db_write_log(&tx, Some(tid), "info",
            &format!("本轮下载完成：成功 {}/{} 张", success_count, total));
        if let Err(e) = tx.commit() {
            set_task_status(&app, tid, "failed", &format!("提交校验事务失败: {}", e));
            return None;
        }
    }

    // 8. 记录本轮进度 + 写入 task.json（任务整体状态由调用方按轮次决定）
    let now = Utc::now().to_rfc3339();
    if let Ok(conn) = get_connection() {
        let _ = conn.execute(
            "UPDATE tasks SET current_round = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![round_number, now, tid],
        );
    }
    write_task_json(
        round_dir,
        tid,
        project_id,
        round_number,
        round_id,
        prompt,
        &download_results,
    );
    if download_retry_exhausted {
        // 保留已下载文件与校验记录，暂停并通知（由调用方停止后续轮次）
        set_task_status(
            app,
            tid,
            "needs_manual_intervention",
            &format!("下载达到最大重试次数（{}），已暂停。已保留已下载图片与校验记录", max_retries),
        );
        let _ = app.emit(
            "retry-exhausted",
            serde_json::json!({ "task_id": tid, "stage": "download", "max_retries": max_retries, "success_images": success_count }),
        );
        return None;
    }
    Some(success_count)
}

/**
 * 人工干预后继续执行（「继续执行」按钮触发）。
 *
 * 原则（task.md 铁律）：绝不盲目重新提交。
 *   - 最新一轮从未提交（无轮次）→ 完整重新执行（安全：没有提交发生）；
 *   - 页面已有生成图 / 已提交正在生成 → 只等待完成，然后进入 提取→下载→校验；
 *   - 输入框有提示词但未发送 → 提示用户在浏览器点「发送」后再次点击「继续执行」；
 *   - 其他情况 → 停在 needs_manual_intervention 并说明原因。
 */
pub async fn resume_task(app: AppHandle, scheduler: Arc<Scheduler>, task_id: i64) {
    if !scheduler.try_acquire(task_id) {
        // 不覆盖正在执行任务的状态，仅记日志
        if let Ok(conn) = get_connection() {
            let _ = db_write_log(&conn, Some(task_id), "warn", "已有任务正在执行，忽略本次「继续执行」");
        }
        return;
    }
    if let Err(e) = resume_task_inner(&app, &scheduler, task_id).await {
        set_task_status(&app, task_id, "needs_manual_intervention", &format!("继续执行失败：{}", e));
    }
    scheduler.release();
}

async fn resume_task_inner(app: &AppHandle, scheduler: &Arc<Scheduler>, tid: i64) -> Result<(), String> {
    let task = load_task_by_id(tid)?;

    // 人工确认节点 1 恢复：沿用已抽取的参考图与提示词快照继续生成
    if task.interrupted_status.as_deref() == Some("confirm_selection") {
        return resume_selection_round(app, scheduler, tid, &task).await;
    }

    // 从未提交过：完整重新执行（不存在重复提交问题）
    let latest = load_latest_round(tid)?;
    if latest.is_none() {
        if let Ok(conn) = get_connection() {
            let _ = db_write_log(&conn, Some(tid), "info", "未找到已提交轮次，按完整流程重新执行");
        }
        execute_task(app.clone(), scheduler.clone(), task).await;
        return Ok(());
    }
    let (round_id, round_number, round_status) = latest.unwrap();

    // 最新一轮已完成：说明中断发生在两轮之间，直接继续后续轮次（避免重复提取/下载）
    let total_rounds_cfg = task.total_rounds.unwrap_or(0).max(1);
    if round_status == "completed" && round_number < total_rounds_cfg {
        let ctx = load_task_context(tid)?;
        let account_id = ctx.account_id;
        let project_root = ctx.project_root.clone();
        let project_id = task.project_id.unwrap_or(0);
        scheduler.start_sidecar(app).await?;
        let mut rx_guard = scheduler.sidecar_event_rx.lock().await;
        let event_rx = rx_guard.as_mut().ok_or("sidecar 事件通道未初始化")?;
        // 复用已打开的浏览器页面（不重新导航），直接执行下一轮
        run_rounds_loop(
            app,
            scheduler,
            event_rx,
            tid,
            project_id,
            account_id,
            &project_root,
            ctx.prompt_path.as_deref(),
            round_number + 1,
            total_rounds_cfg,
        )
        .await;
        return Ok(());
    }

    // 启动/复用 sidecar
    scheduler.start_sidecar(app).await?;

    let mut rx_guard = scheduler.sidecar_event_rx.lock().await;
    let event_rx = rx_guard.as_mut().ok_or("sidecar 事件通道未初始化")?;

    let ctx = load_task_context(tid)?;
    let account_id = ctx.account_id;
    let project_root = ctx.project_root.clone();
    let prompt_path = ctx.prompt_path.clone();
    let project_id = task.project_id.unwrap_or(0);
    let total_rounds = task.total_rounds.unwrap_or(0).max(1);

    set_task_status(app, tid, "generating", "继续执行：先检查页面状态");

    let resume_request_id = new_request_id();
    let resume_cmd = serde_json::json!({
        "cmd": "resume_generate",
        "task_id": tid,
        "request_id": resume_request_id,
        "account_id": account_id,
        "generation_timeout_ms": 180000,
        // 人工确认节点：用户已确认，允许替用户点击一次发送
        "submit_pending": task.interrupted_status.as_deref() == Some("confirm_before_submit"),
    });
    scheduler.send_sidecar_cmd(resume_cmd)?;

    // resume_generate 最长等一个生图周期（180s）+ 余量
    let res = match wait_result(event_rx, "resume_generate", &resume_request_id, 240, scheduler, tid).await {
        WaitOutcome::Result(v) => v,
        WaitOutcome::Timeout => {
            set_task_status(app, tid, "needs_manual_intervention", "继续执行：等待页面状态超时，请检查浏览器后重试");
            return Ok(());
        }
        WaitOutcome::Interrupted => {
            finish_interrupted(scheduler, tid, Some(round_id), "继续执行阶段被中断");
            return Ok(());
        }
    };
    let ok = res.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let state = res.get("state").and_then(|v| v.as_str()).unwrap_or("");

    if ok && state == "fresh" {
        // 页面全新、什么都没提交：释放事件锁，转完整流程重新执行
        drop(rx_guard);
        if let Ok(conn) = get_connection() {
            let _ = db_write_log(&conn, Some(tid), "info", "页面为全新对话，未提交任何内容，转完整流程重新执行");
        }
        execute_task(app.clone(), scheduler.clone(), task).await;
        return Ok(());
    }

    if !ok {
        let reason = res.get("reason").and_then(|v| v.as_str()).unwrap_or("unknown");
        let msg = res.get("message").and_then(|v| v.as_str()).unwrap_or("");
        if reason == "generation_timeout" {
            // 已提交但未出图：后续继续必须重新探测页面，不能再次自动点击发送
            clear_interrupted_status(tid);
        }
        let tip = match reason {
            "prompt_pending_submit" => msg, // sidecar 已给出指引：请在浏览器点发送后再点继续执行
            "browser_not_started" => "浏览器未启动或页面已关闭，无法继续",
            "generation_timeout" => "等待生图超时，页面未出现生成图片",
            _ => "无法自动继续，请查看诊断信息或人工处理",
        };
        let tip = if tip.is_empty() { msg.to_string() } else { tip.to_string() };
        if let Ok(conn) = get_connection() {
            let _ = conn.execute(
                "UPDATE task_rounds SET failure_reason = ?1 WHERE id = ?2",
                rusqlite::params![format!("{}: {}", reason, tip), round_id],
            );
        }
        set_task_status(app, tid, "needs_manual_intervention", &format!("继续执行未完成（{}）：{}", reason, tip));
        return Ok(());
    }

    // submit_pending（人工确认提交前）下 resume_generate 代替用户点击了一次「发送」，计入提交次数
    if task.interrupted_status.as_deref() == Some("confirm_before_submit") {
        bump_account_submit_count(account_id);
    }

    // 页面已有生成图（或等待后出现）：提取 → 下载 → 校验，然后继续剩余轮次
    let (round_dir, prompt_snapshot) = load_round_resume_context(round_id, &project_root, round_number);
    let prompt = if prompt_snapshot.trim().is_empty() {
        read_prompt(&project_root, prompt_path.as_deref())
    } else {
        prompt_snapshot
    };
    match finish_after_generation(
        app,
        scheduler,
        event_rx,
        tid,
        project_id,
        account_id,
        round_number,
        &project_root,
        &round_dir,
        round_id,
        &prompt,
    )
    .await
    {
        Some(0) => {
            set_task_status(app, tid, "failed", "任务失败：本轮未成功下载任何图片");
        }
        Some(_) => {
            // 本轮收尾完成，确认节点标记不再需要
            clear_interrupted_status(tid);
            if round_number >= total_rounds {
                complete_task(app, tid);
            } else {
                run_rounds_loop(
                    app,
                    scheduler,
                    event_rx,
                    tid,
                    project_id,
                    account_id,
                    &project_root,
                    prompt_path.as_deref(),
                    round_number + 1,
                    total_rounds,
                )
                .await;
            }
        }
        None => {}
    }
    Ok(())
}

/** 清除任务的中断原因（确认节点已完成或已转入页面状态探测流程） */
fn clear_interrupted_status(tid: i64) {
    if let Ok(conn) = get_connection() {
        let _ = conn.execute(
            "UPDATE tasks SET interrupted_status = NULL WHERE id = ?1",
            [tid],
        );
    }
}

/** 人工确认节点 1 恢复：用轮次记录里的参考图与提示词继续生成 */
async fn resume_selection_round(
    app: &AppHandle,
    scheduler: &Arc<Scheduler>,
    tid: i64,
    task: &Task,
) -> Result<(), String> {
    let (round_id, round_number, refs_json, prompt_snapshot, output_dir) =
        load_round_generation_input(tid)?;
    let ctx = load_task_context(tid)?;
    let account_id = ctx.account_id;
    let project_root = ctx.project_root.clone();
    let project_id = task.project_id.unwrap_or(0);
    let total_rounds = task.total_rounds.unwrap_or(0).max(1);
    let prompt = if prompt_snapshot.trim().is_empty() {
        read_prompt(&project_root, ctx.prompt_path.as_deref())
    } else {
        prompt_snapshot
    };
    let refs: Vec<String> = serde_json::from_str::<Vec<serde_json::Value>>(&refs_json)
        .unwrap_or_default()
        .iter()
        .filter_map(|v| v.get("path").and_then(|p| p.as_str()).map(|s| s.to_string()))
        .collect();
    if refs.is_empty() {
        set_task_status(
            app,
            tid,
            "needs_manual_intervention",
            "本轮参考图记录缺失，请重新创建任务",
        );
        return Ok(());
    }

    scheduler.start_sidecar(app).await?;
    let mut rx_guard = scheduler.sidecar_event_rx.lock().await;
    let event_rx = rx_guard.as_mut().ok_or("sidecar 事件通道未初始化")?;

    set_task_status(app, tid, "uploading", "人工确认完成：上传参考图片并提交生图");
    let generate_request_id = new_request_id();
    let mut gen_cmd = serde_json::json!({
        "cmd": "generate_images",
        "task_id": tid,
        "request_id": generate_request_id,
        "account_id": account_id,
        "project_root": project_root.to_string_lossy(),
        "refs": refs,
        "prompt": prompt.clone(),
        "pause_before_submit": setting_enabled("confirm_before_submit"),
        "trace": setting_enabled("playwright_trace"),
        "round_dir": output_dir.clone().unwrap_or_default(),
    });
    if let Some(params) = resolve_gen_params(project_id) {
        gen_cmd["gen_params"] = params;
        gen_cmd["apply_gen_params"] = serde_json::Value::Bool(setting_enabled("gen_params_apply"));
    }
    scheduler.send_sidecar_cmd(gen_cmd)?;
    set_task_status(app, tid, "submitting", "已提交，等待生成完成");
    let gen_res = match wait_result(event_rx, "generate_images", &generate_request_id, 300, scheduler, tid).await {
        WaitOutcome::Result(v) => v,
        WaitOutcome::Timeout => {
            clear_interrupted_status(tid);
            set_task_status(app, tid, "failed", "等待生图超时（已提交，可能仍在生成）");
            return Ok(());
        }
        WaitOutcome::Interrupted => {
            finish_interrupted(scheduler, tid, Some(round_id), "生成等待阶段被中断");
            return Ok(());
        }
    };
    if gen_res.get("state").and_then(|v| v.as_str()) == Some("awaiting_confirmation") {
        enter_confirmation_node(
            app,
            tid,
            round_id,
            "confirm_before_submit",
            "参考图已上传、提示词已填写，等待人工确认后提交",
        );
        return Ok(());
    }
    if gen_res.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let reason = gen_res.get("reason").and_then(|v| v.as_str()).unwrap_or("unknown");
        let msg = gen_res.get("message").and_then(|v| v.as_str()).unwrap_or("");
        let (status, log) = classify_gen_failure(reason);
        clear_interrupted_status(tid);
        if let Ok(conn) = get_connection() {
            let _ = conn.execute(
                "UPDATE task_rounds SET status = 'failed', failure_reason = ?1, completed_at = ?2 WHERE id = ?3",
                rusqlite::params![format!("{}: {}", reason, msg), Utc::now().to_rfc3339(), round_id],
            );
            let _ = db_write_log(&conn, Some(tid), "error", &format!("生图未完成（{}）: {} {}", reason, msg, log));
        }
        set_task_status(app, tid, status, &format!("生图未完成（{}）: {} {}", reason, msg, log));
        return Ok(());
    }

    // 生图已确认提交（generate_images 成功）：累计账号提交次数
    bump_account_submit_count(account_id);

    let round_dir = output_dir
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| project_root.join("output").join(format!("round_{}", round_number)));
    match finish_after_generation(
        app,
        scheduler,
        event_rx,
        tid,
        project_id,
        account_id,
        round_number,
        &project_root,
        &round_dir,
        round_id,
        &prompt,
    )
    .await
    {
        Some(0) => set_task_status(app, tid, "failed", "任务失败：本轮未成功下载任何图片"),
        Some(_) => {
            // 本轮收尾完成，确认节点标记不再需要
            clear_interrupted_status(tid);
            if round_number >= total_rounds {
                complete_task(app, tid);
            } else {
                run_rounds_loop(
                    app,
                    scheduler,
                    event_rx,
                    tid,
                    project_id,
                    account_id,
                    &project_root,
                    ctx.prompt_path.as_deref(),
                    round_number + 1,
                    total_rounds,
                )
                .await;
            }
        }
        None => {}
    }
    Ok(())
}

/** 读取最新轮次的生成输入：round_id, round_number, references_json, prompt_snapshot, output_dir */
fn load_round_generation_input(
    tid: i64,
) -> Result<(i64, i64, String, String, Option<String>), String> {
    let conn = get_connection()?;
    conn.query_row(
        "SELECT id, round_number, COALESCE(references_json, ''), COALESCE(prompt_snapshot, ''), output_dir \
         FROM task_rounds WHERE task_id = ?1 ORDER BY round_number DESC, id DESC LIMIT 1",
        [tid],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        },
    )
    .map_err(|e| e.to_string())
}

/** 读取轮次的输出目录与提示词快照；旧数据回退到 output/round_N */
fn load_round_resume_context(
    round_id: i64,
    project_root: &std::path::Path,
    round_number: i64,
) -> (std::path::PathBuf, String) {
    let mut output_dir = project_root
        .join("output")
        .join(format!("round_{}", round_number));
    let mut prompt = String::new();
    if let Ok(conn) = get_connection() {
        if let Ok((dir, snap)) = conn.query_row(
            "SELECT COALESCE(output_dir, ''), COALESCE(prompt_snapshot, '') FROM task_rounds WHERE id = ?1",
            [round_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ) {
            if !dir.trim().is_empty() {
                output_dir = std::path::PathBuf::from(dir);
            }
            prompt = snap;
        }
    }
    (output_dir, prompt)
}

/** 供外部调用：触发任务开始（从 commands.rs 调用） */
pub fn trigger_task_start(app: AppHandle, scheduler: Arc<Scheduler>, task_id: i64) {
    let scheduler_clone = scheduler.clone();
    let app_clone = app.clone();
    tokio::spawn(async move {
        // 将任务状态设为 pending（若尚未），然后调度器会自动捡起
        let conn = get_connection().unwrap();
        let _ = conn.execute(
            "UPDATE tasks SET status = 'pending', updated_at = ?1 WHERE id = ?2",
            rusqlite::params![Utc::now().to_rfc3339(), task_id],
        );
        drop(conn);
        // 调度器主循环会自动捡起 pending 任务
        let _ = scheduler_clone;
        let _ = app_clone;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_task_status_display() {
        assert_eq!(TaskStatus::Pending.to_string(), "pending");
        assert_eq!(TaskStatus::Preparing.to_string(), "preparing");
        assert_eq!(TaskStatus::Generating.to_string(), "generating");
        assert_eq!(TaskStatus::Downloading.to_string(), "downloading");
        assert_eq!(TaskStatus::Completed.to_string(), "completed");
        assert_eq!(TaskStatus::Failed.to_string(), "failed");
        assert_eq!(TaskStatus::Cancelled.to_string(), "cancelled");
        assert_eq!(TaskStatus::Paused.to_string(), "paused");
    }

    #[test]
    fn test_scheduler_new() {
        let scheduler = Scheduler::new();
        assert!(!scheduler.is_running());
        assert!(scheduler.try_acquire(1));
        assert!(!scheduler.try_acquire(2));
        scheduler.release();
        assert!(scheduler.try_acquire(2));
    }

    #[test]
    fn test_error_class_display() {
        assert_eq!(ErrorClass::TempNetwork.to_string(), "temp_network");
        assert_eq!(ErrorClass::LoginExpired.to_string(), "login_expired");
        assert_eq!(ErrorClass::Captcha.to_string(), "captcha");
        assert_eq!(ErrorClass::Other.to_string(), "other");
    }

    #[test]
    fn test_scheduler_control_states() {
        let scheduler = Scheduler::new();
        // 默认运行中
        assert_eq!(scheduler.control_state(7), ControlState::Running);

        scheduler.request_pause(7);
        assert_eq!(scheduler.control_state(7), ControlState::PauseRequested);

        scheduler.request_cancel(7);
        assert_eq!(scheduler.control_state(7), ControlState::CancelRequested);

        // 清除后恢复运行（继续执行时调用）
        scheduler.clear_control(7);
        assert_eq!(scheduler.control_state(7), ControlState::Running);

        // 控制状态按任务隔离
        scheduler.request_pause(7);
        assert_eq!(scheduler.control_state(8), ControlState::Running);
    }

    fn pending_item(url: &str, index: i64) -> serde_json::Value {
        serde_json::json!({ "url": url, "index": index })
    }

    #[test]
    fn absorb_download_results_merges_successes_orders_by_pending() {
        let pending = vec![pending_item("a", 0), pending_item("b", 1)];
        let results = vec![
            serde_json::json!({ "index": 1, "url": "a", "ok": true }),
            serde_json::json!({ "index": 2, "url": "b", "ok": true }),
        ];
        let mut merged = Vec::new();
        let still = absorb_download_results(&mut merged, &pending, &results, 0, 3);
        assert!(still.is_empty());
        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn absorb_download_results_failed_items_are_retried_until_the_cap() {
        let pending = vec![pending_item("a", 0), pending_item("b", 1)];
        let results = vec![
            serde_json::json!({ "index": 1, "url": "a", "ok": true }),
            serde_json::json!({ "index": 2, "url": "b", "ok": false, "error": "network" }),
        ];
        // 重试上限内：成功保留、失败退回重试、失败项不写入 merged
        let mut merged = Vec::new();
        let still = absorb_download_results(&mut merged, &pending, &results, 0, 3);
        assert_eq!(still.len(), 1);
        assert_eq!(still[0], pending[1]);
        assert_eq!(merged.len(), 1);
        // 最后一次尝试仍失败：失败项写入 merged 供校验与暂停
        let mut merged2 = Vec::new();
        let still2 = absorb_download_results(&mut merged2, &pending, &results, 3, 3);
        assert_eq!(still2.len(), 1);
        assert_eq!(merged2.len(), 2);
    }

    #[test]
    fn absorb_download_results_missing_results_stay_pending() {
        let pending = vec![pending_item("a", 0), pending_item("b", 1)];
        let results = vec![serde_json::json!({ "index": 1, "url": "a", "ok": true })];
        let mut merged = Vec::new();
        let still = absorb_download_results(&mut merged, &pending, &results, 0, 3);
        assert_eq!(still.len(), 1);
        assert_eq!(still[0]["url"], "b");
        assert_eq!(merged.len(), 1);
    }

    #[test]
    fn test_merge_gen_params_project_only() {
        let merged = merge_gen_params(
            Some(r#"{"model":"Seedream 5.0 Pro"}"#),
            Some("Seedream 4.5".to_string()),
            Some("1:1".to_string()),
            Some("油画".to_string()),
        )
        .expect("should produce params");
        assert_eq!(merged.get("model").and_then(|v| v.as_str()), Some("Seedream 5.0 Pro"));
        assert_eq!(merged.get("ratio").and_then(|v| v.as_str()), Some("1:1"));
        assert_eq!(merged.get("style").and_then(|v| v.as_str()), Some("油画"));
    }

    #[test]
    fn test_merge_gen_params_project_overrides_global() {
        let merged = merge_gen_params(
            Some(r#"{"model":"Seedream 5.0 Pro","ratio":"16:9"}"#),
            Some("Seedream 4.0".to_string()),
            Some("9:16".to_string()),
            Some("水墨画".to_string()),
        )
        .expect("should produce params");
        assert_eq!(merged.get("model").and_then(|v| v.as_str()), Some("Seedream 5.0 Pro"));
        assert_eq!(merged.get("ratio").and_then(|v| v.as_str()), Some("16:9"));
        assert_eq!(merged.get("style").and_then(|v| v.as_str()), Some("水墨画"));
    }

    #[test]
    fn test_merge_gen_params_empty_returns_none() {
        assert!(merge_gen_params(None, None, None, None).is_none());
    }

    #[test]
    fn test_merge_gen_params_ignores_bad_json() {
        assert!(merge_gen_params(Some("not json"), None, None, None).is_none());
    }

    #[test]
    fn test_merge_gen_params_trims_project_values() {
        let merged = merge_gen_params(
            Some(r#"{"model":"  Seedream 4.5  "}"#),
            Some("Seedream 5.0 Flash".to_string()),
            None,
            None,
        )
        .expect("params should be produced");
        assert_eq!(merged.get("model").and_then(|v| v.as_str()), Some("Seedream 4.5"));
    }

    #[test]
    fn test_over_threshold_rules() {
        assert!(!over_threshold(0, &None));
        assert!(!over_threshold(100, &Some(0))); // 0 表示不限制
        assert!(!over_threshold(4, &Some(5)));
        assert!(over_threshold(5, &Some(5)));
        assert!(over_threshold(6, &Some(5)));
        assert!(!over_threshold(4, &Some(-1))); // 非法负数视为不限制
    }

    #[test]
    fn test_pick_cursor_index_wraps() {
        assert_eq!(pick_cursor_index(3, 0), 0);
        assert_eq!(pick_cursor_index(3, 5), 2);
        assert_eq!(pick_cursor_index(3, -1), 2);
        assert_eq!(pick_cursor_index(0, 7), 0);
    }

    #[test]
    fn test_scheduler_auto_run_gate() {
        let scheduler = Scheduler::new();
        // 启动后默认不允许自动执行任何任务
        assert!(!scheduler.is_auto_run());
        scheduler.enable_auto_run();
        assert!(scheduler.is_auto_run());
    }

    #[test]
    fn test_scheduler_is_current() {
        let scheduler = Scheduler::new();
        assert!(!scheduler.is_current(1));
        assert!(scheduler.try_acquire(1));
        assert!(scheduler.is_current(1));
        assert!(!scheduler.is_current(2));
        scheduler.release();
        assert!(!scheduler.is_current(1));
    }

    /** 轮次目录名：yyyyMMdd_HHmmss_fff 或加 _N 冲突后缀 */
    fn valid_round_dir_name(name: &str) -> bool {
        if name.len() < 19 {
            return false;
        }
        let base = &name.as_bytes()[..19];
        for (i, ch) in base.iter().enumerate() {
            if i == 8 || i == 15 {
                if *ch != b'_' {
                    return false;
                }
            } else if !ch.is_ascii_digit() {
                return false;
            }
        }
        let rest = &name[19..];
        rest.is_empty()
            || (rest.starts_with('_')
                && rest.len() > 1
                && rest[1..].chars().all(|c| c.is_ascii_digit()))
    }

    #[test]
    fn test_allocate_round_dir_naming_and_conflict() {
        let root = std::env::temp_dir().join(format!("doubao_round_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let first = allocate_round_dir(&root);
        let name = first.file_name().unwrap().to_string_lossy().to_string();
        assert!(valid_round_dir_name(&name), "unexpected dir name: {}", name);

        std::fs::create_dir_all(&first).unwrap();
        let second = allocate_round_dir(&root);
        assert_ne!(first, second, "已存在目录时不得复用");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_pick_scan_root_prefers_references_dir() {
        let root = std::env::temp_dir().join(format!("scan_root_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("references")).unwrap();
        std::fs::create_dir_all(root.join("output")).unwrap();
        assert_eq!(pick_scan_root(&root), root.join("references"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_pick_scan_root_falls_back_to_project_root() {
        let root = std::env::temp_dir().join(format!("scan_root_test_bare_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("output")).unwrap();
        assert_eq!(pick_scan_root(&root), root);
        let _ = std::fs::remove_dir_all(&root);
    }
}
