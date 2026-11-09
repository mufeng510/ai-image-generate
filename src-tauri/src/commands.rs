use chrono::{Local, Utc};
use serde::Deserialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use crate::db::get_connection;
use crate::models::{Account, DashboardStats, LogEntry, Project, Task, TaskImage, TaskRound};
use crate::task_scheduler;
use crate::task_scheduler::Scheduler;

#[derive(Deserialize)]
pub struct TaskStartPayload {
    pub task_id: i64,
}

/** 确保 sidecar 已启动（供登录等非任务型命令使用） */
async fn manager_ensure_sidecar(app: &AppHandle, scheduler: &Scheduler) -> Result<(), String> {
    scheduler.start_sidecar(app).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn project_list() -> Result<Vec<Project>, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, root_path, prompt_path, gen_params_json, created_at, updated_at FROM projects ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                root_path: row.get(2)?,
                prompt_path: row.get(3)?,
                gen_params_json: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
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
        gen_params_json: None,
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

/** 去掉 Windows canonicalize 产生的 `\\\\?\\` 前缀 */
fn display_path_buf(p: std::path::PathBuf) -> std::path::PathBuf {
    #[cfg(target_os = "windows")]
    {
        let text = p.to_string_lossy().to_string();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return std::path::PathBuf::from(format!(r"\\{}", rest));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return std::path::PathBuf::from(rest);
        }
    }
    p
}

