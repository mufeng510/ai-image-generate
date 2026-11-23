/**
 * src-tauri/src/live_photo.rs
 *
 * 「生成实况图片」：调用外部 AI Image Process CLI，把某个任务文件夹下的
 * 所有轮次图片一次性转成 Apple Live Photo（JPG + MOV）。
 *
 * 设计要点（详见 docs/LIVE_PHOTO_INTEGRATION.md）：
 *   - 输入是任务文件夹本身 <项目根>/output/<清洗后的任务名>/，由
 *     task_output_dir() 直接算出；CLI 开启递归后覆盖全部轮次子目录。
 *   - 输出使用 AI Image Process 自己配置的默认输出目录（config.json 的
 *     output.directory），本软件不接收、不搬运产物。
 *   - 临时配置开启递归、开启本地动态 Live Photo、并强制 delete_originals=false
 *     保护原图；隐藏图片等其他步骤沿用用户在 AIP 里的配置，失败时按 AIP 的
 *     预检/处理结果原样报错。
 *   - CLI 可能跑几分钟：命令立即返回 job_id，后台线程执行并通过事件汇报。
 */

use chrono::Utc;
use serde::Serialize;
use std::collections::VecDeque;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use crate::db::get_connection;
use crate::task_scheduler::{app_data_dir, task_output_dir};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/** 进程级闸门：同时只允许一个实况任务（防止并发 CLI 互相争抢 CPU/临时文件） */
static BUSY: AtomicBool = AtomicBool::new(false);
static JOB_SEQ: AtomicU64 = AtomicU64::new(1);

pub fn try_acquire() -> bool {
    !BUSY.swap(true, Ordering::SeqCst)
}

pub fn release() {
    BUSY.store(false, Ordering::SeqCst);
}

fn new_job_id() -> String {
    format!(
        "lp-{}-{}",
        Utc::now().timestamp_millis(),
        JOB_SEQ.fetch_add(1, Ordering::SeqCst)
    )
}

/** 解析出的 CLI 调用方式：发行包是可执行文件，源码仓库是 venv python */
pub struct ResolvedCli {
    pub program: PathBuf,
    pub pre_args: Vec<String>,
    pub cwd: PathBuf,
}

/** 准备阶段的结果；校验通过后交由后台线程执行 */
pub struct Prepared {
    pub job_id: String,
    pub task_id: i64,
    pub cli: ResolvedCli,
    pub input_dir: PathBuf,
    pub output_dir: PathBuf,
    pub config_path: PathBuf,
}

/// 终态事件载荷（与前端 `LivePhotoFinished` 对应）
#[derive(Serialize, Clone)]
pub struct LivePhotoFinished {
    pub task_id: i64,
    pub job_id: String,
    pub ok: bool,
    pub success: i64,
    pub failed: i64,
    pub preflight_failed: bool,
    pub preflight_error: Option<String>,
    pub output_dir: Option<String>,
    pub error: Option<String>,
}

/** 在目录里寻找 CLI：优先打包版入口，其次源码版 venv python */
pub fn resolve_cli(aip_root: &Path) -> Result<ResolvedCli, String> {
    let mut tried: Vec<String> = Vec::new();
    let exe_names = ["AI-Image-Process-CLI.exe", "AI-Image-Process-CLI"];
    let mut exe_candidates: Vec<PathBuf> = Vec::new();
    for dir in [aip_root.to_path_buf(), aip_root.join("dist").join("AI-Image-Process")] {
        for name in exe_names {
            exe_candidates.push(dir.join(name));
        }
    }
    for candidate in &exe_candidates {
        tried.push(candidate.display().to_string());
        if candidate.is_file() {
            return Ok(ResolvedCli {
                program: candidate.clone(),
                pre_args: Vec::new(),
                cwd: aip_root.to_path_buf(),
            });
        }
    }

    for py in [
        aip_root.join(".venv").join("Scripts").join("python.exe"),
        aip_root.join(".venv").join("bin").join("python"),
    ] {
        tried.push(py.display().to_string());
        if py.is_file() && aip_root.join("app").join("main_cli.py").is_file() {
            return Ok(ResolvedCli {
                program: py,
                pre_args: vec!["-m".to_string(), "app".to_string(), "cli".to_string()],
                cwd: aip_root.to_path_buf(),
            });
        }
    }

    Err(format!(
        "未在指定目录找到 AI Image Process 的 CLI 入口。已尝试：{}。请确认目录里有 AI-Image-Process-CLI.exe（发行包）或 .venv + app/（源码运行）。",
        tried.join("；")
    ))
}

