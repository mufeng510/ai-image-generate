import { useState, useEffect, Fragment } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { convertFileSrc } from '@tauri-apps/api/core'
import {
  projectList,
  projectCreate,
  projectDelete,
  projectImport,
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
  type Project,
  type ProjectReferenceStats,
  type ProjectHistoryItem,
  type ReferenceItem,
  type ReferenceDetail,
} from '@/hooks/api'
import { useI18n } from '@/i18n'

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

const STATUS_LABELS: Record<string, string> = {
  pending: '等待中',
  preparing: '准备中',
  selecting_images: '抽图中',
  waiting_confirmation: '等待确认',
  uploading: '上传中',
  submitting: '提交中',
  generating: '生成中',
  downloading: '下载中',
  verifying: '校验中',
  completed: '已完成',
  failed: '失败',
  paused: '已暂停',
  cancelled: '已取消',
  needs_manual_intervention: '需人工处理',
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

export default function ProjectsPage() {
  const { t } = useI18n()
  const [projects, setProjects] = useState<Project[]>([])
  const [name, setName] = useState('')
  const [rootPath, setRootPath] = useState('')
  const [loading, setLoading] = useState(false)

  const [stats, setStats] = useState<Record<number, ProjectReferenceStats>>({})
  const [refItems, setRefItems] = useState<Record<number, ReferenceItem[]>>({})
  const [refLoading, setRefLoading] = useState<Record<number, boolean>>({})
  const [refFilter, setRefFilter] = useState<Record<number, string>>({})
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const [promptEditor, setPromptEditor] = useState<{ id: number; name: string } | null>(null)
  const [promptText, setPromptText] = useState('')
  const [promptSaving, setPromptSaving] = useState(false)

  const [history, setHistory] = useState<{ id: number; name: string } | null>(null)
  const [historyItems, setHistoryItems] = useState<ProjectHistoryItem[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  const [preview, setPreview] = useState<{ item: ReferenceItem; projectId: number } | null>(null)
  const [detail, setDetail] = useState<ReferenceDetail | null>(null)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    try {
      const data = await projectList()
      setProjects(data)
    } catch (e) {
      alert('加载项目失败: ' + e)
    } finally {
      setLoading(false)
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !rootPath.trim()) return
    setLoading(true)
    try {
      const p = await projectCreate(name.trim(), rootPath.trim())
      setProjects([p, ...projects])
      setName('')
      setRootPath('')
    } catch (e) {
      alert('创建失败: ' + e)
    } finally {
      setLoading(false)
    }
  }

  async function handleImport() {
    if (!rootPath.trim()) {
      alert('请填写要导入的项目根目录')
      return
    }
    setLoading(true)
    try {
      const p = await projectImport(name.trim() || null, rootPath.trim())
      setProjects([p, ...projects])
      setName('')
      setRootPath('')
    } catch (e) {
      alert('导入失败: ' + e)
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete(id: number) {
    if (!window.confirm('确定删除？仅移除项目记录，不会删除磁盘文件。')) return
    try {
      await projectDelete(id)
      setProjects(projects.filter((p) => p.id !== id))
      if (expandedId === id) setExpandedId(null)
    } catch (e) {
      alert('删除失败: ' + e)
    }
  }

  async function handleRename(p: Project) {
    const next = window.prompt('新的项目名称', p.name)
    if (next === null) return
    if (!next.trim()) {
      alert('项目名称不能为空')
      return
    }
    try {
      await projectRename(p.id!, next.trim())
      setProjects(projects.map((x) => (x.id === p.id ? { ...x, name: next.trim() } : x)))
    } catch (e) {
      alert('重命名失败: ' + e)
    }
  }

  async function handleOpenFolder(p: Project) {
    try {
      await projectOpenFolder(p.id!)
    } catch (e) {
      alert('打开目录失败: ' + e)
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
      alert('读取参考图失败: ' + e)
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
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    })
    if (!selected) return
    const paths = Array.isArray(selected) ? selected : [selected]
    const subfolderRaw = window.prompt('子目录（相对于 references，留空表示根目录）', '')
    if (subfolderRaw === null) return
    const subfolder = subfolderRaw.trim() || null
    try {
      const result = await projectRefAdd(p.id!, paths, subfolder)
      await refreshReferenceData(p.id!)
      if (result.added === 0) {
        alert('没有图片被添加。' + (result.skipped.length ? `\n${result.skipped.join('\n')}` : ''))
      } else if (result.skipped.length) {
        alert(`已添加 ${result.added} 张。以下文件被跳过：\n${result.skipped.join('\n')}`)
      }
    } catch (e) {
      alert('添加参考图失败: ' + e)
    }
  }

  async function handleCreateSubfolder(p: Project) {
    const rel = window.prompt('新子目录名，例如 主图/2026', '')
    if (rel === null) return
    if (!rel.trim()) {
      alert('子目录名不能为空')
      return
    }
    try {
      await projectRefCreateFolder(p.id!, rel.trim())
      await refreshReferenceData(p.id!)
    } catch (e) {
      alert('新建子目录失败: ' + e)
    }
  }

  async function handleDeleteRef(p: Project, item: ReferenceItem) {
    if (!window.confirm(`确定删除参考图 ${item.name}？此操作会删除磁盘文件。`)) return
    try {
      await projectRefDelete(p.id!, item.path)
      await refreshReferenceData(p.id!)
    } catch (e) {
      alert('删除失败: ' + e)
    }
  }

  async function handleShowDetail(p: Project, item: ReferenceItem) {
    try {
      const data = await projectRefDetail(p.id!, item.path)
      setDetail(data)
    } catch (e) {
      alert('读取详情失败: ' + e)
    }
  }

  async function handleRevealRef(p: Project, item: ReferenceItem) {
    try {
      await projectRefReveal(p.id!, item.path)
    } catch (e) {
      alert('打开所在目录失败: ' + e)
    }
  }

  async function handleOpenRef(p: Project, item: ReferenceItem) {
    try {
      await projectRefOpen(p.id!, item.path)
    } catch (e) {
      alert('打开图片失败: ' + e)
    }
  }

  async function handleOpenPrompt(p: Project) {
    try {
      const text = await projectPromptGet(p.id!)
      setPromptText(text)
      setPromptEditor({ id: p.id!, name: p.name })
    } catch (e) {
      alert('读取提示词失败: ' + e)
    }
  }

  async function handleSavePrompt() {
    if (!promptEditor) return
    setPromptSaving(true)
    try {
      await projectPromptSet(promptEditor.id, promptText)
      alert('已保存到项目根目录的 prompt.txt')
      setPromptEditor(null)
    } catch (e) {
      alert('保存提示词失败: ' + e)
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
      alert('读取生成历史失败: ' + e)
    } finally {
      setHistoryLoading(false)
    }
  }

  return (
    <div style={{ padding: '24px' }}>
      <h2 style={{ fontSize: '20px', fontWeight: '600', marginBottom: '16px' }}>{t('nav.projects')}</h2>
      <form onSubmit={handleCreate} style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <input
          placeholder="项目名称（导入时可留空）"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={inputStyle}
        />
        <input
          placeholder="项目根目录，例如 D:\\work\\my-project"
          value={rootPath}
          onChange={(e) => setRootPath(e.target.value)}
          style={{ ...inputStyle, minWidth: '260px' }}
        />
        <button
          type="submit"
          disabled={loading}
          style={{ padding: '8px 16px', background: '#166534', color: '#fff', border: 'none', borderRadius: '6px', cursor: loading ? 'not-allowed' : 'pointer' }}
        >
          {loading ? t('btn.create') + '...' : '新建项目'}
        </button>
        <button
          type="button"
          onClick={handleImport}
          disabled={loading}
          style={{ padding: '8px 16px', background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: '6px', cursor: loading ? 'not-allowed' : 'pointer' }}
        >
          导入已有项目
        </button>
      </form>
      <p style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '12px' }}>
        导入会复用已有目录：识别根目录下的 prompt.txt，并在缺失时补建 references、output 子目录，不会覆盖已有文件。
      </p>

      <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff', borderRadius: '8px', overflow: 'hidden' }}>
        <thead>
          <tr style={{ background: '#f9fafb' }}>
            <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>ID</th>
            <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>名称</th>
            <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>根目录</th>
            <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>参考图</th>
            <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>操作</th>
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
                      {info ? `${info.total_images} 张 / ${info.folder_count} 个文件夹` : '查看'}
                      {expandedId === id ? ' ▲' : ' ▼'}
                    </button>
                  </td>
                  <td style={{ padding: '12px', whiteSpace: 'nowrap' }}>
                    <button onClick={() => handleOpenPrompt(p)} style={actionStyle}>
                      提示词
                    </button>
                    <button onClick={() => handleOpenHistory(p)} style={actionStyle}>
                      历史
                    </button>
                    <button onClick={() => handleOpenFolder(p)} style={actionStyle}>
                      打开目录
                    </button>
                    <button onClick={() => handleRename(p)} style={actionStyle}>
                      重命名
                    </button>
                    <button onClick={() => handleDelete(id)} style={dangerStyle}>
                      {t('btn.delete')}
                    </button>
                  </td>
                </tr>
                {expandedId === id && (
                  <tr style={{ borderBottom: '1px solid #e5e5e5', background: '#fbfbfb' }}>
                    <td colSpan={5} style={{ padding: '12px 16px' }}>
                      {!info ? (
                        <span style={{ fontSize: '12px', color: '#9ca3af' }}>读取中…</span>
                      ) : (
                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '10px' }}>
                            <div style={{ fontSize: '12px', color: '#6b7280' }}>
                              共 {info.total_images} 张，分布在 {info.folder_count} 个文件夹；每个文件夹独立参与抽取。
                            </div>
                            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                              <input
                                placeholder="筛选相对路径…"
                                value={refFilter[id] || ''}
                                onChange={(e) => setRefFilter((prev) => ({ ...prev, [id]: e.target.value }))}
                                style={{ padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '12px', width: '180px' }}
                              />
                              <button onClick={() => handleAddRefs(p)} style={{ ...actionStyle, marginRight: 0 }}>
                                添加图片
                              </button>
                              <button onClick={() => handleCreateSubfolder(p)} style={{ ...actionStyle, marginRight: 0 }}>
                                新建子目录
                              </button>
                              <button onClick={() => refreshReferenceData(id)} style={{ ...actionStyle, marginRight: 0 }}>
                                刷新
                              </button>
                            </div>
                          </div>
                          {refLoading[id] ? (
                            <div style={{ fontSize: '12px', color: '#9ca3af' }}>读取中…</div>
                          ) : visible.length === 0 ? (
                            <div style={{ fontSize: '12px', color: '#9ca3af' }}>
                              {items.length === 0
                                ? `未找到参考图。请将 jpg/jpeg/png/webp 放入 ${info.references_root}。`
                                : '没有匹配的图片。'}
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
                                    {item.folder === '.' ? '根目录' : item.folder} · {formatBytes(item.size)}
                                  </div>
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                                    <button onClick={() => setPreview({ item, projectId: id })} style={{ ...actionStyle, fontSize: '11px', padding: '3px 6px', margin: 0 }}>
                                      预览
                                    </button>
                                    <button onClick={() => handleShowDetail(p, item)} style={{ ...actionStyle, fontSize: '11px', padding: '3px 6px', margin: 0 }}>
                                      详情
                                    </button>
                                    <button onClick={() => handleOpenRef(p, item)} style={{ ...actionStyle, fontSize: '11px', padding: '3px 6px', margin: 0 }}>
                                      打开
                                    </button>
                                    <button onClick={() => handleRevealRef(p, item)} style={{ ...actionStyle, fontSize: '11px', padding: '3px 6px', margin: 0 }}>
                                      目录
                                    </button>
                                    <button onClick={() => handleDeleteRef(p, item)} style={{ ...dangerStyle, fontSize: '11px', padding: '3px 6px', margin: 0 }}>
                                      删除
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
                暂无项目
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {history && (
        <div style={modalOverlay} onClick={() => setHistory(null)}>
          <div style={modalCard} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '4px' }}>生成历史 · {history.name}</h3>
            <p style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '12px' }}>最近 20 个任务（按创建时间倒序）</p>
            {historyLoading ? (
              <div style={{ padding: '16px', fontSize: '12px', color: '#9ca3af' }}>读取中…</div>
            ) : historyItems.length === 0 ? (
              <div style={{ padding: '16px', fontSize: '12px', color: '#9ca3af' }}>该项目还没有执行记录。</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    <th style={{ padding: '8px', textAlign: 'left', color: '#6b7280' }}>任务</th>
                    <th style={{ padding: '8px', textAlign: 'left', color: '#6b7280' }}>状态</th>
                    <th style={{ padding: '8px', textAlign: 'left', color: '#6b7280' }}>轮次</th>
                    <th style={{ padding: '8px', textAlign: 'left', color: '#6b7280' }}>成功图片</th>
                    <th style={{ padding: '8px', textAlign: 'left', color: '#6b7280' }}>创建时间</th>
                    <th style={{ padding: '8px', textAlign: 'left', color: '#6b7280' }}>完成时间</th>
                  </tr>
                </thead>
                <tbody>
                  {historyItems.map((h) => (
                    <tr key={h.task_id} style={{ borderBottom: '1px solid #e5e5e5' }}>
                      <td style={{ padding: '8px' }}>#{h.task_id} {h.name}</td>
                      <td style={{ padding: '8px' }}>{STATUS_LABELS[h.status] || h.status}</td>
                      <td style={{ padding: '8px' }}>{h.current_round}/{h.total_rounds}</td>
                      <td style={{ padding: '8px' }}>{h.success_images}</td>
                      <td style={{ padding: '8px', color: '#6b7280' }}>{h.created_at}</td>
                      <td style={{ padding: '8px', color: '#6b7280' }}>{h.completed_at || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
              <button onClick={() => setHistory(null)} style={{ ...actionStyle, marginRight: 0, padding: '8px 16px' }}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {promptEditor && (
        <div style={modalOverlay} onClick={() => setPromptEditor(null)}>
          <div style={modalCard} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '8px' }}>提示词 · {promptEditor.name}</h3>
            <p style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '12px' }}>
              保存后会写入项目根目录的 prompt.txt，之后每轮生图都会重新读取。
            </p>
            <textarea
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              placeholder="输入生图提示词…"
              style={{ width: '100%', minHeight: '220px', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '13px', lineHeight: 1.6, resize: 'vertical', boxSizing: 'border-box' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
              <button onClick={() => setPromptEditor(null)} style={{ ...actionStyle, marginRight: 0, padding: '8px 16px' }}>
                取消
              </button>
              <button
                onClick={handleSavePrompt}
                disabled={promptSaving}
                style={{ padding: '8px 16px', background: '#166534', color: '#fff', border: 'none', borderRadius: '6px', cursor: promptSaving ? 'not-allowed' : 'pointer' }}
              >
                {promptSaving ? '保存中…' : '保存'}
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
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {detail && (
        <div style={modalOverlay} onClick={() => setDetail(null)}>
          <div style={{ ...modalCard, width: 'min(640px, 94vw)' }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '8px' }}>图片详情 · {detail.name}</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <tbody>
                {[
                  ['路径', detail.path],
                  ['相对位置', detail.relative_path],
                  ['大小', formatBytes(detail.size)],
                  ['修改时间', detail.modified || '—'],
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
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
