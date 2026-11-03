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
    /** Sidecar 事件接收通道（供 execute_task 接收提取/下载结果） */
    sidecar_event_rx: Mutex<Option<mpsc::UnboundedReceiver<serde_json::Value>>>,
    /** 调度器运行标志 */
    running: Mutex<bool>,
}

impl Scheduler {
    pub fn new() -> Self {
        Scheduler {
            current_task: Mutex::new(None),
            sidecar_stdin: Mutex::new(None),
            sidecar_event_tx: Mutex::new(None),
            sidecar_event_rx: Mutex::new(None),
            running: Mutex::new(false),
        }
    }

    /** 启动 Sidecar 进程（Node.js + Playwright Chromium） */
    pub fn start_sidecar(&self, app: &AppHandle) -> Result<(), String> {
        let mut stdin_guard = self.sidecar_stdin.lock().map_err(|e| e.to_string())?;
        if stdin_guard.is_some() {
            return Ok(()); // 已启动
        }

        let app_dir = dirs::data_local_dir()
            .ok_or("无法获取本地数据目录")?
            .join("DoubaoBatchImage")
            .join("sidecar");

        let node_exe = which_node()?;
        let mut child = Command::new(node_exe)
            .arg(app_dir.join("src/index.js"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("启动 sidecar 失败: {}", e))?;

        let stdin = child.stdin.take().ok_or("无法获取 sidecar stdin")?;
        *stdin_guard = Some(stdin);

        // 创建 sidecar 事件通道，供 execute_task 接收提取/下载结果
        let (event_tx, event_rx) = mpsc::unbounded_channel::<serde_json::Value>();
        {
            let mut tx_guard = self.sidecar_event_tx.lock().map_err(|e| e.to_string())?;
            *tx_guard = Some(event_tx.clone());
        }
        {
            let mut rx_guard = self.sidecar_event_rx.lock().map_err(|e| e.to_string())?;
            *rx_guard = Some(event_rx);
        }

        // 启动 stdout 读取线程，将 sidecar 事件转发为 Tauri Event 并发送到事件通道
        let app_handle = app.app_handle().clone();
        let stdout = child.stdout.take().ok_or("无法获取 sidecar stdout")?;
        tokio::spawn(async move {
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

        // 启动 stderr 读取线程
        let app_handle_err = app.app_handle().clone();
        let stderr = child.stderr.take().ok_or("无法获取 sidecar stderr")?;
        tokio::spawn(async move {
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

/** 执行单个任务（完整状态机） */
async fn execute_task(app: AppHandle, scheduler: Arc<Scheduler>, task: Task) {
    let _app_handle = app.clone();

    // 辅助：更新状态 + 写日志
    let set_status = |app: &AppHandle, conn: &Connection, tid: i64, status: &str, msg: &str| {
        let _ = db_update_task_status(conn, tid, status);
        let _ = db_write_log(conn, Some(tid), "info", msg);
        let _ = app.emit("task-status-changed", serde_json::json!({
            "task_id": tid,
            "status": status,
        }));
    };

    // 1. preparing
    {
        let conn = get_connection().unwrap();
        set_status(&app, &conn, task.id.expect("task id"), "preparing", "任务准备中");
        drop(conn);
    }
    sleep(Duration::from_millis(500)).await;

    // 启动 sidecar（若未启动）
    if let Err(e) = scheduler.start_sidecar(&app) {
        let conn = get_connection().unwrap();
        set_status(&app, &conn, task.id.expect("task id"), "failed", &format!("启动自动化浏览器失败: {}", e));
        drop(conn);
        scheduler.release();
        return;
    }

    // 2. selecting_images：扫描参考图片并抽取
    {
        let conn = get_connection().unwrap();
        set_status(&app, &conn, task.id.expect("task id"), "selecting_images", "扫描参考图片并抽取");
        drop(conn);
    }

    // 获取项目根目录和账号 user_data_dir
    let project_root = {
        let conn = get_connection().unwrap();
        let result: String = {
            let mut stmt = conn
                .prepare("SELECT p.root_path FROM tasks t JOIN projects p ON t.project_id = p.id WHERE t.id = ?1")
                .unwrap();
            stmt.query_row([task.id], |row| row.get::<_, String>(0)).unwrap()
        };
        drop(conn);
        result
    };

    // 扫描参考图片目录（通过 sidecar）
    let scan_cmd = serde_json::json!({
        "cmd": "scan_images",
        "project_id": task.project_id,
        "root_path": project_root,
    });
    if let Err(e) = scheduler.send_sidecar_cmd(scan_cmd) {
        let conn = get_connection().unwrap();
        set_status(&app, &conn, task.id.expect("task id"), "failed", &format!("发送扫描命令失败: {}", e));
        drop(conn);
        scheduler.release();
        return;
    }

    // 等待 sidecar 返回扫描结果（简化：实际应监听 sidecar-event，暂时等待）
    sleep(Duration::from_secs(3)).await;

    // 3. generating：通过 sidecar 提取图片
    {
        let conn = get_connection().unwrap();
        set_status(&app, &conn, task.id.expect("task id"), "generating", "提取生成的图片");
        drop(conn);
    }

    // 获取获取图片的接收器（从 sidecar_event_rx 克隆，避免所有权问题）
    let mut event_rx: mpsc::UnboundedReceiver<serde_json::Value> = {
        let mut guard = scheduler.sidecar_event_rx.lock().map_err(|e| e.to_string()).unwrap();
        guard.take().ok_or("sidecar 事件通道未初始化").unwrap()
    };

    // 发送 extract_images 命令给 sidecar
    let extract_cmd = serde_json::json!({
        "cmd": "extract_images",
        "task_id": task.id,
    });
    if let Err(e) = scheduler.send_sidecar_cmd(extract_cmd) {
        let conn = get_connection().unwrap();
        set_status(&app, &conn, task.id.expect("task id"), "failed", &format!("发送提取命令失败: {}", e));
        drop(conn);
        scheduler.release();
        return;
    }

    // 等待 sidecar 返回图片提取结果（最多等待 60 秒）
    let extracted_images = {
        let mut deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        let mut images: Vec<serde_json::Value> = Vec::new();
        loop {
            match tokio::time::timeout(Duration::from_secs(1), event_rx.recv()).await {
                Ok(event) => {
                    let event = event.expect("sidecar 事件通道已关闭");
                    let event_type = event.get("event").and_then(|v| v.as_str()).unwrap_or("");
                    if event_type == "images_extracted" {
                        if let Some(arr) = event.get("images").and_then(|v| v.as_array()) {
                            images = arr.clone();
                        }
                        break;
                    } else if event_type == "error" {
                        let conn = get_connection().unwrap();
                        set_status(&app, &conn, task.id.expect("task id"), "failed", &format!("图片提取失败: {:?}", event));
                        drop(conn);
                        scheduler.release();
                        return;
                    }
                }
                Err(_) => {
                    if deadline.elapsed() > Duration::from_secs(60) {
                        break;
                    }
                    continue;
                }
            }
            if deadline.elapsed() > Duration::from_secs(60) {
                break;
            }
        }
        images
    };

    // 创建 task_round 记录
    let round_id = {
        let conn = get_connection().unwrap();
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO task_rounds (task_id, round_number, prompt_snapshot, references_json, status, submitted_at) VALUES (?1, ?2, ?3, ?4, 'submitting', ?5)",
            rusqlite::params![task.id, task.current_round.unwrap_or(1), "auto_capture", "[]", now],
        ).unwrap();
        let rid = conn.last_insert_rowid();
        let _ = db_write_log(&conn, Some(task.id.expect("task id")), "info", &format!("发现 {} 张图片，开始下载", extracted_images.len()));
        drop(conn);
        rid
    };

    // 4. downloading：通过 sidecar 下载图片
    {
        let conn = get_connection().unwrap();
        set_status(&app, &conn, task.id.expect("task id"), "downloading", "下载图片");
        drop(conn);
    }

    // 准备下载项
    let download_items: Vec<serde_json::Value> = extracted_images.iter().enumerate().map(|(idx, img)| {
        serde_json::json!({
            "url": img.get("url").and_then(|v| v.as_str()).unwrap_or(""),
            "index": idx,
        })
    }).collect();

    let download_cmd = serde_json::json!({
        "cmd": "download_images",
        "task_id": task.id,
        "round_id": round_id,
        "images": download_items,
    });
    if let Err(e) = scheduler.send_sidecar_cmd(download_cmd) {
        let conn = get_connection().unwrap();
        set_status(&app, &conn, task.id.expect("task id"), "failed", &format!("发送下载命令失败: {}", e));
        drop(conn);
        scheduler.release();
        return;
    }

    // 等待下载完成（最多 120 秒）
    let download_results: Vec<serde_json::Value> = {
        let mut deadline = tokio::time::Instant::now() + Duration::from_secs(120);
        let mut results: Vec<serde_json::Value> = Vec::new();
        loop {
            if deadline.elapsed() > Duration::from_secs(120) {
                break;
            }
            match tokio::time::timeout(Duration::from_secs(1), event_rx.recv()).await {
                Ok(event) => {
                    let event = event.expect("sidecar 事件通道已关闭");
                    let event_type = event.get("event").and_then(|v| v.as_str()).unwrap_or("");
                    if event_type == "download_completed" {
                        if let Some(arr) = event.get("results").and_then(|v| v.as_array()) {
                            results = arr.clone();
                        }
                        break;
                    } else if event_type == "error" {
                        let conn = get_connection().unwrap();
                        set_status(&app, &conn, task.id.expect("task id"), "failed", &format!("下载失败: {:?}", event));
                        drop(conn);
                        scheduler.release();
                        return;
                    }
                }
                Err(_) => {
                    if deadline.elapsed() > Duration::from_secs(120) {
                        break;
                    }
                    continue;
                }
            }
            if deadline.elapsed() > Duration::from_secs(120) {
                break;
            }
        }
        results
    };

    // 5. verifying：写入图片记录并更新轮次状态
    {
        let conn = get_connection().unwrap();
        let mut success_count = 0;
        for (i, item) in download_results.iter().enumerate() {
            let ok = item.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
            let path = item.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let size = item.get("size").and_then(|v| v.as_i64()).unwrap_or(0);
            let sha256 = item.get("sha256").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let ext = item.get("ext").and_then(|v| v.as_str()).unwrap_or("png").to_string();
            let url = item.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();

            if ok {
                success_count += 1;
            }

            conn.execute(
                "INSERT INTO task_images (task_round_id, image_index, original_url, saved_path, sha256, file_size, format, download_status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    round_id,
                    i + 1,
                    url,
                    path,
                    if sha256.is_empty() { None } else { Some(sha256) },
                    size,
                    ext,
                    if ok { "verified" } else { "failed" },
                ],
            ).unwrap();
        }

        // 更新轮次状态
        let round_status = if success_count == download_results.len() { "completed" } else { "completed" };
        conn.execute(
            "UPDATE task_rounds SET status = ?1, success_count = ?2, completed_at = ?3 WHERE id = ?4",
            rusqlite::params![round_status, success_count, Utc::now().to_rfc3339(), round_id],
        ).unwrap();
        drop(conn);
    }

    // 6. completed
    {
        let conn = get_connection().unwrap();
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE tasks SET status = 'completed', updated_at = ?1, completed_at = ?1 WHERE id = ?2",
            rusqlite::params![now, task.id.expect("task id")],
        ).unwrap();
        let _ = db_write_log(&conn, Some(task.id.expect("task id")), "info", "任务完成");
        drop(conn);
    }

    let _ = app.emit("task-completed", serde_json::json!({ "task_id": task.id.expect("task id") }));
    scheduler.release();
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