/** 读取 AIP 配置：便携模式在 <root>/config/config.json，普通安装在 %APPDATA%/AI-Image-Process/config.json */
pub fn load_aip_config(aip_root: &Path) -> Result<Value, String> {
    let mut candidates = vec![aip_root.join("config").join("config.json")];
    let appdata = std::env::var("APPDATA")
        .map(PathBuf::from)
        .or_else(|_| dirs::config_dir().ok_or(()))
        .map(|p| p.join("AI-Image-Process").join("config.json"));
    if let Ok(p) = appdata {
        candidates.push(p);
    }
    for path in &candidates {
        if path.is_file() {
            let text = std::fs::read_to_string(path)
                .map_err(|e| format!("读取 AI Image Process 配置失败 {}: {}", path.display(), e))?;
            let value: Value = serde_json::from_str(&text)
                .map_err(|e| format!("AI Image Process 配置不是合法 JSON {}: {}", path.display(), e))?;
            if !value.is_object() {
                return Err(format!("AI Image Process 配置根节点不是对象：{}", path.display()));
            }
            return Ok(value);
        }
    }
    // 没有配置文件时给出空对象；后续会因缺少 output.directory 而报错，不擅自替用户选目录。
    Ok(json!({}))
}

/** 取 AIP 用户配置的默认输出目录（必填），相对路径按 AIP 根目录解析 */
pub fn default_output_dir(cfg: &Value, aip_root: &Path) -> Result<PathBuf, String> {
    let raw = cfg
        .get("output")
        .and_then(|v| v.get("directory"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if raw.is_empty() {
        return Err("AI Image Process 尚未设置默认输出目录。请先在 AI Image Process 中设置输出目录。".to_string());
    }
    let path = PathBuf::from(raw);
    Ok(if path.is_absolute() {
        path
    } else {
        aip_root.join(path)
    })
}

/** 任务文件夹：<项目根>/output/<清洗后的任务名>/，复用调度器的同名函数 */
pub fn task_input_dir(task_id: i64) -> Result<PathBuf, String> {
    let conn = get_connection()?;
    let (name, root): (String, String) = conn
        .query_row(
            "SELECT t.name, p.root_path FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?1",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("读取任务信息失败：{}", e))?;
    let dir = task_output_dir(&PathBuf::from(root).join("output"), &name);
    if !dir.is_dir() {
        return Err(format!("该任务尚无输出目录：{}", dir.display()));
    }
    Ok(dir)
}

/** 词法归一化路径（不要求路径已存在） */
fn normalize_path(p: &Path) -> PathBuf {
    let base = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(p)
    };
    let mut out = PathBuf::new();
    for part in base.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/** Windows 路径大小写不敏感；统一成小写 + '/' 便于前缀比较 */
fn path_key(p: &Path) -> String {
    normalize_path(p)
        .to_string_lossy()
        .replace('\\', "/")
        .to_lowercase()
}

/** 输出目录不得位于（递归扫描的）输入目录之内，否则 AIP 预检会直接拒绝 */
pub fn verify_path_safety(input: &Path, output: &Path) -> Result<(), String> {
    let in_key = path_key(input);
    let out_key = path_key(output);
    if out_key == in_key || out_key.starts_with(&format!("{}/", in_key)) {
        return Err(format!(
            "AI Image Process 的默认输出目录位于任务文件夹之内，递归扫描会导致预检失败。请在 AI Image Process 中把默认输出目录改到任务文件夹之外。\n输入：{}\n输出：{}",
            input.display(),
            output.display()
        ));
    }
    Ok(())
}

fn ensure_object(cfg: &mut Value, key: &str) {
    if !cfg.get(key).is_some_and(|v| v.is_object()) {
        cfg[key] = json!({});
    }
}

/// 基于用户 AIP 配置生成一次性配置：递归开、本地动态、禁止删原件；
/// 隐藏图片等其他步骤保持用户原样（失败就按 AIP 的处理结果报错）。
fn build_run_config(aip_cfg: &Value, output_dir: &Path, job_id: &str) -> Result<PathBuf, String> {
    let mut cfg = aip_cfg.clone();
    if !cfg.is_object() {
        cfg = json!({});
    }
    ensure_object(&mut cfg, "input");
    ensure_object(&mut cfg, "output");
    ensure_object(&mut cfg, "steps");
    ensure_object(&mut cfg["steps"], "live_photo");

    cfg["config_version"] = json!(2);
    cfg["input"]["recurse_folders"] = json!(true);
    cfg["input"]["delete_originals_after_run"] = json!(false);
    cfg["output"]["use_source_directory"] = json!(false);
    cfg["output"]["directory"] = json!(output_dir.to_string_lossy());
    cfg["steps"]["live_photo"]["enabled"] = json!(true);
    cfg["steps"]["live_photo"]["video_source"] = json!("local_motion");

    let dir = app_data_dir()?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("创建临时配置目录失败：{}", e))?;
    let path = dir.join(format!("aip-config-{}.json", job_id));
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("写入临时配置失败：{}", e))?;
    Ok(path)
}

