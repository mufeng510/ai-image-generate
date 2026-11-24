/**
 * src/pages/ProjectWorkspace.tsx
 *
 * 项目工作台：进入一个项目后，任务列表来自该项目的 output 目录下的文件夹。
 * 参考图与提示词/参数沿用项目级 API，保持单一项目上下文。
 */

import { useState, useEffect, useCallback } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import {
  projectTaskFolders,
  taskFolderOpen,
  taskCreate,
  accountList,
  projectPromptGet,
  projectPromptSet,
  projectGenParamsGet,
  projectGenParamsSet,
  projectExpectedImagesGet,
  projectExpectedImagesSet,
  projectReferenceStats,
  projectRefList,
  projectRefOpen,
  projectOpenFolder,
  GEN_MODEL_OPTIONS,
  GEN_RATIO_OPTIONS,
  GEN_STYLE_OPTIONS,
  type TaskFolder,
  type FolderSelection,
  type Account,
  type GenParams,
  type ProjectReferenceStats,
  type ReferenceItem,
} from '@/hooks/api'
import { useI18n } from '@/i18n'
import { formatDateTime } from '@/utils/datetime'
import { notify } from '@/utils/dialog'

type Tab = 'tasks' | 'refs' | 'settings'

const FOLDER_STATUS_COLORS: Record<string, string> = {
  generating: '#2563eb',
  pending_review: '#d97706',
  converted: '#16a34a',
  empty: '#6b7280',
}

const btnStyle: React.CSSProperties = {
  padding: '6px 12px', border: '1px solid #d1d5db', borderRadius: '6px',
  background: '#fff', cursor: 'pointer', fontSize: '13px', marginRight: '6px',
}
const primaryStyle: React.CSSProperties = {
  ...btnStyle, background: '#166534', color: '#fff', border: '1px solid #166534',
}

interface Props {
  projectId: number
  projectName: string
  onOpenTask: (sel: FolderSelection) => void
  onBack: () => void
}

