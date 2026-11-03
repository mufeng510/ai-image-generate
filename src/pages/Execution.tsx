/**
 * src/pages/Execution.tsx
 *
 * 任务执行页面：任务队列管理与实时执行日志。
 * 通过 Tauri Commands 操作任务，通过 Tauri Events 接收实时状态推送。
 */

import { useState, useEffect, useCallback } from 'react'
import { useI18n } from '@/i18n'
import {
  taskList,
  taskCreate,
  taskStart,
  taskPause,
  taskResume,
  taskCancel,
  taskDetail,
  taskListRounds,
  taskListImages,
  type Task,
} from '@/hooks/api'
import { listen } from '@tauri-apps/api/event'

const STATUS_LABELS: Record<string, string> = {
  pending: '待处理',
  preparing: '准备中',
  selecting_images: '抽图中',
  waiting_confirmation: '等待确认',
  uploading: '上传中',
  submitting: '提交中',
  generating: '生成中',
  downloading: '下载中',
  verifying: '校验中',
  completed: '已完成',
  paused: '已暂停',
  failed: '失败',
  cancelled: '已取消',
  needs_manual_intervention: '需人工干预',
}

const STATUS_COLORS: Record<string, string> = {
  pending: '#6b7280',
  preparing: '#6b7280',
  selecting_images: '#6b7280',
  waiting_confirmation: '#d97706',
  uploading: '#2563eb',
  submitting: '#2563eb',
  generating: '#2563eb',
  downloading: '#2563eb',
  verifying: '#2563eb',
  completed: '#16a34a',
  paused: '#ea580c',
  failed: '#dc2626',
  cancelled: '#6b7280',
  needs_manual_intervention: '#dc2626',
}

