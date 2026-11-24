import { useState } from 'react'
import { useI18n } from '@/i18n'
import DashboardPage from '@/pages/Dashboard'
import ProjectsPage from '@/pages/Projects'
import AccountsPage from '@/pages/Accounts'
import ExecutionPage from '@/pages/Execution'
import RoundDetail from '@/pages/RoundDetail'
import ProjectWorkspace from '@/pages/ProjectWorkspace'
import LogsPage from '@/pages/Logs'
import SettingsPage from '@/pages/Settings'
import NotificationCenter from '@/components/NotificationCenter'
import { taskFolderLocator, type FolderSelection } from '@/hooks/api'

type Page = 'dashboard' | 'projects' | 'projectWorkspace' | 'accounts' | 'tasks' | 'settings' | 'taskDetail' | 'logs'

const PAGE_LABELS: Record<Page, string> = {
  dashboard: 'nav.dashboard',
  projects: 'nav.projects',
  projectWorkspace: 'nav.projects',
  accounts: 'nav.accounts',
  tasks: 'nav.tasks',
  settings: 'nav.settings',
  taskDetail: 'nav.tasks',
  logs: 'nav.logs',
}

export default function App() {
  const { t, lang, setLang } = useI18n()
  const [page, setPage] = useState<Page>('dashboard')
  const [selectedFolder, setSelectedFolder] = useState<FolderSelection | null>(null)
  const [selectedProject, setSelectedProject] = useState<{ id: number; name: string } | null>(null)
  const [taskReturn, setTaskReturn] = useState<Page>('tasks')

  const navItems: Page[] = ['dashboard', 'projects', 'accounts', 'tasks', 'logs', 'settings']

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <aside style={{ width: '220px', background: '#ffffff', borderRight: '1px solid #e5e5e5', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '0 16px 24px', fontSize: '18px', fontWeight: '700', color: '#1a1a1a' }}>{t('app.title')}</div>
        <nav style={{ flex: 1, overflowY: 'auto', padding: '0 8px' }}>
          {navItems.map((p) => {
            const active = page === p || (page === 'taskDetail' && p === 'tasks') || (page === 'projectWorkspace' && p === 'projects')
            return (
              <a
                key={p}
                href="#"
                onClick={(e) => { e.preventDefault(); setPage(p) }}
                style={{
                  display: 'block',
                  padding: '10px 12px',
                  color: active ? '#166534' : '#4b5563',
                  textDecoration: 'none',
                  borderRadius: '8px',
                  marginBottom: '4px',
                  fontWeight: active ? '600' : '500',
                  background: active ? '#f0fdf4' : 'transparent',
                }}
              >
                {t(PAGE_LABELS[p])}
              </a>
            )
          })}
        </nav>
        <div style={{ padding: '16px', borderTop: '1px solid #e5e5e5' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#6b7280' }}>
            {t('lang.zh')} / {t('lang.en')}
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value as any)}
              style={{ marginLeft: '6px', fontSize: '13px' }}
            >
              <option value="zh-CN">{t('lang.zh')}</option>
              <option value="en-US">{t('lang.en')}</option>
            </select>
          </label>
        </div>
      </aside>
      <main style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
        <NotificationCenter onOpenTask={async (id) => {
          try {
            const loc = await taskFolderLocator(id)
            if (loc) {
              setSelectedFolder({ projectId: loc[0], folder: loc[1], taskId: id })
              setTaskReturn('tasks')
              setPage('taskDetail')
            }
          } catch (e) {
            console.error('定位任务文件夹失败:', e)
          }
        }} />
        {page === 'dashboard' && <DashboardPage />}
        {page === 'projects' && <ProjectsPage onOpenProject={(id, name) => { setSelectedProject({ id, name }); setPage('projectWorkspace') }} />}
        {page === 'projectWorkspace' && selectedProject && (
          <ProjectWorkspace
            projectId={selectedProject.id}
            projectName={selectedProject.name}
            onOpenTask={(sel) => { setSelectedFolder(sel); setTaskReturn('projectWorkspace'); setPage('taskDetail') }}
            onBack={() => setPage('projects')}
          />
        )}
        {page === 'accounts' && <AccountsPage />}
        {page === 'tasks' && <ExecutionPage onFolderSelect={(sel) => { setSelectedFolder(sel); setTaskReturn('tasks'); setPage('taskDetail') }} />}
        {page === 'taskDetail' && selectedFolder && <RoundDetail selection={selectedFolder} onBack={() => setPage(taskReturn)} />}
        {page === 'logs' && <LogsPage />}
        {page === 'settings' && <SettingsPage />}
      </main>
    </div>
  )
}
