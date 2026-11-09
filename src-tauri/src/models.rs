use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: Option<i64>,
    pub name: String,
    pub root_path: String,
    pub prompt_path: Option<String>,
    pub gen_params_json: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

/// 图像生成参数（仅允许经真实网页验证的枚举值）
#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct GenParams {
    pub model: Option<String>,
    pub ratio: Option<String>,
    pub style: Option<String>,
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
    /// 用户自定义顺序（越小越靠前）
    pub order_index: Option<i64>,
    /// 实际成功下载并校验的图片数（按 task_images.download_status='verified' 统计）
    pub verified_images: Option<i64>,
    /// 成功完成的轮次数（task_rounds.status='completed'）
    pub completed_rounds: Option<i64>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: Option<i64>,
    pub name: String,
    pub project_id: Option<i64>,
    pub account_id: Option<i64>,
    pub status: String,
    pub interrupted_status: Option<String>,
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
    pub output_dir: Option<String>,
    pub status: Option<String>,
    pub submitted_at: Option<String>,
    pub completed_at: Option<String>,
    pub success_count: Option<i64>,
    pub failure_reason: Option<String>,
    /// 本轮预期生成张数（提交时解析并记录；None = 未知/旧数据）
    pub expected_count: Option<i64>,
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

/// 参考图目录统计：一个直接包含图片的文件夹算一个抽取单元
#[derive(Clone, Serialize, Deserialize)]
pub struct ReferenceFolder {
    /// 相对项目 `references` 的路径，根目录为 "."
    pub relative_path: String,
    /// 绝对路径
    pub path: String,
    /// 该文件夹直接包含的图片数量（不含子文件夹）
    pub image_count: i64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ProjectReferenceStats {
    pub references_root: String,
    pub total_images: i64,
    pub folder_count: i64,
    pub folders: Vec<ReferenceFolder>,
}

/// 项目历史任务条目
#[derive(Clone, Serialize, Deserialize)]
pub struct ProjectHistoryItem {
    pub task_id: i64,
    pub name: String,
    pub status: String,
    pub total_rounds: i64,
    pub current_round: i64,
    pub success_images: i64,
    pub created_at: String,
    pub completed_at: Option<String>,
}

/// 单张参考图（位于项目 references 目录内）
#[derive(Clone, Serialize, Deserialize)]
pub struct ReferenceItem {
    pub name: String,
    pub path: String,
    pub relative_path: String,
    /// 相对 references 根目录的子文件夹，根目录为 "."
    pub folder: String,
    pub size: i64,
    pub modified: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ReferenceDetail {
    pub name: String,
    pub path: String,
    pub relative_path: String,
    pub size: i64,
    pub modified: Option<String>,
    pub sha256: String,
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
    pub task_name: Option<String>,
}

/// 应用内通知（软件内通知中心；系统通知由前端另发）
#[derive(Clone, Serialize, Deserialize)]
pub struct Notification {
    pub id: Option<i64>,
    pub kind: String,
    pub title: String,
    pub message: String,
    pub level: String,
    pub task_id: Option<i64>,
    pub read: Option<bool>,
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
