/**
 * src/pages/RoundDetail.tsx
 *
 * 任务详情页：展示单个生成轮次的图片、元数据和下载状态。
 * 通过 Tauri Commands 获取任务轮次详情和图片列表。
 */

import { useState, useEffect } from 'react'
import {
  taskListRounds,
  taskListImages,
  type TaskRound,
  type TaskImage,
} from '@/hooks/api'

const STATUS_LABELS: Record<string, string> = {
  preparing: '准备中',
  selecting_images: '抽图中',
  waiting_confirmation: '等待确认',
  uploading: '上传中',
  submitting: '提交中',
  generating: '生成中',
  downloading: '下载中',
  verifying: '校验中',
  completed: '已完成',
  paused: '已暂停',
  failed: '失败',
  cancelled: '已取消',
  needs_manual_intervention: '需人工干预',
}

const STATUS_COLORS: Record<string, string> = {
  preparing: '#6b7280',
  selecting_images: '#6b7280',
  waiting_confirmation: '#d97706',
  uploading: '#2563eb',
  submitting: '#2563eb',
  generating: '#2563eb',
  downloading: '#2563eb',
  verifying: '#2563eb',
  completed: '#16a34a',
  paused: '#ea580c',
  failed: '#dc2626',
  cancelled: '#6b7280',
  needs_manual_intervention: '#dc2626',
}

const DOWNLOAD_STATUS_LABELS: Record<string, string> = {
  pending: '待下载',
  downloading: '下载中',
  verified: '已完成',
  failed: '失败',
}

export default function RoundDetail({ taskId, onBack }: { taskId: number; onBack?: () => void }) {
  const [rounds, setRounds] = useState<TaskRound[]>([])
  const [images, setImages] = useState<TaskImage[]>([])
  const [, setLoading] = useState(false)
  const [selectedRoundId, setSelectedRoundId] = useState<number | null>(null)

  useEffect(() => {
    loadRounds(taskId)
  }, [taskId])

  const loadRounds = async (taskId: number) => {
    setLoading(true)
    try {
      const data = await taskListRounds(taskId)
      setRounds(data)
      if (data.length > 0 && !selectedRoundId) {
        setSelectedRoundId(data[0].id ?? null)
      }
    } catch (e) {
      console.error('加载轮次失败:', e)
    } finally {
      setLoading(false)
    }
  }

  const loadRoundImages = async (roundId: number) => {
    setLoading(true)
    try {
      const data = await taskListImages(roundId)
      setImages(data)
    } catch (e) {
      console.error('加载图片失败:', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (selectedRoundId) {
      loadRoundImages(selectedRoundId)
    }
  }, [selectedRoundId])

  const selectedRound = rounds.find((r) => r.id === selectedRoundId)

  return (
    <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ fontSize: '20px', fontWeight: '600', margin: 0 }}>生成详情</h2>
        {onBack && (
          <button
            onClick={onBack}
            style={{ padding: '6px 12px', border: '1px solid #d1d5db', borderRadius: '6px', background: '#fff', cursor: 'pointer', fontSize: '13px' }}
          >
            ← 返回任务列表
          </button>
        )}
      </div>

      {/* 轮次列表 */}
      <div style={{ background: '#fff', border: '1px solid #e5e5e5', borderRadius: '12px', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>轮次</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>状态</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>成功/总数</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>提交时间</th>
              <th style={{ padding: '12px', textAlign: 'left', color: '#6b7280', fontSize: '13px' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rounds.map((round) => (
              <tr
                key={round.id}
                style={{
                  borderBottom: '1px solid #e5e5e5',
                  cursor: 'pointer',
                  backgroundColor: selectedRoundId === round.id ? '#f0fdf4' : 'transparent',
                }}
                onClick={() => setSelectedRoundId(round.id ?? null)}
              >
                <td style={{ padding: '10px', fontSize: '13px', color: '#6b7280' }}>
                  第 {round.round_number ?? 0} 轮
                </td>
                <td style={{ padding: '10px' }}>
                  <span
                    style={{
                      display: 'inline-block',
                      padding: '2px 8px',
                      borderRadius: '10px',
                      fontSize: '11px',
                      fontWeight: '500',
                      color: '#fff',
                      backgroundColor:
                        STATUS_COLORS[round.status || ''] || '#6b7280',
                    }}
                  >
                    {STATUS_LABELS[round.status || ''] || round.status}
                  </span>
                </td>
                <td style={{ padding: '10px', fontSize: '13px', color: '#6b7280' }}>
                  {round.success_count ?? 0} /
                  {round.success_count ?? 0 + (round.failure_reason ? 0 : 0)}
                </td>
                <td style={{ padding: '10px', fontSize: '13px', color: '#6b7280' }}>
                  {round.submitted_at || '-'}
                </td>
                <td style={{ padding: '10px' }}>
                  {selectedRoundId === round.id ? (
                    <span style={{ color: '#16a34a', fontSize: '11px' }}>已选中</span>
                  ) : (
                    <button
                      onClick={() => setSelectedRoundId(round.id ?? null)}
                      style={{ background: '#f3f4f6', border: 'none', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
                    >
                      查看
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rounds.length === 0 && (
              <tr>
                <td colSpan={5} style={{ padding: '24px', textAlign: 'center', color: '#9ca3af' }}>
                  暂无轮次
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 图片详情 */}
      {selectedRound && (
        <div style={{ background: '#fff', border: '1px solid #e5e5e5', borderRadius: '12px', overflow: 'hidden' }}>
          <div style={{ padding: '16px 24px', borderBottom: '1px solid #e5e5e5', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: '16px', fontWeight: '600', color: '#1a1a1a' }}>第 {selectedRound.round_number} 轮</div>
              <div style={{ fontSize: '13px', color: '#6b7280' }}>
                {STATUS_LABELS[selectedRound.status || ''] || selectedRound.status}
              </div>
            </div>
            <div style={{ fontSize: '13px', color: '#6b7280', textAlign: 'right' }}>
              {selectedRound.submitted_at || '-'}{' | '}
              {selectedRound.completed_at || '-'}
            </div>
          </div>

          <div style={{ padding: '24px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '16px' }}>
              {images.length > 0 ? (
                images.map((img) => (
                  <div key={img.id} style={{ border: '1px solid #e5e5e5', borderRadius: '8px', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ position: 'relative', width: '100%', aspectRatio: '1', background: '#f3f4f6', overflow: 'hidden' }}>
                      {img.saved_path ? (
                        <img
                          src={`file://${img.saved_path}`}
                          alt={`图片 ${img.image_index}`}
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          onError={(e) => {
                            (e.target as HTMLElement).style.display = 'none'
                          }}
                        />
                      ) : (
                        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', fontSize: '12px' }}>
                          图片不可用
                        </div>
                      )}
                      <div style={{ position: 'absolute', top: '4px', left: '4px', background: 'rgba(0,0,0,0.6)', color: '#fff', padding: '2px 6px', borderRadius: '4px', fontSize: '11px' }}>
                        {img.image_index}
                      </div>
                    </div>
                    <div style={{ padding: '8px' }}>
                      <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '4px' }}>
                        {img.original_url?.split('/').pop() || '未知'}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#9ca3af' }}>
                        <span>{img.format || '-'}</span>
                        <span>{img.file_size ? (img.file_size / 1024).toFixed(1) + ' KB' : '-'}</span>
                        <span style={{ color: img.download_status === 'verified' ? '#16a34a' : '#dc2626' }}>
                          {DOWNLOAD_STATUS_LABELS[img.download_status || ''] || img.download_status}
                        </span>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>
                  暂无图片
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
