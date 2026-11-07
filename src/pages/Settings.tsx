import { useState, useEffect } from 'react'
import { settingsGet, settingsSet } from '@/hooks/api'
import { useI18n } from '@/i18n'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification'

export default function SettingsPage() {
  const { lang, setLang } = useI18n()
  const [projectRoot, setProjectRoot] = useState('')
  const [maxRetries, setMaxRetries] = useState('3')
  const [confirmSelection, setConfirmSelection] = useState(false)
  const [confirmBeforeSubmit, setConfirmBeforeSubmit] = useState(false)
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [update, setUpdate] = useState<Update | null>(null)
  const [notifyEnabled, setNotifyEnabled] = useState(false)

  async function load() {
    const v = await settingsGet('project_root')
    if (v) setProjectRoot(v)
    const m = await settingsGet('max_retries')
    if (m) setMaxRetries(String(Math.max(0, Math.min(10, Number(m) || 3))))
    const cs = await settingsGet('confirm_selection')
    setConfirmSelection(cs === 'true')
    const cb = await settingsGet('confirm_before_submit')
    setConfirmBeforeSubmit(cb === 'true')
    const ne = await settingsGet('notify_enabled')
    setNotifyEnabled(ne === 'true')
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

  async function toggleSetting(key: string, value: boolean, setVal: (v: boolean) => void) {
    try {
      await settingsSet(key, value ? 'true' : 'false')
      setVal(value)
    } catch (e) {
      alert('保存失败: ' + e)
    }
  }

  async function toggleNotify(value: boolean) {
    if (!value) {
      try {
        await settingsSet('notify_enabled', 'false')
        setNotifyEnabled(false)
      } catch (e) {
        alert('保存失败: ' + e)
      }
      return
    }
    try {
      let granted = await isPermissionGranted()
      if (!granted) {
        const result = await requestPermission()
        granted = result === 'granted'
      }
      if (!granted) {
        alert('系统通知权限未授予，已开启软件内通知（不发送系统通知）')
      }
      await settingsSet('notify_enabled', 'true')
      setNotifyEnabled(true)
    } catch (e) {
      alert('启用通知失败: ' + e)
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
              checked={notifyEnabled}
              onChange={(e) => toggleNotify(e.target.checked)}
              style={{ width: '18px', height: '18px', cursor: 'pointer' }}
            />
            <label htmlFor='notify' style={{ fontSize: '13px', color: '#1a1a1a', cursor: 'pointer' }}>
              启用任务状态变更通知（任务开始/完成/失败/需人工处理/阈值/最大重试）
            </label>
          </div>
        </div>
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '13px', color: '#6b7280', marginBottom: '6px' }}>人工确认模式</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' }}>
              <input
                type='checkbox'
                checked={confirmSelection}
                onChange={(e) => toggleSetting('confirm_selection', e.target.checked, setConfirmSelection)}
                style={{ width: '18px', height: '18px', cursor: 'pointer' }}
              />
              抽图后暂停，确认参考图后再上传
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' }}>
              <input
                type='checkbox'
                checked={confirmBeforeSubmit}
                onChange={(e) => toggleSetting('confirm_before_submit', e.target.checked, setConfirmBeforeSubmit)}
                style={{ width: '18px', height: '18px', cursor: 'pointer' }}
              />
              上传参考图并填写提示词后暂停，确认后再提交
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