export default function ExecutionPage({ onTaskSelect }: { onTaskSelect: (id: number) => void }) {
  const { t } = useI18n()
  const [tasks, setTasks] = useState<Task[]>([])
  const [logs, setLogs] = useState<string[]>([])
  const [loading, setLoading] = useState(false)

  const loadTasks = useCallback(async () => {
    setLoading(true)
    try {
      const data = await taskList()
      setTasks(data)
    } catch (e) {
      console.error('加载任务失败:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadTasks()

    ;(async () => {
      const unlistenStatus = await listen<{ task_id: number; status: string }>(
        'task-status-changed',
        (event) => {
          const { task_id, status } = event.payload
          setTasks((prev) =>
            prev.map((t) => (t.id === task_id ? { ...t, status } : t))
          )
          addLog(`任务 #${task_id} 状态变更: ${status}`)
        }
      )

      const unlistenComplete = await listen<{ task_id: number }>(
        'task-completed',
        (event) => {
          const { task_id } = event.payload
          setTasks((prev) =>
            prev.map((t) => (t.id === task_id ? { ...t, status: 'completed' } : t))
          )
          addLog(`任务 #${task_id} 已完成`)
        }
      )

      const unlistenLog = await listen<{ level: string; message: string }>(
        'sidecar-log',
        (event) => {
          const { level, message } = event.payload
          addLog(`[${level}] ${message}`)
        }
      )

      return () => {
        unlistenStatus.then((u) => u())
        unlistenComplete.then((u) => u())
        unlistenLog.then((u) => u())
      }
    })()
  }, [loadTasks])

  const addLog = (message: string) => {
    const time = new Date().toLocaleTimeString()
    setLogs((prev) => [`[${time}] ${message}`, ...prev].slice(0, 100))
  }

  const handleStart = async (id: number) => {
    try {
      await taskStart({ task_id: id })
      await loadTasks()
    } catch (e) {
      alert('启动失败: ' + e)
    }
  }

  const handleAction = async (id: number, fn: (id: number) => Promise<void>) => {
    try {
      await fn(id)
      await loadTasks()
    } catch (e) {
      alert('操作失败: ' + e)
    }
  }

  return (
    <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ fontSize: '20px', fontWeight: '600', margin: 0 }}>{t('nav.tasks')}</h2>
        <button
          onClick={loadTasks}
          style={{ padding: '6px 12px', border: '1px solid #d1d5db', borderRadius: '6px', background: '#fff', cursor: 'pointer' }}
        >
          刷新
        </button>
      </div>

      <div style={{ background: '#fff', border: '1px solid #e5e5e5', borderRadius: '12px', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '12px' }}>ID</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>任务名称</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>状态</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>项目</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>账号</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>进度</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.id} style={{ borderBottom: '1px solid #e5e5e5', cursor: 'pointer' }} onClick={() => onTaskSelect(task.id!)}>
                <td style={{ padding: '10px', fontSize: '13px', color: '#6b7280' }}>{task.id}</td>
                <td style={{ padding: '10px', fontSize: '13px', fontWeight: '500' }}>{task.name}</td>
                <td style={{ padding: '10px' }}>
                  <span
                    style={{
                      display: 'inline-block',
                      padding: '2px 8px',
                      borderRadius: '10px',
                      fontSize: '11px',
                      fontWeight: '500',
                      color: '#fff',
                      backgroundColor: STATUS_COLORS[task.status] || '#6b7280',
                    }}
                  >
                    {STATUS_LABELS[task.status] || task.status}
                  </span>
                </td>
                <td style={{ padding: '10px', fontSize: '13px', color: '#6b7280' }}>{String(task.project_id ?? '-')}</td>
                <td style={{ padding: '10px', fontSize: '13px', color: '#6b7280' }}>{String(task.account_id ?? '-')}</td>
                <td style={{ padding: '10px', fontSize: '13px', color: '#6b7280' }}>
                  {task.current_round ?? 0}/{task.total_rounds ?? 0}
                </td>
                <td style={{ padding: '10px' }}>
                  {task.status === 'pending' && (
                    <button
                      onClick={() => handleStart(task.id!)}
                      style={{ background: '#166534', color: '#fff', border: 'none', padding: '6px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', marginRight: '4px' }}
                    >
                      {t('btn.start')}
                    </button>
                  )}
                  {task.status === 'preparing' && (
                    <button
                      onClick={() => handleAction(task.id!, taskPause)}
                      style={{ background: '#ca8a04', color: '#fff', border: 'none', padding: '6px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', marginRight: '4px' }}
                    >
                      {t('btn.pause')}
                    </button>
                  )}
                  {task.status === 'paused' && (
                    <button
                      onClick={() => handleAction(task.id!, taskResume)}
                      style={{ background: '#166534', color: '#fff', border: 'none', padding: '6px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', marginRight: '4px' }}
                    >
                      {t('btn.continue')}
                    </button>
                  )}
                  {['pending', 'preparing', 'paused'].includes(task.status) && (
                    <button
                      onClick={() => handleAction(task.id!, taskCancel)}
                      style={{ background: '#dc2626', color: '#fff', border: 'none', padding: '6px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
                    >
                      {t('btn.cancel')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {tasks.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: '24px', textAlign: 'center', color: '#9ca3af' }}>
                  暂无任务
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ background: '#1e1e1e', border: '1px solid #333', borderRadius: '12px', overflow: 'hidden', flex: 1, minHeight: '300px' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: '14px', fontWeight: '600', color: '#e5e7eb' }}>执行日志</div>
          <button
            onClick={() => setLogs([])}
            style={{ padding: '4px 8px', border: '1px solid #4b5563', borderRadius: '4px', background: 'transparent', color: '#9ca3af', cursor: 'pointer', fontSize: '12px' }}
          >
            清空
          </button>
        </div>
        <div style={{ padding: '12px 16px', overflowY: 'auto', fontFamily: 'monospace', fontSize: '12px', lineHeight: '1.5', color: '#d1d5db', background: '#0f0f0f' }}>
          {logs.length > 0 ? (
            logs.map((log, i) => (
              <div key={i} style={{ marginBottom: '4px', whiteSpace: 'pre-wrap' }}>
                {log}
              </div>
            ))
          ) : (
            <div style={{ color: '#6b7280', paddingTop: '20px' }}>暂无日志</div>
          )}
        </div>
      </div>
    </div>
  )
}
