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

/** 调度器全局状态 */
pub struct Scheduler {
    /** 当前正在执行的任务 ID（串行，None 表示空闲） */
    current_task: Mutex<Option<i64>>,
    /** Sidecar 子进程 stdin（用于发送命令） */
    sidecar_stdin: Mutex<Option<ChildStdin>>,
    /** Sidecar 事件发送通道（stdout 读取线程 -> 调度器） */
    sidecar_event_tx: Mutex<Option<mpsc::UnboundedSender<serde_json::Value>>>,
    /** Sidecar 事件接收通道（供执行任务接收提取/下载结果；异步锁，整个任务期间持有） */
    sidecar_event_rx: tokio::sync::Mutex<Option<mpsc::UnboundedReceiver<serde_json::Value>>>,
    /** 调度器运行标志 */
    running: Mutex<bool>,
}

impl Scheduler {
    pub fn new() -> Self {
        Scheduler {
            current_task: Mutex::new(None),
            sidecar_stdin: Mutex::new(None),
            sidecar_event_tx: Mutex::new(None),
            sidecar_event_rx: tokio::sync::Mutex::new(None),
            running: Mutex::new(false),
        }
    }

    /** 启动 Sidecar 进程（Node.js + Playwright Chromium） */
    pub async fn start_sidecar(&self, app: &AppHandle) -> Result<(), String> {
        let index_js = resolve_sidecar_index(app)?;

        let mut child = {
            let mut stdin_guard = self.sidecar_stdin.lock().map_err(|e| e.to_string())?;
            if stdin_guard.is_some() {
                return Ok(()); // 已启动
            }

            let node_exe = which_node()?;
            let mut child = Command::new(&node_exe)
            .arg(&index_js)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    format!(
                        "未找到 Node.js 运行时（sidecar 需要 Node.js >= 20）。请安装 Node.js，或设置 NODE_EXE 环境变量指向 node.exe 的完整路径。（尝试启动: {}，入口: {}）",
                        node_exe,
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
}

impl Default for Scheduler {
    fn default() -> Self {
        Self::new()
    }
}

/** 从哪里获取 node 可执行文件路径 */
fn which_node() -> Result<String, String> {
    if let Ok(p) = std::env::var("NODE_EXE") {
        return Ok(p);
    }
    Ok("node".to_string())
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
    let dev_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("sidecar")
        .join("src")
        .join("index.js");
    if dev_path.exists() {
        return Ok(dev_path);
    }
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
            .prepare("SELECT id, name, project_id, account_id, status, current_round, total_rounds, created_at, updated_at, started_at, completed_at FROM tasks WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1")
            .and_then(|mut stmt| {
                stmt.query_row([], |row| {
                    Ok(Task {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        project_id: row.get(2)?,
                        account_id: row.get(3)?,
                        status: row.get(4)?,
                        current_round: row.get(5)?,
                        total_rounds: row.get(6)?,
                        created_at: row.get(7)?,
                        updated_at: row.get(8)?,
                        started_at: row.get(9)?,
                        completed_at: row.get(10)?,
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

/** 等待某个 result 命令的结果（带超时）；返回 `result` 或 `error` 行 */
async fn wait_result(
    rx: &mut mpsc::UnboundedReceiver<serde_json::Value>,
    cmd: &str,
    timeout_s: u64,
) -> Option<serde_json::Value> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_s);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return None;
        }
        match tokio::time::timeout(remaining.min(Duration::from_secs(1)), rx.recv()).await {
            Ok(Some(ev)) => {
                let t = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let c = ev.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
                if (t == "result" || t == "error") && c == cmd {
                    return Some(ev);
                }
            }
            Ok(None) => return None,
            Err(_) => continue,
        }
    }
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
        .prepare("SELECT id, name, project_id, account_id, status, current_round, total_rounds, created_at, updated_at, started_at, completed_at FROM tasks WHERE id = ?1")
        .map_err(|e| e.to_string())?;
    stmt.query_row([tid], |row| {
        Ok(Task {
            id: row.get(0)?,
            name: row.get(1)?,
            project_id: row.get(2)?,
            account_id: row.get(3)?,
            status: row.get(4)?,
            current_round: row.get(5)?,
            total_rounds: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
            started_at: row.get(9)?,
            completed_at: row.get(10)?,
        })
    })
    .map_err(|e| e.to_string())
}

/** 读取任务最新一轮（id, round_number）；无轮次返回 None */
fn load_latest_round(tid: i64) -> Result<Option<(i64, i64)>, String> {
    let conn = get_connection()?;
    let mut stmt = conn
        .prepare("SELECT id, round_number FROM task_rounds WHERE task_id = ?1 ORDER BY round_number DESC LIMIT 1")
        .map_err(|e| e.to_string())?;
    match stmt.query_row([tid], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))) {
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
    let prompt = read_prompt(&project_root, prompt_path.as_deref());
    let round_number = task.current_round.unwrap_or(0) + 1;

    // 2. 启动可见浏览器（每账号独立 userDataDir）
    set_task_status(&app, tid, "preparing", "启动可见浏览器…");
    eprintln!("[调度器] 任务 {} 启动可见浏览器…", tid);
    eprintln!("[调度器] 发送 start_browser 命令 (account_id={})…", account_id);
    let start_cmd = serde_json::json!({
        "cmd": "start_browser",
        "account_id": account_id,
        "user_data_dir": user_data_dir,
    });
    if let Err(e) = scheduler.send_sidecar_cmd(start_cmd) {
        set_task_status(&app, tid, "failed", &format!("发送启动浏览器命令失败: {}", e));
        scheduler.release();
        return;
    }
    eprintln!("[调度器] 等待 start_browser 响应 (最长 90 秒)…");
    let res = wait_result(event_rx, "start_browser", 90).await;
    eprintln!("[调度器] start_browser 响应: {:?}", res);

    // 3. selecting_images：扫描参考图 + 文件夹独立抽取 5 张
    set_task_status(&app, tid, "selecting_images", "扫描参考图片并抽取本轮图片");
    eprintln!("[调度器] 发送 scan_images 命令…");
    let state_dir = crate::task_scheduler::app_data_dir()
        .map(|d| d.join("pool").join(format!("project_{}", task.project_id.unwrap_or(0))))
        .unwrap_or_else(|_| project_root.join(".doubao"));
    let units_file = state_dir.join(format!("round_{}.units.json", round_number));
    let scan_cmd = serde_json::json!({
        "cmd": "scan_images",
        "task_id": tid,
        "root_path": project_root.to_string_lossy(),
        "round_number": round_number,
        "state_dir": state_dir.to_string_lossy(),
        "units_file": units_file.to_string_lossy(),
        "count": 5,
    });
    if let Err(e) = scheduler.send_sidecar_cmd(scan_cmd) {
        set_task_status(&app, tid, "failed", &format!("发送扫描命令失败: {}", e));
        scheduler.release();
        return;
    }
    let scan_res = wait_result(event_rx, "scan_images", 120).await;
    eprintln!("[调度器] scan_images 响应: {:?}", scan_res);
    let scan_ok = scan_res.as_ref().and_then(|v| v.get("ok")).and_then(|v| v.as_bool()).unwrap_or(false);
    if !scan_ok {
        let reason = scan_res.as_ref().and_then(|v| v.get("reason")).and_then(|v| v.as_str()).unwrap_or("unknown");
        set_task_status(&app, tid, "failed", &format!("参考图片抽取失败: {}", reason));
        scheduler.release();
        return;
    }
    let selected: Vec<serde_json::Value> = scan_res.as_ref()
        .and_then(|v| v.get("selected")).and_then(|v| v.as_array()).cloned().unwrap_or_default();
    if selected.is_empty() {
        set_task_status(&app, tid, "failed", "本轮未抽取到任何参考图片");
        scheduler.release();
        return;
    }

    // 持久化 image_pool_records + 写日志
    {
        if let Ok(conn) = get_connection() {
            let total_images = scan_res.as_ref().and_then(|v| v.get("total_images")).and_then(|v| v.as_i64()).unwrap_or(0);
            let folder_count = scan_res.as_ref().and_then(|v| v.get("folders")).and_then(|v| v.as_i64()).unwrap_or(0);
            for item in &selected {
                let path = item.get("path").and_then(|v| v.as_str()).unwrap_or("");
                let sha = item.get("sha256").and_then(|v| v.as_str()).unwrap_or("");
                let _ = conn.execute(
                    "INSERT INTO image_pool_records (project_id, image_path, sha256, last_used_at, use_count) VALUES (?1, ?2, ?3, ?4, 1)",
                    rusqlite::params![task.project_id.unwrap_or(0), path, sha, Utc::now().to_rfc3339()],
                );
            }
            let _ = db_write_log(&conn, Some(tid), "info",
                &format!("本轮抽取 {} 张参考图（共 {} 张候选、{} 个文件夹）", selected.len(), total_images, folder_count));
        }
    }

    // 创建本轮记录
    let refs_json = serde_json::to_string(&selected).unwrap_or_else(|_| "[]".to_string());
    let round_id = {
        let conn = match get_connection() {
            Ok(c) => c,
            Err(e) => {
                set_task_status(&app, tid, "failed", &format!("打开数据库失败: {}", e));
                scheduler.release();
                return;
            }
        };
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO task_rounds (task_id, round_number, prompt_snapshot, references_json, status, submitted_at) VALUES (?1, ?2, ?3, ?4, 'selecting_images', ?5)",
            rusqlite::params![tid, round_number, prompt.clone(), refs_json, now],
        ).unwrap();
        conn.last_insert_rowid()
    };

    // 4. uploading/submitting/generating：通过 sidecar 上传、提交、等待生成
    set_task_status(&app, tid, "uploading", "上传参考图片并提交生图");
    let refs_paths: Vec<String> = selected.iter()
        .filter_map(|v| v.get("path").and_then(|s| s.as_str()).map(|s| s.to_string()))
        .collect();
    let gen_cmd = serde_json::json!({
        "cmd": "generate_images",
        "task_id": tid,
        "account_id": account_id,
        "project_root": project_root.to_string_lossy(),
        "refs": refs_paths,
        "prompt": prompt,
    });
    if let Err(e) = scheduler.send_sidecar_cmd(gen_cmd) {
        set_task_status(&app, tid, "failed", &format!("发送生图命令失败: {}", e));
        scheduler.release();
        return;
    }
    set_task_status(&app, tid, "submitting", "已提交，等待生成完成");
    let gen_res = wait_result(event_rx, "generate_images", 300).await;
    let gen_ok = gen_res.as_ref().and_then(|v| v.get("ok")).and_then(|v| v.as_bool()).unwrap_or(false);
    if !gen_ok {
        let reason = gen_res.as_ref().and_then(|v| v.get("reason")).and_then(|v| v.as_str()).unwrap_or("unknown");
        let msg = gen_res.as_ref().and_then(|v| v.get("message")).and_then(|v| v.as_str()).unwrap_or("");
        let (status, log) = classify_gen_failure(reason);
        if let Ok(conn) = get_connection() {
            let _ = conn.execute(
                "UPDATE task_rounds SET status = 'failed', failure_reason = ?1, completed_at = ?2 WHERE id = ?3",
                rusqlite::params![format!("{}: {}", reason, msg), Utc::now().to_rfc3339(), round_id],
            );
            let _ = db_write_log(&conn, Some(tid), "error", &format!("生图未完成（{}）: {} {}", reason, msg, log));
        }
        set_task_status(&app, tid, status, &format!("生图未完成（{}）: {} {}", reason, msg, log));
        scheduler.release();
        return;
    }

    finish_after_generation(&app, &scheduler, event_rx, tid, account_id, round_number, &project_root, round_id).await;
    scheduler.release();
}

/**
 * 生成完成后的收尾流程：提取 → 下载 → 校验 → 完成/失败。
 * 完整流程（execute_task）与人工干预后的继续流程（resume_task）共用，
 * 调用方负责领取/释放调度器执行权，本函数不释放。
 */
#[allow(clippy::too_many_arguments)]
async fn finish_after_generation(
    app: &AppHandle,
    scheduler: &Scheduler,
    event_rx: &mut mpsc::UnboundedReceiver<serde_json::Value>,
    tid: i64,
    account_id: i64,
    round_number: i64,
    project_root: &std::path::Path,
    round_id: i64,
) {
    // 5. generating → 提取：DOM 扫描生成图片 URL
    set_task_status(app, tid, "generating", "生成完成，提取图片 URL");
    let extract_cmd = serde_json::json!({
        "cmd": "extract_images",
        "task_id": tid,
        "account_id": account_id,
        "project_root": project_root.to_string_lossy(),
    });
    if let Err(e) = scheduler.send_sidecar_cmd(extract_cmd) {
        set_task_status(&app, tid, "failed", &format!("发送提取命令失败: {}", e));
        return;
    }
    let extract_res = wait_result(event_rx, "extract_images", 180).await;
    let extract_ok = extract_res.as_ref().and_then(|v| v.get("ok")).and_then(|v| v.as_bool()).unwrap_or(false);
    let raw_images: Vec<serde_json::Value> = extract_res.as_ref()
        .and_then(|v| v.get("images")).and_then(|v| v.as_array()).cloned().unwrap_or_default();
    if !extract_ok || raw_images.is_empty() {
        let reason = extract_res.as_ref().and_then(|v| v.get("reason")).and_then(|v| v.as_str()).unwrap_or("unknown");
        if let Ok(conn) = get_connection() {
            let _ = conn.execute(
                "UPDATE task_rounds SET status = 'failed', failure_reason = ?1, completed_at = ?2 WHERE id = ?3",
                rusqlite::params![reason, Utc::now().to_rfc3339(), round_id],
            );
        }
        set_task_status(&app, tid, "needs_manual_intervention", &format!("未提取到生成图片（{}），请查看诊断信息", reason));
        return;
    }

    // 6. downloading：下载到 output/round_<n>
    set_task_status(&app, tid, "downloading", "下载生成图片");
    let round_dir = project_root.join("output").join(format!("round_{}", round_number));
    let download_items: Vec<serde_json::Value> = raw_images.iter().enumerate().map(|(idx, img)| {
        serde_json::json!({
            "url": img.get("url").and_then(|v| v.as_str()).unwrap_or(""),
            "index": idx,
        })
    }).collect();
    let download_cmd = serde_json::json!({
        "cmd": "download_images",
        "task_id": tid,
        "account_id": account_id,
        "round_id": round_id,
        "round_dir": round_dir.to_string_lossy(),
        "images": download_items,
    });
    if let Err(e) = scheduler.send_sidecar_cmd(download_cmd) {
        set_task_status(&app, tid, "failed", &format!("发送下载命令失败: {}", e));
        return;
    }
    let dl_res = wait_result(event_rx, "download_images", 300).await;
    let download_results: Vec<serde_json::Value> = dl_res.as_ref()
        .and_then(|v| v.get("results")).and_then(|v| v.as_array()).cloned().unwrap_or_default();

    // 7. verifying：写入图片记录、计算成功数
    let mut success_count = 0i64;
    {
        let conn = match get_connection() {
            Ok(c) => c,
            Err(e) => {
                set_task_status(&app, tid, "failed", &format!("打开数据库失败: {}", e));
                return;
            }
        };
        for (i, item) in download_results.iter().enumerate() {
            let ok = item.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
            let path = item.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let size = item.get("size").and_then(|v| v.as_i64()).unwrap_or(0);
            let sha256 = item.get("sha256").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let ext = item.get("ext").and_then(|v| v.as_str()).unwrap_or("png").to_string();
            let url = item.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if ok { success_count += 1; }
            let _ = conn.execute(
                "INSERT INTO task_images (task_round_id, image_index, original_url, saved_path, sha256, file_size, format, download_status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    round_id,
                    (i as i64) + 1,
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
        let round_status = if success_count > 0 { "completed" } else { "failed" };
        let _ = conn.execute(
            "UPDATE task_rounds SET status = ?1, success_count = ?2, completed_at = ?3 WHERE id = ?4",
            rusqlite::params![round_status, success_count, Utc::now().to_rfc3339(), round_id],
        );
        let _ = db_write_log(&conn, Some(tid), "info",
            &format!("本轮下载完成：成功 {}/{} 张", success_count, total));
    }

    // 8. completed / failed（无成功下载则不得标记已完成）
    if success_count > 0 {
        let now = Utc::now().to_rfc3339();
        if let Ok(conn) = get_connection() {
            let _ = conn.execute(
                "UPDATE tasks SET status = 'completed', current_round = ?1, updated_at = ?2, completed_at = ?2 WHERE id = ?3",
                rusqlite::params![round_number, now, tid],
            );
            let _ = db_write_log(&conn, Some(tid), "info", &format!("任务完成：本轮成功下载 {} 张图片", success_count));
        }
        set_task_status(&app, tid, "completed", "任务完成");
        let _ = app.emit("task-completed", serde_json::json!({ "task_id": tid }));
    } else {
        if let Ok(conn) = get_connection() {
            let _ = conn.execute(
                "UPDATE tasks SET status = 'failed', updated_at = ?1 WHERE id = ?2",
                rusqlite::params![Utc::now().to_rfc3339(), tid],
            );
            let _ = db_write_log(&conn, Some(tid), "error", "任务失败：本轮未成功下载任何图片");
        }
        set_task_status(&app, tid, "failed", "任务失败：未成功下载任何图片");
    }
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

    // 从未提交过：完整重新执行（不存在重复提交问题）
    let latest = load_latest_round(tid)?;
    if latest.is_none() {
        if let Ok(conn) = get_connection() {
            let _ = db_write_log(&conn, Some(tid), "info", "未找到已提交轮次，按完整流程重新执行");
        }
        execute_task(app.clone(), scheduler.clone(), task).await;
        return Ok(());
    }
    let (round_id, round_number) = latest.unwrap();

    // 启动/复用 sidecar
    scheduler.start_sidecar(app).await?;

    let mut rx_guard = scheduler.sidecar_event_rx.lock().await;
    let event_rx = rx_guard.as_mut().ok_or("sidecar 事件通道未初始化")?;

    let ctx = load_task_context(tid)?;
    let account_id = ctx.account_id;
    let project_root = ctx.project_root.clone();

    set_task_status(app, tid, "generating", "继续执行：先检查页面状态");

    let resume_cmd = serde_json::json!({
        "cmd": "resume_generate",
        "account_id": account_id,
        "generation_timeout_ms": 180000,
    });
    scheduler.send_sidecar_cmd(resume_cmd)?;

    // resume_generate 最长等一个生图周期（180s）+ 余量
    let res = wait_result(event_rx, "resume_generate", 240).await;
    let ok = res.as_ref().and_then(|v| v.get("ok")).and_then(|v| v.as_bool()).unwrap_or(false);
    let state = res.as_ref().and_then(|v| v.get("state")).and_then(|v| v.as_str()).unwrap_or("");

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
        let reason = res.as_ref().and_then(|v| v.get("reason")).and_then(|v| v.as_str()).unwrap_or("unknown");
        let msg = res.as_ref().and_then(|v| v.get("message")).and_then(|v| v.as_str()).unwrap_or("");
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

    // 页面已有生成图（或等待后出现）：提取 → 下载 → 校验 → 完成
    finish_after_generation(app, scheduler, event_rx, tid, account_id, round_number, &project_root, round_id).await;
    Ok(())
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
}
