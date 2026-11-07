import { useState, useEffect } from 'react'
import { useI18n } from '@/i18n'
import { logsQuery, logsExport, accountList, type Account, type LogEntry, type LogFilter } from '@/hooks/api'
import { save } from '@tauri-apps/plugin-dialog'

const LEVELS = ['info', 'warn', 'error', 'debug']

export default function LogsPage() {
  const { t } = useI18n()
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [taskId, setTaskId] = useState('')
  const [accountId, setAccountId] = useState('')
  const [level, setLevel] = useState('')
  const [fromTime, setFromTime] = useState('')
  const [toTime, setToTime] = useState('')
  const [accounts, setAccounts] = useState<Account[]>([])
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    accountList().then(setAccounts).catch(() => setAccounts([]))
  }, [])

  useEffect(() => {
    loadLogs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const buildFilter = (limit = 300): LogFilter | null => {
    const filter: LogFilter = { limit }
    const trimmedId = taskId.trim()
    if (trimmedId) {
      const n = Number(trimmedId)
      if (!Number.isInteger(n) || n <= 0) {
        alert(t('logs.needPositiveInt'))
        return null
      }
      filter.task_id = n
    }
    if (accountId) filter.account_id = Number(accountId)
    if (level) filter.level = level
    if (fromTime) filter.from = new Date(fromTime).toISOString()
    if (toTime) filter.to = new Date(toTime).toISOString()
    return filter
  }

  const loadLogs = async () => {
    const filter = buildFilter()
    if (!filter) return
    setLoading(true)
    try {
      const data = await logsQuery(filter)
      setLogs(data)
    } catch (e) {
      console.error(t('logs.loadFailed'), e)
      alert(t('logs.loadFailed') + e)
    } finally {
      setLoading(false)
    }
  }

  const resetFilters = () => {
    setTaskId('')
    setAccountId('')
    setLevel('')
    setFromTime('')
    setToTime('')
  }

  const exportCsv = async () => {
    // CSV 导出最多 5000 条（与后端钳制一致）
    const filter = buildFilter(5000)
    if (!filter) return
    setExporting(true)
    try {
      const path = await save({
        title: t('logs.exportCsv'),
        defaultPath: 'execution-logs.csv',
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      })
      if (!path) return
      const count = await logsExport(filter, path)
      alert(t('logs.exportSuccess', { count, path }))
    } catch (e) {
      alert(t('logs.exportFailed') + e)
    } finally {
      setExporting(false)
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', gap: '12px', flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: '20px', fontWeight: '600', margin: 0 }}>{t('nav.logs')}</h2>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={loadLogs}
            disabled={loading}
            style={{ padding: '6px 12px', border: '1px solid #d1d5db', borderRadius: '6px', background: '#fff', cursor: 'pointer' }}
          >
            {loading ? t('common.loading') : t('logs.filter')}
          </button>
          <button
            onClick={resetFilters}
            style={{ padding: '6px 12px', border: '1px solid #d1d5db', borderRadius: '6px', background: '#fff', cursor: 'pointer' }}
          >
            {t('logs.reset')}
          </button>
          <button
            onClick={exportCsv}
            disabled={exporting}
            style={{ padding: '6px 12px', border: '1px solid #d1d5db', borderRadius: '6px', background: '#166534', color: '#fff', borderColor: '#166534', cursor: 'pointer' }}
          >
            {exporting ? t('logs.exporting') : t('logs.exportCsv')}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
        <input
          placeholder={t('logs.taskIdPlaceholder')}
          value={taskId}
          onChange={(e) => setTaskId(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') loadLogs() }}
          style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: '6px', width: '110px' }}
        />
        <select
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: '6px' }}
        >
          <option value="">{t('logs.allAccounts')}</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}（#{a.id}）
            </option>
          ))}
        </select>
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: '6px' }}
        >
          <option value="">{t('logs.allLevels')}</option>
          {LEVELS.map((lv) => (
            <option key={lv} value={lv}>{lv.toUpperCase()}</option>
          ))}
        </select>
        <input
          type="datetime-local"
          value={fromTime}
          onChange={(e) => setFromTime(e.target.value)}
          title={t('logs.timeFrom')}
          style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: '6px' }}
        />
        <span style={{ alignSelf: 'center', color: '#9ca3af' }}>—</span>
        <input
          type="datetime-local"
          value={toTime}
          onChange={(e) => setToTime(e.target.value)}
          title={t('logs.timeTo')}
          style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: '6px' }}
        />
        <span style={{ alignSelf: 'center', fontSize: '12px', color: '#9ca3af' }}>{t('logs.exportLimit')}</span>
      </div>

      <div style={{ background: '#fff', border: '1px solid #e5e5e5', borderRadius: '12px', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>{t('logs.colTime')}</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>{t('logs.colLevel')}</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>{t('logs.colTask')}</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>{t('logs.colMessage')}</th>
            </tr>
          </thead>
          <tbody>
            {logs.length > 0 ? (
              logs.map((log) => (
                <tr key={log.id} style={{ borderBottom: '1px solid #e5e5e5' }}>
                  <td style={{ padding: '10px', fontSize: '13px', color: '#6b7280', whiteSpace: 'nowrap' }}>
                    {(log.created_at ?? '').replace('T', ' ').slice(0, 19)}
                  </td>
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
                  <td style={{ padding: '10px', fontSize: '12px', color: '#4b5563', whiteSpace: 'nowrap' }}>
                    {log.task_id ? `#${log.task_id}${log.task_name ? ` ${log.task_name}` : ''}` : '-'}
                  </td>
                  <td style={{ padding: '10px', fontSize: '13px', color: '#1a1a1a', whiteSpace: 'pre-wrap' }}>{log.message}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} style={{ padding: '24px', textAlign: 'center', color: '#9ca3af' }}>
                  {loading ? t('common.loading') : t('logs.none')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
