import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
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

/** Allow digits and at most one decimal point while typing (e.g. "", "12", "12.", "12.5"). */
function sanitizeSecondsDraft(raw: string): string {
  let out = ''
  let sawDot = false
  for (const ch of raw) {
    if (ch >= '0' && ch <= '9') {
      out += ch
    } else if (ch === '.' && !sawDot) {
      out += ch
      sawDot = true
    }
  }
  return out
}

function parseSecondsDraft(draft: string, fallback: number): number {
  const trimmed = draft.trim()
  if (trimmed === '' || trimmed === '.') return fallback
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n < 0) return fallback
  return round1(n)
}

interface SecondsInputProps {
  value: number
  onCommit: (seconds: number) => void
  readOnly?: boolean
  disabled?: boolean
  className?: string
  title?: string
}

const STEP_SEC = 0.1

/**
 * Typable seconds field with compact ▲▼ nudges (0.1s).
 * Locked/auto-chained starts stay readOnly (no steppers).
 */
function SecondsInput({
  value,
  onCommit,
  readOnly = false,
  disabled = false,
  className,
  title,
}: SecondsInputProps) {
  const [draft, setDraft] = useState(() => formatSec(value))
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!focused) setDraft(formatSec(value))
  }, [value, focused])

  if (readOnly || disabled) {
    return (
      <input
        type="text"
        inputMode="decimal"
        value={formatSec(value)}
        readOnly={readOnly}
        disabled={disabled}
        className={className}
        title={title}
      />
    )
  }

  const nudge = (delta: number) => {
    const base = focused ? parseSecondsDraft(draft, value) : round1(value)
    const next = round1(Math.max(0, base + delta))
    setDraft(formatSec(next))
    if (next !== round1(value)) onCommit(next)
  }

  return (
    <div className="seconds-input-row">
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={focused ? draft : formatSec(value)}
        className={className}
        title={title}
        onFocus={(e) => {
          setFocused(true)
          setDraft(formatSec(value))
          e.target.select()
        }}
        onChange={(e) => {
          setDraft(sanitizeSecondsDraft(e.target.value))
        }}
        onBlur={() => {
          const next = parseSecondsDraft(draft, value)
          setFocused(false)
          setDraft(formatSec(next))
          if (next !== round1(value)) onCommit(next)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur()
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            nudge(STEP_SEC)
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            nudge(-STEP_SEC)
          }
        }}
      />
      <div className="seconds-stepper" role="group" aria-label="Adjust by 0.1 seconds">
        <button
          type="button"
          className="seconds-nudge"
          aria-label="Increase by 0.1 seconds"
          title="+0.1s"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => nudge(STEP_SEC)}
        >
          ▲
        </button>
        <button
          type="button"
          className="seconds-nudge"
          aria-label="Decrease by 0.1 seconds"
          title="−0.1s"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => nudge(-STEP_SEC)}
        >
          ▼
        </button>
      </div>
    </div>
  )
}

interface SectionScrubberProps {
  startSec: number
  endSec: number
  disabled?: boolean
  onSeek: (sec: number) => void
  onPlay: (fromSec: number) => void
  onStop: () => void
  getCurrentTime: () => number
  playLabel: string
}

/**
 * Mini player for one section clip: Play/Stop + scrubber.
 * Drag sets position within start→end; Play starts from the thumb (default: section start).
 */
