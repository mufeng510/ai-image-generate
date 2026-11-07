import { invoke } from '@tauri-apps/api/core'

export interface Project {
  id?: number
  name: string
  root_path: string
  prompt_path?: string
  created_at?: string
  updated_at?: string
}

export interface ReferenceFolder {
  relative_path: string
  path: string
  image_count: number
}

export interface ProjectReferenceStats {
  references_root: string
  total_images: number
  folder_count: number
  folders: ReferenceFolder[]
}

export interface ProjectHistoryItem {
  task_id: number
  name: string
  status: string
  total_rounds: number
  current_round: number
  success_images: number
  created_at: string
  completed_at?: string
}

export interface ReferenceItem {
  name: string
  path: string
  relative_path: string
  folder: string
  size: number
  modified?: string
}

export interface ReferenceDetail {
  name: string
  path: string
  relative_path: string
  size: number
  modified?: string
  sha256: string
}

export interface Account {
  id?: number
  name: string
  user_data_dir: string
  status: string
  image_threshold?: number
  success_count?: number
  submit_count?: number
  last_used_at?: string
  created_at?: string
  order_index?: number
  /** 实际下载并校验通过的图片数 */
  verified_images?: number
  /** 成功完成的轮次数 */
  completed_rounds?: number
}

export interface Task {
  id?: number
  name: string
  project_id?: number
  account_id?: number
  status: string
  interrupted_status?: string
  current_round?: number
  total_rounds?: number
  created_at?: string
  updated_at?: string
  started_at?: string
  completed_at?: string
}

export interface TaskRound {
  id?: number
  task_id?: number
  round_number?: number
  prompt_snapshot?: string
  references_json?: string
  status?: string
  submitted_at?: string
  completed_at?: string
  success_count?: number
  failure_reason?: string
}

export interface TaskImage {
  id?: number
  task_round_id?: number
  image_index?: number
  original_url?: string
  saved_path?: string
  sha256?: string
  file_size?: number
  format?: string
  download_status?: string
}

export interface Setting {
  key: string
  value: string
}

export interface DashboardStats {
  total_projects: number
  total_accounts: number
  total_tasks: number
  completed_tasks: number
  total_images: number
  pending_tasks: number
  failed_tasks: number
}

export interface LogEntry {
  id?: number
  task_id?: number
  level: string
  message: string
  created_at?: string
  task_name?: string
}

export interface LogFilter {
  task_id?: number | null
  account_id?: number | null
  level?: string | null
  from?: string | null
  to?: string | null
  limit?: number
}

export interface Notification {
  id?: number
  kind: string
  title: string
  message: string
  level: string
  task_id?: number
  read?: boolean
  created_at?: string
}

export async function greet(name: string): Promise<string> {
  return invoke('greet', { name })
}

export async function projectList(): Promise<Project[]> {
  return invoke('project_list')
}

export async function projectCreate(name: string, root_path: string): Promise<Project> {
  return invoke('project_create', { name, root_path })
}

export async function projectDelete(id: number): Promise<void> {
  return invoke('project_delete', { id })
}

export async function projectImport(name: string | null, root_path: string): Promise<Project> {
  return invoke('project_import', { name, root_path })
}

export async function projectRename(id: number, name: string): Promise<void> {
  return invoke('project_rename', { id, name })
}

export async function projectOpenFolder(id: number): Promise<void> {
  return invoke('project_open_folder', { id })
}

export async function projectPromptGet(id: number): Promise<string> {
  return invoke('project_prompt_get', { id })
}

export async function projectPromptSet(id: number, content: string): Promise<void> {
  return invoke('project_prompt_set', { id, content })
}

export async function projectReferenceStats(id: number): Promise<ProjectReferenceStats> {
  return invoke('project_reference_stats', { id })
}

export async function projectTaskHistory(id: number, limit = 20): Promise<ProjectHistoryItem[]> {
  return invoke('project_task_history', { id, limit })
}

export async function projectRefList(id: number): Promise<ReferenceItem[]> {
  return invoke('project_ref_list', { id })
}

