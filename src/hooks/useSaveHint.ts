import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 保存成功后的短暂行内提示。
 * 原生 message 对话框在 Tauri/WebView2 下容易被忽略，所以保存按钮旁必须给出可见反馈。
 * 定时器在卸载或下次保存时清理，避免旧提示串到别的保存区域。
 */
export function useSaveHint(durationMs = 2500) {
  const [hint, setHint] = useState('')
  const timer = useRef<number | null>(null)

  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  useEffect(() => clear, [clear])

  const markSaved = useCallback(
    (text: string) => {
      clear()
      setHint(text)
      timer.current = window.setTimeout(() => {
        setHint('')
        timer.current = null
      }, durationMs)
    },
    [clear, durationMs],
  )

  return { hint, markSaved }
}
