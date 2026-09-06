import { useEffect, useState } from 'react'
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

export function TakesList({ takes, selectedId, onSelect, onDelete, onUpdateNotes }: Props) {
  const [urls, setUrls] = useState<Record<string, string>>({})

  useEffect(() => {
    const next: Record<string, string> = {}
    for (const t of takes) {
      next[t.id] = URL.createObjectURL(t.blob)
    }
    setUrls(next)
    return () => {
      Object.values(next).forEach((u) => URL.revokeObjectURL(u))
    }
  }, [takes])

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
              <button type="button" className="btn tiny ghost" onClick={() => onDelete(take.id)}>
                Delete
              </button>
            </div>
            {urls[take.id] && <audio controls src={urls[take.id]} />}
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
