import { useState, useEffect } from 'react'
import { projectList, projectCreate, projectDelete, type Project } from '@/hooks/api'
import { useI18n } from '@/i18n'

export default function ProjectsPage() {
  const { t } = useI18n()
  const [projects, setProjects] = useState<Project[]>([])
  const [name, setName] = useState('')
  const [rootPath, setRootPath] = useState('')
  const [loading, setLoading] = useState(false)

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
      setProjects([...projects, p])
      setName('')
      setRootPath('')
    } catch (e) {
      alert('创建失败: ' + e)
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete(id: number) {
    if (!window.confirm('确定删除？')) return
    try {
      await projectDelete(id)
      setProjects(projects.filter((p) => p.id !== id))
    } catch (e) {
      alert('删除失败: ' + e)
    }
  }

  return (
    <div style={{ padding: '24px' }}>
      <h2 style={{ fontSize: '20px', fontWeight: '600', marginBottom: '16px' }}>{t('nav.projects')}</h2>
      <form onSubmit={handleCreate} style={{ display: 'flex', gap: '8px', marginBottom: '20px', flexWrap: 'wrap' }}>
        <input
          placeholder="项目名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '6px', flex: 1, minWidth: '150px' }}
        />
        <input
          placeholder="项目根目录"
          value={rootPath}
          onChange={(e) => setRootPath(e.target.value)}
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
            <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>名称</th>
            <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>根目录</th>
            <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.id} style={{ borderBottom: '1px solid #e5e5e5' }}>
              <td style={{ padding: '12px', fontSize: '13px', color: '#6b7280' }}>{p.id}</td>
              <td style={{ padding: '12px', fontSize: '13px', fontWeight: '500' }}>{p.name}</td>
              <td style={{ padding: '12px', fontSize: '12px', color: '#6b7280' }}>{p.root_path}</td>
              <td style={{ padding: '12px' }}>
                <button
                  onClick={() => handleDelete(p.id!)}
                  style={{ background: '#dc2626', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
                >
                  {t('btn.delete')}
                </button>
              </td>
            </tr>
          ))}
          {projects.length === 0 && (
            <tr>
              <td colSpan={4} style={{ padding: '24px', textAlign: 'center', color: '#9ca3af' }}>
                暂无项目
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
