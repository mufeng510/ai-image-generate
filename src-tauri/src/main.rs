#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Builder, Manager};
mod commands;
mod db;
mod models;
mod schema;
mod task_scheduler;

use std::sync::Arc;
use task_scheduler::Scheduler;

fn main() {
    let scheduler = Arc::new(Scheduler::new());
    Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(scheduler)
        .invoke_handler(tauri::generate_handler![
            commands::project_list,
            commands::project_create,
            commands::project_delete,
            commands::project_import,
            commands::project_rename,
            commands::project_open_folder,
            commands::project_prompt_get,
            commands::project_prompt_set,
            commands::project_gen_params_get,
            commands::project_gen_params_set,
            commands::project_reference_stats,
            commands::project_task_history,
            commands::project_ref_list,
            commands::project_ref_add,
            commands::project_ref_delete,
            commands::project_ref_create_folder,
            commands::project_ref_detail,
            commands::project_ref_reveal,
            commands::project_ref_open,
            commands::project_get,
            commands::account_list,
            commands::account_add,
            commands::account_delete,
            commands::account_reorder,
            commands::account_threshold_set,
            commands::account_get,
            commands::account_open_login,
            commands::settings_get,
            commands::settings_set,
            commands::scheduler_auto_run_get,
            commands::scheduler_auto_run_set,
            commands::task_list,
            commands::task_create,
            commands::task_start,
            commands::task_pause,
            commands::task_resume,
            commands::task_continue,
            commands::task_cancel,
            commands::task_detail,
            commands::task_list_rounds,
            commands::round_open_output_dir,
            commands::task_list_images,
            commands::dashboard_stats,
            commands::execution_logs,
            commands::logs_query,
            commands::logs_export,
            commands::notification_list,
            commands::notification_create,
            commands::notification_mark_read,
            commands::notification_mark_all_read,
            commands::notification_clear,
        ])
        .setup(|app| {
            let _ = db::init_db();
            // 启动恢复：不自动执行上次未完成任务，标记为需人工处理并保留原状态
            if let Err(e) = task_scheduler::recover_interrupted_tasks() {
                eprintln!("[启动] 恢复未完成任务失败: {}", e);
            }
            // 在闭包外克隆 Arc 和 AppHandle，避免借用逃离
            let app_handle = app.app_handle().clone();
            let scheduler = app.state::<Arc<Scheduler>>().inner().clone();
            tauri::async_runtime::spawn(async move {
                task_scheduler::scheduler_loop(app_handle, scheduler).await;
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
