import { createContext, useContext, useState, ReactNode } from 'react'

type Lang = 'zh-CN' | 'en-US'

interface I18nContextType {
  lang: Lang
  t: (key: string) => string
  setLang: (lang: Lang) => void
}

const I18nContext = createContext<I18nContextType | null>(null)

const translations: Record<Lang, Record<string, string>> = {
  'zh-CN': {
    'app.title': '豆包批量生图',
    'nav.dashboard': '仪表盘',
    'nav.projects': '项目管理',
    'nav.accounts': '账号管理',
    'nav.tasks': '任务队列',
    'nav.logs': '执行日志',
    'nav.settings': '设置',
    'btn.create': '创建',
    'btn.delete': '删除',
    'btn.start': '开始',
    'btn.pause': '暂停',
    'btn.continue': '继续',
    'btn.cancel': '取消',
    'lang.zh': '中文',
    'lang.en': 'English',
  },
  'en-US': {
    'app.title': 'Doubao Batch Image Generate',
    'nav.dashboard': 'Dashboard',
    'nav.projects': 'Projects',
    'nav.accounts': 'Accounts',
    'nav.tasks': 'Task Queue',
    'nav.logs': 'Logs',
    'nav.settings': 'Settings',
    'btn.create': 'Create',
    'btn.delete': 'Delete',
    'btn.start': 'Start',
    'btn.pause': 'Pause',
    'btn.continue': 'Continue',
    'btn.cancel': 'Cancel',
    'lang.zh': '中文',
    'lang.en': 'English',
  },
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>('zh-CN')
  const t = (key: string) => translations[lang][key] || key
  return (
    <I18nContext.Provider value={{ lang, t, setLang }}>
      {children}
    </I18nContext.Provider>
  )
}

export function useI18n() {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}
