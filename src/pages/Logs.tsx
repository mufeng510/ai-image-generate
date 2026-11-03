import { useState, useEffect } from 'react'
import { useI18n } from '@/i18n'
import { executionLogs } from '@/hooks/api'

export default function LogsPage() {
  const { t } = useI18n()
  const [logs, setLogs] = useState<{
    id?: number
    task_id?: number
    level: string
    message: string
    created_at?: string
  }[]>([])
  const [, setLoading] = useState(false)

  useEffect(() => {
    loadLogs()
  }, [])

  const loadLogs = async () => {
    setLoading(true)
    try {
      const data = await executionLogs(100)
      setLogs(data)
    } catch (e) {
      console.error('加载日志失败:', e)
    } finally {
      setLoading(false)
    }
  }

  const levelColor: Record<string, string> = {
    info: '#2563eb',
    warn: '#d97706',
    error: '#dc2626',
    debug: '#6b7280',
  }

  return (
    <div style={{ padding: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h2 style={{ fontSize: '20px', fontWeight: '600', margin: 0 }}>{t('nav.logs')}</h2>
        <button
          onClick={loadLogs}
          style={{ padding: '6px 12px', border: '1px solid #d1d5db', borderRadius: '6px', background: '#fff', cursor: 'pointer' }}
        >
          刷新
        </button>
      </div>
      <div style={{ background: '#fff', border: '1px solid #e5e5e5', borderRadius: '12px', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>时间</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>级别</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>任务 ID</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>消息</th>
            </tr>
          </thead>
          <tbody>
            {logs.length > 0 ? (
              logs.map((log) => (
                <tr key={log.id} style={{ borderBottom: '1px solid #e5e5e5' }}>
                  <td style={{ padding: '10px', fontSize: '13px', color: '#6b7280' }}>{log.created_at || '-'}</td>
                  <td style={{ padding: '10px' }}>
                    <span
                      style={{
                        display: 'inline-block',
                        padding: '2px 8px',
                        borderRadius: '10px',
                        fontSize: '11px',
                        fontWeight: '500',
                        color: '#fff',
                        backgroundColor: levelColor[log.level] || '#6b7280',
                      }}
                    >
                      {log.level.toUpperCase()}
                    </span>
                  </td>
                  <td style={{ padding: '10px', fontSize: '13px', color: '#6b7280' }}>{log.task_id ?? '-'}</td>
                  <td style={{ padding: '10px', fontSize: '13px', color: '#1a1a1a', whiteSpace: 'pre-wrap' }}>{log.message}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} style={{ padding: '24px', textAlign: 'center', color: '#9ca3af' }}>
                  暂无日志
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
