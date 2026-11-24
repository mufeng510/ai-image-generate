/**
 * src/pages/Execution.tsx
 *
 * 任务列表：记录来自项目 output 目录下现存的文件夹（一个文件夹 = 一条任务记录）。
 * 运行中任务的操作仍走 Tauri Commands，状态变化通过 Tauri Events 推送。
 */

import { useState, useEffect, useCallback } from 'react'
import { useI18n } from '@/i18n'
import {
  taskList,
  taskCreate,
  taskStart,
  taskPause,
  taskResume,
  taskContinue,
  taskCancel,
  projectList,
  accountList,
  projectTaskFolders,
  taskFolderOpen,
  type Task,
  type Project,
  type Account,
  type TaskFolder,
  type FolderSelection,
} from '@/hooks/api'
import { listen } from '@tauri-apps/api/event'
import { useTaskStatusLabels, useConfirmNodeLabels } from '@/utils/taskStatus'
import { formatDateTime } from '@/utils/datetime'
import { notify } from '@/utils/dialog'

const FOLDER_STATUS_COLORS: Record<string, string> = {
  generating: '#2563eb',
  pending_review: '#d97706',
  converted: '#16a34a',
  empty: '#6b7280',
}

/** 正在执行、可被暂停/取消的任务状态 */
const ACTIVE_STATUSES = [
  'preparing',
  'selecting_images',
  'waiting_confirmation',
  'uploading',
  'submitting',
  'generating',
  'downloading',
  'verifying',
]

const CANCELLABLE_STATUSES = [
  'pending',
  'paused',
  'failed',
  'needs_manual_intervention',
  ...ACTIVE_STATUSES,
]

