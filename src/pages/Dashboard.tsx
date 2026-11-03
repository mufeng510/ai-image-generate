import { useState, useEffect } from 'react'
import { useI18n } from '@/i18n'
import { dashboardStats } from '@/hooks/api'

export default function DashboardPage() {
  const { t } = useI18n()
  const [stats, setStats] = useState<{
    total_projects: number
    total_accounts: number
    total_tasks: number
    completed_tasks: number
    total_images: number
    pending_tasks: number
    failed_tasks: number
  } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    dashboardStats()
      .then(setStats)
      .finally(() => setLoading(false))
  }, [])

  return (
    <div style={{ padding: '24px' }}>
      <h2 style={{ fontSize: '24px', fontWeight: '600', marginBottom: '24px' }}>{t('nav.dashboard')}</h2>
      {loading ? (
        <div style={{ color: '#6b7280' }}>加载中...</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: '16px', marginBottom: '24px' }}>
            <StatCard title={t('nav.projects')} value={stats?.total_projects ?? 0} color='#2563eb' />
            <StatCard title={t('nav.accounts')} value={stats?.total_accounts ?? 0} color='#16a34a' />
            <StatCard title={t('nav.tasks')} value={stats?.total_tasks ?? 0} color='#dc2626' />
            <StatCard title='完成任务' value={stats?.completed_tasks ?? 0} color='#059669' />
            <StatCard title='失败任务' value={stats?.failed_tasks ?? 0} color='#ef4444' />
            <StatCard title='生成图片' value={stats?.total_images ?? 0} color='#7c3aed' />
          </div>
          <div style={{ background: '#fff', border: '1px solid #e5e5e5', borderRadius: '12px', padding: '24px' }}>
            <p style={{ color: '#6b7280' }}>欢迎使用豆包批量生图桌面软件。请从左侧导航选择功能模块。</p>
          </div>
        </>
      )}
    </div>
  )
}

function StatCard({ title, value, color }: { title: string; value: number; color: string }) {
  return (
    <div style={{ background: '#f9fafb', border: '1px solid #e5e5e5', borderRadius: '8px', padding: '16px', flex: 1 }}>
      <div style={{ fontSize: '13px', color: '#6b7280', marginBottom: '8px' }}>{title}</div>
      <div style={{ fontSize: '32px', fontWeight: '700', color }}>{value}</div>
    </div>
  )
}