function SectionScrubber({
  startSec,
  endSec,
  disabled = false,
  onSeek,
  onPlay,
  onStop,
  getCurrentTime,
  playLabel,
}: SectionScrubberProps) {
  const valid =
    Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec + 0.05
  const lo = valid ? round1(startSec) : 0
  const hi = valid ? round1(endSec) : 0.1
  const [pos, setPos] = useState(lo)
  const [playing, setPlaying] = useState(false)
  const scrubbingRef = useRef(false)
  const posRef = useRef(pos)
  posRef.current = pos

  useEffect(() => {
    setPos((prev) => {
      if (!valid) return lo
      // Keep thumb in range; default to section start when previously unset/out of range.
      if (prev < lo - 0.05 || prev > hi + 0.05) return lo
      return Math.min(hi, Math.max(lo, round1(prev)))
    })
    if (!valid) setPlaying(false)
  }, [lo, hi, valid])

  const inactive = disabled || !valid

  // Follow the live player while this clip is playing.
  useEffect(() => {
    if (!playing || inactive) return
    const id = window.setInterval(() => {
      if (scrubbingRef.current) return
      const t = round1(getCurrentTime())
      if (t >= hi - 0.05) {
        setPos(hi)
        setPlaying(false)
        return
      }
      // Another control moved the shared player outside this section.
      if (t < lo - 0.25 || t > hi + 0.25) {
        setPlaying(false)
        return
      }
      setPos(Math.min(hi, Math.max(lo, t)))
    }, 100)
    return () => window.clearInterval(id)
  }, [playing, inactive, lo, hi, getCurrentTime])

  const seek = (raw: number) => {
    if (!valid || disabled) return
    const next = round1(Math.min(hi, Math.max(lo, raw)))
    setPos(next)
    onSeek(next)
  }

  const togglePlay = () => {
    if (inactive) return
    if (playing) {
      onStop()
      setPlaying(false)
      return
    }
    const from = round1(Math.min(hi, Math.max(lo, posRef.current)))
    // If thumb is at/near the end, restart from section start.
    const startFrom = from >= hi - 0.05 ? lo : from
    setPos(startFrom)
    onPlay(startFrom)
    setPlaying(true)
  }

  const rel = valid ? round1(Math.max(0, Math.min(hi, pos) - lo)) : 0
  const dur = valid ? round1(Math.max(0, hi - lo)) : 0

  return (
    <div className={`section-scrubber${inactive ? ' is-disabled' : ''}`}>
      <div className="section-scrubber-row">
        <button
          type="button"
          className={`btn tiny ${playing ? 'danger' : 'primary'}`}
          disabled={inactive}
          aria-label={playing ? `Stop ${playLabel} clip` : `Play ${playLabel} clip`}
          onClick={togglePlay}
        >
          {playing ? '■ Stop' : '▶ Play'}
        </button>
        <input
          type="range"
          min={lo}
          max={hi}
          step={0.1}
          value={valid ? Math.min(hi, Math.max(lo, pos)) : lo}
          disabled={inactive}
          aria-label={`${playLabel} section scrubber`}
          onPointerDown={() => {
            scrubbingRef.current = true
          }}
          onPointerUp={() => {
            scrubbingRef.current = false
          }}
          onPointerCancel={() => {
            scrubbingRef.current = false
          }}
          onChange={(e) => seek(Number(e.target.value))}
        />
        <span className="section-scrubber-time" aria-live="polite">
          {valid ? (
            <>
              <strong>{formatSec(rel)}</strong>
              <span className="section-scrubber-range"> / {formatSec(dur)}</span>
            </>
          ) : (
            'Set start & end'
          )}
        </span>
      </div>
    </div>
  )
}

type AlexiaTimes = Record<string, { startSec: number; endSec: number }>

/** Start of section i (i>0) always equals end of i-1. Section 0 start unchanged. */
function makeYtContinuous(sections: PracticeSection[]): PracticeSection[] {
  if (sections.length === 0) return sections
  const next = sections.map((s) => ({ ...s }))
  for (let i = 1; i < next.length; i++) {
    next[i].youtubeStartSec = next[i - 1].youtubeEndSec
    if (next[i].youtubeEndSec < next[i].youtubeStartSec) {
      next[i].youtubeEndSec = round1(next[i].youtubeStartSec + 0.5)
    }
  }
  return next
}

/** Same continuity rule for Alexia take times, keyed by section order. */
function makeAlexiaContinuous(sections: PracticeSection[], alexia: AlexiaTimes): AlexiaTimes {
  if (sections.length === 0) return alexia
  const next: AlexiaTimes = { ...alexia }
  for (let i = 1; i < sections.length; i++) {
    const prevId = sections[i - 1].id
    const id = sections[i].id
    const prevEnd = next[prevId]?.endSec
    if (prevEnd === undefined) continue
    const cur = next[id] ?? { startSec: prevEnd, endSec: round1(prevEnd + 0.5) }
    const startSec = prevEnd
    const endSec = Math.max(cur.endSec, round1(startSec + 0.5))
    next[id] = { startSec: round1(startSec), endSec: round1(endSec) }
  }
  return next
}

