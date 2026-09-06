import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  getPiecePracticeSectionsWithLegacyFallback,
  getTakeSectionTimes,
  patchTakeGamification,
  savePiecePracticeSections,
  saveTakeSectionTimes,
} from '../lib/storage'
import type { PracticeSection } from '../types'
import { StarRating } from './StarRating'
import { StickerPicker } from './StickerPicker'
import type { TakePlayerHandle } from './TakePlayer'
import type { YouTubePlayerHandle } from './YouTubePlayer'

interface Props {
  pieceId: string
  takeId: string | null
  youtubeRef: RefObject<YouTubePlayerHandle | null>
  takeRef: RefObject<TakePlayerHandle | null>
  /** Fired when stars/stickers change so the progress card can refresh. */
  onGamificationChange?: () => void
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
    if (next[i].youtubeEndSec <= next[i].youtubeStartSec + 0.05) {
      // Keep a usable default window when cascade pushes start past end.
      next[i].youtubeEndSec = round1(next[i].youtubeStartSec + 20)
    }
  }
  return next
}

/** Same continuity rule for Alexia take times, keyed by section order.
 *  Section i start is always previous end. Missing windows default to start+20. */
function makeAlexiaContinuous(sections: PracticeSection[], alexia: AlexiaTimes): AlexiaTimes {
  if (sections.length === 0) return alexia
  const next: AlexiaTimes = { ...alexia }
  for (let i = 1; i < sections.length; i++) {
    const prevId = sections[i - 1].id
    const id = sections[i].id
    const prev = next[prevId]
    if (!prev || !Number.isFinite(prev.endSec)) continue
    const prevEnd = round1(prev.endSec)
    const cur = next[id]
    const startSec = prevEnd
    // Preserve an existing end when still valid; otherwise default to a 20s window.
    let endSec: number
    if (cur && Number.isFinite(cur.endSec) && cur.endSec > startSec + 0.05) {
      endSec = round1(cur.endSec)
    } else {
      endSec = round1(startSec + 20)
    }
    next[id] = { startSec, endSec }
  }
  return next
}

