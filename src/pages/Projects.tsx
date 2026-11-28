import { useState, useEffect, Fragment } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { convertFileSrc } from '@tauri-apps/api/core'
import {
  projectList,
  projectCreate,
  projectDeletePreview,
  projectForceDelete,
  projectImport,
  projectImportCandidates,
  projectRename,
  projectOpenFolder,
  projectPromptGet,
  projectPromptSet,
  projectReferenceStats,
  projectTaskHistory,
  projectRefList,
  projectRefAdd,
  projectRefDelete,
  projectRefCreateFolder,
  projectRefDetail,
  projectRefReveal,
  projectRefOpen,
  projectGenParamsGet,
  projectGenParamsSet,
  projectExpectedImagesGet,
  projectExpectedImagesSet,
  projectBackfillTaskMeta,
  GEN_MODEL_OPTIONS,
  GEN_RATIO_OPTIONS,
  GEN_STYLE_OPTIONS,
  type Project,
  type ProjectDeletePreview,
  type ProjectImportCandidate,
  type ProjectReferenceStats,
  type ProjectHistoryItem,
  type ReferenceItem,
  type ReferenceDetail,
  type GenParams,
} from '@/hooks/api'
import { useI18n } from '@/i18n'
import { useSaveHint } from '@/hooks/useSaveHint'
import { askConfirm, notify } from '@/utils/dialog'
import { useTaskStatusLabels } from '@/utils/taskStatus'
import { formatDateTime } from '@/utils/datetime'

const inputStyle: React.CSSProperties = {
  padding: '8px 12px',
  border: '1px solid #d1d5db',
  borderRadius: '6px',
  flex: 1,
  minWidth: '150px',
}
const actionStyle: React.CSSProperties = {
  background: '#f3f4f6',
  color: '#374151',
  border: '1px solid #d1d5db',
  padding: '5px 10px',
  borderRadius: '4px',
  cursor: 'pointer',
  fontSize: '12px',
  marginRight: '6px',
}
const dangerStyle: React.CSSProperties = {
  ...actionStyle,
  background: '#dc2626',
  color: '#fff',
  border: '1px solid #dc2626',
}

function formatBytes(size: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = size
  for (const unit of units) {
    if (value < 1024 || unit === 'GB') {
      return `${value < 10 && unit !== 'B' ? value.toFixed(1) : Math.round(value)} ${unit}`
    }
    value /= 1024
  }
  return `${value.toFixed(1)} TB`
}

const modalOverlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 50,
}
const modalCard: React.CSSProperties = {
  background: '#fff',
  borderRadius: '8px',
  padding: '20px',
  width: 'min(860px, 94vw)',
  maxHeight: '85vh',
  overflow: 'auto',
}

