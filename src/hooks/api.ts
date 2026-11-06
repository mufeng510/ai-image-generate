import { invoke } from '@tauri-apps/api/core'

export interface Project {
  id?: number
  name: string
  root_path: string
  prompt_path?: string
  created_at?: string
  updated_at?: string
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
}

export interface Task {
  id?: number
  name: string
  project_id?: number
  account_id?: number
  status: string
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

export async function accountList(): Promise<Account[]> {
  return invoke('account_list')
}

export async function accountAdd(name: string): Promise<Account> {
  return invoke('account_add', { name })
}

export async function accountOpenLogin(id: number): Promise<void> {
  return invoke('account_open_login', { id })
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

export async function taskCreate(name: string, project_id: number, account_id: number): Promise<Task> {
  return invoke('task_create', { name, project_id, account_id })
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
