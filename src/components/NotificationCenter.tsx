import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { isPermissionGranted, sendNotification } from '@tauri-apps/plugin-notification'
import {
  notificationList,
  notificationCreate,
  notificationMarkRead,
  notificationMarkAllRead,
  notificationClear,
  settingsGet,
  type Notification,
} from '@/hooks/api'

const LEVEL_DOT: Record<string, string> = {
  info: '#2563eb',
  success: '#16a34a',
  warn: '#d97706',
  error: '#dc2626',
}

interface Toast {
  id: number
  title: string
  message: string
  level: string
  taskId?: number
}

interface Props {
  onOpenTask?: (taskId: number) => void
}

function fmtTime(value?: string): string {
  if (!value) return ''
  return value.replace('T', ' ').slice(0, 16)
}

export default function NotificationCenter({ onOpenTask }: Props) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Notification[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])

  const unread = items.filter((i) => !i.read).length

  async function refresh() {
    try {
      const list = await notificationList(30)
      setItems((prev) => {
        const seen = new Set<number>()
        const merged: Notification[] = []
        for (const item of [...list, ...prev]) {
          const id = item.id
          if (id == null || seen.has(id)) continue
          seen.add(id)
          merged.push(item)
        }
        // 按 id 倒序（id 单调递增，即创建时间倒序）
        return merged.sort((a, b) => (b.id ?? 0) - (a.id ?? 0))
      })
    } catch {
      /* 通知表读取失败时静默 */
    }
  }

  useEffect(() => {
    const unlisteners: Array<() => void> = []
    let cancelled = false

    async function notify(n: {
      kind: string
      title: string
      message: string
      level: string
      task_id?: number
    }) {
      try {
        const created = await notificationCreate(n.kind, n.title, n.message, n.level, n.task_id)
        if (cancelled) return
        const toast: Toast = {
          id: created.id ?? Date.now(),
          title: created.title,
          message: created.message,
          level: created.level,
          taskId: created.task_id,
        }
        setItems((prev) => [created, ...prev])
        setToasts((prev) => [...prev.slice(-2), toast])
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== toast.id))
        }, 6000)
        // 系统通知：用户开启了通知开关且系统已授予权限才发
        try {
          const enabled = await settingsGet('notify_enabled')
          if (enabled === 'true' && (await isPermissionGranted())) {
            sendNotification({ title: created.title, body: created.message })
          }
        } catch {
          /* 系统通知失败不影响软件内通知 */
        }
      } catch (e) {
        console.warn('[通知] 创建失败', e)
      }
    }

    const p = (e: unknown): Record<string, any> => (e && typeof e === 'object' ? (e as { payload?: Record<string, any> }).payload ?? {} : {})

    const subs = [
      listen('task-started', (e) => {
        const payload = p(e)
        notify({
          kind: 'task_started',
          title: '任务已开始',
          message: `任务 #${payload.task_id} 已开始执行`,
          level: 'info',
          task_id: payload.task_id,
        })
      }),
      listen('task-completed', (e) => {
        const payload = p(e)
        notify({
          kind: 'task_completed',
          title: '任务完成',
          message: `任务 #${payload.task_id} 已完成`,
          level: 'success',
          task_id: payload.task_id,
        })
      }),
      listen('task-status-changed', (e) => {
        const payload = p(e)
        const status = payload.status
        if (status === 'failed') {
          notify({
            kind: 'task_failed',
            title: '任务失败',
            message: `任务 #${payload.task_id} 执行失败，请查看执行日志`,
            level: 'error',
            task_id: payload.task_id,
          })
        } else if (status === 'needs_manual_intervention') {
          notify({
            kind: 'needs_manual_intervention',
            title: '需人工处理',
            message: `任务 #${payload.task_id} 需要手动处理，请查看任务队列`,
            level: 'warn',
            task_id: payload.task_id,
          })
        }
      }),
      listen('retry-exhausted', (e) => {
        const payload = p(e)
        notify({
          kind: 'retry_exhausted',
          title: '超过最大重试次数',
          message: `下载未完成，达到最大重试次数（阶段：${payload.stage ?? 'unknown'}），已暂停`,
          level: 'error',
          task_id: payload.task_id,
        })
      }),
      listen('account-threshold-reached', (e) => {
        const payload = p(e)
        notify({
          kind: 'account_threshold_reached',
          title: '账号已达自定义阈值',
          message: `账号 #${payload.account_id} 已达到用户设定的图片阈值，任务已暂停`,
          level: 'warn',
          task_id: payload.task_id,
        })
      }),
    ]
    Promise.all(subs).then((fns) => {
      if (cancelled) {
        fns.forEach((f) => f())
        return
      }
      unlisteners.push(...fns)
      // 先订阅再拉取列表，避免响应晚到时覆盖新通知
      refresh()
    })
    return () => {
      cancelled = true
      unlisteners.forEach((f) => f())
    }
  }, [])

  async function handleClear() {
    try {
      await notificationClear()
      setItems([])
    } catch (e) {
      alert('清空通知失败: ' + e)
    }
  }

  async function handleMarkAllRead() {
    try {
      await notificationMarkAllRead()
      setItems((prev) => prev.map((i) => ({ ...i, read: true })))
    } catch (e) {
      alert('标记已读失败: ' + e)
    }
  }

  async function handleItemClick(item: Notification) {
    try {
      if (!item.read) {
        await notificationMarkRead(item.id!)
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, read: true } : i)))
      }
    } catch {
      /* 标记失败不阻断跳转 */
    }
    if (item.task_id && onOpenTask) {
      setOpen(false)
      onOpenTask(item.task_id)
    }
  }

  return (
    <>
      {/* 通知铃铛（右上角悬浮按钮） */}
      <button
        onClick={() => setOpen((v) => !v)}
        title="通知中心"
        aria-label="通知中心"
        style={{
          position: 'fixed',
          top: '16px',
          right: '18px',
          zIndex: 45,
          width: '42px',
          height: '42px',
          borderRadius: '9999px',
          border: '1px solid #e5e5e5',
          background: '#fff',
          cursor: 'pointer',
          boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
          fontSize: '18px',
        }}
      >
        🔔
        {unread > 0 && (
          <span
            style={{
              position: 'absolute',
              top: '-4px',
              right: '-4px',
              minWidth: '20px',
              height: '20px',
              borderRadius: '10px',
              background: '#dc2626',
              color: '#fff',
              fontSize: '11px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0 5px',
            }}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {/* 通知面板 */}
      {open && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 44 }}
          onClick={() => setOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              top: '66px',
              right: '18px',
              width: 'min(380px, 92vw)',
              maxHeight: '70vh',
              background: '#fff',
              borderRadius: '12px',
              border: '1px solid #e5e5e5',
              boxShadow: '0 12px 32px rgba(0,0,0,0.16)',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '1px solid #f0f0f0' }}>
              <span style={{ fontSize: '14px', fontWeight: 600, color: '#111827' }}>通知中心</span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={handleMarkAllRead}
                  style={{ fontSize: '12px', padding: '4px 10px', border: '1px solid #d1d5db', borderRadius: '6px', background: '#fff', cursor: 'pointer', color: '#374151' }}
                >
                  全部已读
                </button>
                <button
                  onClick={handleClear}
                  style={{ fontSize: '12px', padding: '4px 10px', border: '1px solid #fecaca', borderRadius: '6px', background: '#fff', cursor: 'pointer', color: '#b91c1c' }}
                >
                  清空
                </button>
              </div>
            </div>
            <div style={{ overflowY: 'auto' }}>
              {items.length === 0 ? (
                <div style={{ padding: '24px', textAlign: 'center', fontSize: '12px', color: '#9ca3af' }}>暂无通知</div>
              ) : (
                items.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => handleItemClick(item)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '10px 14px',
                      background: item.read ? '#fff' : '#f8fafc',
                      border: 'none',
                      borderBottom: '1px solid #f5f5f5',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span
                        style={{
                          width: '8px',
                          height: '8px',
                          borderRadius: '9999px',
                          background: LEVEL_DOT[item.level] ?? '#6b7280',
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ fontSize: '13px', fontWeight: 600, color: '#111827' }}>{item.title}</span>
                      <span style={{ fontSize: '11px', color: '#9ca3af', marginLeft: 'auto' }}>{fmtTime(item.created_at)}</span>
                    </div>
                    <div style={{ fontSize: '12px', color: '#4b5563', margin: '4px 0 0 16px' }}>{item.message}</div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* 软件内气泡通知（右下角） */}
      <div style={{ position: 'fixed', right: '18px', bottom: '18px', zIndex: 46, display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="alert"
            onClick={() => toast.taskId && onOpenTask && onOpenTask(toast.taskId)}
            style={{
              width: '300px',
              background: '#111827',
              color: '#f9fafb',
              borderRadius: '10px',
              borderLeft: `4px solid ${LEVEL_DOT[toast.level] ?? '#6b7280'}`,
              padding: '10px 12px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
              cursor: toast.taskId ? 'pointer' : 'default',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '12px', fontWeight: 600 }}>{toast.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setToasts((prev) => prev.filter((t) => t.id !== toast.id))
                }}
                aria-label="关闭"
                style={{ background: 'transparent', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: '14px', lineHeight: 1 }}
              >
                ×
              </button>
            </div>
            <div style={{ fontSize: '12px', color: '#d1d5db', marginTop: '4px' }}>{toast.message}</div>
          </div>
        ))}
      </div>
    </>
  )
}