export function PracticeSections({
  pieceId,
  takeId,
  youtubeRef,
  takeRef,
  onGamificationChange,
}: Props) {
  const [sections, setSections] = useState<PracticeSection[]>([])
  const [alexia, setAlexia] = useState<AlexiaTimes>({})
  const [starsBySection, setStarsBySection] = useState<Record<string, number>>({})
  const [takeStickers, setTakeStickers] = useState<string[]>([])
  const [stickersBySection, setStickersBySection] = useState<Record<string, string[]>>({})
  const [status, setStatus] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [templateDirty, setTemplateDirty] = useState(false)
  const sectionsRef = useRef(sections)
  sectionsRef.current = sections
  const savedTemplateJsonRef = useRef('[]')
  const onGamifyRef = useRef(onGamificationChange)
  onGamifyRef.current = onGamificationChange

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

  /** Apply Alexia map update with continuous starts, then persist for this take. */
  const persistAlexia = useCallback(
    (recipe: (prev: AlexiaTimes) => AlexiaTimes, sectionOrder?: PracticeSection[]) => {
      const order = sectionOrder ?? sectionsRef.current
      setAlexia((prev) => {
        const continuous = makeAlexiaContinuous(order, recipe(prev))
        if (!takeId) return continuous
        void saveTakeSectionTimes({
          takeId,
          bySection: continuous,
          updatedAt: Date.now(),
        }).catch((err) => {
          console.error(err)
          setStatus('Could not save Alexia section times.')
        })
        return continuous
      })
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
        // Load piece YouTube template (shared across takes); try legacy id if empty.
        const { row, restoredFromLegacy } =
          await getPiecePracticeSectionsWithLegacyFallback(pieceId)
        if (cancelled) return
        const loaded = row?.sections ?? []
        const continuous = makeYtContinuous(loaded)
        setSections(continuous)
        savedTemplateJsonRef.current = JSON.stringify(continuous)
        setTemplateDirty(false)
        if (restoredFromLegacy && continuous.length > 0) {
          setStatus('Restored saved template from earlier piece name.')
        }
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
    // Always clear immediately so a prior take’s times never flash/edit into the new take.
    setAlexia({})
    setStarsBySection({})
    setTakeStickers([])
    setStickersBySection({})
    if (!takeId) return
    void (async () => {
      try {
        // Per-take Alexia times + stars/stickers — never touch the piece YouTube template.
        const row = await getTakeSectionTimes(takeId)
        if (cancelled) return
        setStarsBySection(row?.starsBySection ?? {})
        setTakeStickers(row?.stickers ?? [])
        setStickersBySection(row?.stickersBySection ?? {})
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
        if (!cancelled) {
          setAlexia({})
          setStarsBySection({})
          setTakeStickers([])
          setStickersBySection({})
        }
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
    const ytEnd = round1(ytStart + 20)
    const next: PracticeSection = {
      id: newSectionId(),
      label: `Section ${n}`,
      youtubeStartSec: ytStart,
      youtubeEndSec: ytEnd,
    }
    const order = [...sections, next]
    applyYtTemplateLocal(order)
    // With a take selected, seed Alexia window as start→start+20 (chained from prev end).
    if (takeId) {
      const aStart = prev
        ? round1(
            alexia[prev.id] && Number.isFinite(alexia[prev.id].endSec)
              ? alexia[prev.id].endSec
              : 0,
          )
        : 0
      const aEnd = round1(aStart + 20)
      persistAlexia((prevMap) => ({
        ...prevMap,
        [next.id]: { startSec: aStart, endSec: aEnd },
      }), order)
      setStatus(
        `Added “${next.label}” (YouTube + Alexia ${formatSec(aStart)}–${formatSec(aEnd)}s). Save YouTube template when ready.`,
      )
    } else {
      setStatus(`Added “${next.label}”. Save YouTube template when ready.`)
    }
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
      persistAlexia((prev) => {
        const { [id]: _, ...rest } = prev
        return rest
      }, next)
    }
  }

  const setAlexiaEnd = (sectionId: string, endSec: number) => {
    if (!takeId) {
      setStatus('Select or record a take first, then mark Alexia times.')
      return
    }
    const idx = sections.findIndex((s) => s.id === sectionId)
    if (idx < 0) return
    const order = sectionsRef.current

    persistAlexia((prev) => {
      const startSec =
        idx === 0
          ? (prev[sectionId]?.startSec ?? 0)
          : (prev[order[idx - 1]?.id]?.endSec ?? prev[sectionId]?.startSec ?? 0)
      const safeStart = round1(startSec)
      const safeEnd = round1(Math.max(endSec, safeStart + 0.5))
      const next: AlexiaTimes = {
        ...prev,
        [sectionId]: { startSec: safeStart, endSec: safeEnd },
      }

      // Mirror YouTube: end of i sets start of i+1 immediately (makeAlexiaContinuous cascades further).
      if (idx + 1 < order.length) {
        const nextId = order[idx + 1].id
        const nextCur = next[nextId]
        const nextStart = safeEnd
        const nextEnd =
          nextCur && Number.isFinite(nextCur.endSec) && nextCur.endSec > nextStart + 0.05
            ? round1(Math.max(nextCur.endSec, nextStart + 0.5))
            : round1(nextStart + 20)
        next[nextId] = { startSec: nextStart, endSec: nextEnd }
      }

      return next
    })
  }

  const setAlexiaStartFirst = (startSec: number) => {
    if (!takeId) {
      setStatus('Select or record a take first, then mark Alexia times.')
      return
    }
    if (sections.length === 0) return
    const firstId = sections[0].id
    const safeStart = round1(Math.max(0, startSec))
    persistAlexia((prev) => {
      const cur = prev[firstId]
      // New window: start → start+20. Existing end kept if still after start.
      const end =
        cur && Number.isFinite(cur.endSec) && cur.endSec > safeStart + 0.05
          ? round1(Math.max(cur.endSec, safeStart + 0.5))
          : round1(safeStart + 20)
      return {
        ...prev,
        [firstId]: { startSec: safeStart, endSec: end },
      }
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
    // Always read from the full-take / section player — same audio element.
    const t = round1(takeRef.current?.getCurrentTime() ?? 0)

    if (which === 'start') {
      if (idx > 0) {
        setStatus('Start is locked to the previous section’s end.')
        return
      }
      setAlexiaStartFirst(t)
      setStatus(
        `Alexia start marked at ${formatSec(t)}s (from take playback). End defaults to ${formatSec(t + 20)}s until you Mark end.`,
      )
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
    if (!takeId) {
      setStatus('Select or record a take first.')
      return
    }
    // Ensure a playable window even if times were never marked (caller usually passes defaults).
    const start = round1(Math.max(0, startSec))
    const end =
      Number.isFinite(endSec) && endSec > start + 0.05
        ? round1(endSec)
        : round1(start + 20)
    if (!(end > start)) {
      setStatus('Could not play this Alexia section.')
      return
    }
    if (!takeRef.current) {
      setStatus('Take player not ready — select the take, then try Play again.')
      return
    }
    const from =
      fromSec == null
        ? start
        : round1(Math.min(end, Math.max(start, fromSec)))
    void takeRef.current.playClip(from, end)
    if (from === round1(start)) {
      setStatus(`Playing Alexia: ${label} (${formatSec(start)}–${formatSec(end)}s)`)
    } else {
      setStatus(
        `Playing Alexia from ${formatSec(from)}s: ${label} (→${formatSec(end)}s)`,
      )
    }
  }

  const setSectionStars = (sectionId: string, stars: number) => {
    if (!takeId) {
      setStatus('Select a take first, then tap Stars.')
      return
    }
    setStarsBySection((prev) => {
      const next = { ...prev }
      if (stars < 1) delete next[sectionId]
      else next[sectionId] = stars
      void patchTakeGamification(takeId, { starsBySection: next })
        .then(() => onGamifyRef.current?.())
        .catch((err) => {
          console.error(err)
          setStatus('Could not save stars.')
        })
      return next
    })
    if (stars >= 1) setStatus(`Stars saved: ${stars} ★`)
    else setStatus('Stars cleared')
  }

  const setSectionStickers = (sectionId: string, ids: string[]) => {
    if (!takeId) return
    setStickersBySection((prev) => {
      const next = { ...prev, [sectionId]: ids }
      void patchTakeGamification(takeId, { stickersBySection: next })
        .then(() => onGamifyRef.current?.())
        .catch((err) => {
          console.error(err)
          setStatus('Could not save stickers.')
        })
      return next
    })
  }

  const setWholeTakeStickers = (ids: string[]) => {
    if (!takeId) return
    setTakeStickers(ids)
    void patchTakeGamification(takeId, { stickers: ids })
      .then(() => onGamifyRef.current?.())
      .catch((err) => {
        console.error(err)
        setStatus('Could not save stickers.')
      })
  }

  const alexiaStartFor = (index: number, sectionId: string): number => {
    if (index === 0) return alexia[sectionId]?.startSec ?? 0
    const prevId = sections[index - 1]?.id
    if (prevId && alexia[prevId] && Number.isFinite(alexia[prevId].endSec)) {
      return round1(alexia[prevId].endSec)
    }
    return alexia[sectionId]?.startSec ?? 0
  }

  /**
   * Effective Alexia window for UI + Play. Missing end defaults to start+20 so
   * section Play is usable as soon as a take is selected (no stars required).
   * Mark start/end still persist real times from the take's currentTime.
   */
  const alexiaWindowFor = (index: number, sectionId: string) => {
    const startSec = round1(Math.max(0, alexiaStartFor(index, sectionId)))
    const storedEnd = alexia[sectionId]?.endSec
    const endSec =
      storedEnd != null && Number.isFinite(storedEnd) && storedEnd > startSec + 0.05
        ? round1(storedEnd)
        : round1(startSec + 20)
    // Show "default +20s" when we invented the end (nothing valid stored yet).
    const isDefault = !(
      storedEnd != null && Number.isFinite(storedEnd) && storedEnd > startSec + 0.05
    )
    return { startSec, endSec, isDefault }
  }

  return (
    <div className="practice-sections card">
      <h2>Practice sections</h2>
      <p className="compare-tip continuous-tip">
        YouTube cuts are the piece template. Select a take, play it below, then Mark Alexia
        start/end from the take’s current time. Until marked, Alexia Play uses start→+20s.
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
        {takeId && (
          <span className="hint inline-hint">
            Play the take (below), then Mark start/end — Play uses start→+20s until marked.
          </span>
        )}
      </div>

      {takeId && (
        <div className="take-gamify-bar">
          <StickerPicker
            title="Stickers for this take"
            selected={takeStickers}
            onChange={setWholeTakeStickers}
          />
        </div>
      )}

      {sections.length === 0 ? (
        <p className="hint">No sections yet. Add one for the opening phrase, a tricky bar, etc.</p>
      ) : (
        <ul className="section-edit-list">
          {sections.map((section, index) => {
            const startLocked = index > 0
            const { startSec: aStart, endSec: aEnd, isDefault: aDefault } =
              alexiaWindowFor(index, section.id)
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
                        {aDefault && takeId && (
                          <span className="locked-hint">default +20s</span>
                        )}
                        <SecondsInput
                          value={aEnd}
                          disabled={!takeId}
                          title={
                            aDefault && takeId
                              ? 'Default window until you Mark end (start → start+20s)'
                              : undefined
                          }
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

                {takeId && (
                  <div className="section-gamify">
                    <StarRating
                      value={starsBySection[section.id]}
                      onChange={(n) => setSectionStars(section.id, n)}
                      label="Stars"
                      size="sm"
                    />
                    <StickerPicker
                      title="Stickers"
                      compact
                      selected={stickersBySection[section.id] ?? []}
                      onChange={(ids) => setSectionStickers(section.id, ids)}
                    />
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
