import { useState, useEffect } from 'react'
import { settingsGet, settingsSet } from '@/hooks/api'
import { useI18n } from '@/i18n'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification'
import { getVersion } from '@tauri-apps/api/app'

export default function SettingsPage() {
  const { t, lang, setLang } = useI18n()
  const [projectRoot, setProjectRoot] = useState('')
  const [maxRetries, setMaxRetries] = useState('3')
  const [confirmSelection, setConfirmSelection] = useState(false)
  const [confirmBeforeSubmit, setConfirmBeforeSubmit] = useState(false)
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [update, setUpdate] = useState<Update | null>(null)
  const [notifyEnabled, setNotifyEnabled] = useState(false)
  const [executionMode, setExecutionMode] = useState<'auto' | 'step'>('auto')
  const [version, setVersion] = useState('')

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
    const em = await settingsGet('execution_mode')
    setExecutionMode(em === 'step' ? 'step' : 'auto')
    getVersion().then(setVersion).catch(() => setVersion('unknown'))
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
        alert(`${t('settings.newVersion', { version: u.version })}${u.body ? '\n\n' + u.body : ''}`)
      } else {
        alert(t('settings.latestVersion'))
      }
    } catch (e) {
      alert(t('settings.updateFailed') + String(e))
    } finally {
      setChecking(false)
    }
  }

  async function downloadAndInstall() {
    if (!update) {
      alert(t('settings.beforeCheck'))
      return
    }
    setInstalling(true)
    try {
      await update.downloadAndInstall()
      alert(t('settings.installDone'))
    } catch (e) {
      alert(t('settings.downloadPromptFailed') + String(e))
    } finally {
      setInstalling(false)
    }
  }

  async function saveKey(key: string, getVal: () => string, setVal: (v: string) => void) {
    try {
      await settingsSet(key, getVal())
      setVal(getVal())
      alert(t('settings.saveSuccess'))
    } catch (e) {
      alert(t('settings.saveFailed') + e)
    }
  }

  async function toggleSetting(key: string, value: boolean, setVal: (v: boolean) => void) {
    try {
      await settingsSet(key, value ? 'true' : 'false')
      setVal(value)
    } catch (e) {
      alert(t('settings.saveFailed') + e)
    }
  }

  async function toggleNotify(value: boolean) {
    if (!value) {
      try {
        await settingsSet('notify_enabled', 'false')
        setNotifyEnabled(false)
      } catch (e) {
        alert(t('settings.saveFailed') + e)
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
        alert(t('settings.notifyPermissionDenied'))
      }
      await settingsSet('notify_enabled', 'true')
      setNotifyEnabled(true)
    } catch (e) {
      alert(t('settings.saveFailed') + e)
    }
  }

  return (
    <div style={{ padding: '24px' }}>
      <h2 style={{ fontSize: '20px', fontWeight: '600', marginBottom: '24px' }}>{t('nav.settings')}</h2>
      <div style={{ background: '#fff', border: '1px solid #e5e5e5', borderRadius: '12px', padding: '24px' }}>
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '13px', color: '#6b7280', marginBottom: '6px' }}>{t('settings.projectRoot')}</label>
          <input
            value={projectRoot}
            onChange={(e) => setProjectRoot(e.target.value)}
            style={{ width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '6px' }}
          />
        </div>
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '13px', color: '#6b7280', marginBottom: '6px' }}>{t('settings.maxRetries')}</label>
          <input
            type="number"
            value={maxRetries}
            onChange={(e) => setMaxRetries(e.target.value)}
            style={{ width: '120px', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '6px' }}
          />
        </div>
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '13px', color: '#6b7280', marginBottom: '6px' }}>{t('settings.language')}</label>
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value as any)}
            style={{ padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '6px' }}
          >
            <option value="zh-CN">{t('lang.zh')}</option>
            <option value="en-US">{t('lang.en')}</option>
          </select>
        </div>
        <div style={{ marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              id='notify'
              type='checkbox'
              checked={notifyEnabled}
              onChange={(e) => toggleNotify(e.target.checked)}
              style={{ width: '18px', height: '18px', cursor: 'pointer' }}
            />
            <label htmlFor='notify' style={{ fontSize: '13px', color: '#1a1a1a', cursor: 'pointer' }}>
              {t('settings.notify')}
            </label>
          </div>
        </div>
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '13px', color: '#6b7280', marginBottom: '6px' }}>{t('settings.confirmMode')}</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' }}>
              <input
                type='checkbox'
                checked={confirmSelection}
                onChange={(e) => toggleSetting('confirm_selection', e.target.checked, setConfirmSelection)}
                style={{ width: '18px', height: '18px', cursor: 'pointer' }}
              />
              {t('settings.confirmSelection')}
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' }}>
              <input
                type='checkbox'
                checked={confirmBeforeSubmit}
                onChange={(e) => toggleSetting('confirm_before_submit', e.target.checked, setConfirmBeforeSubmit)}
                style={{ width: '18px', height: '18px', cursor: 'pointer' }}
              />
              {t('settings.confirmBeforeSubmit')}
            </label>
          </div>
        </div>
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '13px', color: '#6b7280', marginBottom: '6px' }}>{t('settings.executionMode')}</label>
          <select
            value={executionMode}
            onChange={async (e) => {
              const next = e.target.value as 'auto' | 'step'
              setExecutionMode(next)
              try {
                await settingsSet('execution_mode', next)
              } catch (err) {
                alert(t('settings.saveFailed') + err)
              }
            }}
            style={{ padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '6px' }}
          >
            <option value="auto">{t('settings.executionAuto')}</option>
            <option value="step">{t('settings.executionStep')}</option>
          </select>
        </div>
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '13px', color: '#6b7280', marginBottom: '6px' }}>{t('settings.roundCountNote')}</label>
        </div>
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '13px', color: '#6b7280', marginBottom: '6px' }}>{t('settings.versionLabel')}</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '14px', color: '#1a1a1a', fontFamily: 'ui-monospace, monospace' }}>{version || '—'}</span>
          </div>
        </div>
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '13px', color: '#6b7280', marginBottom: '6px' }}>{t('settings.update')}</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              onClick={checkForUpdates}
              disabled={checking}
              style={{ padding: '8px 16px', background: '#166534', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
            >
              {checking ? t('settings.checking') : t('settings.checkUpdate')}
            </button>
            <button
              onClick={downloadAndInstall}
              disabled={installing || !update}
              style={{ padding: '8px 16px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: '6px', cursor: installing || !update ? 'not-allowed' : 'pointer', opacity: installing || !update ? 0.6 : 1 }}
            >
              {installing ? t('settings.installing') : t('settings.downloadInstall')}
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button
            onClick={() => saveKey('project_root', () => projectRoot, setProjectRoot)}
            style={{ padding: '8px 16px', background: '#166534', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
          >
            {t('settings.saveProjectRoot')}
          </button>
          <button
            onClick={() => saveKey('max_retries', () => maxRetries, setMaxRetries)}
            style={{ padding: '8px 16px', background: '#166534', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
          >
            {t('settings.saveMaxRetries')}
          </button>
        </div>
      </div>
    </div>
  )
}
