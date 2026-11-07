use chrono::{Local, Utc};
use serde::Deserialize;
use std::sync::Arc;
use tauri::{AppHandle, State};

use crate::db::get_connection;
use crate::models::{Account, DashboardStats, LogEntry, Project, Task, TaskImage, TaskRound};
use crate::task_scheduler;
use crate::task_scheduler::Scheduler;

#[derive(Deserialize)]
pub struct TaskStartPayload {
    pub task_id: i64,
}

#[derive(Deserialize)]
pub struct TaskCreateRoundPayload {
    pub task_id: i64,
    pub round_number: i64,
    pub prompt_snapshot: Option<String>,
    pub references_json: Option<String>,
}

#[derive(Deserialize, Clone)]
pub struct TaskAddImagePayload {
    pub task_round_id: i64,
    pub image_index: i64,
    pub original_url: Option<String>,
    pub saved_path: Option<String>,
    pub sha256: Option<String>,
    pub file_size: Option<i64>,
    pub format: Option<String>,
}

#[derive(Deserialize)]
pub struct TaskUpdateRoundPayload {
    pub round_id: i64,
    pub status: Option<String>,
    pub success_count: Option<i64>,
    pub failure_reason: Option<String>,
}

/** 确保 sidecar 已启动（供登录等非任务型命令使用） */
async fn manager_ensure_sidecar(app: &AppHandle, scheduler: &Scheduler) -> Result<(), String> {
    scheduler.start_sidecar(app).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn project_list() -> Result<Vec<Project>, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, root_path, prompt_path, created_at, updated_at FROM projects ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                root_path: row.get(2)?,
                prompt_path: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn project_create(name: String, root_path: String) -> Result<Project, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    // 创建项目根目录与参考图片目录，便于用户直接放入参考图片
    let root = std::path::PathBuf::from(&root_path);
    let _ = std::fs::create_dir_all(root.join("references"));
    let _ = std::fs::create_dir_all(root.join("output"));
    conn.execute(
        "INSERT INTO projects (name, root_path, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        rusqlite::params![name, root_path, now],
    )
    .map_err(|e| e.to_string())?;
    let last_id = conn.last_insert_rowid();
    Ok(Project {
        id: Some(last_id),
        name,
        root_path,
        prompt_path: None,
        created_at: Some(now.clone()),
        updated_at: Some(now),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn project_delete(id: i64) -> Result<(), String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM projects WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn account_list() -> Result<Vec<Account>, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, user_data_dir, status, image_threshold, success_count, submit_count, last_used_at, created_at FROM accounts ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Account {
                id: row.get(0)?,
                name: row.get(1)?,
                user_data_dir: row.get(2)?,
                status: row.get(3)?,
                image_threshold: row.get(4)?,
                success_count: row.get(5)?,
                submit_count: row.get(6)?,
                last_used_at: row.get(7)?,
                created_at: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn account_add(name: String) -> Result<Account, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    // 每个账号独立的用户数据目录（绝对路径，便于传给 Sidecar 启动 Chromium 持久化上下文）
    let user_data_dir = crate::task_scheduler::app_data_dir()?
        .join("accounts")
        .join(&name)
        .join("user-data")
        .to_string_lossy()
        .to_string();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO accounts (name, user_data_dir, status, success_count, submit_count, created_at) VALUES (?1, ?2, 'unknown', 0, 0, ?3)",
        rusqlite::params![name, user_data_dir, now],
    )
    .map_err(|e| e.to_string())?;
    let last_id = conn.last_insert_rowid();
    Ok(Account {
        id: Some(last_id),
        name,
        user_data_dir,
        status: "unknown".to_string(),
        image_threshold: Some(0),
        success_count: Some(0),
        submit_count: Some(0),
        last_used_at: None,
        created_at: Some(now),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn account_delete(id: i64) -> Result<(), String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM accounts WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn settings_get(key: String) -> Result<Option<String>, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT value FROM app_settings WHERE key = ?1").map_err(|e| e.to_string())?;
    let row = stmt.query_row([&key], |row| row.get::<_, String>(0));
    match row {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn settings_set(key: String, value: String) -> Result<(), String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
        rusqlite::params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn task_list() -> Result<Vec<Task>, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, project_id, account_id, status, current_round, total_rounds, created_at, updated_at, started_at, completed_at FROM tasks ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
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
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/** 生成任务名：项目名-日期（本地日期，如：奶瓶收纳盒生图-2026-11-06） */
fn make_task_name(project_name: &str) -> String {
    let trimmed = project_name.trim();
    let base = if trimmed.is_empty() { "任务" } else { trimmed };
    format!("{}-{}", base, Local::now().format("%Y-%m-%d"))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn task_create(project_id: i64, account_id: i64) -> Result<Task, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let project_name: String = conn
        .query_row("SELECT name FROM projects WHERE id = ?1", [project_id], |row| row.get(0))
        .map_err(|_| "项目不存在".to_string())?;
    let name = make_task_name(&project_name);
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO tasks (name, project_id, account_id, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'pending', ?4, ?4)",
        rusqlite::params![name, project_id, account_id, now],
    )
    .map_err(|e| e.to_string())?;
    let last_id = conn.last_insert_rowid();
    Ok(Task {
        id: Some(last_id),
        name,
        project_id: Some(project_id),
        account_id: Some(account_id),
        status: "pending".to_string(),
        current_round: Some(0),
        total_rounds: Some(0),
        created_at: Some(now.clone()),
        updated_at: Some(now),
        started_at: None,
        completed_at: None,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn task_start(
    app: AppHandle,
    scheduler: State<'_, Arc<Scheduler>>,
    payload: TaskStartPayload,
) -> Result<(), String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE tasks SET status = 'pending', updated_at = ?1 WHERE id = ?2",
        rusqlite::params![now, payload.task_id],
    )
    .map_err(|e| e.to_string())?;
    drop(conn);

    let scheduler_inner = scheduler.inner().clone();
    let app_clone = app.clone();
    tokio::spawn(async move {
        let _ = task_scheduler::trigger_task_start(app_clone, scheduler_inner, payload.task_id);
    });

    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn task_pause(id: i64) -> Result<(), String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE tasks SET status = 'paused', updated_at = ?1 WHERE id = ?2",
        rusqlite::params![Utc::now().to_rfc3339(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn task_resume(id: i64) -> Result<(), String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE tasks SET status = 'pending', updated_at = ?1 WHERE id = ?2 AND status = 'paused'",
        rusqlite::params![Utc::now().to_rfc3339(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/**
 * 人工干预后继续执行：检查豆包页面状态后接着完成（不盲目重新提交）。
 * 允许 needs_manual_intervention / failed / paused 状态的任务调用。
 */
#[tauri::command(rename_all = "snake_case")]
pub async fn task_continue(
    app: AppHandle,
    scheduler: State<'_, Arc<Scheduler>>,
    id: i64,
) -> Result<(), String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let status: String = conn
        .query_row("SELECT status FROM tasks WHERE id = ?1", [id], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if status != "needs_manual_intervention" && status != "failed" && status != "paused" {
        return Err(format!("当前状态（{}）不支持继续执行", status));
    }
    drop(conn);

    let scheduler_inner = scheduler.inner().clone();
    tokio::spawn(async move {
        task_scheduler::resume_task(app, scheduler_inner, id).await;
    });
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn task_cancel(id: i64) -> Result<(), String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE tasks SET status = 'cancelled', updated_at = ?1 WHERE id = ?2",
        rusqlite::params![Utc::now().to_rfc3339(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn task_detail(id: i64) -> Result<Option<Task>, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT id, name, project_id, account_id, status, current_round, total_rounds, created_at, updated_at, started_at, completed_at FROM tasks WHERE id = ?1").map_err(|e| e.to_string())?;
    let row = stmt.query_row([id], |row| {
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
    });
    match row {
        Ok(t) => Ok(Some(t)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn task_list_rounds(task_id: i64) -> Result<Vec<TaskRound>, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, task_id, round_number, prompt_snapshot, references_json, status, submitted_at, completed_at, success_count, failure_reason FROM task_rounds WHERE task_id = ?1 ORDER BY round_number")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([task_id], |row| {
            Ok(TaskRound {
                id: row.get(0)?,
                task_id: row.get(1)?,
                round_number: row.get(2)?,
                prompt_snapshot: row.get(3)?,
                references_json: row.get(4)?,
                status: row.get(5)?,
                submitted_at: row.get(6)?,
                completed_at: row.get(7)?,
                success_count: row.get(8)?,
                failure_reason: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn task_list_images(round_id: i64) -> Result<Vec<TaskImage>, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, task_round_id, image_index, original_url, saved_path, sha256, file_size, format, download_status FROM task_images WHERE task_round_id = ?1 ORDER BY image_index")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([round_id], |row| {
            Ok(TaskImage {
                id: row.get(0)?,
                task_round_id: row.get(1)?,
                image_index: row.get(2)?,
                original_url: row.get(3)?,
                saved_path: row.get(4)?,
                sha256: row.get(5)?,
                file_size: row.get(6)?,
                format: row.get(7)?,
                download_status: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn task_create_round(
    app: AppHandle,
    payload: TaskCreateRoundPayload,
) -> Result<TaskRound, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO task_rounds (task_id, round_number, prompt_snapshot, references_json, status, submitted_at) VALUES (?1, ?2, ?3, ?4, 'selecting_images', ?5)",
        rusqlite::params![payload.task_id, payload.round_number, payload.prompt_snapshot, payload.references_json, now],
    )
    .map_err(|e| e.to_string())?;
    let last_id = conn.last_insert_rowid();
    Ok(TaskRound {
        id: Some(last_id),
        task_id: Some(payload.task_id),
        round_number: Some(payload.round_number),
        prompt_snapshot: payload.prompt_snapshot,
        references_json: payload.references_json,
        status: Some("selecting_images".to_string()),
        submitted_at: Some(now),
        completed_at: None,
        success_count: Some(0),
        failure_reason: None,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn task_add_image(
    app: AppHandle,
    payload: TaskAddImagePayload,
) -> Result<TaskImage, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO task_images (task_round_id, image_index, original_url, saved_path, sha256, file_size, format, download_status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending')",
        rusqlite::params![
            payload.task_round_id,
            payload.image_index,
            payload.original_url,
            payload.saved_path,
            payload.sha256,
            payload.file_size,
            payload.format,
        ],
    )
    .map_err(|e| e.to_string())?;
    let last_id = conn.last_insert_rowid();
    Ok(TaskImage {
        id: Some(last_id),
        task_round_id: Some(payload.task_round_id),
        image_index: Some(payload.image_index),
        original_url: payload.original_url,
        saved_path: payload.saved_path,
        sha256: payload.sha256,
        file_size: payload.file_size,
        format: payload.format,
        download_status: Some("pending".to_string()),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn task_update_round(
    app: AppHandle,
    payload: TaskUpdateRoundPayload,
) -> Result<TaskRound, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let mut updates = Vec::new();
    let mut params: Vec<rusqlite::types::Value> = Vec::new();
    if let Some(status) = &payload.status {
        updates.push("status = ?".to_string());
        params.push(rusqlite::types::Value::Text(status.clone()));
    }
    if let Some(success_count) = payload.success_count {
        updates.push("success_count = ?".to_string());
        params.push(rusqlite::types::Value::Integer(success_count));
    }
    if let Some(failure_reason) = &payload.failure_reason {
        updates.push("failure_reason = ?".to_string());
        params.push(rusqlite::types::Value::Text(failure_reason.clone()));
    }
    if payload.status.as_deref() == Some("completed") || payload.status.as_deref() == Some("failed") {
        updates.push("completed_at = ?".to_string());
        params.push(rusqlite::types::Value::Text(now.clone()));
    }
    updates.push("updated_at = ?".to_string());
    params.push(rusqlite::types::Value::Text(now));
    params.push(rusqlite::types::Value::Integer(payload.round_id));
    let sql = format!("UPDATE task_rounds SET {} WHERE id = ?{}", updates.join(", "), params.len());
    conn.execute(&sql, rusqlite::params_from_iter(params))
        .map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT id, task_id, round_number, prompt_snapshot, references_json, status, submitted_at, completed_at, success_count, failure_reason FROM task_rounds WHERE id = ?1").map_err(|e| e.to_string())?;
    let row = stmt.query_row([payload.round_id], |row| {
        Ok(TaskRound {
            id: row.get(0)?,
            task_id: row.get(1)?,
            round_number: row.get(2)?,
            prompt_snapshot: row.get(3)?,
            references_json: row.get(4)?,
            status: row.get(5)?,
            submitted_at: row.get(6)?,
            completed_at: row.get(7)?,
            success_count: row.get(8)?,
            failure_reason: row.get(9)?,
        })
    }).map_err(|e| e.to_string())?;
    Ok(row)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn account_get(id: i64) -> Result<Option<Account>, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT id, name, user_data_dir, status, image_threshold, success_count, submit_count, last_used_at, created_at FROM accounts WHERE id = ?1").map_err(|e| e.to_string())?;
    let row = stmt.query_row([id], |row| {
        Ok(Account {
            id: row.get(0)?,
            name: row.get(1)?,
            user_data_dir: row.get(2)?,
            status: row.get(3)?,
            image_threshold: row.get(4)?,
            success_count: row.get(5)?,
            submit_count: row.get(6)?,
            last_used_at: row.get(7)?,
            created_at: row.get(8)?,
        })
    });
    match row {
        Ok(a) => Ok(Some(a)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn project_get(id: i64) -> Result<Option<Project>, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT id, name, root_path, prompt_path, created_at, updated_at FROM projects WHERE id = ?1").map_err(|e| e.to_string())?;
    let row = stmt.query_row([id], |row| {
        Ok(Project {
            id: row.get(0)?,
            name: row.get(1)?,
            root_path: row.get(2)?,
            prompt_path: row.get(3)?,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
        })
    });
    match row {
        Ok(p) => Ok(Some(p)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/**
 * 打开账号的可见浏览器用于手动登录（不接收账号密码，仅启动持久化上下文）。
 */
#[tauri::command(rename_all = "snake_case")]
pub async fn account_open_login(
    app: AppHandle,
    scheduler: State<'_, Arc<Scheduler>>,
    id: i64,
) -> Result<(), String> {
    let account = account_get(id).await?.ok_or("账号不存在")?;
    let user_data_dir = account.user_data_dir.clone();
    manager_ensure_sidecar(&app, &scheduler).await?;
    let cmd = serde_json::json!({
        "cmd": "open_login",
        "account_id": id,
        "user_data_dir": user_data_dir,
    });
    scheduler.send_sidecar_cmd(cmd)?;
    // 更新账号状态为登录中
    let conn = get_connection().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE accounts SET status = 'login_pending' WHERE id = ?1",
        rusqlite::params![id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dashboard_stats() -> Result<DashboardStats, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let total_projects: i64 = conn.query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0)).unwrap_or(0);
    let total_accounts: i64 = conn.query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0)).unwrap_or(0);
    let total_tasks: i64 = conn.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0)).unwrap_or(0);
    let completed_tasks: i64 = conn.query_row("SELECT COUNT(*) FROM tasks WHERE status = 'completed'", [], |r| r.get(0)).unwrap_or(0);
    let pending_tasks: i64 = conn.query_row("SELECT COUNT(*) FROM tasks WHERE status = 'pending'", [], |r| r.get(0)).unwrap_or(0);
    let failed_tasks: i64 = conn.query_row("SELECT COUNT(*) FROM tasks WHERE status = 'failed'", [], |r| r.get(0)).unwrap_or(0);
    let total_images: i64 = conn.query_row("SELECT COUNT(*) FROM task_images", [], |r| r.get(0)).unwrap_or(0);
    Ok(DashboardStats {
        total_projects,
        total_accounts,
        total_tasks,
        completed_tasks,
        total_images,
        pending_tasks,
        failed_tasks,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn execution_logs(limit: i64) -> Result<Vec<LogEntry>, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, task_id, level, message, created_at FROM execution_logs ORDER BY created_at DESC LIMIT ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit], |row| {
            Ok(LogEntry {
                id: row.get(0)?,
                task_id: row.get(1)?,
                level: row.get(2)?,
                message: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::make_task_name;

    #[test]
    fn make_task_name_uses_trimmed_project_and_date() {
        let name = make_task_name("  奶瓶收纳盒生图  ");
        assert!(name.starts_with("奶瓶收纳盒生图-"));
        assert_eq!(name.chars().count(), "奶瓶收纳盒生图-".chars().count() + 10);
    }

    #[test]
    fn make_task_name_empty_falls_back_to_default() {
        let name = make_task_name("   ");
        assert!(name.starts_with("任务-"));
    }
}
