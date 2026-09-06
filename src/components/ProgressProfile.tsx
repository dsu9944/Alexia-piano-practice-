import { useEffect, useState } from 'react'
import {
  getPiecePracticeSectionsWithLegacyFallback,
  getTakeSectionTimesMany,
} from '../lib/storage'
import type { PracticeSection, Take, TakeSectionTimes } from '../types'
import { StarDisplay } from './StarRating'
import { StickerChips } from './StickerPicker'

interface Props {
  pieceId: string
  takes: Take[]
  /** Bump when stars/stickers change so profile refreshes. */
  refreshKey?: number
}

type Trend = 'improving' | 'same' | 'needs-work' | 'new'

function trendLabel(t: Trend): string {
  switch (t) {
    case 'improving':
      return 'Getting better 🌟'
    case 'same':
      return 'Steady 👍'
    case 'needs-work':
      return 'Keep practising 💪'
    case 'new':
      return 'Just starting 🌱'
  }
}

function sectionTrend(history: (number | undefined)[]): Trend {
  const rated = history.filter((n): n is number => typeof n === 'number' && n >= 1)
  if (rated.length === 0) return 'new'
  if (rated.length === 1) return 'new'
  const latest = rated[0]
  const prev = rated[1]
  if (latest > prev) return 'improving'
  if (latest < prev) return 'needs-work'
  return 'same'
}

function avgStars(row: TakeSectionTimes | undefined, sectionIds: string[]): number | null {
  if (!row?.starsBySection) return null
  const vals: number[] = []
  for (const id of sectionIds) {
    const s = row.starsBySection[id]
    if (typeof s === 'number' && s >= 1 && s <= 5) vals.push(s)
  }
  if (vals.length === 0) return null
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10
}

function formatTakeDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

function overallCompare(
  latest: number | null,
  previous: number | null,
): string {
  if (latest == null) return 'Tap stars after listening to start the story.'
  if (previous == null) return `Latest practice averaged ${latest} ★ — nice start!`
  if (latest > previous) return `Latest ${latest} ★ vs last time ${previous} ★ — going up!`
  if (latest < previous) return `Latest ${latest} ★ vs last time ${previous} ★ — keep going, you’ve got this.`
  return `Latest ${latest} ★ — same as last time. Steady work!`
}

export function ProgressProfile({ pieceId, takes, refreshKey = 0 }: Props) {
  const [sections, setSections] = useState<PracticeSection[]>([])
  const [meta, setMeta] = useState<Record<string, TakeSectionTimes>>({})

  // Newest first; last 3 practices
  const recent = takes.slice(0, 3)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { row } = await getPiecePracticeSectionsWithLegacyFallback(pieceId)
        if (cancelled) return
        setSections(row?.sections ?? [])
      } catch {
        if (!cancelled) setSections([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pieceId])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const ids = recent.map((t) => t.id)
        const rows = await getTakeSectionTimesMany(ids)
        if (!cancelled) setMeta(rows)
      } catch {
        if (!cancelled) setMeta({})
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pieceId, takes.map((t) => t.id).join('|'), refreshKey])

  const sectionIds = sections.map((s) => s.id)
  const latestAvg = recent[0] ? avgStars(meta[recent[0].id], sectionIds) : null
  const prevAvg = recent[1] ? avgStars(meta[recent[1].id], sectionIds) : null

  // Collect stickers from last 3 takes (take + section)
  const earnedStickers: string[] = []
  const seen = new Set<string>()
  for (const take of recent) {
    const row = meta[take.id]
    if (!row) continue
    for (const id of row.stickers ?? []) {
      if (!seen.has(id)) {
        seen.add(id)
        earnedStickers.push(id)
      }
    }
    for (const list of Object.values(row.stickersBySection ?? {})) {
      for (const id of list) {
        if (!seen.has(id)) {
          seen.add(id)
          earnedStickers.push(id)
        }
      }
    }
  }

  if (takes.length === 0) {
    return (
      <div className="progress-profile card">
        <h2>Alexia’s progress</h2>
        <p className="hint">Record a practice, then Joe can add Stars and Stickers.</p>
      </div>
    )
  }

  return (
    <div className="progress-profile card">
      <h2>Alexia’s progress</h2>
      <p className="hint">Last {recent.length} practice{recent.length === 1 ? '' : 's'} for this piece</p>

      <div className="progress-overall">
        <p className="progress-overall-text">{overallCompare(latestAvg, prevAvg)}</p>
      </div>

      {earnedStickers.length > 0 && (
        <div className="progress-stickers-block">
          <h3 className="progress-subhead">Stickers</h3>
          <StickerChips ids={earnedStickers} />
        </div>
      )}

      <div className="progress-takes-row">
        {recent.map((take, i) => (
          <div key={take.id} className={`progress-take-pill${i === 0 ? ' is-latest' : ''}`}>
            <span className="progress-take-label">
              {i === 0 ? 'Latest' : i === 1 ? 'Before' : 'Earlier'}
            </span>
            <span className="progress-take-date">{formatTakeDate(take.createdAt)}</span>
          </div>
        ))}
      </div>

      {sections.length === 0 ? (
        <p className="hint">Add practice sections to see Stars per bit.</p>
      ) : (
        <ul className="progress-section-list">
          {sections.map((section) => {
            const history = recent.map((t) => meta[t.id]?.starsBySection?.[section.id])
            const trend = sectionTrend(history)
            return (
              <li key={section.id} className="progress-section-row">
                <div className="progress-section-top">
                  <span className="progress-section-name">{section.label}</span>
                  <span className={`progress-trend trend-${trend}`}>{trendLabel(trend)}</span>
                </div>
                <div className="progress-star-history">
                  {recent.map((take, i) => (
                    <div key={take.id} className="progress-star-cell">
                      <span className="progress-star-when">
                        {i === 0 ? 'Now' : i === 1 ? 'Last' : 'Before'}
                      </span>
                      <StarDisplay value={history[i]} />
                    </div>
                  ))}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