/// 同步校验 + 准备工作，全部成功后才启动后台线程。
pub fn prepare(task_id: i64, aip_root_str: String) -> Result<Prepared, String> {
    let root = PathBuf::from(aip_root_str.trim());
    if root.as_os_str().is_empty() || !root.is_dir() {
        return Err("请先在设置页配置有效的 AI Image Process 目录".to_string());
    }
    let cli = resolve_cli(&root)?;
    let aip_cfg = load_aip_config(&root)?;
    let output_dir = default_output_dir(&aip_cfg, &root)?;
    let input_dir = task_input_dir(task_id)?;
    verify_path_safety(&input_dir, &output_dir)?;
    let job_id = new_job_id();
    let config_path = build_run_config(&aip_cfg, &output_dir, &job_id)?;
    Ok(Prepared {
        job_id,
        task_id,
        cli,
        input_dir,
        output_dir,
        config_path,
    })
}

/** 后台执行 CLI，返回终态结果 */
pub fn execute(app: &AppHandle, prepared: Prepared) -> LivePhotoFinished {
    let Prepared {
        job_id,
        task_id,
        cli,
        input_dir,
        output_dir,
        config_path,
    } = prepared;

    let mut cmd = Command::new(&cli.program);
    for arg in &cli.pre_args {
        cmd.arg(arg);
    }
    cmd.arg(&input_dir)
        .arg("-o")
        .arg(&output_dir)
        .arg("--config")
        .arg(&config_path)
        .arg("--enable-live-photo")
        .arg("--video-source")
        .arg("local_motion")
        .arg("--json-summary")
        .current_dir(&cli.cwd)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let _ = app.emit(
        "live-photo-progress",
        json!({
            "task_id": task_id,
            "job_id": job_id,
            "line": format!("开始调用 AI Image Process：{}", input_dir.display()),
        }),
    );

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = std::fs::remove_file(&config_path);
            return failure(&job_id, task_id, &output_dir, format!("启动 AI Image Process 失败：{}", e));
        }
    };

    // stderr 必须并发读取，否则进度日志填满管道缓冲区后子进程会阻塞。
    let tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    let stderr_app = app.clone();
    let stderr_tail = Arc::clone(&tail);
    let stderr_job = job_id.clone();
    let stderr = child.stderr.take();
    let stderr_handle = std::thread::spawn(move || {
        if let Some(stderr) = stderr {
            for line in BufReader::new(stderr).lines() {
                let line = line.unwrap_or_else(|_| "<无法解码的日志>".to_string());
                if !line.trim().is_empty() {
                    let _ = stderr_app.emit(
                        "live-photo-progress",
                        json!({
                            "task_id": task_id,
                            "job_id": stderr_job,
                            "line": line.clone(),
                        }),
                    );
                    let mut guard = stderr_tail.lock().unwrap();
                    if guard.len() >= 30 {
                        guard.pop_front();
                    }
                    guard.push_back(line);
                }
            }
        }
    });

    let mut stdout_text = String::new();
    let stdout_result = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取 AI Image Process 的 stdout".to_string())
        .and_then(|mut stdout| {
            stdout
                .read_to_string(&mut stdout_text)
                .map_err(|e| format!("读取 AI Image Process 输出失败：{}", e))
        });
    let status = child.wait().map_err(|e| e.to_string());
    let _ = stderr_handle.join();
    let _ = std::fs::remove_file(&config_path);

    if let Err(e) = stdout_result {
        return failure(&job_id, task_id, &output_dir, e);
    }
    let code = match status {
        Ok(s) => s.code().unwrap_or(-1),
        Err(e) => return failure(&job_id, task_id, &output_dir, format!("等待 AI Image Process 结束失败：{}", e)),
    };

    let trimmed = stdout_text.trim();
    let summary: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => {
            let tail_text = tail
                .lock()
                .unwrap()
                .iter()
                .cloned()
                .collect::<Vec<_>>()
                .join("\n");
            return failure(
                &job_id,
                task_id,
                &output_dir,
                format!(
                    "无法解析 AI Image Process 的结果（退出码 {}）。stderr 末尾：\n{}",
                    code,
                    if tail_text.is_empty() { "<空>" } else { &tail_text }
                ),
            );
        }
    };

    let num = |key: &str| -> i64 {
        summary.get(key).and_then(|v| v.as_i64()).unwrap_or(0)
    };
    let success = num("success");
    let failed = num("failed");
    let preflight_failed = summary
        .get("preflight_failed")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let preflight_error = summary
        .get("preflight_error")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let mut error: Option<String> = None;
    if preflight_failed {
        error = Some(preflight_error.clone().unwrap_or_else(|| "预检未通过".to_string()));
    } else if code == 1 {
        error = Some(format!("部分文件处理失败（{} 张）", failed));
    } else if code != 0 {
        error = Some(format!("AI Image Process 退出码异常：{}", code));
    } else if success == 0 {
        error = Some("AI Image Process 报告成功但没有产出文件".to_string());
    }

    LivePhotoFinished {
        task_id,
        job_id,
        ok: error.is_none(),
        success,
        failed,
        preflight_failed,
        preflight_error,
        output_dir: Some(output_dir.to_string_lossy().to_string()),
        error,
    }
}