export default function ProjectsPage({ onOpenProject }: { onOpenProject: (projectId: number, name: string) => void }) {
  const { t } = useI18n()
  const saveHint = useSaveHint()
  const STATUS_LABELS = useTaskStatusLabels()
  const [projects, setProjects] = useState<Project[]>([])
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importCandidates, setImportCandidates] = useState<ProjectImportCandidate[]>([])
  const [importLoading, setImportLoading] = useState(false)
  const [importingPath, setImportingPath] = useState<string | null>(null)

  const [stats, setStats] = useState<Record<number, ProjectReferenceStats>>({})
  const [refItems, setRefItems] = useState<Record<number, ReferenceItem[]>>({})
  const [refLoading, setRefLoading] = useState<Record<number, boolean>>({})
  const [refFilter, setRefFilter] = useState<Record<number, string>>({})
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const [promptEditor, setPromptEditor] = useState<{ id: number; name: string } | null>(null)
  const [promptText, setPromptText] = useState('')
  const [promptSaving, setPromptSaving] = useState(false)

  // 删除确认弹窗：默认仅清数据库，可勾选同时永久删除磁盘文件夹
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null)
  const [deletePreview, setDeletePreview] = useState<ProjectDeletePreview | null>(null)
  const [deleteRemoveDisk, setDeleteRemoveDisk] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const [history, setHistory] = useState<{ id: number; name: string } | null>(null)
  const [historyItems, setHistoryItems] = useState<ProjectHistoryItem[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  const [preview, setPreview] = useState<{ item: ReferenceItem; projectId: number } | null>(null)
  const [detail, setDetail] = useState<ReferenceDetail | null>(null)

  const [genParamsEditor, setGenParamsEditor] = useState<{ id: number; name: string; model: string; ratio: string; style: string; expected: string } | null>(null)
  const [promptRequest, setPromptRequest] = useState<{ message: string; value: string; resolve: (v: string | null) => void } | null>(null)

  useEffect(() => {
    if (!promptRequest) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        promptRequest.resolve(null)
        setPromptRequest(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [promptRequest])

  function askText(message: string, defaultValue = ''): Promise<string | null> {
    return new Promise((resolve) => setPromptRequest({ message, value: defaultValue, resolve }))
  }

  function finishPrompt(value: string | null) {
    if (!promptRequest) return
    promptRequest.resolve(value)
    setPromptRequest(null)
  }

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    try {
      const data = await projectList()
      setProjects(data)
    } catch (e) {
      notify(t('projects.loadFailed') + e)
    } finally {
      setLoading(false)
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setLoading(true)
    try {
      const p = await projectCreate(trimmed)
      setProjects([p, ...projects])
      setName('')
    } catch (e) {
      notify(t('projects.createFailed') + e)
    } finally {
      setLoading(false)
    }
  }

  /** 打开导入弹窗：列出工作区根目录下可导入的子文件夹 */
  async function handleOpenImport() {
    setImportOpen(true)
    setImportCandidates([])
    setImportLoading(true)
    try {
      setImportCandidates(await projectImportCandidates())
    } catch (e) {
      notify(t('projects.importCandidatesFailed') + e)
      setImportOpen(false)
    } finally {
      setImportLoading(false)
    }
  }

  async function handleImportCandidate(c: ProjectImportCandidate) {
    setImportingPath(c.path)
    try {
      const p = await projectImport(c.name, c.path)
      setProjects([p, ...projects])
      setImportCandidates((prev) => prev.filter((x) => x.path !== c.path))
    } catch (e) {
      notify(t('projects.importFailed') + e)
    } finally {
      setImportingPath(null)
    }
  }

  async function handleOpenDelete(p: Project) {
    setDeleteTarget(p)
    setDeletePreview(null)
    setDeleteRemoveDisk(false)
    setDeleteBusy(true)
    try {
      setDeletePreview(await projectDeletePreview(p.id!))
    } catch (e) {
      notify(t('projects.deletePreviewFailed') + e)
      setDeleteTarget(null)
    } finally {
      setDeleteBusy(false)
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget || deleteBusy) return
    setDeleteBusy(true)
    try {
      const result = await projectForceDelete(deleteTarget.id!, deleteRemoveDisk)
      setProjects(projects.filter((p) => p.id !== deleteTarget.id))
      if (expandedId === deleteTarget.id) setExpandedId(null)
      const parts = [
        t('projects.deleteImpact', {
          tasks: result.tasks, rounds: result.rounds, images: result.images,
          pool: result.poolRecords, logs: result.logs, notices: result.notifications,
        }),
      ]
      if (result.diskDeleted) parts.push(t('projects.deleteDiskDone'))
      if (result.diskError) parts.push(t('projects.deleteDiskSkipped', { reason: result.diskError }))
      setDeleteTarget(null)
      notify(t('projects.deleteDone', { summary: parts.join(' ') }))
    } catch (e) {
      notify(t('projects.deleteFailed') + e)
    } finally {
      setDeleteBusy(false)
    }
  }

  async function handleRename(p: Project) {
    const next = await askText(t('projects.renamePrompt'), p.name)
    if (next === null) return
    if (!next.trim()) {
      notify(t('projects.renameEmpty'))
      return
    }
    try {
      const updated = await projectRename(p.id!, next.trim())
      setProjects(projects.map((x) => (x.id === p.id ? updated : x)))
    } catch (e) {
      notify(t('projects.renameFailed') + e)
    }
  }

  async function handleOpenFolder(p: Project) {
    try {
      await projectOpenFolder(p.id!)
    } catch (e) {
      notify(t('projects.openFolderFailed') + e)
    }
  }

  async function refreshReferenceData(id: number) {
    setRefLoading((prev) => ({ ...prev, [id]: true }))
    try {
      const [statsData, itemsData] = await Promise.all([
        projectReferenceStats(id),
        projectRefList(id),
      ])
      setStats((prev) => ({ ...prev, [id]: statsData }))
      setRefItems((prev) => ({ ...prev, [id]: itemsData }))
    } catch (e) {
      notify(t('msg.readRefsFailed') + e)
    } finally {
      setRefLoading((prev) => ({ ...prev, [id]: false }))
    }
  }

  async function toggleExpand(p: Project) {
    const id = p.id!
    if (expandedId === id) {
      setExpandedId(null)
      return
    }
    setExpandedId(id)
    await refreshReferenceData(id)
  }

  async function handleAddRefs(p: Project) {
    const selected = await openDialog({
      multiple: true,
      directory: false,
      filters: [{ name: t('msg.imageFilterName'), extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    })
    if (!selected) return
    const paths = Array.isArray(selected) ? selected : [selected]
    const subfolderRaw = await askText(t('msg.subfolderPrompt'), '')
    if (subfolderRaw === null) return
    const subfolder = subfolderRaw.trim() || null
    try {
      const result = await projectRefAdd(p.id!, paths, subfolder)
      await refreshReferenceData(p.id!)
      if (result.added === 0) {
        notify(t('msg.noneAdded', { list: result.skipped.length ? `\n${result.skipped.join('\n')}` : '' }))
      } else if (result.skipped.length) {
        notify(t('msg.added', { n: result.added, list: result.skipped.join('\n') }))
      }
    } catch (e) {
      notify(t('msg.addFailed') + e)
    }
  }

  async function handleCreateSubfolder(p: Project) {
    const rel = await askText(t('msg.newSubfolderPrompt'), '')
    if (rel === null) return
    if (!rel.trim()) {
      notify(t('msg.newSubfolderEmpty'))
      return
    }
    try {
      await projectRefCreateFolder(p.id!, rel.trim())
      await refreshReferenceData(p.id!)
    } catch (e) {
      notify(t('msg.createSubfolderFailed') + e)
    }
  }

  async function handleDeleteRef(p: Project, item: ReferenceItem) {
    if (!(await askConfirm(t('msg.refDeleteConfirm', { name: item.name })))) return
    try {
      await projectRefDelete(p.id!, item.path)
      await refreshReferenceData(p.id!)
    } catch (e) {
      notify(t('msg.refDeleteFailed') + e)
    }
  }

  async function handleShowDetail(p: Project, item: ReferenceItem) {
    try {
      const data = await projectRefDetail(p.id!, item.path)
      setDetail(data)
    } catch (e) {
      notify(t('msg.detailFailed') + e)
    }
  }

  async function handleRevealRef(p: Project, item: ReferenceItem) {
    try {
      await projectRefReveal(p.id!, item.path)
    } catch (e) {
      notify(t('msg.revealFailed') + e)
    }
  }

  async function handleOpenRef(p: Project, item: ReferenceItem) {
    try {
      await projectRefOpen(p.id!, item.path)
    } catch (e) {
      notify(t('msg.openFailed') + e)
    }
  }

  async function handleOpenGenParams(p: Project) {
    try {
      const g: GenParams = await projectGenParamsGet(p.id!)
      let expected = ''
      try {
        const n = await projectExpectedImagesGet(p.id!)
        expected = n == null ? '' : String(n)
      } catch (_) {
        expected = ''
      }
      setGenParamsEditor({ id: p.id!, name: p.name, model: g.model ?? '', ratio: g.ratio ?? '', style: g.style ?? '', expected })
    } catch (e) {
      notify(t('projects.paramsFailed') + e)
    }
  }

  async function handleSaveGenParams() {
    if (!genParamsEditor) return
    const expectedTrim = genParamsEditor.expected.trim()
    let expectedValue: number | null = null
    if (expectedTrim !== '') {
      const n = Number(expectedTrim)
      if (!Number.isInteger(n) || n < 1 || n > 20) {
        notify(t('projects.expectedImagesInvalid'))
        return
      }
      expectedValue = n
    }
    try {
      await projectGenParamsSet(genParamsEditor.id, {
        model: genParamsEditor.model.trim() || null,
        ratio: genParamsEditor.ratio.trim() || null,
        style: genParamsEditor.style.trim() || null,
      })
      await projectExpectedImagesSet(genParamsEditor.id, expectedValue)
      saveHint.markSaved(t('common.savedHint'))
      setGenParamsEditor(null)
    } catch (e) {
      notify(t('projects.paramsSaveFailed') + e)
    }
  }

  async function handleOpenPrompt(p: Project) {
    try {
      const text = await projectPromptGet(p.id!)
      setPromptText(text)
      setPromptEditor({ id: p.id!, name: p.name })
    } catch (e) {
      notify(t('projects.loadPromptFailed') + e)
    }
  }

  async function handleSavePrompt() {
    if (!promptEditor) return
    setPromptSaving(true)
    try {
      await projectPromptSet(promptEditor.id, promptText)
      saveHint.markSaved(t('common.savedHint'))
      setPromptEditor(null)
    } catch (e) {
      notify(t('projects.savePromptFailed') + e)
    } finally {
      setPromptSaving(false)
    }
  }

  async function handleOpenHistory(p: Project) {
    setHistory({ id: p.id!, name: p.name })
    setHistoryItems([])
    setHistoryLoading(true)
    try {
      const items = await projectTaskHistory(p.id!, 20)
      setHistoryItems(items)
    } catch (e) {
      notify(t('projects.historyFailed') + e)
    } finally {
      setHistoryLoading(false)
    }
  }

  return (
    <div style={{ padding: '24px' }}>
      <h2 style={{ fontSize: '20px', fontWeight: '600', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
        {t('nav.projects')}
        {saveHint.hint && <span style={{ fontSize: '12px', fontWeight: '400', color: '#166534' }}>{saveHint.hint}</span>}
      </h2>
      <form onSubmit={handleCreate} style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <input
          placeholder={t('projects.placeholderName')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={inputStyle}
        />
        <button
          type="submit"
          disabled={loading || !name.trim()}
          style={{ padding: '8px 16px', background: '#166534', color: '#fff', border: 'none', borderRadius: '6px', cursor: loading || !name.trim() ? 'not-allowed' : 'pointer' }}
        >
          {loading ? t('btn.create') + '...' : t('btn.newProject')}
        </button>
        <button
          type="button"
          onClick={handleOpenImport}
          disabled={loading}
          style={{ padding: '8px 16px', background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: '6px', cursor: loading ? 'not-allowed' : 'pointer' }}
        >
          {t('btn.import')}
        </button>
      </form>
      <p style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '12px' }}>
        {t('projects.createHint')}
      </p>

      <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff', borderRadius: '8px', overflow: 'hidden' }}>
        <thead>
          <tr style={{ background: '#f9fafb' }}>
            <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>ID</th>
            <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>{t('projects.tableName')}</th>
            <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>{t('projects.tableRoot')}</th>
            <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>{t('projects.tableReferences')}</th>
            <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>{t('projects.tableActions')}</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => {
            const id = p.id!
            const info = stats[id]
            const items = refItems[id] || []
            const filter = (refFilter[id] || '').toLowerCase()
            const visible = filter ? items.filter((i) => i.relative_path.toLowerCase().includes(filter)) : items
            return (
              <Fragment key={id}>
                <tr style={{ borderBottom: '1px solid #e5e5e5' }}>
                  <td style={{ padding: '12px', fontSize: '13px', color: '#6b7280' }}>{p.id}</td>
                  <td style={{ padding: '12px', fontSize: '13px', fontWeight: '500' }}>{p.name}</td>
                  <td style={{ padding: '12px', fontSize: '12px', color: '#6b7280', wordBreak: 'break-all' }}>{p.root_path}</td>
                  <td style={{ padding: '12px' }}>
                    <button onClick={() => toggleExpand(p)} style={actionStyle}>
                      {info
                        ? t('projects.chartBars', { n: info.total_images, folders: info.folder_count })
                        : t('btn.view')}
                      {expandedId === id ? ' ▲' : ' ▼'}
                    </button>
                  </td>
                  <td style={{ padding: '12px', whiteSpace: 'nowrap' }}>
                    <button onClick={() => onOpenProject(id, p.name)} style={{ ...actionStyle, background: '#166534', color: '#fff', border: '1px solid #166534' }}>
                      {t('projects.enter')}
                    </button>
                    <button onClick={() => handleOpenGenParams(p)} style={actionStyle}>
                      {t('projects.params')}
                    </button>
                    <button onClick={() => handleOpenPrompt(p)} style={actionStyle}>
                      {t('btn.prompt')}
                    </button>
                    <button
                      onClick={async () => {
                        if (!(await askConfirm(t('projects.backfillConfirm')))) return
                        try {
                          const n = await projectBackfillTaskMeta(id)
                          notify(t('projects.backfillDone', { n }))
                        } catch (e) { notify(t('projects.backfillFailed') + e) }
                      }}
                      style={actionStyle}
                      title={t('projects.backfillHint')}
                    >
                      {t('projects.backfill')}
                    </button>
                    <button onClick={() => handleOpenHistory(p)} style={actionStyle}>
                      {t('btn.history')}
                    </button>
                    <button onClick={() => handleOpenFolder(p)} style={actionStyle}>
                      {t('btn.openFolder')}
                    </button>
                    <button onClick={() => handleRename(p)} style={actionStyle}>
                      {t('btn.rename')}
                    </button>
                    <button onClick={() => handleOpenDelete(p)} style={dangerStyle}>
                      {t('btn.delete')}
                    </button>
                  </td>
                </tr>
                {expandedId === id && (
                  <tr style={{ borderBottom: '1px solid #e5e5e5', background: '#fbfbfb' }}>
                    <td colSpan={5} style={{ padding: '12px 16px' }}>
                      {!info ? (
                        <span style={{ fontSize: '12px', color: '#9ca3af' }}>{t('common.loading')}</span>
                      ) : (
                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '10px' }}>
                            <div style={{ fontSize: '12px', color: '#6b7280' }}>
                              {t('projects.chartSummary', { total: info.total_images, folders: info.folder_count })}
                            </div>
                            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                              <input
                                placeholder={t('projects.filteredPath')}
                                value={refFilter[id] || ''}
                                onChange={(e) => setRefFilter((prev) => ({ ...prev, [id]: e.target.value }))}
                                style={{ padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '12px', width: '180px' }}
                              />
                              <button onClick={() => handleAddRefs(p)} style={{ ...actionStyle, marginRight: 0 }}>
                                {t('btn.addImage')}
                              </button>
                              <button onClick={() => handleCreateSubfolder(p)} style={{ ...actionStyle, marginRight: 0 }}>
                                {t('btn.newSubfolder')}
                              </button>
                              <button onClick={() => refreshReferenceData(id)} style={{ ...actionStyle, marginRight: 0 }}>
                                {t('btn.refresh')}
                              </button>
                            </div>
                          </div>
                          {refLoading[id] ? (
                            <div style={{ fontSize: '12px', color: '#9ca3af' }}>{t('common.loading')}</div>
                          ) : visible.length === 0 ? (
                            <div style={{ fontSize: '12px', color: '#9ca3af' }}>
                              {items.length === 0
                                ? t('projects.noReferences', { root: info.references_root })
                                : t('projects.noMatch')}
                            </div>
                          ) : (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
                              {visible.map((item) => (
                                <div
                                  key={item.path}
                                  style={{ width: '128px', background: '#fff', border: '1px solid #e5e5e5', borderRadius: '6px', padding: '6px' }}
                                >
                                  <img
                                    src={convertFileSrc(item.path)}
                                    alt={item.name}
                                    loading="lazy"
                                    onClick={() => setPreview({ item, projectId: id })}
                                    style={{ width: '100%', height: '88px', objectFit: 'cover', borderRadius: '4px', background: '#f3f4f6', cursor: 'pointer' }}
                                  />
                                  <div
                                    title={item.relative_path}
                                    style={{ fontSize: '11px', fontWeight: '500', margin: '6px 0 2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                  >
                                    {item.name}
                                  </div>
                                  <div style={{ fontSize: '11px', color: '#9ca3af', marginBottom: '6px' }}>
                                    {item.folder === '.' ? t('projects.folderRoot') : item.folder} · {formatBytes(item.size)}
                                  </div>
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                                    <button onClick={() => setPreview({ item, projectId: id })} style={{ ...actionStyle, fontSize: '11px', padding: '3px 6px', margin: 0 }}>
                                      {t('btn.preview')}
                                    </button>
                                    <button onClick={() => handleShowDetail(p, item)} style={{ ...actionStyle, fontSize: '11px', padding: '3px 6px', margin: 0 }}>
                                      {t('btn.details')}
                                    </button>
                                    <button onClick={() => handleOpenRef(p, item)} style={{ ...actionStyle, fontSize: '11px', padding: '3px 6px', margin: 0 }}>
                                      {t('btn.open')}
                                    </button>
                                    <button onClick={() => handleRevealRef(p, item)} style={{ ...actionStyle, fontSize: '11px', padding: '3px 6px', margin: 0 }}>
                                      {t('btn.folder')}
                                    </button>
                                    <button onClick={() => handleDeleteRef(p, item)} style={{ ...dangerStyle, fontSize: '11px', padding: '3px 6px', margin: 0 }}>
                                      {t('btn.delete')}
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
          {projects.length === 0 && (
            <tr>
              <td colSpan={5} style={{ padding: '24px', textAlign: 'center', color: '#9ca3af' }}>
                {t('projects.none')}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {importOpen && (
        <div style={modalOverlay} onClick={() => setImportOpen(false)}>
          <div style={{ ...modalCard, width: 'min(520px, 94vw)' }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '4px' }}>{t('projects.importTitle')}</h3>
            <p style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '12px' }}>{t('projects.importModalNote')}</p>
            {importLoading ? (
              <div style={{ padding: '16px', fontSize: '12px', color: '#9ca3af' }}>{t('common.loading')}</div>
            ) : importCandidates.length === 0 ? (
              <div style={{ padding: '16px', fontSize: '12px', color: '#9ca3af' }}>{t('projects.importEmpty')}</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '50vh', overflow: 'auto' }}>
                {importCandidates.map((c) => (
                  <div key={c.path} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px', border: '1px solid #e5e5e5', borderRadius: '6px' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '13px', fontWeight: '500' }}>{c.name}</div>
                      <div style={{ fontSize: '11px', color: '#9ca3af', wordBreak: 'break-all' }}>{c.path}</div>
                    </div>
                    <button
                      onClick={() => handleImportCandidate(c)}
                      disabled={importingPath !== null}
                      style={{ padding: '6px 12px', background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: '6px', cursor: importingPath !== null ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}
                    >
                      {importingPath === c.path ? t('btn.import') + '...' : t('btn.import')}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
              <button onClick={() => setImportOpen(false)} style={{ ...actionStyle, marginRight: 0, padding: '8px 16px' }}>
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div style={modalOverlay} onClick={() => { if (!deleteBusy) setDeleteTarget(null) }}>
          <div style={{ ...modalCard, width: 'min(560px, 94vw)' }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '8px' }}>
              {t('projects.deleteModalTitle', { name: deleteTarget.name })}
            </h3>
            <p style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '12px', lineHeight: 1.6 }}>
              {t('projects.deleteModalNote')}
            </p>
            {deleteBusy && !deletePreview ? (
              <div style={{ padding: '12px', fontSize: '12px', color: '#9ca3af' }}>{t('common.loading')}</div>
            ) : deletePreview && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ fontSize: '12px', color: '#374151', padding: '10px', background: '#f9fafb', borderRadius: '6px' }}>
                  {t('projects.deleteImpact', {
                    tasks: deletePreview.tasks, rounds: deletePreview.rounds, images: deletePreview.images,
                    pool: deletePreview.poolRecords, logs: deletePreview.logs, notices: deletePreview.notifications,
                  })}
                </div>
                <div style={{ fontSize: '12px', color: '#6b7280', wordBreak: 'break-all' }}>
                  {t('projects.deleteDiskPath', {
                    path: deletePreview.rootPath,
                    state: deletePreview.diskExists ? t('projects.deleteDiskExists') : t('projects.deleteDiskMissing'),
                  })}
                </div>
                <label style={{ fontSize: '13px', color: '#374151', display: 'flex', alignItems: 'flex-start', gap: '8px', cursor: deletePreview.diskExists ? 'pointer' : 'not-allowed' }}>
                  <input
                    type="checkbox"
                    checked={deleteRemoveDisk}
                    disabled={!deletePreview.diskExists}
                    onChange={(e) => setDeleteRemoveDisk(e.target.checked)}
                    style={{ width: '16px', height: '16px', marginTop: '2px', flexShrink: 0 }}
                  />
                  {t('projects.deleteRemoveDisk')}
                </label>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
              <button onClick={() => setDeleteTarget(null)} disabled={deleteBusy} style={{ ...actionStyle, marginRight: 0, padding: '8px 16px' }}>
                {t('common.cancel')}
              </button>
              <button onClick={handleConfirmDelete} disabled={deleteBusy || !deletePreview} style={{ ...dangerStyle, marginRight: 0, padding: '8px 16px' }}>
                {deleteBusy ? t('common.deleting') : t('btn.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {history && (
        <div style={modalOverlay} onClick={() => setHistory(null)}>
          <div style={modalCard} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '4px' }}>{t('projects.historyTitle', { name: history.name })}</h3>
            <p style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '12px' }}>{t('projects.historyNote')}</p>
            {historyLoading ? (
              <div style={{ padding: '16px', fontSize: '12px', color: '#9ca3af' }}>{t('common.loading')}</div>
            ) : historyItems.length === 0 ? (
              <div style={{ padding: '16px', fontSize: '12px', color: '#9ca3af' }}>{t('projects.historyEmpty')}</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    <th style={{ padding: '8px', textAlign: 'left', color: '#6b7280' }}>{t('tasks.nameHeader')}</th>
                    <th style={{ padding: '8px', textAlign: 'left', color: '#6b7280' }}>{t('tasks.statusHeader')}</th>
                    <th style={{ padding: '8px', textAlign: 'left', color: '#6b7280' }}>{t('roundDetail.tableRound')}</th>
                    <th style={{ padding: '8px', textAlign: 'left', color: '#6b7280' }}>{t('projects.successImages')}</th>
                    <th style={{ padding: '8px', textAlign: 'left', color: '#6b7280' }}>{t('projects.taskTimeCreated')}</th>
                    <th style={{ padding: '8px', textAlign: 'left', color: '#6b7280' }}>{t('projects.taskTimeCompleted')}</th>
                  </tr>
                </thead>
                <tbody>
                  {historyItems.map((h) => (
                    <tr key={h.task_id} style={{ borderBottom: '1px solid #e5e5e5' }}>
                      <td style={{ padding: '8px' }}>#{h.task_id} {h.name}</td>
                      <td style={{ padding: '8px' }}>{STATUS_LABELS[h.status] || h.status}</td>
                      <td style={{ padding: '8px' }}>{h.current_round}/{h.total_rounds}</td>
                      <td style={{ padding: '8px' }}>{h.success_images}</td>
                      <td style={{ padding: '8px', color: '#6b7280' }}>{formatDateTime(h.created_at)}</td>
                      <td style={{ padding: '8px', color: '#6b7280' }}>{formatDateTime(h.completed_at) || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
              <button onClick={() => setHistory(null)} style={{ ...actionStyle, marginRight: 0, padding: '8px 16px' }}>
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {genParamsEditor && (
        <div style={modalOverlay} onClick={() => setGenParamsEditor(null)}>
          <div style={{ ...modalCard, width: 'min(520px, 94vw)' }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '8px' }}>{t('projects.paramsModalTitle', { name: genParamsEditor.name })}</h3>
            <p style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '12px' }}>{t('projects.paramsModalNote')}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <label style={{ fontSize: '13px', color: '#6b7280' }}>
                {t('settings.genParamsModel')}
                <select value={genParamsEditor.model} onChange={(e) => setGenParamsEditor({ ...genParamsEditor, model: e.target.value })} style={{ display: 'block', width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: '6px', marginTop: '4px' }}>
                  <option value="">（沿用全局）</option>
                  {GEN_MODEL_OPTIONS.map((m) => (<option key={m} value={m}>{m}</option>))}
                </select>
              </label>
              <label style={{ fontSize: '13px', color: '#6b7280' }}>
                {t('settings.genParamsRatio')}
                <select value={genParamsEditor.ratio} onChange={(e) => setGenParamsEditor({ ...genParamsEditor, ratio: e.target.value })} style={{ display: 'block', width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: '6px', marginTop: '4px' }}>
                  <option value="">（沿用全局）</option>
                  {GEN_RATIO_OPTIONS.map((r) => (<option key={r} value={r}>{r}</option>))}
                </select>
              </label>
              <label style={{ fontSize: '13px', color: '#6b7280' }}>
                {t('projects.expectedImages')}
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={genParamsEditor.expected}
                  onChange={(e) => setGenParamsEditor({ ...genParamsEditor, expected: e.target.value })}
                  placeholder={t('projects.expectedImagesPlaceholder')}
                  style={{ display: 'block', width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: '6px', marginTop: '4px', boxSizing: 'border-box' }}
                />
                <span style={{ fontSize: '11px', color: '#9ca3af', display: 'block', marginTop: '4px' }}>{t('projects.expectedImagesNote')}</span>
              </label>
              <label style={{ fontSize: '13px', color: '#6b7280' }}>
                {t('settings.genParamsStyle')}
                <select value={genParamsEditor.style} onChange={(e) => setGenParamsEditor({ ...genParamsEditor, style: e.target.value })} style={{ display: 'block', width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: '6px', marginTop: '4px' }}>
                  <option value="">（沿用全局）</option>
                  {GEN_STYLE_OPTIONS.map((s) => (<option key={s} value={s}>{s}</option>))}
                </select>
              </label>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
              <button onClick={() => setGenParamsEditor(null)} style={{ ...actionStyle, marginRight: 0, padding: '8px 16px' }}>{t('common.cancel')}</button>
              <button onClick={handleSaveGenParams} style={{ padding: '8px 16px', background: '#166534', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>{t('btn.save')}</button>
            </div>
          </div>
        </div>
      )}

      {promptEditor && (
        <div style={modalOverlay} onClick={() => setPromptEditor(null)}>
          <div style={modalCard} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '8px' }}>{t('projects.promptTitle', { name: promptEditor.name })}</h3>
            <p style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '12px' }}>
              {t('projects.promptSaveNote')}
            </p>
            <textarea
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              placeholder={t('projects.promptPlaceholder')}
              style={{ width: '100%', minHeight: '220px', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '13px', lineHeight: 1.6, resize: 'vertical', boxSizing: 'border-box' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
              <button onClick={() => setPromptEditor(null)} style={{ ...actionStyle, marginRight: 0, padding: '8px 16px' }}>
                {t('common.cancel')}
              </button>
              <button
                onClick={handleSavePrompt}
                disabled={promptSaving}
                style={{ padding: '8px 16px', background: '#166534', color: '#fff', border: 'none', borderRadius: '6px', cursor: promptSaving ? 'not-allowed' : 'pointer' }}
              >
                {promptSaving ? t('common.saving') : t('btn.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {preview && (
        <div style={modalOverlay} onClick={() => setPreview(null)}>
          <div
            style={{ background: '#fff', borderRadius: '8px', padding: '16px', maxWidth: '92vw', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: '12px', color: '#374151', marginBottom: '8px', maxWidth: '80vw', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {preview.item.relative_path}
            </div>
            <img
              src={convertFileSrc(preview.item.path)}
              alt={preview.item.name}
              style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain', background: '#111', borderRadius: '4px' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '10px' }}>
              <button onClick={() => setPreview(null)} style={{ ...actionStyle, marginRight: 0, padding: '8px 16px' }}>
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {detail && (
        <div style={modalOverlay} onClick={() => setDetail(null)}>
          <div style={{ ...modalCard, width: 'min(640px, 94vw)' }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '8px' }}>{t('projects.detailTitle', { name: detail.name })}</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <tbody>
                {[
                  [t('details.path'), detail.path],
                  [t('details.relativePath'), detail.relative_path],
                  [t('details.size'), formatBytes(detail.size)],
                  [t('details.modified'), detail.modified || '—'],
                  ['SHA-256', detail.sha256],
                ].map(([label, value]) => (
                  <tr key={label as string} style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: '8px', color: '#6b7280', width: '90px', verticalAlign: 'top' }}>{label}</td>
                    <td style={{ padding: '8px', color: '#374151', wordBreak: 'break-all' }}>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
              <button onClick={() => setDetail(null)} style={{ ...actionStyle, marginRight: 0, padding: '8px 16px' }}>
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {promptRequest && (
        <div style={modalOverlay} onClick={() => finishPrompt(null)}>
          <div style={{ ...modalCard, width: 'min(520px, 94vw)' }} onClick={(e) => e.stopPropagation()}>
            <p style={{ fontSize: '13px', color: '#374151', marginBottom: '12px' }}>{promptRequest.message}</p>
            <input
              autoFocus
              value={promptRequest.value}
              onChange={(e) => setPromptRequest({ ...promptRequest, value: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') finishPrompt(promptRequest.value) }}
              style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
              <button onClick={() => finishPrompt(null)} style={{ ...actionStyle, marginRight: 0, padding: '8px 16px' }}>{t('common.cancel')}</button>
              <button onClick={() => finishPrompt(promptRequest.value)} style={{ padding: '8px 16px', background: '#166534', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>{t('common.confirm')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
