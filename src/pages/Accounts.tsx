import { useState, useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { accountList, accountAdd, accountDelete, accountOpenLogin, accountReorder, accountThresholdSet, type Account } from '@/hooks/api'
import { useI18n } from '@/i18n'
import { formatDateTime } from '@/utils/datetime'

const smallBtn: React.CSSProperties = {
  background: '#f3f4f6',
  color: '#374151',
  border: '1px solid #d1d5db',
  padding: '6px 12px',
  borderRadius: '4px',
  cursor: 'pointer',
  fontSize: '12px',
  marginRight: '6px',
}

function fmtTime(value?: string): string {
  return formatDateTime(value) || '—'
}

export default function AccountsPage() {
  const { t } = useI18n()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [draggingId, setDraggingId] = useState<number | null>(null)

  const STATUS_LABEL: Record<string, string> = {
    unknown: t('accounts.unknown'),
    login_pending: t('accounts.loginPending'),
    logged_in: t('accounts.loggedIn'),
  }

  useEffect(() => {
    load()
    // 监听后端识别到登录的事件，自动刷新账号列表
    const unlistenPromise = listen('login-detected', () => {
      load()
    })
    // 兜底：每 5 秒自动刷新账号列表（数量很小，开销可忽略）
    const timer = setInterval(async () => {
      try {
        const data = await accountList()
        setAccounts(data)
      } catch { /* 忽略轮询失败 */ }
    }, 5000)
    return () => {
      clearInterval(timer)
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {})
    }
  }, [])

  async function load() {
    setLoading(true)
    try {
      const data = await accountList()
      setAccounts(data)
    } catch (e) {
      alert(t('accounts.loadFailed') + e)
    } finally {
      setLoading(false)
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) {
      alert(t('accounts.nameEmpty'))
      return
    }
    setLoading(true)
    try {
      const a = await accountAdd(name.trim())
      setAccounts([...accounts, a])
      setName('')
    } catch (e) {
      alert(t('accounts.createFailed') + e)
    } finally {
      setLoading(false)
    }
  }

  async function handleLogin(id: number) {
    try {
      await accountOpenLogin(id)
      await load()
    } catch (e) {
      alert(t('accounts.loginFailed') + e)
    }
  }

  async function handleDelete(id: number) {
    if (!window.confirm(t('accounts.deleteConfirm'))) return
    try {
      await accountDelete(id)
      setAccounts(accounts.filter((a) => a.id !== id))
    } catch (e) {
      alert(t('accounts.deleteFailed') + e)
    }
  }

  async function handleThresholdChange(account: Account, e: React.FocusEvent<HTMLInputElement>) {
    const raw = Number(e.target.value)
    const value = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
    e.target.value = String(value)
    if (value === (account.image_threshold ?? 0)) return
    try {
      await accountThresholdSet(account.id!, value)
      setAccounts(accounts.map((a) => (a.id === account.id ? { ...a, image_threshold: value } : a)))
    } catch (e2) {
      alert(t('accounts.thresholdFailed') + e2)
    }
  }

  function handleDrop(target: Account) {
    if (draggingId === null || draggingId === target.id) {
      setDraggingId(null)
      return
    }
    const from = accounts.findIndex((a) => a.id === draggingId)
    const to = accounts.findIndex((a) => a.id === target.id)
    if (from < 0 || to < 0) {
      setDraggingId(null)
      return
    }
    const reordered = [...accounts]
    const [moved] = reordered.splice(from, 1)
    reordered.splice(to, 0, moved)
    setAccounts(reordered)
    setDraggingId(null)
    accountReorder(reordered.map((a) => a.id!)).catch((e) => {
      alert(t('accounts.orderFailed') + e)
      load()
    })
  }

  return (
    <div style={{ padding: '24px' }}>
      <h2 style={{ fontSize: '20px', fontWeight: '600', marginBottom: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {t('nav.accounts')}
        <button onClick={load} style={{ fontSize: '12px', padding: '6px 12px', border: '1px solid #d1d5db', background: '#fff', borderRadius: '6px', cursor: 'pointer', fontWeight: '400' }}>{t('accounts.refresh')}</button>
      </h2>
      <form onSubmit={handleCreate} style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <input
          placeholder={t('accounts.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '6px', flex: 1, minWidth: '200px' }}
        />
        <button
          type="submit"
          disabled={loading}
          style={{ padding: '8px 16px', background: '#166534', color: '#fff', border: 'none', borderRadius: '6px', cursor: loading ? 'not-allowed' : 'pointer' }}
        >
          {loading ? t('btn.create') + '...' : t('btn.create')}
        </button>
      </form>
      <p style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '12px' }}>
        {t('accounts.note')}
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff', borderRadius: '8px', overflow: 'hidden' }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              <th style={{ padding: '12px 8px', textAlign: 'left', color: '#6b7280', fontSize: '13px', width: '56px' }}>{t('accounts.order')}</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>{t('accounts.nameCol')}</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>{t('accounts.status')}</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>{t('accounts.verifiedImages')}</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>{t('accounts.completedRounds')}</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>{t('accounts.threshold')}</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>{t('accounts.lastUsed')}</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>{t('accounts.operations')}</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => {
              const overThreshold = (a.image_threshold ?? 0) > 0 && (a.verified_images ?? 0) >= (a.image_threshold ?? 0)
              return (
                <tr
                  key={a.id}
                  draggable
                  onDragStart={(e) => {
                    setDraggingId(a.id!)
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', String(a.id))
                  }}
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    handleDrop(a)
                  }}
                  onDragEnd={() => setDraggingId(null)}
                  style={{
                    borderBottom: '1px solid #e5e5e5',
                    background: draggingId === a.id ? '#eef2ff' : undefined,
                    cursor: 'grab',
                  }}
                >
                  <td style={{ padding: '12px 8px', fontSize: '16px', color: '#9ca3af', textAlign: 'center', userSelect: 'none' }}>⠿</td>
                  <td style={{ padding: '12px', fontSize: '13px', fontWeight: '500' }}>
                    {a.name}
                    {overThreshold && (
                      <span style={{ marginLeft: '6px', fontSize: '11px', background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d', borderRadius: '4px', padding: '2px 6px' }}>
                        {t('accounts.overThreshold')}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '12px', fontSize: '13px', color: '#6b7280' }}>{STATUS_LABEL[a.status] ?? a.status}</td>
                  <td style={{ padding: '12px', fontSize: '13px', color: '#374151' }}>{a.verified_images ?? 0}</td>
                  <td style={{ padding: '12px', fontSize: '13px', color: '#374151' }}>{a.completed_rounds ?? 0}</td>
                  <td style={{ padding: '12px' }}>
                    <input
                      key={`${a.id}-${a.image_threshold ?? 0}`}
                      type="number"
                      min={0}
                      defaultValue={a.image_threshold ?? 0}
                      title={t('accounts.threshold')}
                      onBlur={(e) => handleThresholdChange(a, e)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur()
                      }}
                      style={{ width: '88px', padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '12px' }}
                    />
                  </td>
                  <td style={{ padding: '12px', fontSize: '12px', color: '#6b7280', whiteSpace: 'nowrap' }}>{fmtTime(a.last_used_at)}</td>
                  <td style={{ padding: '12px', whiteSpace: 'nowrap' }}>
                    <button
                      onClick={() => handleLogin(a.id!)}
                      style={{ ...smallBtn, background: '#166534', color: '#fff', border: '1px solid #166534' }}
                    >
                      {t('accounts.openLogin')}
                    </button>
                    <button
                      onClick={() => handleDelete(a.id!)}
                      style={{ ...smallBtn, background: '#dc2626', color: '#fff', border: '1px solid #dc2626', marginRight: 0 }}
                    >
                      {t('btn.delete')}
                    </button>
                  </td>
                </tr>
              )
            })}
            {accounts.length === 0 && (
              <tr>
                <td colSpan={8} style={{ padding: '24px', textAlign: 'center', color: '#9ca3af' }}>
                  {t('common.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
