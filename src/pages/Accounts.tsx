import { useState, useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { accountList, accountAdd, accountDelete, accountOpenLogin, type Account } from '@/hooks/api'
import { useI18n } from '@/i18n'

const STATUS_LABEL: Record<string, string> = {
  unknown: '未知',
  login_pending: '等待登录…',
  logged_in: '已登录',
}

export default function AccountsPage() {
  const { t } = useI18n()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)

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
      alert('加载账号失败: ' + e)
    } finally {
      setLoading(false)
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) {
      alert('账号名称不能为空。请先在输入框输入账号名称（注意：如果豆包浏览器窗口获得了键盘焦点，输入内容会进入豆包页面，而不是此处）。')
      return
    }
    setLoading(true)
    try {
      const a = await accountAdd(name.trim())
      setAccounts([...accounts, a])
      setName('')
    } catch (e) {
      alert('创建失败: ' + e)
    } finally {
      setLoading(false)
    }
  }

  async function handleLogin(id: number) {
    try {
      await accountOpenLogin(id)
      await load()
    } catch (e) {
      alert('打开登录窗口失败: ' + e)
    }
  }

  async function handleDelete(id: number) {
    if (!window.confirm('确定删除？')) return
    try {
      await accountDelete(id)
      setAccounts(accounts.filter((a) => a.id !== id))
    } catch (e) {
      alert('删除失败: ' + e)
    }
  }

  return (
    <div style={{ padding: '24px' }}>
      <h2 style={{ fontSize: '20px', fontWeight: '600', marginBottom: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {t('nav.accounts')}
        <button onClick={load} style={{ fontSize: '12px', padding: '6px 12px', border: '1px solid #d1d5db', background: '#fff', borderRadius: '6px', cursor: 'pointer', fontWeight: '400' }}>刷新状态</button>
      </h2>
      <form onSubmit={handleCreate} style={{ display: 'flex', gap: '8px', marginBottom: '20px', flexWrap: 'wrap' }}>
        <input
          placeholder="账号名称"
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
      <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff', borderRadius: '8px', overflow: 'hidden' }}>
        <thead>
          <tr style={{ background: '#f9fafb' }}>
            <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>ID</th>
            <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>账号名称</th>
            <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>状态</th>
            <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.id} style={{ borderBottom: '1px solid #e5e5e5' }}>
              <td style={{ padding: '12px', fontSize: '13px', color: '#6b7280' }}>{a.id}</td>
              <td style={{ padding: '12px', fontSize: '13px', fontWeight: '500' }}>{a.name}</td>
              <td style={{ padding: '12px', fontSize: '13px', color: '#6b7280' }}>{STATUS_LABEL[a.status] ?? a.status}</td>
              <td style={{ padding: '12px' }}>
                <button
                  onClick={() => handleLogin(a.id!)}
                  style={{ background: '#166534', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', marginRight: '6px' }}
                >
                  打开登录窗口
                </button>
                <button
                  onClick={() => handleDelete(a.id!)}
                  style={{ background: '#dc2626', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
                >
                  {t('btn.delete')}
                </button>
              </td>
            </tr>
          ))}
          {accounts.length === 0 && (
            <tr>
              <td colSpan={4} style={{ padding: '24px', textAlign: 'center', color: '#9ca3af' }}>
                暂无账号
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