export function PracticeSections({ pieceId, takeId, youtubeRef, takeRef }: Props) {
  const [sections, setSections] = useState<PracticeSection[]>([])
  const [alexia, setAlexia] = useState<AlexiaTimes>({})
  const [status, setStatus] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [templateDirty, setTemplateDirty] = useState(false)
  const sectionsRef = useRef(sections)
  sectionsRef.current = sections
  const savedTemplateJsonRef = useRef('[]')

  /** YouTube sections are the piece template — edit locally until Save. */
  const applyYtTemplateLocal = useCallback((next: PracticeSection[]) => {
    const continuous = makeYtContinuous(next)
    setSections(continuous)
    setTemplateDirty(JSON.stringify(continuous) !== savedTemplateJsonRef.current)
  }, [])

  const saveYouTubeTemplate = useCallback(async () => {
    const continuous = makeYtContinuous(sectionsRef.current)
    setSections(continuous)
    try {
      await savePiecePracticeSections({
        pieceId,
        sections: continuous,
        updatedAt: Date.now(),
      })
      savedTemplateJsonRef.current = JSON.stringify(continuous)
      setTemplateDirty(false)
      setStatus('Template saved for this piece')
    } catch (err) {
      console.error(err)
      setStatus('Could not save YouTube template.')
    }
  }, [pieceId])

  const persistAlexia = useCallback(
    async (next: AlexiaTimes, sectionOrder?: PracticeSection[]) => {
      const order = sectionOrder ?? sectionsRef.current
      const continuous = makeAlexiaContinuous(order, next)
      setAlexia(continuous)
      if (!takeId) return
      try {
        await saveTakeSectionTimes({
          takeId,
          bySection: continuous,
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
    setSections([])
    setTemplateDirty(false)
    setStatus(null)
    void (async () => {
      try {
        // Load piece YouTube template (shared across takes).
        const row = await getPiecePracticeSections(pieceId)
        if (cancelled) return
        const loaded = row?.sections ?? []
        const continuous = makeYtContinuous(loaded)
        setSections(continuous)
        savedTemplateJsonRef.current = JSON.stringify(continuous)
        setTemplateDirty(false)
        if (
          loaded.length > 0 &&
          JSON.stringify(loaded) !== JSON.stringify(continuous)
        ) {
          try {
            await savePiecePracticeSections({
              pieceId,
              sections: continuous,
              updatedAt: Date.now(),
            })
            savedTemplateJsonRef.current = JSON.stringify(continuous)
          } catch (err) {
            console.error(err)
          }
        }
      } catch (err) {
        console.error(err)
        if (!cancelled) setLoadError('Could not load YouTube template for this piece.')
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
        // Per-take Alexia times only — never touch the piece YouTube template.
        const row = await getTakeSectionTimes(takeId)
        if (cancelled) return
        const loaded = row?.bySection ?? {}
        if (Object.keys(loaded).length === 0) {
          setAlexia({})
          return
        }
        const continuous = makeAlexiaContinuous(sectionsRef.current, loaded)
        setAlexia(continuous)
        if (JSON.stringify(continuous) !== JSON.stringify(loaded)) {
          try {
            await saveTakeSectionTimes({
              takeId,
              bySection: continuous,
              updatedAt: Date.now(),
            })
          } catch (err) {
            console.error(err)
          }
        }
      } catch (err) {
        console.error(err)
        if (!cancelled) setAlexia({})
      }
    })()
    return () => {
      cancelled = true
    }
  }, [takeId])

  // Re-apply Alexia continuity when section order is ready (covers load races).
  // Only when this take already has some marked times — never invent or write template.
  useEffect(() => {
    if (!takeId || sections.length < 2) return
    setAlexia((prev) => {
      if (Object.keys(prev).length === 0) return prev
      const continuous = makeAlexiaContinuous(sections, prev)
      if (JSON.stringify(continuous) === JSON.stringify(prev)) return prev
      void saveTakeSectionTimes({
        takeId,
        bySection: continuous,
        updatedAt: Date.now(),
      }).catch((err) => console.error(err))
      return continuous
    })
  }, [takeId, sections])

  const addSection = () => {
    const n = sections.length + 1
    const prev = sections[sections.length - 1]
    const ytStart = prev ? prev.youtubeEndSec : 0
    const ytEnd = round1(ytStart + 10)
    const next: PracticeSection = {
      id: newSectionId(),
      label: `Section ${n}`,
      youtubeStartSec: ytStart,
      youtubeEndSec: ytEnd,
    }
    applyYtTemplateLocal([...sections, next])
    // Do not invent Alexia times — leave empty for this take until marked.
    setStatus(`Added “${next.label}”. Save YouTube template when ready.`)
  }

  const updateSection = (id: string, patch: Partial<PracticeSection>) => {
    const idx = sections.findIndex((s) => s.id === id)
    if (idx < 0) return

    const next = sections.map((s) => (s.id === id ? { ...s, ...patch } : s))

    // Starts for section 2+ are driven by previous end — ignore direct start edits
    if (idx > 0 && patch.youtubeStartSec !== undefined) {
      next[idx] = {
        ...next[idx],
        youtubeStartSec: next[idx - 1].youtubeEndSec,
      }
    }

    // When end of section i changes, start of i+1 follows (makeYtContinuous also does this)
    if (patch.youtubeEndSec !== undefined && idx + 1 < next.length) {
      next[idx + 1] = {
        ...next[idx + 1],
        youtubeStartSec: next[idx].youtubeEndSec,
      }
    }

    applyYtTemplateLocal(next)
  }

  const deleteSection = (id: string) => {
    const next = sections.filter((s) => s.id !== id)
    applyYtTemplateLocal(next)
    if (takeId && alexia[id]) {
      const { [id]: _, ...rest } = alexia
      void persistAlexia(rest, next)
    }
  }

  const setAlexiaEnd = (sectionId: string, endSec: number) => {
    if (!takeId) {
      setStatus('Select or record a take first, then mark Alexia times.')
      return
    }
    const idx = sections.findIndex((s) => s.id === sectionId)
    if (idx < 0) return

    const startSec =
      idx === 0
        ? (alexia[sectionId]?.startSec ?? 0)
        : (alexia[sections[idx - 1].id]?.endSec ?? alexia[sectionId]?.startSec ?? 0)

    const next: AlexiaTimes = {
      ...alexia,
      [sectionId]: { startSec: round1(startSec), endSec: round1(endSec) },
    }

    if (idx + 1 < sections.length) {
      const nextId = sections[idx + 1].id
      const nextCur = next[nextId] ?? {
        startSec: endSec,
        endSec: round1(endSec + 0.5),
      }
      next[nextId] = {
        startSec: round1(endSec),
        endSec: round1(Math.max(nextCur.endSec, endSec + 0.5)),
      }
    }

    void persistAlexia(next)
  }

  const setAlexiaStartFirst = (startSec: number) => {
    if (!takeId) {
      setStatus('Select or record a take first, then mark Alexia times.')
      return
    }
    if (sections.length === 0) return
    const firstId = sections[0].id
    const cur = alexia[firstId] ?? { startSec: 0, endSec: 10 }
    const end = Math.max(cur.endSec, round1(startSec + 0.5))
    void persistAlexia({
      ...alexia,
      [firstId]: { startSec: round1(startSec), endSec: round1(end) },
    })
  }

  const markYt = (section: PracticeSection, which: 'start' | 'end') => {
    const idx = sections.findIndex((s) => s.id === section.id)
    if (idx < 0) return
    const t = round1(youtubeRef.current?.getCurrentTime() ?? 0)

    if (which === 'start') {
      if (idx > 0) {
        setStatus('Start is locked to the previous section’s end.')
        return
      }
      const end = Math.max(section.youtubeEndSec, t + 0.5)
      updateSection(section.id, { youtubeStartSec: t, youtubeEndSec: end })
      setStatus(`YouTube start marked at ${formatSec(t)}s — save template when ready`)
    } else {
      updateSection(section.id, { youtubeEndSec: t })
      if (idx + 1 < sections.length) {
        setStatus(
          `YouTube end marked at ${formatSec(t)}s — next starts there. Save template when ready.`,
        )
      } else {
        setStatus(`YouTube end marked at ${formatSec(t)}s — save template when ready`)
      }
    }
  }

  const markAlexia = (sectionId: string, which: 'start' | 'end') => {
    if (!takeId) {
      setStatus('Select or record a take first.')
      return
    }
    const idx = sections.findIndex((s) => s.id === sectionId)
    if (idx < 0) return
    const t = round1(takeRef.current?.getCurrentTime() ?? 0)

    if (which === 'start') {
      if (idx > 0) {
        setStatus('Start is locked to the previous section’s end.')
        return
      }
      setAlexiaStartFirst(t)
      setStatus(`Alexia start marked at ${formatSec(t)}s`)
    } else {
      setAlexiaEnd(sectionId, t)
      if (idx + 1 < sections.length) {
        setStatus(
          `Alexia end marked at ${formatSec(t)}s — next section starts there too.`,
        )
      } else {
        setStatus(`Alexia end marked at ${formatSec(t)}s`)
      }
    }
  }

  const playYtClip = (section: PracticeSection, fromSec?: number) => {
    const start = section.youtubeStartSec
    const end = section.youtubeEndSec
    if (!(end > start)) {
      setStatus('Set YouTube end after start for this section.')
      return
    }
    const from =
      fromSec == null
        ? start
        : round1(Math.min(end, Math.max(start, fromSec)))
    youtubeRef.current?.playClip(from, end)
    if (from === round1(start)) {
      setStatus(`Playing YouTube: ${section.label} (${formatSec(start)}–${formatSec(end)}s)`)
    } else {
      setStatus(
        `Playing YouTube from ${formatSec(from)}s: ${section.label} (→${formatSec(end)}s)`,
      )
    }
  }

  const playAlexiaClip = (
    label: string,
    startSec: number,
    endSec: number,
    fromSec?: number,
  ) => {
    if (!(endSec > startSec)) {
      setStatus('Mark Alexia start and end for this section first.')
      return
    }
    const from =
      fromSec == null
        ? startSec
        : round1(Math.min(endSec, Math.max(startSec, fromSec)))
    void takeRef.current?.playClip(from, endSec)
    if (from === round1(startSec)) {
      setStatus(`Playing Alexia: ${label} (${formatSec(startSec)}–${formatSec(endSec)}s)`)
    } else {
      setStatus(
        `Playing Alexia from ${formatSec(from)}s: ${label} (→${formatSec(endSec)}s)`,
      )
    }
  }

  const alexiaStartFor = (index: number, sectionId: string): number => {
    if (index === 0) return alexia[sectionId]?.startSec ?? 0
    const prevId = sections[index - 1]?.id
    if (prevId && alexia[prevId]) return alexia[prevId].endSec
    return alexia[sectionId]?.startSec ?? 0
  }

  return (
    <div className="practice-sections card">
      <h2>Practice sections</h2>
      <p className="compare-tip continuous-tip">
        YouTube cuts are the piece template. For each new take, only set Alexia’s times.
        Continuous — each section starts where the last ended. Type or use ▲▼ / ↑↓ (±0.1s).
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
        <button
          type="button"
          className={`btn ${templateDirty ? 'secondary' : 'ghost'}`}
          onClick={() => void saveYouTubeTemplate()}
          disabled={sections.length === 0 && !templateDirty}
          title="Save YouTube section names and times as this piece’s template"
        >
          Save YouTube template
        </button>
        {templateDirty && (
          <span className="hint inline-hint dirty-hint">Unsaved template changes</span>
        )}
        {!takeId && (
          <span className="hint inline-hint">Select a take to mark Alexia times.</span>
        )}
      </div>

      {sections.length === 0 ? (
        <p className="hint">No sections yet. Add one for the opening phrase, a tricky bar, etc.</p>
      ) : (
        <ul className="section-edit-list">
          {sections.map((section, index) => {
            const startLocked = index > 0
            const aStart = alexiaStartFor(index, section.id)
            const aEnd = alexia[section.id]?.endSec ?? 0
            return (
              <li key={section.id} className="section-edit-card">
                <div className="section-edit-top">
                  <label className="section-label-field">
                    <span className="sr-only">Name</span>
                    <input
                      type="text"
                      value={section.label}
                      onChange={(e) => updateSection(section.id, { label: e.target.value })}
                      placeholder="Section name"
                      aria-label="Section name"
                    />
                  </label>
                  <button
                    type="button"
                    className="btn tiny ghost"
                    onClick={() => deleteSection(section.id)}
                  >
                    ✕
                  </button>
                </div>

                <div className="section-times-grid">
                  <div className="time-block">
                    <div className="time-block-head">
                      <h3>YouTube</h3>
                      <div className="mark-row">
                        {!startLocked && (
                          <button
                            type="button"
                            className="btn micro secondary"
                            onClick={() => markYt(section, 'start')}
                          >
                            Mark start
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn micro secondary"
                          onClick={() => markYt(section, 'end')}
                        >
                          Mark end
                        </button>
                      </div>
                    </div>
                    <div className="time-inputs">
                      <label>
                        Start
                        {startLocked && (
                          <span className="locked-hint">← prev</span>
                        )}
                        <SecondsInput
                          value={section.youtubeStartSec}
                          readOnly={startLocked}
                          className={startLocked ? 'input-readonly' : undefined}
                          title={
                            startLocked
                              ? 'Locked: equals previous section’s YouTube end'
                              : undefined
                          }
                          onCommit={(seconds) =>
                            updateSection(section.id, { youtubeStartSec: seconds })
                          }
                        />
                      </label>
                      <label>
                        End
                        <SecondsInput
                          value={section.youtubeEndSec}
                          onCommit={(seconds) =>
                            updateSection(section.id, { youtubeEndSec: seconds })
                          }
                        />
                      </label>
                    </div>
                    <SectionScrubber
                      startSec={section.youtubeStartSec}
                      endSec={section.youtubeEndSec}
                      playLabel="YouTube"
                      onSeek={(sec) => youtubeRef.current?.seekTo(sec)}
                      onPlay={(from) => playYtClip(section, from)}
                      onStop={() => youtubeRef.current?.stopClip()}
                      getCurrentTime={() => youtubeRef.current?.getCurrentTime() ?? 0}
                    />
                  </div>

                  <div className="time-block">
                    <div className="time-block-head">
                      <h3>Alexia</h3>
                      <div className="mark-row">
                        {!startLocked && (
                          <button
                            type="button"
                            className="btn micro secondary"
                            disabled={!takeId}
                            onClick={() => markAlexia(section.id, 'start')}
                          >
                            Mark start
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn micro secondary"
                          disabled={!takeId}
                          onClick={() => markAlexia(section.id, 'end')}
                        >
                          Mark end
                        </button>
                      </div>
                    </div>
                    <div className="time-inputs">
                      <label>
                        Start
                        {startLocked && (
                          <span className="locked-hint">← prev</span>
                        )}
                        <SecondsInput
                          value={aStart}
                          disabled={!takeId}
                          readOnly={startLocked}
                          className={startLocked ? 'input-readonly' : undefined}
                          title={
                            startLocked
                              ? 'Locked: equals previous section’s Alexia end'
                              : undefined
                          }
                          onCommit={(seconds) => setAlexiaStartFirst(seconds)}
                        />
                      </label>
                      <label>
                        End
                        <SecondsInput
                          value={aEnd}
                          disabled={!takeId}
                          onCommit={(seconds) => setAlexiaEnd(section.id, seconds)}
                        />
                      </label>
                    </div>
                    <SectionScrubber
                      startSec={aStart}
                      endSec={aEnd}
                      disabled={!takeId}
                      playLabel="Alexia"
                      onSeek={(sec) => takeRef.current?.seekTo(sec)}
                      onPlay={(from) =>
                        playAlexiaClip(section.label, aStart, aEnd, from)
                      }
                      onStop={() => takeRef.current?.stopClip()}
                      getCurrentTime={() => takeRef.current?.getCurrentTime() ?? 0}
                    />
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
