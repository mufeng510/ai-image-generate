/**
 * src/pages/RoundDetail.tsx
 *
 * 任务详情：轮次与图片直接从任务文件夹里的 task.json / 图片文件读取。
 * 文件夹是记录真相源，数据库只提供运行中与实况生成的事件。
 */

import { useState, useEffect, useCallback } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  taskFolderDetail,
  taskFolderOpen,
  taskFolderDeleteImage,
  livePhotoGenerate,
  type TaskFolderDetail,
  type FolderSelection,
  type LivePhotoFinished,
} from '@/hooks/api'
import { useI18n } from '@/i18n'

export default function RoundDetail({ selection, onBack }: { selection: FolderSelection; onBack?: () => void }) {
  const { t } = useI18n()
  const [detail, setDetail] = useState<TaskFolderDetail | null>(null)
  const [selectedRoundDir, setSelectedRoundDir] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  /** 实况生成状态：job_id（'pending' = 请求已发出）与最近一条进度/结果 */
  const [livePhotoJob, setLivePhotoJob] = useState<string | null>(null)
  const [livePhotoStatus, setLivePhotoStatus] = useState('')
  const [deletingFile, setDeletingFile] = useState<string | null>(null)

  const loadDetail = useCallback(async () => {
    setLoading(true)
    try {
      const data = await taskFolderDetail(selection.projectId, selection.folder)
      setDetail(data)
      setSelectedRoundDir((prev) => {
        if (prev && data.rounds.some((r) => r.dir === prev)) return prev
        return data.rounds[0]?.dir ?? null
      })
    } catch (e) {
      console.error('加载任务文件夹失败:', e)
    } finally {
      setLoading(false)
    }
  }, [selection.projectId, selection.folder])

  useEffect(() => {
    loadDetail()
  }, [loadDetail])

  // 实况事件：只响应当前任务的 job
  useEffect(() => {
    if (selection.taskId == null) return
    let unlistenProgress: (() => void) | null = null
    let unlistenFinished: (() => void) | null = null
    ;(async () => {
      unlistenProgress = await listen<{ task_id: number; job_id: string; line: string }>(
        'live-photo-progress',
        (event) => {
          if (event.payload.task_id === selection.taskId) setLivePhotoStatus(event.payload.line)
        },
      )
      unlistenFinished = await listen<LivePhotoFinished>('live-photo-finished', (event) => {
        const r = event.payload
        if (r.task_id !== selection.taskId) return
        setLivePhotoJob(null)
        if (r.ok) {
          setLivePhotoStatus(
            t('tasks.livePhotoDone', { id: selection.taskId, count: r.success })
            + (r.cleanup_note ? ` · ${r.cleanup_note}` : ''),
          )
          if (r.records_cleaned && onBack) {
            onBack()
          } else {
            loadDetail()
          }
        } else {
          const reason = r.error || r.preflight_error || ''
          setLivePhotoStatus(t('tasks.livePhotoFailed', { id: selection.taskId }) + (reason ? `：${reason}` : ''))
        }
      })
    })()
    return () => {
      unlistenProgress?.()
      unlistenFinished?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.taskId, loadDetail])

  const handleLivePhoto = async () => {
    if (selection.taskId == null) return
    setLivePhotoJob('pending')
    setLivePhotoStatus(t('tasks.livePhotoStarted', { id: selection.taskId }))
    try {
      const jobId = await livePhotoGenerate(selection.taskId)
      setLivePhotoJob(jobId)
    } catch (e) {
      setLivePhotoJob(null)
      setLivePhotoStatus(t('tasks.livePhotoFailed', { id: selection.taskId }) + e)
    }
  }

  const handleDeleteImage = async (fileName: string) => {
    if (!window.confirm(t('roundDetail.deleteImageConfirm'))) return
    if (!selectedRoundDir) return
    setDeletingFile(fileName)
    try {
      await taskFolderDeleteImage(selection.projectId, selection.folder, selectedRoundDir, fileName)
      await loadDetail()
    } catch (e) {
      alert(t('roundDetail.deleteImageFailed') + e)
    } finally {
      setDeletingFile(null)
    }
  }

  const handleOpenFolder = async (roundDir?: string) => {
    try {
      await taskFolderOpen(selection.projectId, selection.folder, roundDir)
    } catch (e) {
      alert(t('roundDetail.openFolderFailed') + e)
    }
  }

  const selectedRound = detail?.rounds.find((r) => r.dir === selectedRoundDir) ?? null
  const totalImages = detail?.rounds.reduce((sum, r) => sum + r.image_count, 0) ?? 0

  return (
    <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '20px', fontWeight: '600', margin: 0 }}>{t('roundDetail.title')}</h2>
          <div style={{ fontSize: '13px', color: '#6b7280', marginTop: '4px' }}>
            {t('roundDetail.folderLabel')}: {selection.folder}
            {' · '}
            {t('roundDetail.allImages')}: {totalImages}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {selection.taskId != null && detail && detail.rounds.length > 0 && (
            <button
              onClick={handleLivePhoto}
              disabled={!!livePhotoJob}
              title={t('tasks.livePhotoHint')}
              style={{ background: livePhotoJob ? '#6b7280' : '#7c3aed', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: '6px', cursor: livePhotoJob ? 'not-allowed' : 'pointer', fontSize: '12px', whiteSpace: 'nowrap' }}
            >
              {livePhotoJob ? t('btn.generatingLivePhoto') : t('btn.generateLivePhoto')}
            </button>
          )}
          <button
            onClick={() => loadDetail()}
            style={{ padding: '6px 12px', border: '1px solid #d1d5db', borderRadius: '6px', background: '#fff', cursor: 'pointer', fontSize: '13px' }}
          >
            {t('btn.refresh')}
          </button>
          {onBack && (
            <button
              onClick={onBack}
              style={{ padding: '6px 12px', border: '1px solid #d1d5db', borderRadius: '6px', background: '#fff', cursor: 'pointer', fontSize: '13px' }}
            >
              ← {t('roundDetail.back')}
            </button>
          )}
        </div>
      </div>

      {livePhotoStatus && (
        <div style={{ background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: '8px', padding: '10px 14px', fontSize: '12px', color: '#5b21b6', overflowWrap: 'anywhere' }}>
          {livePhotoStatus}
        </div>
      )}

      {/* 轮次列表：来自任务文件夹下的子目录 */}
      <div style={{ background: '#fff', border: '1px solid #e5e5e5', borderRadius: '12px', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>{t('roundDetail.tableRound')}</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>{t('roundDetail.roundDir')}</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>{t('tasks.imageHeader')}</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>{t('tasks.actionsHeader')}</th>
            </tr>
          </thead>
          <tbody>
            {detail?.rounds.map((round) => (
              <tr
                key={round.dir}
                style={{
                  borderBottom: '1px solid #e5e5e5', cursor: 'pointer',
                  backgroundColor: selectedRoundDir === round.dir ? '#f0fdf4' : 'transparent',
                }}
                onClick={() => setSelectedRoundDir(round.dir)}
              >
                <td style={{ padding: '10px', fontSize: '13px' }}>
                  {t('roundDetail.batchRound', { n: round.round_number ?? 0 })}
                </td>
                <td style={{ padding: '10px', fontSize: '12px', color: '#6b7280' }}>{round.dir}</td>
                <td style={{ padding: '10px', fontSize: '13px', color: '#6b7280' }}>{round.image_count}</td>
                <td style={{ padding: '10px' }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleOpenFolder(round.dir) }}
                    style={{ background: '#166534', color: '#fff', border: 'none', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
                  >
                    {t('roundDetail.openFolder')}
                  </button>
                </td>
              </tr>
            ))}
            {(!detail || detail.rounds.length === 0) && (
              <tr>
                <td colSpan={4} style={{ padding: '24px', textAlign: 'center', color: '#9ca3af' }}>
                  {loading ? '…' : t('roundDetail.none')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 图片网格：支持勾选式删除（逐张） */}
      {selectedRound && (
        <div style={{ background: '#fff', border: '1px solid #e5e5e5', borderRadius: '12px', overflow: 'hidden' }}>
          <div style={{ padding: '16px 24px', borderBottom: '1px solid #e5e5e5', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '16px', fontWeight: '600', color: '#1a1a1a' }}>
                {t('roundDetail.batchRound', { n: selectedRound.round_number ?? 0 })}
              </div>
              <div style={{ fontSize: '12px', color: '#6b7280', maxWidth: '620px', overflowWrap: 'anywhere' }}>
                {selectedRound.prompt ? `${t('roundDetail.promptLabel')}: ${selectedRound.prompt}` : '-'}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button
                onClick={() => handleOpenFolder(selectedRound.dir)}
                style={{ background: '#f3f4f6', color: '#374151', border: 'none', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', whiteSpace: 'nowrap' }}
              >
                {t('roundDetail.openFolder')}
              </button>
            </div>
          </div>
          <div style={{ padding: '24px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '16px' }}>
              {selectedRound.images.length > 0 ? (
                selectedRound.images.map((img) => (
                  <div key={img.file} style={{ border: '1px solid #e5e5e5', borderRadius: '8px', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ position: 'relative', width: '100%', aspectRatio: '1', background: '#f3f4f6', overflow: 'hidden' }}>
                      <img
                        src={convertFileSrc(img.path)}
                        alt={t('roundDetail.altImage', { n: img.index ?? 0 })}
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        onError={(e) => { (e.target as HTMLElement).style.display = 'none' }}
                      />
                      <div style={{ position: 'absolute', top: '4px', left: '4px', background: 'rgba(0,0,0,0.6)', color: '#fff', padding: '2px 6px', borderRadius: '4px', fontSize: '11px' }}>
                        {img.index ?? img.file}
                      </div>
                      <button
                        onClick={() => handleDeleteImage(img.file)}
                        disabled={deletingFile === img.file}
                        title={t('roundDetail.deleteImageHint')}
                        style={{ position: 'absolute', top: '4px', right: '4px', background: 'rgba(220,38,38,0.9)', color: '#fff', border: 'none', padding: '2px 8px', borderRadius: '4px', cursor: deletingFile === img.file ? 'not-allowed' : 'pointer', fontSize: '11px' }}
                      >
                        {deletingFile === img.file ? '…' : t('roundDetail.deleteImage')}
                      </button>
                    </div>
                    <div style={{ padding: '8px' }}>
                      <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '4px', overflowWrap: 'anywhere' }}>{img.file}</div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#9ca3af' }}>
                        <span>{img.format || '-'}</span>
                        <span>{img.size ? (img.size / 1024).toFixed(1) + ' KB' : '-'}</span>
                        <span style={{ color: img.ok === false ? '#dc2626' : '#16a34a' }}>
                          {img.ok === false ? t('roundDetail.unknown') : t('roundDetail.selected')}
                        </span>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>
                  {t('roundDetail.noImages')}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
