import { useCallback, useEffect, useState, type RefObject } from 'react'
import {
  getPiecePracticeSections,
  getTakeSectionTimes,
  savePiecePracticeSections,
  saveTakeSectionTimes,
} from '../lib/storage'
import type { PracticeSection } from '../types'
import type { TakePlayerHandle } from './TakePlayer'
import type { YouTubePlayerHandle } from './YouTubePlayer'

interface Props {
  pieceId: string
  takeId: string | null
  youtubeRef: RefObject<YouTubePlayerHandle | null>
  takeRef: RefObject<TakePlayerHandle | null>
}

function newSectionId(): string {
  return `sec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function formatSec(n: number): string {
  if (!Number.isFinite(n)) return '0.0'
  return round1(n).toFixed(1)
}

type AlexiaTimes = Record<string, { startSec: number; endSec: number }>

export function PracticeSections({ pieceId, takeId, youtubeRef, takeRef }: Props) {
  const [sections, setSections] = useState<PracticeSection[]>([])
  const [alexia, setAlexia] = useState<AlexiaTimes>({})
  const [status, setStatus] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const persistPiece = useCallback(
    async (next: PracticeSection[]) => {
      setSections(next)
      try {
        await savePiecePracticeSections({
          pieceId,
          sections: next,
          updatedAt: Date.now(),
        })
      } catch (err) {
        console.error(err)
        setStatus('Could not save YouTube section times.')
      }
    },
    [pieceId],
  )

  const persistAlexia = useCallback(
    async (next: AlexiaTimes) => {
      setAlexia(next)
      if (!takeId) return
      try {
        await saveTakeSectionTimes({
          takeId,
          bySection: next,
          updatedAt: Date.now(),
        })
      } catch (err) {
        console.error(err)
        setStatus('Could not save Alexia section times.')
      }
    },
    [takeId],
  )

  useEffect(() => {
    let cancelled = false
    setLoadError(null)
    void (async () => {
      try {
        const row = await getPiecePracticeSections(pieceId)
        if (!cancelled) setSections(row?.sections ?? [])
      } catch (err) {
        console.error(err)
        if (!cancelled) setLoadError('Could not load practice sections for this piece.')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pieceId])

  useEffect(() => {
    let cancelled = false
    if (!takeId) {
      setAlexia({})
      return
    }
    void (async () => {
      try {
        const row = await getTakeSectionTimes(takeId)
        if (!cancelled) setAlexia(row?.bySection ?? {})
      } catch (err) {
        console.error(err)
        if (!cancelled) setAlexia({})
      }
    })()
    return () => {
      cancelled = true
    }
  }, [takeId])

  const addSection = () => {
    const n = sections.length + 1
    const next: PracticeSection = {
      id: newSectionId(),
      label: `Section ${n}`,
      youtubeStartSec: 0,
      youtubeEndSec: 10,
    }
    void persistPiece([...sections, next])
    setStatus(`Added “${next.label}”. Mark YouTube and Alexia times for this bit.`)
  }

  const updateSection = (id: string, patch: Partial<PracticeSection>) => {
    const next = sections.map((s) => (s.id === id ? { ...s, ...patch } : s))
    void persistPiece(next)
  }

  const deleteSection = (id: string) => {
    const next = sections.filter((s) => s.id !== id)
    void persistPiece(next)
    if (takeId && alexia[id]) {
      const { [id]: _, ...rest } = alexia
      void persistAlexia(rest)
    }
  }

  const setAlexiaTimes = (sectionId: string, startSec: number, endSec: number) => {
    if (!takeId) {
      setStatus('Select or record a take first, then mark Alexia times.')
      return
    }
    void persistAlexia({
      ...alexia,
      [sectionId]: { startSec: round1(startSec), endSec: round1(endSec) },
    })
  }

  const markYt = (section: PracticeSection, which: 'start' | 'end') => {
    const t = round1(youtubeRef.current?.getCurrentTime() ?? 0)
    if (which === 'start') {
      const end = Math.max(section.youtubeEndSec, t + 0.5)
      updateSection(section.id, { youtubeStartSec: t, youtubeEndSec: end })
      setStatus(`YouTube start marked at ${formatSec(t)}s`)
    } else {
      const start = Math.min(section.youtubeStartSec, Math.max(0, t - 0.5))
      updateSection(section.id, { youtubeStartSec: start, youtubeEndSec: t })
      setStatus(`YouTube end marked at ${formatSec(t)}s`)
    }
  }

  const markAlexia = (sectionId: string, which: 'start' | 'end') => {
    if (!takeId) {
      setStatus('Select or record a take first.')
      return
    }
    const t = round1(takeRef.current?.getCurrentTime() ?? 0)
    const cur = alexia[sectionId] ?? { startSec: 0, endSec: 10 }
    if (which === 'start') {
      const end = Math.max(cur.endSec, t + 0.5)
      setAlexiaTimes(sectionId, t, end)
      setStatus(`Alexia start marked at ${formatSec(t)}s`)
    } else {
      const start = Math.min(cur.startSec, Math.max(0, t - 0.5))
      setAlexiaTimes(sectionId, start, t)
      setStatus(`Alexia end marked at ${formatSec(t)}s`)
    }
  }

  const playYtClip = (section: PracticeSection) => {
    const start = section.youtubeStartSec
    const end = section.youtubeEndSec
    if (!(end > start)) {
      setStatus('Set YouTube end after start for this section.')
      return
    }
    youtubeRef.current?.playClip(start, end)
    setStatus(`Playing YouTube: ${section.label} (${formatSec(start)}–${formatSec(end)}s)`)
  }

  const playAlexiaClip = (sectionId: string, label: string) => {
    const times = alexia[sectionId]
    if (!times || !(times.endSec > times.startSec)) {
      setStatus('Mark Alexia start and end for this section first.')
      return
    }
    void takeRef.current?.playClip(times.startSec, times.endSec)
    setStatus(
      `Playing Alexia: ${label} (${formatSec(times.startSec)}–${formatSec(times.endSec)}s)`,
    )
  }

  return (
    <div className="practice-sections card">
      <h2>Practice sections</h2>
      <p className="compare-tip">
        Mark the same musical bit on YouTube and on Alexia’s take, then play each to compare by ear.
      </p>
      <p className="hint">
        YouTube times are saved for this piece (shared). Alexia times are saved for the selected take
        (each recording can differ slightly).
      </p>

      {loadError && <p className="error">{loadError}</p>}
      {status && (
        <p className="section-status" role="status">
          {status}
        </p>
      )}

      <div className="section-toolbar">
        <button type="button" className="btn primary" onClick={addSection}>
          + Add section
        </button>
        {!takeId && (
          <span className="hint inline-hint">Select a take to mark Alexia times.</span>
        )}
      </div>

      {sections.length === 0 ? (
        <p className="hint">No sections yet. Add one for the opening phrase, a tricky bar, etc.</p>
      ) : (
        <ul className="section-edit-list">
          {sections.map((section) => {
            const a = alexia[section.id] ?? { startSec: 0, endSec: 0 }
            const hasAlexia = takeId && alexia[section.id] && a.endSec > a.startSec
            return (
              <li key={section.id} className="section-edit-card">
                <div className="section-edit-top">
                  <label className="section-label-field">
                    Name
                    <input
                      type="text"
                      value={section.label}
                      onChange={(e) => updateSection(section.id, { label: e.target.value })}
                      placeholder="e.g. Opening"
                    />
                  </label>
                  <button
                    type="button"
                    className="btn tiny ghost"
                    onClick={() => deleteSection(section.id)}
                  >
                    Delete
                  </button>
                </div>

                <div className="section-times-grid">
                  <div className="time-block">
                    <h3>YouTube</h3>
                    <div className="time-inputs">
                      <label>
                        Start (s)
                        <input
                          type="number"
                          min={0}
                          step={0.1}
                          value={section.youtubeStartSec}
                          onChange={(e) =>
                            updateSection(section.id, {
                              youtubeStartSec: Number(e.target.value) || 0,
                            })
                          }
                        />
                      </label>
                      <label>
                        End (s)
                        <input
                          type="number"
                          min={0}
                          step={0.1}
                          value={section.youtubeEndSec}
                          onChange={(e) =>
                            updateSection(section.id, {
                              youtubeEndSec: Number(e.target.value) || 0,
                            })
                          }
                        />
                      </label>
                    </div>
                    <div className="mark-row">
                      <button
                        type="button"
                        className="btn tiny secondary"
                        onClick={() => markYt(section, 'start')}
                      >
                        Mark YouTube start
                      </button>
                      <button
                        type="button"
                        className="btn tiny secondary"
                        onClick={() => markYt(section, 'end')}
                      >
                        Mark YouTube end
                      </button>
                    </div>
                    <button
                      type="button"
                      className="btn primary"
                      onClick={() => playYtClip(section)}
                    >
                      ▶ Play YouTube clip
                    </button>
                  </div>

                  <div className="time-block">
                    <h3>Alexia’s take</h3>
                    <div className="time-inputs">
                      <label>
                        Start (s)
                        <input
                          type="number"
                          min={0}
                          step={0.1}
                          value={a.startSec}
                          disabled={!takeId}
                          onChange={(e) =>
                            setAlexiaTimes(
                              section.id,
                              Number(e.target.value) || 0,
                              a.endSec || Number(e.target.value) || 0,
                            )
                          }
                        />
                      </label>
                      <label>
                        End (s)
                        <input
                          type="number"
                          min={0}
                          step={0.1}
                          value={a.endSec}
                          disabled={!takeId}
                          onChange={(e) =>
                            setAlexiaTimes(
                              section.id,
                              a.startSec || 0,
                              Number(e.target.value) || 0,
                            )
                          }
                        />
                      </label>
                    </div>
                    <div className="mark-row">
                      <button
                        type="button"
                        className="btn tiny secondary"
                        disabled={!takeId}
                        onClick={() => markAlexia(section.id, 'start')}
                      >
                        Mark Alexia start
                      </button>
                      <button
                        type="button"
                        className="btn tiny secondary"
                        disabled={!takeId}
                        onClick={() => markAlexia(section.id, 'end')}
                      >
                        Mark Alexia end
                      </button>
                    </div>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={!hasAlexia}
                      onClick={() => playAlexiaClip(section.id, section.label)}
                    >
                      ▶ Play Alexia clip
                    </button>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
