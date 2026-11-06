import { useState, useEffect } from 'react'
import { settingsGet, settingsSet } from '@/hooks/api'
import { useI18n } from '@/i18n'
import { check, type Update } from '@tauri-apps/plugin-updater'

export default function SettingsPage() {
  const { lang, setLang } = useI18n()
  const [projectRoot, setProjectRoot] = useState('')
  const [maxRetries, setMaxRetries] = useState('3')
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [update, setUpdate] = useState<Update | null>(null)

  async function load() {
    const v = await settingsGet('project_root')
    if (v) setProjectRoot(v)
    const m = await settingsGet('max_retries')
    if (m) setMaxRetries(m)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function checkForUpdates() {
    setChecking(true)
    try {
      const u = await check()
      setUpdate(u)
      if (u) {
        alert(`发现新版本 ${u.version}${u.body ? '\n\n' + u.body : ''}`)
      } else {
        alert('当前已是最新版本')
      }
    } catch (e) {
      alert('检查更新失败（若未配置更新源，这是预期结果）: ' + String(e))
    } finally {
      setChecking(false)
    }
  }

  async function downloadAndInstall() {
    if (!update) {
      alert('请先点击“检查更新”')
      return
    }
    setInstalling(true)
    try {
      await update.downloadAndInstall()
      alert('更新已安装，请重启应用')
    } catch (e) {
      alert('下载或安装失败: ' + String(e))
    } finally {
      setInstalling(false)
    }
  }

  async function saveKey(key: string, getVal: () => string, setVal: (v: string) => void) {
    try {
      await settingsSet(key, getVal())
      setVal(getVal())
      alert('保存成功')
    } catch (e) {
      alert('保存失败: ' + e)
    }
  }

  return (
    <div style={{ padding: '24px' }}>
      <h2 style={{ fontSize: '20px', fontWeight: '600', marginBottom: '24px' }}>设置</h2>
      <div style={{ background: '#fff', border: '1px solid #e5e5e5', borderRadius: '12px', padding: '24px' }}>
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '13px', color: '#6b7280', marginBottom: '6px' }}>项目根目录</label>
          <input
            value={projectRoot}
            onChange={(e) => setProjectRoot(e.target.value)}
            style={{ width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '6px' }}
          />
        </div>
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '13px', color: '#6b7280', marginBottom: '6px' }}>最大重试次数</label>
          <input
            type="number"
            value={maxRetries}
            onChange={(e) => setMaxRetries(e.target.value)}
            style={{ width: '120px', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '6px' }}
          />
        </div>
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '13px', color: '#6b7280', marginBottom: '6px' }}>界面语言</label>
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value as any)}
            style={{ padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '6px' }}
          >
            <option value="zh-CN">中文</option>
            <option value="en-US">English</option>
          </select>
        </div>
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '13px', color: '#6b7280', marginBottom: '6px' }}>启用通知</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              id='notify'
              type='checkbox'
              style={{ width: '18px', height: '18px', cursor: 'pointer' }}
            />
            <label htmlFor='notify' style={{ fontSize: '13px', color: '#1a1a1a', cursor: 'pointer' }}>
              启用任务状态变更通知
            </label>
          </div>
        </div>
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '13px', color: '#6b7280', marginBottom: '6px' }}>软件更新</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              onClick={checkForUpdates}
              disabled={checking}
              style={{ padding: '8px 16px', background: '#166534', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
            >
              {checking ? '检查中…' : '检查更新'}
            </button>
            <button
              onClick={downloadAndInstall}
              disabled={installing || !update}
              style={{ padding: '8px 16px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: '6px', cursor: installing || !update ? 'not-allowed' : 'pointer', opacity: installing || !update ? 0.6 : 1 }}
            >
              {installing ? '安装中…' : '下载并安装'}
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button
            onClick={() => saveKey('project_root', () => projectRoot, setProjectRoot)}
            style={{ padding: '8px 16px', background: '#166534', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
          >
            保存项目根目录
          </button>
          <button
            onClick={() => saveKey('max_retries', () => maxRetries, setMaxRetries)}
            style={{ padding: '8px 16px', background: '#166534', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
          >
            保存重试次数
          </button>
        </div>
      </div>
    </div>
  )
}
