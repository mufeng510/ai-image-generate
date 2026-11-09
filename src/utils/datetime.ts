/**
 * src/utils/datetime.ts
 *
 * 时间展示统一入口：数据库中存的是 Rust `Utc::now().to_rfc3339()`（UTC，含纳秒），
 * 界面统一按本地时间（用户实际时区）显示，去掉毫秒/纳秒与 +00:00 后缀。
 */

/** 格式化为 `YYYY-MM-DD HH:mm:ss`（本地时间）；withSeconds=false 截到分钟 */
export function formatDateTime(value?: string | null, withSeconds = true): string {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) {
    // 无法解析：退化为去掉 T 的朴素 UTC 形式，宁可显示原文也不崩
    return value.replace('T', ' ').slice(0, 19)
  }
  const pad = (n: number) => String(n).padStart(2, '0')
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  return withSeconds ? `${base}:${pad(d.getSeconds())}` : base
}
