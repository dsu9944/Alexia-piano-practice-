import { useEffect, useState } from 'react'
import {
  downloadBlob,
  extensionForAudioMime,
  PLAYBACK_RETRY_TYPES,
  reviveAudioBlob,
} from '../lib/audioMime'
import type { Take } from '../types'

interface Props {
  takes: Take[]
  selectedId: string | null
  onSelect: (take: Take) => void
  onDelete: (id: string) => void
  onUpdateNotes: (id: string, notes: string) => void
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function formatDur(ms: number): string {
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function downloadTake(take: Take): void {
  const ext = extensionForAudioMime(take.blob.type)
  const stamp = new Date(take.createdAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')
  downloadBlob(take.blob, `alexia-take-${take.pieceId}-${stamp}.${ext}`)
}

export function TakesList({ takes, selectedId, onSelect, onDelete, onUpdateNotes }: Props) {
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [playErrors, setPlayErrors] = useState<Record<string, string>>({})
  const [retryIndex, setRetryIndex] = useState<Record<string, number>>({})

  // Only rebuild players when audio identity changes — not after Compare
  // updates analysis/reference on the same take blob (Safari “Error” flicker).
  const audioKey = takes.map((t) => `${t.id}:${t.blob.size}:${t.blob.type}`).join('|')

  useEffect(() => {
    let cancelled = false
    const created: string[] = []
    const snapshot = takes

    void (async () => {
      const next: Record<string, string> = {}
      for (const t of snapshot) {
        try {
          const revived = await reviveAudioBlob(t.blob)
          const url = URL.createObjectURL(revived)
          created.push(url)
          next[t.id] = url
        } catch {
          const url = URL.createObjectURL(t.blob)
          created.push(url)
          next[t.id] = url
        }
      }
      if (!cancelled) {
        setUrls(next)
        setPlayErrors({})
        setRetryIndex({})
      } else {
        created.forEach((u) => URL.revokeObjectURL(u))
      }
    })()

    return () => {
      cancelled = true
      created.forEach((u) => URL.revokeObjectURL(u))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by audioKey
  }, [audioKey])

  const handleAudioError = async (take: Take) => {
    const idx = retryIndex[take.id] ?? 0
    if (idx < PLAYBACK_RETRY_TYPES.length) {
      const nextType = PLAYBACK_RETRY_TYPES[idx]
      try {
        const rewrapped = await reviveAudioBlob(take.blob, nextType)
        const url = URL.createObjectURL(rewrapped)
        setUrls((prev) => {
          if (prev[take.id]) URL.revokeObjectURL(prev[take.id])
          return { ...prev, [take.id]: url }
        })
        setRetryIndex((prev) => ({ ...prev, [take.id]: idx + 1 }))
        return
      } catch (err) {
        console.warn('Playback rewrap failed', nextType, err)
        setRetryIndex((prev) => ({ ...prev, [take.id]: idx + 1 }))
      }
    }
    setPlayErrors((prev) => ({
      ...prev,
      [take.id]:
        'Safari couldn’t play this yet — try Download to keep the file, then open it in QuickTime or Chrome.',
    }))
  }

  if (takes.length === 0) {
    return (
      <div className="takes card">
        <h2>Saved takes</h2>
        <p className="hint">No recordings yet for this piece. Record one above.</p>
      </div>
    )
  }

  return (
    <div className="takes card">
      <h2>Saved takes</h2>
      <ul className="takes-list">
        {takes.map((take) => (
          <li key={take.id} className={`take-item${selectedId === take.id ? ' selected' : ''}`}>
            <div className="take-header">
              <button type="button" className="linkish" onClick={() => onSelect(take)}>
                {formatDate(take.createdAt)} · {formatDur(take.durationMs)}
                {take.analysis && (
                  <span className={`badge ${take.analysis.mode}`}>
                    {take.analysis.mode === 'comparison' ? 'vs reference' : 'solo check'}
                  </span>
                )}
              </button>
              <div className="take-actions">
                <button type="button" className="btn tiny ghost" onClick={() => downloadTake(take)}>
                  Download
                </button>
                <button type="button" className="btn tiny ghost" onClick={() => onDelete(take.id)}>
                  Delete
                </button>
              </div>
            </div>
            {urls[take.id] && !playErrors[take.id] && (
              <audio
                controls
                src={urls[take.id]}
                onError={() => {
                  void handleAudioError(take)
                }}
              />
            )}
            {playErrors[take.id] && (
              <p className="play-error hint" role="status">
                {playErrors[take.id]}{' '}
                <button type="button" className="linkish" onClick={() => downloadTake(take)}>
                  Download take
                </button>
              </p>
            )}
            <label className="notes-label">
              Notes for this take
              <textarea
                value={take.notes}
                rows={2}
                onChange={(e) => onUpdateNotes(take.id, e.target.value)}
                placeholder="e.g. keep right hand softer in the B section"
              />
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}
