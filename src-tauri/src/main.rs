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
        // .plugin(tauri_plugin_updater::init())
        .manage(scheduler)
        .invoke_handler(tauri::generate_handler![
            commands::project_list,
            commands::project_create,
            commands::project_delete,
            commands::project_get,
            commands::account_list,
            commands::account_add,
            commands::account_delete,
            commands::account_get,
            commands::account_open_login,
            commands::settings_get,
            commands::settings_set,
            commands::task_list,
            commands::task_create,
            commands::task_start,
            commands::task_pause,
            commands::task_resume,
            commands::task_cancel,
            commands::task_detail,
            commands::task_list_rounds,
            commands::task_list_images,
            commands::task_create_round,
            commands::task_add_image,
            commands::task_update_round,
            commands::dashboard_stats,
            commands::execution_logs,
        ])
        .setup(|app| {
            let _ = db::init_db();
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