export async function projectRefAdd(id: number, source_paths: string[], subfolder?: string | null): Promise<{ added: number; skipped: string[] }> {
  return invoke('project_ref_add', { id, source_paths, subfolder: subfolder ?? null })
}

export async function projectRefDelete(id: number, path: string): Promise<void> {
  return invoke('project_ref_delete', { id, path })
}

export async function projectRefCreateFolder(id: number, subfolder: string): Promise<void> {
  return invoke('project_ref_create_folder', { id, subfolder })
}

export async function projectRefDetail(id: number, path: string): Promise<ReferenceDetail> {
  return invoke('project_ref_detail', { id, path })
}

export async function projectRefReveal(id: number, path: string): Promise<void> {
  return invoke('project_ref_reveal', { id, path })
}

export async function projectRefOpen(id: number, path: string): Promise<void> {
  return invoke('project_ref_open', { id, path })
}

export async function accountList(): Promise<Account[]> {
  return invoke('account_list')
}

export async function accountAdd(name: string): Promise<Account> {
  return invoke('account_add', { name })
}

export async function accountOpenLogin(id: number): Promise<void> {
  return invoke('account_open_login', { id })
}

export async function accountReorder(order_ids: number[]): Promise<void> {
  return invoke('account_reorder', { order_ids })
}

export async function accountThresholdSet(id: number, threshold: number): Promise<void> {
  return invoke('account_threshold_set', { id, threshold })
}

export async function accountDelete(id: number): Promise<void> {
  return invoke('account_delete', { id })
}

export async function settingsGet(key: string): Promise<string | null> {
  return invoke('settings_get', { key })
}

export async function settingsSet(key: string, value: string): Promise<void> {
  return invoke('settings_set', { key, value })
}

export async function taskList(): Promise<Task[]> {
  return invoke('task_list')
}

export async function taskCreate(project_id: number, account_id: number | null, rounds = 1): Promise<Task> {
  return invoke('task_create', { project_id, account_id, rounds })
}

export async function taskStart(id: number): Promise<void> {
  return invoke('task_start', { payload: { task_id: id } })
}

export async function taskPause(id: number): Promise<void> {
  return invoke('task_pause', { id })
}

export async function taskResume(id: number): Promise<void> {
  return invoke('task_resume', { id })
}

export async function taskContinue(id: number): Promise<void> {
  return invoke('task_continue', { id })
}

export async function taskCancel(id: number): Promise<void> {
  return invoke('task_cancel', { id })
}

export async function taskDetail(id: number): Promise<Task | null> {
  return invoke('task_detail', { id })
}

export async function taskListRounds(task_id: number): Promise<TaskRound[]> {
  return invoke('task_list_rounds', { task_id })
}

export async function taskListImages(round_id: number): Promise<TaskImage[]> {
  return invoke('task_list_images', { round_id })
}

export async function dashboardStats(): Promise<DashboardStats> {
  return invoke('dashboard_stats')
}

export async function executionLogs(limit: number = 100): Promise<LogEntry[]> {
  return invoke('execution_logs', { limit })
}

export async function logsQuery(filter: LogFilter): Promise<LogEntry[]> {
  return invoke('logs_query', { filter })
}

export async function logsExport(filter: LogFilter, file_path: string): Promise<number> {
  return invoke('logs_export', { filter, file_path })
}

export async function notificationList(limit = 50): Promise<Notification[]> {
  return invoke('notification_list', { limit })
}

export async function notificationCreate(kind: string, title: string, message: string, level?: string, task_id?: number): Promise<Notification> {
  return invoke('notification_create', { kind, title, message, level: level ?? null, task_id: task_id ?? null })
}

export async function notificationMarkRead(id: number): Promise<void> {
  return invoke('notification_mark_read', { id })
}

export async function notificationMarkAllRead(): Promise<void> {
  return invoke('notification_mark_all_read')
}

export async function notificationClear(): Promise<void> {
  return invoke('notification_clear')
}