fn failure(job_id: &str, task_id: i64, output_dir: &Path, message: String) -> LivePhotoFinished {
    LivePhotoFinished {
        task_id,
        job_id: job_id.to_string(),
        ok: false,
        success: 0,
        failed: 0,
        preflight_failed: false,
        preflight_error: None,
        output_dir: Some(output_dir.to_string_lossy().to_string()),
        error: Some(message),
    }
}

/// 软件内通知（直接写 notifications 表，避免后台线程里再走 async command）
pub fn write_notification(result: &LivePhotoFinished) {
    let title = if result.ok {
        format!("实况图片生成完成（{} 张）", result.success)
    } else {
        "实况图片生成失败".to_string()
    };
    let detail = result
        .error
        .clone()
        .or_else(|| result.preflight_error.clone())
        .unwrap_or_else(|| format!("输出目录：{}", result.output_dir.clone().unwrap_or_default()));
    let title: String = title.chars().take(120).collect();
    let detail: String = detail.chars().take(1000).collect();
    let level = if result.ok { "success" } else { "error" };
    if let Ok(conn) = get_connection() {
        let now = Utc::now().to_rfc3339();
        let _ = conn.execute(
            "INSERT INTO notifications (kind, title, message, level, task_id, read, created_at) VALUES ('live_photo', ?1, ?2, ?3, ?4, 0, ?5)",
            rusqlite::params![title, detail, level, result.task_id, now],
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_safety_rejects_output_inside_input() {
        let input = Path::new(r"C:\proj\output\task-a");
        let output = Path::new(r"C:\proj\output\task-a\live");
        assert!(verify_path_safety(input, output).is_err());
        assert!(verify_path_safety(input, Path::new(r"C:\proj\output\task-b")).is_ok());
    }

    #[test]
    fn run_config_applies_required_overrides() {
        let base = json!({
            "config_version": 1,
            "steps": {"hidden_image": {"enabled": true}, "live_photo": {"video_source": "ai_video"}},
            "input": {"delete_originals_after_run": true}
        });
        let mut cfg = base;
        ensure_object(&mut cfg, "input");
        ensure_object(&mut cfg, "output");
        ensure_object(&mut cfg, "steps");
        ensure_object(&mut cfg["steps"], "live_photo");
        cfg["config_version"] = json!(2);
        cfg["input"]["recurse_folders"] = json!(true);
        cfg["input"]["delete_originals_after_run"] = json!(false);
        cfg["output"]["use_source_directory"] = json!(false);
        cfg["steps"]["live_photo"]["enabled"] = json!(true);
        cfg["steps"]["live_photo"]["video_source"] = json!("local_motion");

        assert_eq!(cfg["config_version"], json!(2));
        assert_eq!(cfg["input"]["recurse_folders"], json!(true));
        assert_eq!(cfg["input"]["delete_originals_after_run"], json!(false));
        // 隐藏图片步骤沿用用户配置，不被强制关闭；失败由 AIP 自行报错。
        assert_eq!(cfg["steps"]["hidden_image"]["enabled"], json!(true));
        assert_eq!(cfg["steps"]["live_photo"]["video_source"], json!("local_motion"));
    }

    #[test]
    fn default_output_dir_requires_explicit_setting() {
        assert!(default_output_dir(&json!({}), Path::new(r"C:\aip")).is_err());
        assert_eq!(
            default_output_dir(&json!({"output": {"directory": r"C:\aip\out"}}), Path::new(r"C:\aip")).unwrap(),
            PathBuf::from(r"C:\aip\out")
        );
    }
}
