use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: Option<i64>,
    pub name: String,
    pub root_path: String,
    pub prompt_path: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Account {
    pub id: Option<i64>,
    pub name: String,
    pub user_data_dir: String,
    pub status: String,
    pub image_threshold: Option<i64>,
    pub success_count: Option<i64>,
    pub submit_count: Option<i64>,
    pub last_used_at: Option<String>,
    pub created_at: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: Option<i64>,
    pub name: String,
    pub project_id: Option<i64>,
    pub account_id: Option<i64>,
    pub status: String,
    pub current_round: Option<i64>,
    pub total_rounds: Option<i64>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct TaskRound {
    pub id: Option<i64>,
    pub task_id: Option<i64>,
    pub round_number: Option<i64>,
    pub prompt_snapshot: Option<String>,
    pub references_json: Option<String>,
    pub status: Option<String>,
    pub submitted_at: Option<String>,
    pub completed_at: Option<String>,
    pub success_count: Option<i64>,
    pub failure_reason: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct TaskImage {
    pub id: Option<i64>,
    pub task_round_id: Option<i64>,
    pub image_index: Option<i64>,
    pub original_url: Option<String>,
    pub saved_path: Option<String>,
    pub sha256: Option<String>,
    pub file_size: Option<i64>,
    pub format: Option<String>,
    pub download_status: Option<String>,
}

#[allow(dead_code)]
#[derive(Clone, Serialize, Deserialize)]
pub struct Setting {
    pub key: String,
    pub value: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub id: Option<i64>,
    pub task_id: Option<i64>,
    pub level: String,
    pub message: String,
    pub created_at: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct DashboardStats {
    pub total_projects: i64,
    pub total_accounts: i64,
    pub total_tasks: i64,
    pub completed_tasks: i64,
    pub total_images: i64,
    pub pending_tasks: i64,
    pub failed_tasks: i64,
}
