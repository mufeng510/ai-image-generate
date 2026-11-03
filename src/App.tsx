import { useState } from 'react'
import { useI18n } from '@/i18n'
import DashboardPage from '@/pages/Dashboard'
import ProjectsPage from '@/pages/Projects'
import AccountsPage from '@/pages/Accounts'
import ExecutionPage from '@/pages/Execution'
import RoundDetail from '@/pages/RoundDetail'
import LogsPage from '@/pages/Logs'
import SettingsPage from '@/pages/Settings'

type Page = 'dashboard' | 'projects' | 'accounts' | 'tasks' | 'settings' | 'taskDetail' | 'logs'

const PAGE_LABELS: Record<Page, string> = {
  dashboard: 'nav.dashboard',
  projects: 'nav.projects',
  accounts: 'nav.accounts',
  tasks: 'nav.tasks',
  settings: 'nav.settings',
  taskDetail: 'nav.tasks',
  logs: 'nav.logs',
}

export default function App() {
  const { t, lang, setLang } = useI18n()
  const [page, setPage] = useState<Page>('dashboard')
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null)

  const navItems: Page[] = ['dashboard', 'projects', 'accounts', 'tasks', 'logs', 'settings']

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <aside style={{ width: '220px', background: '#ffffff', borderRight: '1px solid #e5e5e5', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '0 16px 24px', fontSize: '18px', fontWeight: '700', color: '#1a1a1a' }}>{t('app.title')}</div>
        <nav style={{ flex: 1, overflowY: 'auto', padding: '0 8px' }}>
          {navItems.map((p) => {
            const active = page === p || (page === 'taskDetail' && p === 'tasks')
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
        {page === 'dashboard' && <DashboardPage />}
        {page === 'projects' && <ProjectsPage />}
        {page === 'accounts' && <AccountsPage />}
        {page === 'tasks' && <ExecutionPage onTaskSelect={setSelectedTaskId} onBack={setPage} />}
        {page === 'taskDetail' && selectedTaskId && <RoundDetail taskId={selectedTaskId} />}
        {page === 'logs' && <LogsPage />}
        {page === 'settings' && <SettingsPage />}
      </main>
    </div>
  )
}
