import { useState } from 'react'
import { taskList, taskCreate, taskStart, taskPause, taskResume, taskCancel, type Task } from '@/hooks/api'
import { useI18n } from '@/i18n'

export default function TasksPage() {
  const { t } = useI18n()
  const [tasks, setTasks] = useState<Task[]>([])
  const [name, setName] = useState('')
  const [projectId, setProjectId] = useState('')
  const [accountId, setAccountId] = useState('')
  const [loading, setLoading] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const data = await taskList()
      setTasks(data)
    } catch (e) {
      alert('加载任务失败: ' + e)
    } finally {
      setLoading(false)
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !projectId || !accountId) return
    setLoading(true)
    try {
      const t = await taskCreate(name.trim(), Number(projectId), Number(accountId))
      setTasks([...tasks, t])
      setName('')
      setProjectId('')
      setAccountId('')
    } catch (e) {
      alert('创建失败: ' + e)
    } finally {
      setLoading(false)
    }
  }

  async function handleAction(id: number, fn: (id: number) => Promise<void>) {
    try {
      await fn(id)
      await load()
    } catch (e) {
      alert('操作失败: ' + e)
    }
  }

  return (
    <div style={{ padding: '24px' }}>
      <h2 style={{ fontSize: '20px', fontWeight: '600', marginBottom: '16px' }}>{t('nav.tasks')}</h2>
      <form onSubmit={handleCreate} style={{ display: 'flex', gap: '8px', marginBottom: '20px', flexWrap: 'wrap' }}>
        <input
          placeholder="任务名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '6px', flex: 1, minWidth: '160px' }}
        />
        <input
          placeholder="项目ID"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          style={{ padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '6px', width: '100px' }}
        />
        <input
          placeholder="账号ID"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          style={{ padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '6px', width: '100px' }}
        />
        <button
          type="submit"
          disabled={loading}
          style={{ padding: '8px 16px', background: '#166534', color: '#fff', border: 'none', borderRadius: '6px', cursor: loading ? 'not-allowed' : 'pointer' }}
        >
          {loading ? t('btn.create') + '...' : t('btn.create')}
        </button>
      </form>
      <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff', borderRadius: '8px', overflow: 'hidden' }}>
        <thead>
          <tr style={{ background: '#f9fafb' }}>
            <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>ID</th>
            <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>名称</th>
            <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>状态</th>
            <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>项目</th>
            <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>账号</th>
            <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id} style={{ borderBottom: '1px solid #e5e5e5' }}>
              <td style={{ padding: '12px', fontSize: '13px', color: '#6b7280' }}>{t.id}</td>
              <td style={{ padding: '12px', fontSize: '13px', fontWeight: '500' }}>{t.name}</td>
              <td style={{ padding: '12px', fontSize: '13px', color: '#6b7280' }}>{t.status}</td>
              <td style={{ padding: '12px', fontSize: '13px', color: '#6b7280' }}>{String(t.project_id ?? '-')}</td>
              <td style={{ padding: '12px', fontSize: '13px', color: '#6b7280' }}>{String(t.account_id ?? '-')}</td>
              <td style={{ padding: '12px' }}>
                {t.status === 'pending' && (
                  <button onClick={() => handleAction(t.id!, taskStart)} style={{ background: '#166534', color: '#fff', border: 'none', padding: '6px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', marginRight: '4px' }}>{t('btn.start')}</button>
                )}
                {t.status === 'preparing' && (
                  <button onClick={() => handleAction(t.id!, taskPause)} style={{ background: '#ca8a04', color: '#fff', border: 'none', padding: '6px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', marginRight: '4px' }}>{t('btn.pause')}</button>
                )}
                {t.status === 'paused' && (
                  <button onClick={() => handleAction(t.id!, taskResume)} style={{ background: '#166534', color: '#fff', border: 'none', padding: '6px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', marginRight: '4px' }}>{t('btn.continue')}</button>
                )}
                {['pending', 'preparing', 'paused'].includes(t.status) && (
                  <button onClick={() => handleAction(t.id!, taskCancel)} style={{ background: '#dc2626', color: '#fff', border: 'none', padding: '6px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>{t('btn.cancel')}</button>
                )}
              </td>
            </tr>
          ))}
          {tasks.length === 0 && (
            <tr>
              <td colSpan={6} style={{ padding: '24px', textAlign: 'center', color: '#9ca3af' }}>
                暂无任务
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