export default function ProjectWorkspace({ projectId, projectName, onOpenTask, onBack }: Props) {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('tasks')
  const [folders, setFolders] = useState<TaskFolder[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [accountId, setAccountId] = useState('')
  const [rounds, setRounds] = useState('1')
  const [creating, setCreating] = useState(false)

  const [prompt, setPrompt] = useState('')
  const [savingPrompt, setSavingPrompt] = useState(false)
  const [genParams, setGenParams] = useState<GenParams>({})
  const [expected, setExpected] = useState('')
  const [stats, setStats] = useState<ProjectReferenceStats | null>(null)
  const [refs, setRefs] = useState<ReferenceItem[]>([])

  const loadFolders = useCallback(async () => {
    try { setFolders(await projectTaskFolders(projectId)) } catch (e) { console.error(e) }
  }, [projectId])

  useEffect(() => {
    loadFolders()
    accountList().then(setAccounts).catch(() => {})
  }, [loadFolders])

  useEffect(() => {
    if (tab === 'settings') {
      projectPromptGet(projectId).then(setPrompt).catch(() => {})
      projectGenParamsGet(projectId).then(setGenParams).catch(() => {})
      projectExpectedImagesGet(projectId).then((v) => setExpected(v == null ? '' : String(v))).catch(() => {})
    }
    if (tab === 'refs') {
      projectReferenceStats(projectId).then(setStats).catch(() => {})
      projectRefList(projectId).then(setRefs).catch(() => {})
    }
  }, [tab, projectId])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    try {
      await taskCreate(projectId, accountId ? Number(accountId) : null, Math.max(1, Math.min(999, Number(rounds) || 1)))
      setAccountId('')
      setRounds('1')
      await loadFolders()
    } catch (err) {
      notify(t('tasks.createFailed') + err)
    } finally {
      setCreating(false)
    }
  }

  async function savePrompt() {
    setSavingPrompt(true)
    try { await projectPromptSet(projectId, prompt) } catch (e) { notify(t('btn.save') + e) } finally { setSavingPrompt(false) }
  }

  async function saveParams() {
    try {
      await projectGenParamsSet(projectId, genParams)
      const value = expected.trim() === '' ? null : Math.max(1, Math.min(999, Number(expected) || 1))
      await projectExpectedImagesSet(projectId, value)
    } catch (e) {
      notify(t('btn.save') + e)
    }
  }

  const folderStatusLabel = (status: string) => {
    const key = `tasks.folderStatus.${status}`
    return t(key) === key ? status : t(key)
  }

  return (
    <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
        <div>
          <h2 style={{ fontSize: '20px', fontWeight: '600', margin: 0 }}>{t('workspace.title')} · {projectName}</h2>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button onClick={() => projectOpenFolder(projectId).catch((e) => notify(e))} style={btnStyle}>{t('btn.openFolder')}</button>
          <button onClick={onBack} style={btnStyle}>← {t('roundDetail.back')}</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid #e5e5e5' }}>
        {([['tasks', 'workspace.tabTasks'], ['refs', 'workspace.tabRefs'], ['settings', 'workspace.tabSettings']] as [Tab, string][]).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              padding: '10px 16px', border: 'none', borderBottom: tab === key ? '2px solid #166534' : '2px solid transparent',
              background: 'transparent', color: tab === key ? '#166534' : '#6b7280', cursor: 'pointer', fontSize: '13px', fontWeight: tab === key ? 600 : 500,
            }}
          >
            {t(label)}
          </button>
        ))}
      </div>

      {tab === 'tasks' && (
        <>
          <form onSubmit={handleCreate} style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#374151' }}>{t('workspace.newTask')}</span>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)} style={btnStyle} title={t('tasks.autoAccountTitle')}>
              <option value="">{t('tasks.createPlaceholderAccount')}</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.verified_images != null ? `（${a.verified_images}）` : ''}</option>)}
            </select>
            <label style={{ fontSize: '13px', color: '#374151' }}>
              {t('tasks.rounds')}
              <input type="number" min={1} max={999} value={rounds} onChange={(e) => setRounds(e.target.value)} style={{ ...btnStyle, width: '72px', marginLeft: '6px' }} />
            </label>
            <button type="submit" disabled={creating} style={primaryStyle}>{t('tasks.createTask')}</button>
          </form>
          <p style={{ fontSize: '12px', color: '#9ca3af', margin: '-12px 0 0' }}>{t('tasks.folderHint')}</p>

          <div style={{ background: '#fff', border: '1px solid #e5e5e5', borderRadius: '12px', overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '13px', color: '#6b7280' }}>{t('tasks.folderHeader')}</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '13px', color: '#6b7280' }}>{t('tasks.statusHeader')}</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '13px', color: '#6b7280' }}>{t('tasks.progressHeader')}</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '13px', color: '#6b7280' }}>{t('tasks.imageHeader')}</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '13px', color: '#6b7280' }}>{t('tasks.updatedHeader')}</th>
                  <th style={{ padding: '12px', textAlign: 'left', fontSize: '13px', color: '#6b7280' }}>{t('tasks.actionsHeader')}</th>
                </tr>
              </thead>
              <tbody>
                {folders.map((folder) => (
                  <tr
                    key={folder.folder}
                    style={{ borderBottom: '1px solid #e5e5e5', cursor: 'pointer' }}
                    onClick={() => onOpenTask({ projectId, folder: folder.folder, taskId: folder.task_id })}
                  >
                    <td style={{ padding: '10px', fontSize: '13px', fontWeight: 500 }}>{folder.folder}</td>
                    <td style={{ padding: '10px' }}>
                      <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: '10px', fontSize: '11px', color: '#fff', backgroundColor: FOLDER_STATUS_COLORS[folder.status] || '#6b7280' }}>
                        {folderStatusLabel(folder.status)}
                      </span>
                    </td>
                    <td style={{ padding: '10px', fontSize: '13px', color: '#6b7280' }}>{folder.round_count}/{folder.total_rounds}</td>
                    <td style={{ padding: '10px', fontSize: '13px', color: '#6b7280' }}>{folder.image_count}</td>
                    <td style={{ padding: '10px', fontSize: '12px', color: '#6b7280' }}>{folder.updated_at ? formatDateTime(folder.updated_at) : '-'}</td>
                    <td style={{ padding: '10px' }}>
                      <button onClick={(e) => { e.stopPropagation(); taskFolderOpen(projectId, folder.folder).catch((err) => notify(err)) }} style={btnStyle}>
                        {t('tasks.folderOpen')}
                      </button>
                    </td>
                  </tr>
                ))}
                {folders.length === 0 && (
                  <tr><td colSpan={6} style={{ padding: '24px', textAlign: 'center', color: '#9ca3af' }}>{t('tasks.noTasks')}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'refs' && (
        <div style={{ background: '#fff', border: '1px solid #e5e5e5', borderRadius: '12px', padding: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <div style={{ fontSize: '13px', color: '#6b7280' }}>
              {stats ? t('projects.chartBars', { n: stats.total_images, folders: stats.folder_count }) : '…'}
            </div>
            <button onClick={() => projectOpenFolder(projectId).catch((e) => notify(e))} style={btnStyle}>{t('btn.openFolder')}</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '12px' }}>
            {refs.map((item) => (
              <div key={item.path} style={{ border: '1px solid #e5e5e5', borderRadius: '8px', overflow: 'hidden' }}>
                <div style={{ width: '100%', aspectRatio: '1', background: '#f3f4f6' }}>
                  <img src={convertFileSrc(item.path)} alt={item.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={(e) => { (e.target as HTMLElement).style.display = 'none' }} />
                </div>
                <div style={{ padding: '6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '4px' }}>
                  <span style={{ fontSize: '11px', color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.relative_path}>{item.name}</span>
                  <button onClick={() => projectRefOpen(projectId, item.path).catch((e) => notify(e))} style={{ ...btnStyle, padding: '2px 6px', margin: 0, fontSize: '11px' }}>{t('btn.view')}</button>
                </div>
              </div>
            ))}
          </div>
          {refs.length === 0 && <div style={{ padding: '32px', textAlign: 'center', color: '#9ca3af' }}>{t('roundDetail.noImages')}</div>}
        </div>
      )}

      {tab === 'settings' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '860px' }}>
          <div style={{ background: '#fff', border: '1px solid #e5e5e5', borderRadius: '12px', padding: '20px' }}>
            <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '10px' }}>{t('workspace.tabSettings')}</div>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={10} style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '6px', fontFamily: 'monospace', fontSize: '13px' }} />
            <div style={{ marginTop: '10px', display: 'flex', justifyContent: 'flex-end', gap: '6px' }}>
              <button onClick={savePrompt} disabled={savingPrompt} style={primaryStyle}>{t('btn.save')}</button>
            </div>
          </div>
          <div style={{ background: '#fff', border: '1px solid #e5e5e5', borderRadius: '12px', padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ fontSize: '14px', fontWeight: 600 }}>{t('projects.params')}</div>
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <label style={{ fontSize: '13px', color: '#374151' }}>
                {t('settings.genParamsModel')}
                <select value={genParams.model ?? ''} onChange={(e) => setGenParams({ ...genParams, model: e.target.value || null })} style={{ ...btnStyle, marginLeft: '6px' }}>
                  <option value="">{t('projects.inheritGlobal')}</option>
                  {GEN_MODEL_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              <label style={{ fontSize: '13px', color: '#374151' }}>
                {t('settings.genParamsRatio')}
                <select value={genParams.ratio ?? ''} onChange={(e) => setGenParams({ ...genParams, ratio: e.target.value || null })} style={{ ...btnStyle, marginLeft: '6px' }}>
                  <option value="">{t('projects.inheritGlobal')}</option>
                  {GEN_RATIO_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
              <label style={{ fontSize: '13px', color: '#374151' }}>
                {t('settings.genParamsStyle')}
                <select value={genParams.style ?? ''} onChange={(e) => setGenParams({ ...genParams, style: e.target.value || null })} style={{ ...btnStyle, marginLeft: '6px' }}>
                  <option value="">{t('projects.inheritGlobal')}</option>
                  {GEN_STYLE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </label>
              <label style={{ fontSize: '13px', color: '#374151' }}>
                {t('projects.expectedImages')}
                <input type="number" min={1} max={20} value={expected} onChange={(e) => setExpected(e.target.value)} style={{ ...btnStyle, width: '72px', marginLeft: '6px' }} />
              </label>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={saveParams} style={primaryStyle}>{t('btn.save')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
