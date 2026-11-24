import { ask, message as tauriMessage } from '@tauri-apps/plugin-dialog'

/** 显示一条非阻塞消息（Tauri 原生对话框）。不等待用户操作。 */
export function notify(text: unknown): void {
  void tauriMessage(String(text))
}

/** 显示阻塞式确认对话框，返回用户是否确认。 */
export function askConfirm(text: string, title?: string): Promise<boolean> {
  return ask(text, { kind: 'warning', ...(title ? { title } : {}) })
}