/** 校验项目根目录存在且是目录，返回去掉 Windows `\\\\?\\` 前缀的路径 */
fn normalize_project_root(root_path: &str) -> Result<std::path::PathBuf, String> {
    let trimmed = root_path.trim();
    if trimmed.is_empty() {
        return Err("项目根目录不能为空".to_string());
    }
    let raw = std::path::PathBuf::from(trimmed);
    if !raw.exists() {
        return Err(format!("目录不存在：{}", raw.display()));
    }
    if !raw.is_dir() {
        return Err(format!("不是目录：{}", raw.display()));
    }
    let canonical = raw
        .canonicalize()
        .map_err(|e| format!("无法解析目录：{}", e))?;
    Ok(display_path_buf(canonical))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn project_import(name: Option<String>, root_path: String) -> Result<Project, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let root = normalize_project_root(&root_path)?;
    let root_str = root.to_string_lossy().to_string();

    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM projects WHERE lower(root_path) = lower(?1)",
            [&root_str],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists > 0 {
        return Err("该目录已在项目列表中".to_string());
    }

    let project_name = name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .or_else(|| root.file_name().map(|n| n.to_string_lossy().to_string()))
        .ok_or_else(|| "无法推断项目名称，请手动填写".to_string())?;

    // 只补齐缺失目录，不覆盖已有内容
    std::fs::create_dir_all(root.join("references")).map_err(|e| format!("创建参考图目录失败：{}", e))?;
    std::fs::create_dir_all(root.join("output")).map_err(|e| format!("创建输出目录失败：{}", e))?;

    let prompt_path = {
        let p = root.join("prompt.txt");
        if p.is_file() {
            Some(p.to_string_lossy().to_string())
        } else {
            None
        }
    };

    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO projects (name, root_path, prompt_path, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
        rusqlite::params![project_name, root_str, prompt_path, now],
    )
    .map_err(|e| e.to_string())?;
    let last_id = conn.last_insert_rowid();
    Ok(Project {
        id: Some(last_id),
        name: project_name,
        root_path: root_str,
        prompt_path,
        gen_params_json: None,
        created_at: Some(now.clone()),
        updated_at: Some(now),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn project_rename(id: i64, name: String) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("项目名称不能为空".to_string());
    }
    let conn = get_connection().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let affected = conn
        .execute(
            "UPDATE projects SET name = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![name, now, id],
        )
        .map_err(|e| e.to_string())?;
    if affected == 0 {
        return Err("项目不存在".to_string());
    }
    Ok(())
}

/** 读取项目根目录，并要求目录仍然存在 */
fn project_root_by_id(id: i64) -> Result<std::path::PathBuf, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let root_path: String = conn
        .query_row("SELECT root_path FROM projects WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .map_err(|_| "项目不存在".to_string())?;
    let root = std::path::PathBuf::from(&root_path);
    if !root.is_dir() {
        return Err(format!("项目目录不存在或不可访问：{}", root_path));
    }
    Ok(root)
}

fn open_in_file_manager(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("explorer");
        c.arg(path);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(path);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(path);
        c
    };
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("打开目录失败：{}", e))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn project_open_folder(id: i64) -> Result<(), String> {
    let root = project_root_by_id(id)?;
    open_in_file_manager(&root)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn project_prompt_get(id: i64) -> Result<String, String> {
    let root = project_root_by_id(id)?;
    let conn = get_connection().map_err(|e| e.to_string())?;
    let stored: Option<String> = conn
        .query_row("SELECT prompt_path FROM projects WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .map_err(|e| e.to_string())?;

    let mut candidates = vec![root.join("prompt.txt")];
    if let Some(p) = stored {
        let p = std::path::PathBuf::from(p);
        if p != root.join("prompt.txt") {
            candidates.push(p);
        }
    }
    for candidate in candidates {
        if candidate.is_file() {
            let bytes = std::fs::read(&candidate).map_err(|e| format!("读取提示词失败：{}", e))?;
            return Ok(String::from_utf8_lossy(&bytes).to_string());
        }
    }
    Ok(String::new())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn project_gen_params_get(id: i64) -> Result<crate::models::GenParams, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let json: Option<String> = conn
        .query_row("SELECT gen_params_json FROM projects WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .map_err(|_| "项目不存在".to_string())?;
    Ok(persisted_gen_params(json))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn project_gen_params_set(id: i64, params: crate::models::GenParams) -> Result<crate::models::GenParams, String> {
    let validated = validate_gen_params(&params)?;
    let json = serde_json::to_string(&validated).map_err(|e| e.to_string())?;
    let conn = get_connection().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let affected = conn
        .execute(
            "UPDATE projects SET gen_params_json = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![json, now, id],
        )
        .map_err(|e| e.to_string())?;
    if affected == 0 {
        return Err("项目不存在".to_string());
    }
    Ok(validated)
}

/** 预期生成张数合法范围（豆包单次生成数量级有限；0/空 = 未设置） */
fn normalize_expected_images(value: i64) -> Result<i64, String> {
    if !(1..=20).contains(&value) {
        return Err("预期生成张数必须在 1-20 之间".to_string());
    }
    Ok(value)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn project_expected_images_get(id: i64) -> Result<Option<i64>, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT expected_images_per_round FROM projects WHERE id = ?1",
        [id],
        |row| row.get::<_, Option<i64>>(0),
    )
    .map_err(|_| "项目不存在".to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn project_expected_images_set(id: i64, value: Option<i64>) -> Result<Option<i64>, String> {
    let normalized = match value {
        Some(v) => Some(normalize_expected_images(v)?),
        None => None,
    };
    let conn = get_connection().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let affected = conn
        .execute(
            "UPDATE projects SET expected_images_per_round = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![normalized, now, id],
        )
        .map_err(|e| e.to_string())?;
    if affected == 0 {
        return Err("项目不存在".to_string());
    }
    Ok(normalized)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn project_prompt_set(id: i64, content: String) -> Result<(), String> {
    let root = project_root_by_id(id)?;
    std::fs::create_dir_all(&root).map_err(|e| format!("创建项目目录失败：{}", e))?;
    let prompt_path = root.join("prompt.txt");
    std::fs::write(&prompt_path, content.as_bytes())
        .map_err(|e| format!("写入 prompt.txt 失败：{}", e))?;
    let conn = get_connection().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE projects SET prompt_path = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![prompt_path.to_string_lossy().to_string(), now, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/** 图像生成参数合法值（经真实 Doubao 页面验证） */
pub const GEN_MODELS: &[&str] = &[
    "Seedream 5.0 Pro",
    "Seedream 5.0 Flash",
    "Seedream 4.5",
    "Seedream 4.0",
];
pub const GEN_RATIOS: &[&str] = &[
    "自动", "9:16", "2:3", "3:4", "1:1", "4:3", "3:2", "16:9",
];
pub const GEN_STYLES: &[&str] = &[
    "人像摄影", "电影写真", "中国风", "动漫", "3D渲染", "赛博朋克", "CG 动画", "水墨画", "油画", "古典", "水彩画", "卡通",
    "平面插画", "风景", "港风动漫", "像素风格", "荧光绘画", "彩铅画", "手办", "儿童绘画", "抽象", "锐笔插画", "二次元",
    "油墨印刷", "版画", "莫奈", "毕加索", "伦勃朗", "马蒂斯", "巴洛克", "复古动漫", "绘本",
];

fn validate_gen_params(p: &crate::models::GenParams) -> Result<crate::models::GenParams, String> {
    let ok = |v: &Option<String>, allow: &[&str], name: &str| -> Result<Option<String>, String> {
        match v {
            Some(s) => {
                let s = s.trim();
                if s.is_empty() {
                    Ok(None)
                } else if allow.contains(&s) {
                    Ok(Some(s.to_string()))
                } else {
                    Err(format!("{} 值 `{}` 不在已验证的枚举列表中", name, s))
                }
            }
            None => Ok(None),
        }
    };
    Ok(crate::models::GenParams {
        model: ok(&p.model, GEN_MODELS, "模型")?,
        ratio: ok(&p.ratio, GEN_RATIOS, "比例")?,
        style: ok(&p.style, GEN_STYLES, "风格")?,
    })
}

fn persisted_gen_params(json: Option<String>) -> crate::models::GenParams {
    #[derive(Deserialize)]
    struct GenParamsWire {
        model: Option<String>,
        ratio: Option<String>,
        style: Option<String>,
    }
    match json.ok_or(())
        .and_then(|s| serde_json::from_str::<GenParamsWire>(&s).map_err(|_| ()))
    {
        Ok(w) => crate::models::GenParams {
            model: w.model,
            ratio: w.ratio,
            style: w.style,
        },
        Err(_) => crate::models::GenParams {
            model: None,
            ratio: None,
            style: None,
        },
    }
}

fn is_supported_image(path: &std::path::Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => {
            let ext = ext.to_ascii_lowercase();
            ext == "jpg" || ext == "jpeg" || ext == "png" || ext == "webp"
        }
        None => false,
    }
}

/** 递归统计 references 下每个“直接包含图片”的文件夹 */
fn scan_reference_stats(root: &std::path::Path) -> crate::models::ProjectReferenceStats {
    use crate::models::{ProjectReferenceStats, ReferenceFolder};

    let references_root = root.join("references");
    let mut folders: Vec<ReferenceFolder> = Vec::new();
    let mut total_images: i64 = 0;

    fn walk(
        dir: &std::path::Path,
        references_root: &std::path::Path,
        folders: &mut Vec<ReferenceFolder>,
        total_images: &mut i64,
    ) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return, // 无权限或已被删除，跳过
        };
        let mut direct_images = 0i64;
        let mut subdirs = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                subdirs.push(path);
            } else if file_type.is_file() && is_supported_image(&path) {
                direct_images += 1;
            }
        }
        if direct_images > 0 {
            *total_images += direct_images;
            let relative_path = dir
                .strip_prefix(references_root)
                .map(|p| {
                    if p.as_os_str().is_empty() {
                        ".".to_string()
                    } else {
                        p.to_string_lossy().to_string()
                    }
                })
                .unwrap_or_else(|_| dir.to_string_lossy().to_string());
            folders.push(ReferenceFolder {
                relative_path,
                path: dir.to_string_lossy().to_string(),
                image_count: direct_images,
            });
        }
        for sub in subdirs {
            walk(&sub, references_root, folders, total_images);
        }
    }

    if references_root.is_dir() {
        walk(&references_root, &references_root, &mut folders, &mut total_images);
    }
    folders.sort_by(|a, b| a.relative_path.to_lowercase().cmp(&b.relative_path.to_lowercase()));

    ProjectReferenceStats {
        references_root: references_root.to_string_lossy().to_string(),
        total_images,
        folder_count: folders.len() as i64,
        folders,
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn project_reference_stats(id: i64) -> Result<crate::models::ProjectReferenceStats, String> {
    let root = project_root_by_id(id)?;
    Ok(scan_reference_stats(&root))
}

/** 项目生成历史：最近任务及成功图片数（按 create 时间倒序） */
#[tauri::command(rename_all = "snake_case")]
pub async fn project_task_history(id: i64, limit: Option<i64>) -> Result<Vec<crate::models::ProjectHistoryItem>, String> {
    use crate::models::ProjectHistoryItem;
    let conn = get_connection().map_err(|e| e.to_string())?;
    let limit = limit.unwrap_or(20).clamp(1, 200);
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.name, t.status, COALESCE(t.total_rounds, 0), COALESCE(t.current_round, 0),
                    (SELECT COUNT(*) FROM task_images ti
                       JOIN task_rounds tr ON ti.task_round_id = tr.id
                      WHERE tr.task_id = t.id AND ti.download_status = 'verified'),
                    t.created_at, t.completed_at
               FROM tasks t
              WHERE t.project_id = ?1
              ORDER BY t.created_at DESC
              LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![id, limit], |row| {
            Ok(ProjectHistoryItem {
                task_id: row.get(0)?,
                name: row.get(1)?,
                status: row.get(2)?,
                total_rounds: row.get(3)?,
                current_round: row.get(4)?,
                success_images: row.get(5)?,
                created_at: row.get(6)?,
                completed_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

// ===== 参考图文件管理 =====

/** 校验 references 内的相对子目录，拒绝绝对路径与 `..` */
fn safe_subfolder(rel: &str) -> Result<std::path::PathBuf, String> {
    use std::path::{Component, PathBuf};
    let input = rel.trim();
    if input.is_empty() {
        return Ok(PathBuf::new());
    }
    let mut out = PathBuf::new();
    for part in std::path::Path::new(input).components() {
        match part {
            Component::Normal(c) => out.push(c),
            Component::CurDir => {}
            _ => return Err(format!("子目录 `{}` 不合法（不允许上级或根目录）", rel)),
        }
    }
    Ok(out)
}

/** 目标已存在时追加 " (n)"；全部占用则返回 None（由调用方报错，避免覆盖） */
fn unique_destination(dest: &std::path::Path) -> Option<std::path::PathBuf> {
    let exists = |p: &std::path::Path| p.symlink_metadata().is_ok();
    if !exists(dest) {
        return Some(dest.to_path_buf());
    }
    let parent = dest.parent().unwrap_or(std::path::Path::new("."));
    let stem = dest
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "image".to_string());
    let ext = dest
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for index in 2..1000 {
        let candidate = parent.join(format!("{} ({}){}", stem, index, ext));
        if !exists(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{:02x}", byte));
    }
    out
}

/** 流式计算 SHA-256，避免大图整文件读入内存 */
fn sha256_file(path: &std::path::Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|e| format!("打开文件失败：{}", e))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("读取文件失败：{}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn canonical_references(root: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let refs = root.join("references");
    refs.canonicalize()
        .map_err(|e| format!("参考图目录不存在：{}（{}）", refs.display(), e))
}

/** 校验 references 目录存在；缺失时创建（位于项目根目录下，安全） */
fn ensure_references(root: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let refs = root.join("references");
    std::fs::create_dir_all(&refs).map_err(|e| format!("创建参考图目录失败：{}", e))?;
    canonical_references(root)
}

/** 定位 base 内已存在的路径；越界或不存在则报错 */
fn ensure_within(base: &std::path::Path, candidate: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let canonical = candidate
        .canonicalize()
        .map_err(|e| format!("路径不存在：{}（{}）", candidate.display(), e))?;
    if !canonical.starts_with(base) {
        return Err("路径不在项目参考图目录内".to_string());
    }
    Ok(canonical)
}

/** 为 base 内（可能尚不存在的）相对子目录计算最终路径；先校验最深已存在祖先再拼接，避免 junction 逃逸 */
fn ensure_destination_within(
    base: &std::path::Path,
    rel: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let mut existing = base.join(rel);
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        let name = existing.file_name().map(|s| s.to_os_string());
        match name {
            Some(n) => tail.push(n),
            None => return Err(format!("路径无效：{}", base.join(rel).display())),
        }
        if !existing.pop() {
            return Err(format!("路径无效：{}", base.join(rel).display()));
        }
    }
    let mut prefix = ensure_within(base, &existing)?;
    for part in tail.iter().rev() {
        prefix.push(part);
    }
    Ok(prefix)
}

/** 定位 references 目录内的文件；越界或不存在则返回错误 */
fn resolve_ref_path(id: i64, path: &str) -> Result<std::path::PathBuf, String> {
    let root = project_root_by_id(id)?;
    let base = canonical_references(&root)?;
    ensure_within(&base, std::path::Path::new(path))
}

fn relative_under(base: &std::path::Path, target: &std::path::Path) -> String {
    target
        .strip_prefix(base)
        .map(|rel| {
            if rel.as_os_str().is_empty() {
                return ".".to_string();
            }
            rel.to_string_lossy().replace('\\', "/")
        })
        .unwrap_or_else(|_| target.to_string_lossy().replace('\\', "/"))
}

fn modified_rfc3339(metadata: &std::fs::Metadata) -> Option<String> {
    metadata
        .modified()
        .ok()
        .map(chrono::DateTime::<Utc>::from)
        .map(|t| t.to_rfc3339())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn project_ref_list(id: i64) -> Result<Vec<crate::models::ReferenceItem>, String> {
    use crate::models::ReferenceItem;

    let root = project_root_by_id(id)?;
    let refs = root.join("references");
    if !refs.is_dir() {
        return Ok(Vec::new());
    }
    let base = canonical_references(&root)?;

    fn walk(
        dir: &std::path::Path,
        base: &std::path::Path,
        out: &mut Vec<ReferenceItem>,
    ) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                walk(&path, base, out);
                continue;
            }
            if !file_type.is_file() || !is_supported_image(&path) {
                continue;
            }
            let metadata = match std::fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let relative = relative_under(base, &path);
            let folder = relative
                .rfind('/')
                .map(|idx| relative[..idx].to_string())
                .unwrap_or_else(|| ".".to_string());
            out.push(ReferenceItem {
                name: path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default(),
                path: display_path_buf(path).to_string_lossy().to_string(),
                relative_path: relative,
                folder,
                size: metadata.len() as i64,
                modified: modified_rfc3339(&metadata),
            });
        }
    }

    let mut items = Vec::new();
    walk(&base, &base, &mut items);
    items.sort_by(|a, b| a.relative_path.to_lowercase().cmp(&b.relative_path.to_lowercase()));
    Ok(items)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn project_ref_add(
    id: i64,
    source_paths: Vec<String>,
    subfolder: Option<String>,
) -> Result<serde_json::Value, String> {
    let root = project_root_by_id(id)?;
    let base = ensure_references(&root)?;
    let rel = safe_subfolder(&subfolder.unwrap_or_default())?;
    let dest_dir = ensure_destination_within(&base, &rel)?;
    std::fs::create_dir_all(&dest_dir).map_err(|e| format!("创建子目录失败：{}", e))?;

    let mut added = 0i64;
    let mut skipped: Vec<String> = Vec::new();
    for source in source_paths {
        let src_path = std::path::PathBuf::from(&source);
        if !src_path.is_file() || !is_supported_image(&src_path) {
            skipped.push(format!("{}：不是支持的图片（jpg/jpeg/png/webp）", source));
            continue;
        }
        let file_name = match src_path.file_name() {
            Some(n) => n.to_os_string(),
            None => {
                skipped.push(format!("{}：无法获取文件名", source));
                continue;
            }
        };
        // 去重前先做 junction/symlink 规避：目标路径全部经过 symlink_metadata 判定
        let dest = match unique_destination(&dest_dir.join(&file_name)) {
            Some(d) => d,
            None => {
                skipped.push(format!("{}：同名文件过多，请重命名后重试", source));
                continue;
            }
        };
        match std::fs::copy(&src_path, &dest) {
            Ok(_) => added += 1,
            Err(e) => skipped.push(format!("{}：{}", source, e)),
        }
    }
    Ok(serde_json::json!({ "added": added, "skipped": skipped }))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn project_ref_delete(id: i64, path: String) -> Result<(), String> {
    let target = resolve_ref_path(id, &path)?;
    if !target.is_file() {
        return Err("只能删除单个图片文件".to_string());
    }
    std::fs::remove_file(&target).map_err(|e| format!("删除失败：{}", e))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn project_ref_create_folder(id: i64, subfolder: String) -> Result<(), String> {
    let rel = safe_subfolder(&subfolder)?;
    if rel.as_os_str().is_empty() {
        return Err("子目录名不能为空".to_string());
    }
    let root = project_root_by_id(id)?;
    let base = ensure_references(&root)?;
    let target = ensure_destination_within(&base, &rel)?;
    std::fs::create_dir_all(&target).map_err(|e| format!("创建子目录失败：{}", e))?;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn project_ref_detail(id: i64, path: String) -> Result<crate::models::ReferenceDetail, String> {
    use crate::models::ReferenceDetail;

    let root = project_root_by_id(id)?;
    let base = canonical_references(&root)?;
    let target = ensure_within(&base, std::path::Path::new(&path))?;
    if !target.is_file() {
        return Err("路径不是文件".to_string());
    }
    let metadata = std::fs::metadata(&target).map_err(|e| format!("读取文件信息失败：{}", e))?;
    let relative_path = relative_under(&base, &target);
    Ok(ReferenceDetail {
        name: target
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        path: display_path_buf(target.clone()).to_string_lossy().to_string(),
        relative_path,
        size: metadata.len() as i64,
        modified: modified_rfc3339(&metadata),
        sha256: sha256_file(&target)?,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn project_ref_reveal(id: i64, path: String) -> Result<(), String> {
    let target = display_path_buf(resolve_ref_path(id, &path)?);
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(format!("/select,{}", target.display()))
            .spawn()
            .map_err(|e| format!("打开资源管理器失败：{}", e))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("打开 Finder 失败：{}", e))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = target.parent().unwrap_or(&target);
        return open_in_file_manager(parent);
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn project_ref_open(id: i64, path: String) -> Result<(), String> {
    let target = display_path_buf(resolve_ref_path(id, &path)?);
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("打开图片失败：{}", e))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("打开图片失败：{}", e))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("打开图片失败：{}", e))?;
        return Ok(());
    }
}

#[cfg(test)]
mod project_tests {
    use super::*;
    use crate::schema::create_tables;
    use crate::task_scheduler::auto_pick_account_id;

    fn temp_project_dir(tag: &str) -> std::path::PathBuf {
        let stamp = Utc::now().timestamp_nanos_opt().unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "ai-image-project-test-{}-{}-{}",
            tag,
            std::process::id(),
            stamp
        ));
        std::fs::create_dir_all(dir.join("references")).unwrap();
        dir
    }

    fn touch(path: &std::path::Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"x").unwrap();
    }

    #[test]
    fn scan_counts_only_direct_images_per_folder() {
        let dir = temp_project_dir("scan");
        touch(&dir.join("references").join("a.png"));
        touch(&dir.join("references").join("note.txt"));
        touch(&dir.join("references").join("sub").join("b.jpg"));
        touch(&dir.join("references").join("sub").join("nested").join("c.webp"));
        touch(&dir.join("references").join("sub").join("nested").join("d.jpeg"));

        let stats = scan_reference_stats(&dir);

        assert_eq!(stats.total_images, 4);
        assert_eq!(stats.folder_count, 3);
        let root = stats.folders.iter().find(|f| f.relative_path == ".").unwrap();
        assert_eq!(root.image_count, 1);
        let sub = stats
            .folders
            .iter()
            .find(|f| f.relative_path == "sub")
            .unwrap();
        assert_eq!(sub.image_count, 1);
        let nested = stats
            .folders
            .iter()
            .find(|f| f.relative_path.ends_with("nested"))
            .unwrap();
        assert_eq!(nested.image_count, 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_returns_empty_stats_when_no_references() {
        let dir = temp_project_dir("empty");
        let stats = scan_reference_stats(&dir);
        assert_eq!(stats.total_images, 0);
        assert_eq!(stats.folder_count, 0);
        assert!(stats.folders.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn safe_subfolder_accepts_relative_children() {
        let rel = safe_subfolder("主图/2026/  ").unwrap();
        assert_eq!(rel, std::path::PathBuf::from("主图").join("2026"));
    }

    #[test]
    fn safe_subfolder_rejects_root_and_parent() {
        assert!(safe_subfolder(r"C:\evil").is_err());
        assert!(safe_subfolder("..").is_err());
        assert!(safe_subfolder("ok/../../evil").is_err());
        assert!(safe_subfolder("/").is_err());
    }

    fn memory_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        create_tables(&conn).unwrap();
        conn
    }

    fn seed_account(
        conn: &rusqlite::Connection,
        id: i64,
        name: &str,
        status: &str,
        threshold: Option<i64>,
        order_index: i64,
    ) {
        conn.execute(
            "INSERT INTO accounts (id, name, user_data_dir, status, image_threshold, success_count, submit_count, last_used_at, order_index, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, NULL, ?6, '2020-01-01T00:00:00Z')",
            rusqlite::params![id, name, format!("dir-{}", id), status, threshold, order_index],
        )
        .unwrap();
    }

    fn seed_verified_images(conn: &rusqlite::Connection, account_id: i64, task_id: i64, count: i64) {
        conn.execute(
            "INSERT INTO tasks (id, name, project_id, account_id, status, total_rounds, created_at, updated_at) VALUES (?1, 't', NULL, ?2, 'completed', 1, '2020', '2020')",
            rusqlite::params![task_id, account_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO task_rounds (id, task_id, round_number, status, success_count) VALUES (?1, ?2, 1, 'completed', ?3)",
            rusqlite::params![task_id * 100, task_id, count],
        )
        .unwrap();
        for image_index in 1..=count {
            conn.execute(
                "INSERT INTO task_images (task_round_id, image_index, download_status) VALUES (?1, ?2, 'verified')",
                rusqlite::params![task_id * 100, image_index],
            )
            .unwrap();
        }
    }

    #[test]
    fn auto_pick_skips_unlogged_and_rotates_in_order() {
        let conn = memory_conn();
        seed_account(&conn, 1, "a", "logged_in", None, 1);
        seed_account(&conn, 2, "b", "unknown", None, 2);
        seed_account(&conn, 3, "c", "logged_in", None, 3);

        let first = auto_pick_account_id(&conn).unwrap();
        let second = auto_pick_account_id(&conn).unwrap();
        let third = auto_pick_account_id(&conn).unwrap();

        assert_eq!((first, second, third), (1, 3, 1));
        // 未被选中的账号 2 从未加入轮换，且 cursor 持久化
        let cursor: String = conn
            .query_row("SELECT value FROM app_settings WHERE key = 'account_rotation_cursor'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cursor, "3");
    }

    #[test]
    fn auto_pick_errors_when_no_eligible() {
        let conn = memory_conn();
        seed_account(&conn, 9, "x", "unknown", None, 1);
        let err = auto_pick_account_id(&conn).unwrap_err();
        assert!(err.contains("没有可用账号"));
    }

    #[test]
    fn auto_pick_skips_over_threshold_account() {
        let conn = memory_conn();
        seed_account(&conn, 1, "hot", "logged_in", Some(2), 1);
        seed_verified_images(&conn, 1, 100, 2);
        seed_account(&conn, 2, "free", "logged_in", Some(0), 2);

        let pick1 = auto_pick_account_id(&conn).unwrap();
        let pick2 = auto_pick_account_id(&conn).unwrap();
        assert_eq!(pick1, 2);
        assert_eq!(pick2, 2);
    }

    #[test]
    fn reorder_requires_all_accounts() {
        let conn = memory_conn();
        seed_account(&conn, 1, "a", "unknown", None, 1);
        seed_account(&conn, 2, "b", "unknown", None, 2);
        // 只给一个 id：完整性校验失败
        assert!(apply_reorder(&conn, &[1]).is_err());
        // 包含全部 id：成功
        apply_reorder(&conn, &[2, 1]).unwrap();
        let order: Vec<i64> = {
            let mut stmt = conn.prepare("SELECT order_index FROM accounts ORDER BY id").unwrap();
            stmt.query_map([], |row| row.get(0)).unwrap().filter_map(|r| r.ok()).collect()
        };
        assert_eq!(order, vec![2, 1]);
        // 不存在的 id 被拒绝
        assert!(apply_reorder(&conn, &[2, 999]).is_err());
    }

    #[test]
    fn validate_gen_params_rejects_unknown_values() {
        use crate::models::GenParams;
        let bad = GenParams {
            model: Some("Seedream 99 Pro".to_string()),
            ratio: None,
            style: None,
        };
        assert!(validate_gen_params(&bad).is_err());

        let bad2 = GenParams {
            model: Some("Seedream 5.0 Flash".to_string()),
            ratio: Some("5:7".to_string()),
            style: None,
        };
        assert!(validate_gen_params(&bad2).is_err());

        let ok = GenParams {
            model: Some("Seedream 5.0 Flash".to_string()),
            ratio: Some("1:1".to_string()),
            style: Some("油画".to_string()),
        };
        let v = validate_gen_params(&ok).expect("valid params should pass");
        assert_eq!(v.model.as_deref(), Some("Seedream 5.0 Flash"));
        assert_eq!(v.ratio.as_deref(), Some("1:1"));
        assert_eq!(v.style.as_deref(), Some("油画"));
    }

    #[test]
    fn validate_gen_params_empty_is_treated_as_unset() {
        use crate::models::GenParams;
        let p = GenParams {
            model: Some("".to_string()),
            ratio: None,
            style: Some("".to_string()),
        };
        let v = validate_gen_params(&p).expect("empty fields should be allowed");
        assert!(v.model.is_none());
        assert!(v.style.is_none());
    }

    #[test]
    fn account_name_validation_rejects_dangerous_names() {
        assert!(validate_account_name("").is_err());
        assert!(validate_account_name("  ").is_err());
        assert!(validate_account_name("a/b").is_err());
        assert!(validate_account_name("..").is_err());
        assert!(validate_account_name("CON").is_err());
        assert!(validate_account_name("acc-生图-01").is_ok());
        assert_eq!(validate_account_name("  普通账号  ").unwrap(), "普通账号");
    }

    #[test]
    fn unique_destination_renames_instead_of_overwriting() {
        let dir = temp_project_dir("unique");
        let dest = dir.join("references").join("photo.png");
        std::fs::write(&dest, b"1").unwrap();
        let candidate = unique_destination(&dest).expect("free name should be found");
        assert_eq!(candidate, dir.join("references").join("photo (2).png"));
        // 已存在文件仍不能被直接返回覆盖
        std::fs::write(&candidate, b"2").unwrap();
        let next = unique_destination(&dest).expect("second collision should bump index");
        assert_eq!(next, dir.join("references").join("photo (3).png"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_within_rejects_paths_outside_references() {
        let dir = temp_project_dir("within");
        let base = canonical_references(&dir).unwrap();
        let outside = dir.join("secret.png");
        std::fs::write(&outside, b"x").unwrap();
        assert_eq!(
            ensure_within(&base, &outside).unwrap_err(),
            "路径不在项目参考图目录内"
        );
        let inside = dir.join("references").join("ok.png");
        std::fs::write(&inside, b"x").unwrap();
        assert_eq!(ensure_within(&base, &inside).unwrap(), inside.canonicalize().unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_destination_within_resolves_nested_relative_paths() {
        let dir = temp_project_dir("destination");
        let base = canonical_references(&dir).unwrap();
        let target = ensure_destination_within(&base, std::path::Path::new("a/b/c")).unwrap();
        assert_eq!(target, base.join("a").join("b").join("c"));
        std::fs::create_dir_all(base.join("a").join("b")).unwrap();
        let again = ensure_destination_within(&base, std::path::Path::new("a/b/c")).unwrap();
        assert_eq!(again, base.join("a").join("b").join("c"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sha256_hex_matches_known_vector() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn relative_under_uses_forward_slashes() {
        let base = std::path::PathBuf::from("C:/proj/references");
        let target = std::path::PathBuf::from("C:/proj/references/sub/inner/a.png");
        assert_eq!(relative_under(&base, &target), "sub/inner/a.png");
    }

    #[test]
    fn list_reference_items_skips_unsupported() {
        let dir = temp_project_dir("list");
        touch(&dir.join("references").join("ok.webp"));
        touch(&dir.join("references").join("notes.txt"));
        touch(&dir.join("references").join("sub").join("ok2.JPG"));
        // 直接调用底层遍历逻辑：构造项目记录不可行，改为验证相对路径转换与扩展名判断
        assert!(is_supported_image(std::path::Path::new("ok2.JPG")));
        assert!(!is_supported_image(std::path::Path::new("notes.txt")));
        let target = canonical_references(&dir).unwrap().join("sub").join("ok2.JPG");
        assert_eq!(relative_under(&canonical_references(&dir).unwrap(), &target), "sub/ok2.JPG");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn account_list() -> Result<Vec<Account>, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT a.id, a.name, a.user_data_dir, a.status, a.image_threshold, a.success_count, a.submit_count, a.last_used_at, a.created_at, a.order_index,
                    (SELECT COUNT(*) FROM task_images ti
                       JOIN task_rounds tr ON ti.task_round_id = tr.id
                       JOIN tasks t ON tr.task_id = t.id
                      WHERE t.account_id = a.id AND ti.download_status = 'verified') AS verified_images,
                    (SELECT COUNT(*) FROM task_rounds tr
                       JOIN tasks t ON tr.task_id = t.id
                      WHERE t.account_id = a.id AND tr.status = 'completed') AS completed_rounds
               FROM accounts a
              ORDER BY COALESCE(a.order_index, a.id) ASC, a.id ASC",
        )
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
                order_index: row.get(9)?,
                verified_images: row.get(10)?,
                completed_rounds: row.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/** 校验账号名称：非空、长度、去掉 Windows 非法字符与保留设备名 */
fn validate_account_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("账号名称不能为空".to_string());
    }
    if trimmed.chars().count() > 64 {
        return Err("账号名称过长（最多 64 个字符）".to_string());
    }
    for ch in trimmed.chars() {
        match ch {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => {
                return Err(r#"账号名称不能包含 \ / : * ? " < > |"#.to_string());
            }
            c if c.is_control() => return Err("账号名称不能包含控制字符".to_string()),
            _ => {}
        }
    }
    if trimmed == "." || trimmed == ".." {
        return Err("账号名称不能为 . 或 ..".to_string());
    }
    // Windows 保留设备名（大小写不敏感，取第一个 '.' 前的部分）
    let base = trimmed.split('.').next().unwrap_or("");
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.iter().any(|r| base.eq_ignore_ascii_case(r)) {
        return Err("账号名称不能使用系统保留名".to_string());
    }
    Ok(trimmed.to_string())
}

/** 排序：输入必须包含全部账号且都存在；单事务回填 1..N */
fn apply_reorder(conn: &rusqlite::Connection, order_ids: &[i64]) -> Result<(), String> {
    let existing: std::collections::HashSet<i64> = {
        let mut stmt = conn
            .prepare("SELECT id FROM accounts")
            .map_err(|e| e.to_string())?;
        let ids: Vec<i64> = stmt
            .query_map([], |row| row.get::<_, i64>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        ids.into_iter().collect()
    };
    if existing.len() != order_ids.len() {
        return Err(format!(
            "排序列表包含 {} 个账号，但数据库中有 {} 个，请刷新后重试",
            order_ids.len(),
            existing.len()
        ));
    }
    for id in order_ids {
        if !existing.contains(id) {
            return Err(format!("账号 id 不存在：{}", id));
        }
    }
    let mut seen = std::collections::HashSet::new();
    for id in order_ids {
        if !seen.insert(*id) {
            return Err(format!("账号 id 重复：{}", id));
        }
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for (position, id) in order_ids.iter().enumerate() {
        tx.execute(
            "UPDATE accounts SET order_index = ?1 WHERE id = ?2",
            rusqlite::params![(position as i64) + 1, id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn account_add(name: String) -> Result<Account, String> {
    let name = validate_account_name(&name)?;
    let conn = get_connection().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    let duplicate: i64 = tx
        .query_row("SELECT COUNT(*) FROM accounts WHERE name = ?1", [&name], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if duplicate > 0 {
        return Err(format!("账号名称已存在：{}", name));
    }
    let next_order: i64 = tx
        .query_row("SELECT COALESCE(MAX(order_index), 0) + 1 FROM accounts", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    // user_data_dir 需要账号 id，先插入占位再回填，整体处于同一事务
    tx.execute(
        "INSERT INTO accounts (name, user_data_dir, status, success_count, submit_count, last_used_at, order_index, created_at) VALUES (?1, '', 'unknown', 0, 0, NULL, ?2, ?3)",
        rusqlite::params![name, next_order, now],
    )
    .map_err(|e| e.to_string())?;
    let last_id = tx.last_insert_rowid();

    let user_data_dir = crate::task_scheduler::app_data_dir()?
        .join("accounts")
        .join(last_id.to_string())
        .join("user-data")
        .to_string_lossy()
        .to_string();
    tx.execute(
        "UPDATE accounts SET user_data_dir = ?1 WHERE id = ?2",
        rusqlite::params![user_data_dir, last_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

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
        order_index: Some(next_order),
        verified_images: Some(0),
        completed_rounds: Some(0),
    })
}

/** 按列表顺序回填 order_index；前端拖动排序后调用（必须包含全部账号） */
#[tauri::command(rename_all = "snake_case")]
pub async fn account_reorder(order_ids: Vec<i64>) -> Result<(), String> {
    if order_ids.is_empty() {
        return Err("排序列表为空".to_string());
    }
    let conn = get_connection().map_err(|e| e.to_string())?;
    apply_reorder(&conn, &order_ids)
}

/** 设置账号的自定义图片阈值；0 表示不限制 */
#[tauri::command(rename_all = "snake_case")]
pub async fn account_threshold_set(id: i64, threshold: i64) -> Result<(), String> {
    if threshold < 0 {
        return Err("阈值不能为负数".to_string());
    }
    let conn = get_connection().map_err(|e| e.to_string())?;
    let affected = conn
        .execute(
            "UPDATE accounts SET image_threshold = ?1 WHERE id = ?2",
            rusqlite::params![threshold, id],
        )
        .map_err(|e| e.to_string())?;
    if affected == 0 {
        return Err("账号不存在".to_string());
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn account_delete(id: i64) -> Result<(), String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let blocking: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM tasks
              WHERE account_id = ?1
                AND status IN ('pending','preparing','selecting_images','waiting_confirmation','uploading','submitting','generating','downloading','verifying','paused','needs_manual_intervention')",
            [id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if blocking > 0 {
        return Err(format!(
            "该账号有 {} 个未完成任务（含需人工处理），请先取消或完成它们再删除",
            blocking
        ));
    }
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

/** 查询 auto_run 闸门状态（进程级，启动后默认 false；用户点击「开始」后启用） */
#[tauri::command(rename_all = "snake_case")]
pub async fn scheduler_auto_run_get(scheduler: State<'_, Arc<Scheduler>>) -> Result<bool, String> {
    Ok(scheduler.is_auto_run())
}

/** 设置 auto_run 闸门：关闭后主循环不再自动拣取 pending 任务；已排队任务需手动点「开始」 */
#[tauri::command(rename_all = "snake_case")]
pub async fn scheduler_auto_run_set(scheduler: State<'_, Arc<Scheduler>>, open: bool) -> Result<(), String> {
    if open {
        scheduler.enable_auto_run();
    } else {
        scheduler.disable_auto_run();
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn task_list() -> Result<Vec<Task>, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, project_id, account_id, status, interrupted_status, current_round, total_rounds, created_at, updated_at, started_at, completed_at FROM tasks ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
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
pub async fn task_create(project_id: i64, account_id: Option<i64>, rounds: Option<i64>) -> Result<Task, String> {
    let total_rounds = rounds.unwrap_or(1).clamp(1, 999);
    let conn = get_connection().map_err(|e| e.to_string())?;
    let project_name: String = conn
        .query_row("SELECT name FROM projects WHERE id = ?1", [project_id], |row| row.get(0))
        .map_err(|_| "项目不存在".to_string())?;
    // 账号：显式优先（单次任务指定优先账号）；否则按列表顺序自动轮换（跳过未登录或已达阈值的账号）
    let account_id = match account_id {
        Some(id) if id > 0 => {
            let exists: i64 = conn
                .query_row("SELECT COUNT(*) FROM accounts WHERE id = ?1", [id], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            if exists == 0 {
                return Err("账号不存在".to_string());
            }
            id
        }
        Some(_) => return Err("账号 id 非法，请传正整数或缺省（自动选择）".to_string()),
        None => crate::task_scheduler::auto_pick_account_id(&conn)?,
    };
    let name = make_task_name(&project_name);
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO tasks (name, project_id, account_id, status, total_rounds, created_at, updated_at) VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?5)",
        rusqlite::params![name, project_id, account_id, total_rounds, now],
    )
    .map_err(|e| e.to_string())?;
    let last_id = conn.last_insert_rowid();
    Ok(Task {
        id: Some(last_id),
        name,
        project_id: Some(project_id),
        account_id: Some(account_id),
        status: "pending".to_string(),
        interrupted_status: None,
        current_round: Some(0),
        total_rounds: Some(total_rounds),
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
    scheduler.clear_control(payload.task_id);
    scheduler.enable_auto_run();

    let conn = get_connection().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE tasks SET status = 'pending', interrupted_status = NULL, current_round = 0, completed_at = NULL, updated_at = ?1 WHERE id = ?2",
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

/**
 * 暂停任务：
 *   - 在数据库立即标记 paused（用户可看到即时反馈）；
 *   - 请求 sidecar 中止当前等待/下载（正在进行的单张下载允许安全结束）；
 *   - 执行线程在下一个检查点退出，不会继续提交新操作。
 */
#[tauri::command(rename_all = "snake_case")]
pub async fn task_pause(
    app: AppHandle,
    scheduler: State<'_, Arc<Scheduler>>,
    id: i64,
) -> Result<(), String> {
    scheduler.request_pause(id);
    if scheduler.is_current(id) {
        let _ = scheduler.send_sidecar_cmd(serde_json::json!({
            "cmd": "abort",
            "task_id": id,
            "reason": "pause",
        }));
    }
    let conn = get_connection().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE tasks SET status = 'paused', updated_at = ?1 WHERE id = ?2",
        rusqlite::params![Utc::now().to_rfc3339(), id],
    )
    .map_err(|e| e.to_string())?;
    let _ = app.emit("task-status-changed", serde_json::json!({ "task_id": id, "status": "paused" }));
    Ok(())
}

/**
 * 继续暂停的任务：不直接重新提交，而是走 resume_task 的页面状态探测流程。
 */
#[tauri::command(rename_all = "snake_case")]
pub async fn task_resume(
    app: AppHandle,
    scheduler: State<'_, Arc<Scheduler>>,
    id: i64,
) -> Result<(), String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let status: String = conn
        .query_row("SELECT status FROM tasks WHERE id = ?1", [id], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if status != "paused" {
        return Err(format!("当前状态（{}）不支持继续", status));
    }
    drop(conn);
    if scheduler.is_running() {
        return Err("任务仍在停止中或已有其他任务在执行，请稍后再试".to_string());
    }
    scheduler.clear_control(id);
    scheduler.enable_auto_run();
    let scheduler_inner = scheduler.inner().clone();
    tokio::spawn(async move {
        task_scheduler::resume_task(app, scheduler_inner, id).await;
    });
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
    if status != "needs_manual_intervention" && status != "failed" && status != "paused" && status != "waiting_confirmation" {
        return Err(format!("当前状态（{}）不支持继续执行", status));
    }
    drop(conn);
    if scheduler.is_running() {
        return Err("任务仍在停止中或已有其他任务在执行，请稍后再试".to_string());
    }
    scheduler.clear_control(id);
    scheduler.enable_auto_run();

    let scheduler_inner = scheduler.inner().clone();
    tokio::spawn(async move {
        task_scheduler::resume_task(app, scheduler_inner, id).await;
    });
    Ok(())
}

/**
 * 取消任务：停止后续轮次，请求 sidecar 中止当前等待，已下载文件保留。
 */
#[tauri::command(rename_all = "snake_case")]
pub async fn task_cancel(
    app: AppHandle,
    scheduler: State<'_, Arc<Scheduler>>,
    id: i64,
) -> Result<(), String> {
    scheduler.request_cancel(id);
    if scheduler.is_current(id) {
        let _ = scheduler.send_sidecar_cmd(serde_json::json!({
            "cmd": "abort",
            "task_id": id,
            "reason": "cancel",
        }));
    }
    let conn = get_connection().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE tasks SET status = 'cancelled', updated_at = ?1 WHERE id = ?2",
        rusqlite::params![Utc::now().to_rfc3339(), id],
    )
    .map_err(|e| e.to_string())?;
    let _ = app.emit("task-status-changed", serde_json::json!({ "task_id": id, "status": "cancelled" }));
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn task_detail(id: i64) -> Result<Option<Task>, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT id, name, project_id, account_id, status, interrupted_status, current_round, total_rounds, created_at, updated_at, started_at, completed_at FROM tasks WHERE id = ?1").map_err(|e| e.to_string())?;
    let row = stmt.query_row([id], |row| {
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
        .prepare("SELECT id, task_id, round_number, prompt_snapshot, references_json, output_dir, status, submitted_at, completed_at, success_count, failure_reason, expected_count FROM task_rounds WHERE task_id = ?1 ORDER BY round_number")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([task_id], |row| {
            Ok(TaskRound {
                id: row.get(0)?,
                task_id: row.get(1)?,
                round_number: row.get(2)?,
                prompt_snapshot: row.get(3)?,
                references_json: row.get(4)?,
                output_dir: row.get(5)?,
                status: row.get(6)?,
                submitted_at: row.get(7)?,
                completed_at: row.get(8)?,
                success_count: row.get(9)?,
                failure_reason: row.get(10)?,
                expected_count: row.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn round_open_output_dir(round_id: i64) -> Result<(), String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let output_dir: Option<String> = conn
        .query_row(
            "SELECT output_dir FROM task_rounds WHERE id = ?1",
            [round_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("轮次不存在：{}", e))?;
    let dir = output_dir
        .filter(|d| !d.trim().is_empty())
        .ok_or_else(|| "该轮次没有输出目录记录".to_string())?;
    let path = std::path::PathBuf::from(&dir);
    if !path.is_dir() {
        return Err(format!("输出目录不存在或不可访问：{}", dir));
    }
    open_in_file_manager(&path)
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
pub async fn account_get(id: i64) -> Result<Option<Account>, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT a.id, a.name, a.user_data_dir, a.status, a.image_threshold, a.success_count, a.submit_count, a.last_used_at, a.created_at, a.order_index,
                (SELECT COUNT(*) FROM task_images ti
                   JOIN task_rounds tr ON ti.task_round_id = tr.id
                   JOIN tasks t ON tr.task_id = t.id
                  WHERE t.account_id = a.id AND ti.download_status = 'verified') AS verified_images,
                (SELECT COUNT(*) FROM task_rounds tr
                   JOIN tasks t ON tr.task_id = t.id
                  WHERE t.account_id = a.id AND tr.status = 'completed') AS completed_rounds
           FROM accounts a
          WHERE a.id = ?1",
    ).map_err(|e| e.to_string())?;
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
            order_index: row.get(9)?,
            verified_images: row.get(10)?,
            completed_rounds: row.get(11)?,
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
    let mut stmt = conn.prepare("SELECT id, name, root_path, prompt_path, gen_params_json, created_at, updated_at FROM projects WHERE id = ?1").map_err(|e| e.to_string())?;
    let row = stmt.query_row([id], |row| {
        Ok(Project {
            id: row.get(0)?,
            name: row.get(1)?,
            root_path: row.get(2)?,
            prompt_path: row.get(3)?,
            gen_params_json: row.get(4)?,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
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
        .prepare(
            "SELECT l.id, l.task_id, l.level, l.message, l.created_at, t.name
               FROM execution_logs l
               LEFT JOIN tasks t ON l.task_id = t.id
              ORDER BY l.created_at DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit], |row| {
            Ok(LogEntry {
                id: row.get(0)?,
                task_id: row.get(1)?,
                level: row.get(2)?,
                message: row.get(3)?,
                created_at: row.get(4)?,
                task_name: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

// ===== 日志筛选与导出 =====

#[derive(Deserialize)]
pub struct LogFilterPayload {
    pub task_id: Option<i64>,
    pub account_id: Option<i64>,
    pub level: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub limit: Option<i64>,
}

fn logs_query_with_conn(
    conn: &rusqlite::Connection,
    filter: &LogFilterPayload,
) -> Result<Vec<LogEntry>, String> {
    let limit = filter.limit.unwrap_or(500).clamp(1, 5000);
    let mut sql = String::from(
        "SELECT l.id, l.task_id, l.level, l.message, l.created_at, t.name
           FROM execution_logs l
           LEFT JOIN tasks t ON l.task_id = t.id
          WHERE 1 = 1",
    );
    let mut params: Vec<rusqlite::types::Value> = Vec::new();
    if let Some(task_id) = filter.task_id {
        sql.push_str(" AND l.task_id = ?");
        params.push(rusqlite::types::Value::Integer(task_id));
    }
    if let Some(account_id) = filter.account_id {
        sql.push_str(" AND t.account_id = ?");
        params.push(rusqlite::types::Value::Integer(account_id));
    }
    if let Some(level) = &filter.level {
        let trimmed = level.trim();
        if !trimmed.is_empty() {
            sql.push_str(" AND l.level = ?");
            params.push(rusqlite::types::Value::Text(trimmed.to_string()));
        }
    }
    if let Some(from) = &filter.from {
        sql.push_str(" AND l.created_at >= ?");
        params.push(rusqlite::types::Value::Text(from.clone()));
    }
    if let Some(to) = &filter.to {
        sql.push_str(" AND l.created_at <= ?");
        params.push(rusqlite::types::Value::Text(to.clone()));
    }
    sql.push_str(" ORDER BY l.created_at DESC LIMIT ?");
    params.push(rusqlite::types::Value::Integer(limit));
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), |row| {
            Ok(LogEntry {
                id: row.get(0)?,
                task_id: row.get(1)?,
                level: row.get(2)?,
                message: row.get(3)?,
                created_at: row.get(4)?,
                task_name: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn logs_query(filter: LogFilterPayload) -> Result<Vec<LogEntry>, String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    logs_query_with_conn(&conn, &filter)
}

/// CSV 字段转义：含逗号/引号/换行时包裹引号并加倍引号
fn csv_field(value: &str) -> String {
    if value.contains(',') || value.contains('"') || value.contains('\n') || value.contains('\r') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

/// CSV 单元格：先做公式注入转义（首个非空白字符为 = + - @ 时加上前缀 '，防止 Excel 执行），再做字段转义
fn csv_cell(value: &str) -> String {
    let trimmed = value.trim_start();
    let needs_prefix = trimmed
        .chars()
        .next()
        .map(|c| matches!(c, '=' | '+' | '-' | '@'))
        .unwrap_or(false);
    if needs_prefix {
        csv_field(&format!("'{}", value))
    } else {
        csv_field(value)
    }
}

/** 渲染日志为 CSV：BOM + 表头（Excel 正确识别 UTF-8 中文）+ 每行一条，字段按 csv_cell 规则转义 */
fn render_logs_csv(rows: &[LogEntry]) -> String {
    let mut out = String::from("\u{FEFF}时间,级别,任务ID,任务名称,消息\n");
    for row in rows {
        out.push_str(&format!(
            "{},{},{},{},{}\n",
            csv_cell(row.created_at.as_deref().unwrap_or("")),
            csv_cell(&row.level),
            csv_cell(&row.task_id.map(|id| id.to_string()).unwrap_or_default()),
            csv_cell(row.task_name.as_deref().unwrap_or("")),
            csv_cell(&row.message)
        ));
    }
    out
}

#[tauri::command(rename_all = "snake_case")]
pub async fn logs_export(filter: LogFilterPayload, file_path: String) -> Result<i64, String> {
    let trimmed = file_path.trim();
    if trimmed.is_empty() {
        return Err("导出路径不能为空".to_string());
    }
    let conn = get_connection().map_err(|e| e.to_string())?;
    let rows = logs_query_with_conn(&conn, &filter)?;
    let out = render_logs_csv(&rows);
    let parent = std::path::Path::new(trimmed)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    if !parent.as_os_str().is_empty() {
        std::fs::create_dir_all(&parent).map_err(|e| format!("创建导出目录失败：{}", e))?;
    }
    std::fs::write(trimmed, out).map_err(|e| format!("写入导出文件失败：{}", e))?;
    Ok(rows.len() as i64)
}

// ===== 通知中心 =====

use crate::models::Notification;

fn notification_row(row: &rusqlite::Row) -> Result<Notification, rusqlite::Error> {
    let read_i64: i64 = row.get(6)?;
    Ok(Notification {
        id: row.get(0)?,
        kind: row.get(1)?,
        title: row.get(2)?,
        message: row.get(3)?,
        level: row.get(4)?,
        task_id: row.get(5)?,
        read: Some(read_i64 != 0),
        created_at: row.get(7)?,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn notification_list(limit: Option<i64>) -> Result<Vec<Notification>, String> {
    let limit = limit.unwrap_or(50).clamp(1, 500);
    let conn = get_connection().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, kind, title, message, level, task_id, read, created_at FROM notifications ORDER BY id DESC LIMIT ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit], notification_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn notification_create(
    kind: String,
    title: String,
    message: String,
    level: Option<String>,
    task_id: Option<i64>,
) -> Result<Notification, String> {
    let title = title.trim();
    let message = message.trim();
    if title.is_empty() || message.is_empty() {
        return Err("通知标题与内容不能为空".to_string());
    }
    // 限制长度与 level 枚举，防止 DB 膨胀与意外值
    let title: String = title.chars().take(120).collect();
    let message: String = message.chars().take(1000).collect();
    let kind: String = kind.trim().chars().take(64).collect::<String>();
    let kind = if kind.is_empty() { "general".to_string() } else { kind };
    let level = level
        .map(|v| v.trim().to_string())
        .unwrap_or_else(|| "info".to_string());
    let level = match level.as_str() {
        "info" | "success" | "warn" | "error" => level,
        _ => "info".to_string(),
    };
    let conn = get_connection().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO notifications (kind, title, message, level, task_id, read, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)",
        rusqlite::params![kind, title, message, level, task_id, now],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    Ok(Notification {
        id: Some(id),
        kind,
        title: title.to_string(),
        message: message.to_string(),
        level,
        task_id,
        read: Some(false),
        created_at: Some(now),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn notification_mark_read(id: i64) -> Result<(), String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    let affected = conn
        .execute("UPDATE notifications SET read = 1 WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    if affected == 0 {
        return Err("通知不存在".to_string());
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn notification_mark_all_read() -> Result<(), String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    conn.execute("UPDATE notifications SET read = 1 WHERE read = 0", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn notification_clear() -> Result<(), String> {
    let conn = get_connection().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM notifications", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{make_task_name, csv_field, csv_cell, render_logs_csv, LogEntry};

    #[test]
    fn csv_field_escapes_comma_quote_and_newline() {
        assert_eq!(csv_field("plain"), "plain");
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_field("line1\nline2"), "\"line1\nline2\"");
    }

    #[test]
    fn csv_cell_neutralizes_formula_prefix() {
        assert_eq!(csv_cell("=1+1"), "'=1+1");
        assert_eq!(csv_cell("+cmd"), "'+cmd");
        assert_eq!(csv_cell("-10"), "'-10");
        assert_eq!(csv_cell("@SUM(A1)"), "'@SUM(A1)");
        assert_eq!(csv_cell("  =1+1"), "'  =1+1");
        assert_eq!(csv_cell("plain"), "plain");
        assert_eq!(csv_cell("a,b"), "\"a,b\"");
    }


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

    #[test]
    fn render_logs_csv_writes_bom_and_escapes_rows() {
        let rows = vec![
            LogEntry {
                id: Some(1),
                task_id: Some(18),
                level: "info".to_string(),
                message: "已提交，等待生成完成".to_string(), // 全角逗号，不需要引号
                created_at: Some("2026-11-09T04:19:32+00:00".to_string()),
                task_name: Some("镊子-2026-11-09".to_string()),
            },
            LogEntry {
                id: Some(2),
                task_id: None,
                level: "error".to_string(),
                message: "含半角,逗号 \"引号\"\n换行".to_string(),
                created_at: Some("2026-11-09T04:20:00+00:00".to_string()),
                task_name: None,
            },
            LogEntry {
                id: Some(3),
                task_id: Some(99),
                level: "warn".to_string(),
                message: "=1+1".to_string(), // 公式注入：前缀 ' 中和
                created_at: None,
                task_name: Some("".to_string()),
            },
        ];
        let out = render_logs_csv(&rows);
        assert!(out.starts_with('\u{FEFF}'), "必须带 BOM 供 Excel 识别 UTF-8");
        let body = out.trim_start_matches('\u{FEFF}');
        assert!(body.starts_with("时间,级别,任务ID,任务名称,消息\n"));
        // 全角逗号原文直出（CSV 只认半角逗号）
        assert!(out.contains("2026-11-09T04:19:32+00:00,info,18,镊子-2026-11-09,已提交，等待生成完成\n"));
        // 半角逗号+引号+换行 → 整体加引号、引号加倍
        assert!(out.contains(",\"含半角,逗号 \"\"引号\"\"\n换行\"\n"));
        // 缺 task_id / created_at / task_name → 空字段
        assert!(out.contains(",error,,,"));
        assert!(out.contains("2026-11-09T04:20:00+00:00,error,,,\"含半角"));
        // 公式注入被前缀 ' 中和（整行含引号是因为 csv_field 处理换行）
        assert!(out.contains("'=1+1\n"));
    }

    #[test]
    fn csv_field_quotes_only_when_needed_and_doubles_quotes() {
        assert_eq!(csv_field("plain"), "plain");
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_field("line1\nline2"), "\"line1\nline2\"");
        assert_eq!(csv_field("a\rb"), "\"a\rb\"");
    }

    #[test]
    fn csv_cell_neutralizes_formula_injection() {
        assert_eq!(csv_cell("=1+1"), "'=1+1");
        assert!(csv_cell("+cmd").starts_with('\''));
        assert!(csv_cell("-2+3").starts_with('\''));
        assert!(csv_cell("@SUM(A1)").starts_with('\''));
        assert!(csv_cell("  =1+1").starts_with('\'')); // 首个非空白字符仍为 =
        assert!(csv_cell("=a,b").starts_with("\"'")); // 前缀后含逗号 → 整体再被 csv_field 加引号
        assert_eq!(csv_cell("正常消息"), "正常消息");
        assert_eq!(csv_cell("100"), "100");
        assert_eq!(csv_cell("-"), "'-");
        assert_eq!(csv_cell(" "), " ");
    }
}
