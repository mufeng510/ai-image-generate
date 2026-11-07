import { useI18n } from '@/i18n'

/** UI labels for task/round statuses, backed by i18n resources */
export function useTaskStatusLabels(): Record<string, string> {
  const { t } = useI18n()
  return {
    pending: t('tasks.status.pending'),
    preparing: t('tasks.status.preparing'),
    selecting_images: t('tasks.status.selecting_images'),
    waiting_confirmation: t('tasks.status.waiting_confirmation'),
    uploading: t('tasks.status.uploading'),
    submitting: t('tasks.status.submitting'),
    generating: t('tasks.status.generating'),
    downloading: t('tasks.status.downloading'),
    verifying: t('tasks.status.verifying'),
    completed: t('tasks.status.completed'),
    failed: t('tasks.status.failed'),
    paused: t('tasks.status.paused'),
    cancelled: t('tasks.status.cancelled'),
    needs_manual_intervention: t('tasks.status.needs_manual_intervention'),
  }
}

/** UI labels for human confirmation nodes */
export function useConfirmNodeLabels(): Record<string, string> {
  const { t } = useI18n()
  return {
    confirm_selection: t('tasks.confirmNode.confirm_selection'),
    confirm_before_submit: t('tasks.confirmNode.confirm_before_submit'),
  }
}

/** UI labels for task_images.download_status */
export function useDownloadStatusLabels(): Record<string, string> {
  const { t } = useI18n()
  return {
    pending: t('downloads.pending'),
    downloading: t('downloads.downloading'),
    verified: t('downloads.verified'),
    failed: t('downloads.failed'),
  }
}