export default function ExecutionPage({ onFolderSelect }: { onFolderSelect: (sel: FolderSelection) => void }) {
  const { t } = useI18n()
  const STATUS_LABELS = useTaskStatusLabels()
  const CONFIRM_NODE_LABELS = useConfirmNodeLabels()
  const [folders, setFolders] = useState<TaskFolder[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [projectId, setProjectId] = useState('')
  const [accountId, setAccountId] = useState('')
  const [rounds, setRounds] = useState('1')
  const [logs, setLogs] = useState<string[]>([])
  const [loading, setLoading] = useState(false)

  /** 列表真相源：扫描磁盘文件夹；同时拉一份运行中任务用于操作按钮 */
  const loadFolders = useCallback(async () => {
    setLoading(true)
    try {
      const ps = await projectList()
      setProjects(ps)
      const groups = await Promise.all(ps.map((p) => projectTaskFolders(p.id!)))
      setFolders(groups.flat())
      setTasks(await taskList())
    } catch (e) {
      console.error('加载任务文件夹失败:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadFolders()
    accountList().then(setAccounts).catch(() => {})

    let unlistenStatus: (() => void) | null = null
    let unlistenComplete: (() => void) | null = null
    let unlistenLog: (() => void) | null = null
    ;(async () => {
      unlistenStatus = await listen<{ task_id: number; status: string; reason?: string }>(
        'task-status-changed',
        (event) => {
          const { task_id, status, reason } = event.payload
          setTasks((prev) => prev.map((x) => (x.id === task_id ? { ...x, status } : x)))
          const base = t('logs.taskStatusChanged', { id: task_id, status })
          addLog(reason ? `${base}（${reason}）` : base)
        },
      )
      unlistenComplete = await listen<{ task_id: number }>('task-completed', (event) => {
        addLog(t('logs.taskCompleted', { id: event.payload.task_id }))
        // 轮次落盘后刷新文件夹汇总（轮次数/图片数）
        loadFolders()
      })
      unlistenLog = await listen<{ level: string; message: string }>('sidecar-log', (event) => {
        addLog(`[${event.payload.level}] ${event.payload.message}`)
      })
    })()

    return () => {
      unlistenStatus?.()
      unlistenComplete?.()
      unlistenLog?.()
    }
  }, [loadFolders])

  const addLog = (message: string) => {
    const time = new Date().toLocaleTimeString()
    setLogs((prev) => [`[${time}] ${message}`, ...prev].slice(0, 100))
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!projectId) {
      notify(t('tasks.selectProject'))
      return
    }
    setLoading(true)
    try {
      const r = Math.max(1, Math.min(999, Number(rounds) || 1))
      await taskCreate(Number(projectId), accountId ? Number(accountId) : null, r)
      setProjectId('')
      setAccountId('')
      setRounds('1')
      await loadFolders()
    } catch (err) {
      notify(t('tasks.createFailed') + err)
    } finally {
      setLoading(false)
    }
  }

  const handleStart = async (id: number) => {
    try {
      await taskStart(id)
      await loadFolders()
    } catch (e) {
      notify(t('tasks.startFailed') + e)
    }
  }

  const handleAction = async (id: number, fn: (id: number) => Promise<void>) => {
    try {
      await fn(id)
      await loadFolders()
    } catch (e) {
      notify(t('tasks.actionFailed') + e)
    }
  }

  const taskFor = (folder: TaskFolder) => tasks.find((x) => x.id === folder.task_id)
  /** 全局页只保留运行中或需要人工处理的任务；已完成/待筛选的记录在项目工作台查看 */
  const visibleFolders = folders.filter((folder) => {
    if (folder.status === 'generating') return true
    const task = taskFor(folder)
    if (!task) return false
    return [
      'pending', 'preparing', 'selecting_images', 'waiting_confirmation', 'uploading',
      'submitting', 'generating', 'downloading', 'verifying', 'paused', 'failed',
      'needs_manual_intervention',
    ].includes(task.status)
  })
  const folderStatusLabel = (status: string) =>
    t(`tasks.folderStatus.${status}`) === `tasks.folderStatus.${status}` ? status : t(`tasks.folderStatus.${status}`)

  return (
    <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ fontSize: '20px', fontWeight: '600', margin: 0 }}>{t('nav.tasks')}</h2>
        <button
          onClick={loadFolders}
          style={{ padding: '6px 12px', border: '1px solid #d1d5db', borderRadius: '6px', background: '#fff', cursor: 'pointer' }}
        >
          {t('btn.refresh')}
        </button>
      </div>

      <form onSubmit={handleCreate} style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          style={{ padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '6px', minWidth: '180px' }}
        >
          <option value="">{t('tasks.createPlaceholderProject')}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{t('tasks.projectHeader')} #{p.id} {p.name}</option>
          ))}
        </select>
        <select
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          title={t('tasks.autoAccountTitle')}
          style={{ padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '6px', minWidth: '180px' }}
        >
          <option value="">{t('tasks.createPlaceholderAccount')}</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{t('tasks.accountHeader')} #{a.id} {a.name}{a.verified_images != null ? `（${a.verified_images}）` : ''}</option>
          ))}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#374151' }}>
          {t('tasks.rounds')}
          <input
            type="number"
            min={1}
            max={999}
            value={rounds}
            onChange={(e) => setRounds(e.target.value)}
            style={{ width: '72px', padding: '8px', border: '1px solid #d1d5db', borderRadius: '6px' }}
          />
        </label>
        <button
          type="submit"
          disabled={loading}
          style={{ padding: '8px 16px', background: '#166534', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
        >
          {t('tasks.createTask')}
        </button>
      </form>
      <p style={{ fontSize: '12px', color: '#9ca3af', margin: '-12px 0 0' }}>
        {t('tasks.createHint')}
      </p>
      <p style={{ fontSize: '12px', color: '#9ca3af', margin: '-12px 0 0' }}>
        {t('tasks.folderHint')} {t('workspace.allTasksHint')}
      </p>

      <div style={{ background: '#fff', border: '1px solid #e5e5e5', borderRadius: '12px', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '12px' }}>{t('tasks.idHeader')}</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>{t('tasks.folderHeader')}</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>{t('tasks.statusHeader')}</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>{t('tasks.projectHeader')}</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>{t('tasks.progressHeader')}</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>{t('tasks.imageHeader')}</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>{t('tasks.updatedHeader')}</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>{t('tasks.actionsHeader')}</th>
            </tr>
          </thead>
          <tbody>
            {visibleFolders.map((folder) => {
              const task = taskFor(folder)
              const projectName = projects.find((p) => p.id === folder.project_id)?.name ?? String(folder.project_id ?? '-')
              return (
                <tr
                  key={folder.folder}
                  style={{ borderBottom: '1px solid #e5e5e5', cursor: 'pointer' }}
                  onClick={() => onFolderSelect({ projectId: folder.project_id!, folder: folder.folder, taskId: folder.task_id })}
                >
                  <td style={{ padding: '10px', fontSize: '13px', color: '#6b7280' }}>{folder.task_id ?? '-'}</td>
                  <td style={{ padding: '10px', fontSize: '13px', fontWeight: '500' }}>{folder.folder}</td>
                  <td style={{ padding: '10px' }}>
                    <span
                      style={{
                        display: 'inline-block', padding: '2px 8px', borderRadius: '10px', fontSize: '11px',
                        fontWeight: 500, color: '#fff', backgroundColor: FOLDER_STATUS_COLORS[folder.status] || '#6b7280',
                      }}
                    >
                      {folderStatusLabel(folder.status)}
                    </span>
                    {task?.status === 'needs_manual_intervention' && task.interrupted_status && (
                      <span style={{ marginLeft: '6px', fontSize: '11px', color: '#9ca3af' }}>
                        {t('tasks.lastRun')}: {CONFIRM_NODE_LABELS[task.interrupted_status] || STATUS_LABELS[task.interrupted_status] || task.interrupted_status}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '10px', fontSize: '13px', color: '#6b7280' }}>{projectName}</td>
                  <td style={{ padding: '10px', fontSize: '13px', color: '#6b7280' }}>{folder.round_count}/{folder.total_rounds}</td>
                  <td style={{ padding: '10px', fontSize: '13px', color: '#6b7280' }}>{folder.image_count}</td>
                  <td style={{ padding: '10px', fontSize: '12px', color: '#6b7280' }}>{folder.updated_at ? formatDateTime(folder.updated_at) : '-'}</td>
                  <td style={{ padding: '10px' }}>
                    <button
                      onClick={(e) => { e.stopPropagation(); taskFolderOpen(folder.project_id!, folder.folder).catch((err) => notify(err)) }}
                      style={{ background: '#f3f4f6', color: '#374151', border: 'none', padding: '6px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', marginRight: '4px' }}
                    >
                      {t('tasks.folderOpen')}
                    </button>
                    {task?.status === 'pending' && (
                      <button onClick={(e) => { e.stopPropagation(); handleStart(task.id!) }} style={{ background: '#166534', color: '#fff', border: 'none', padding: '6px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', marginRight: '4px' }}>
                        {t('btn.start')}
                      </button>
                    )}
                    {task && ACTIVE_STATUSES.includes(task.status) && task.status !== 'waiting_confirmation' && (
                      <button onClick={(e) => { e.stopPropagation(); handleAction(task.id!, taskPause) }} style={{ background: '#ca8a04', color: '#fff', border: 'none', padding: '6px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', marginRight: '4px' }}>
                        {t('btn.pause')}
                      </button>
                    )}
                    {task && ['needs_manual_intervention', 'failed', 'waiting_confirmation'].includes(task.status) && (
                      <button onClick={(e) => { e.stopPropagation(); handleAction(task.id!, taskContinue) }} style={{ background: '#166534', color: '#fff', border: 'none', padding: '6px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', marginRight: '4px' }}>
                        {t('btn.continueExecution')}
                      </button>
                    )}
                    {task?.status === 'paused' && (
                      <button onClick={(e) => { e.stopPropagation(); handleAction(task.id!, taskResume) }} style={{ background: '#166534', color: '#fff', border: 'none', padding: '6px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', marginRight: '4px' }}>
                        {t('btn.continue')}
                      </button>
                    )}
                    {task && CANCELLABLE_STATUSES.includes(task.status) && (
                      <button onClick={(e) => { e.stopPropagation(); handleAction(task.id!, taskCancel) }} style={{ background: '#dc2626', color: '#fff', border: 'none', padding: '6px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>
                        {t('btn.cancel')}
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
            {visibleFolders.length === 0 && (
              <tr>
                <td colSpan={8} style={{ padding: '24px', textAlign: 'center', color: '#9ca3af' }}>
                  {t('tasks.noTasks')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ background: '#1e1e1e', border: '1px solid #333', borderRadius: '12px', overflow: 'hidden', flex: 1, minHeight: '300px' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: '14px', fontWeight: '600', color: '#e5e7eb' }}>{t('tasks.logsTitle')}</div>
          <button
            onClick={() => setLogs([])}
            style={{ padding: '4px 8px', border: '1px solid #4b5563', borderRadius: '4px', background: 'transparent', color: '#9ca3af', cursor: 'pointer', fontSize: '12px' }}
          >
            {t('btn.clear')}
          </button>
        </div>
        <div style={{ padding: '12px 16px', overflowY: 'auto', fontFamily: 'monospace', fontSize: '12px', lineHeight: '1.5', color: '#d1d5db', background: '#0f0f0f' }}>
          {logs.length > 0 ? (
            logs.map((log, i) => <div key={i} style={{ marginBottom: '4px', whiteSpace: 'pre-wrap' }}>{log}</div>)
          ) : (
            <div style={{ color: '#6b7280', paddingTop: '20px' }}>{t('logs.none')}</div>
          )}
        </div>
      </div>
    </div>
  )
}
