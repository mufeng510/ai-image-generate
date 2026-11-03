import { useState, useEffect } from 'react'
import { settingsGet, settingsSet } from '@/hooks/api'
import { useI18n } from '@/i18n'

export default function SettingsPage() {
  const { t, lang, setLang } = useI18n()
  const [projectRoot, setProjectRoot] = useState('')
  const [maxRetries, setMaxRetries] = useState('3')

  async function load() {
    const v = await settingsGet('project_root')
    if (v) setProjectRoot(v)
    const m = await settingsGet('max_retries')
    if (m) setMaxRetries(m)
  }

  async function checkForUpdates() {
    setChecking(true)
    try {
      alert('检查更新需要先配置 tauri.conf.json 的 updater.endpoints，并使用签名密钥构建安装包。')
    } catch (e) {
      alert('检查更新失败: ' + e.message)
    } finally {
      setChecking(false)
    }
  }

  async function downloadAndInstall() {
    alert('请先配置 tauri.conf.json 的 updater.endpoints 并构建签名安装包。')
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
              style={{ padding: '8px 16px', background: '#166534', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
            >
              检查更新
            </button>
            <button
              onClick={downloadAndInstall}
              style={{ padding: '8px 16px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
            >
              下载更新
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
