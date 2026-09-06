import { useEffect, useRef, useState } from 'react'
import { analyzeComparison, analyzeSolo, AudioDecodeError } from '../lib/audioAnalysis'
import { reviveAudioBlob } from '../lib/audioMime'
import type { AnalysisResult, SectionAnalysis, SectionScore, Take } from '../types'

export type AnalyzedPayload = {
  result: AnalysisResult
  /** Included when comparison runs so the reference survives refresh. */
  reference?: { blob: Blob; fileName?: string }
}

interface Props {
  take: Take | null
  onAnalyzed: (takeId: string, payload: AnalyzedPayload) => void
}

type PlayingClip = {
  sectionIndex: number
  source: 'alexia' | 'reference' | 'both'
  phase?: 'alexia' | 'reference'
  label: string
} | null

function scoreClass(s: SectionScore): string {
  return `score ${s}`
}

function formatRange(start: number, end: number): string {
  return `${start.toFixed(1)}–${end.toFixed(1)}s`
}

export function ComparisonView({ take, onAnalyzed }: Props) {
  const [refBlob, setRefBlob] = useState<Blob | null>(take?.referenceBlob ?? null)
  const [refFileName, setRefFileName] = useState<string | null>(take?.referenceFileName ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AnalysisResult | null>(take?.analysis ?? null)
  const [alexiaUrl, setAlexiaUrl] = useState<string | null>(null)
  const [refUrl, setRefUrl] = useState<string | null>(null)
  const [playing, setPlaying] = useState<PlayingClip>(null)

  const alexiaAudioRef = useRef<HTMLAudioElement | null>(null)
  const refAudioRef = useRef<HTMLAudioElement | null>(null)
  const stopTimerRef = useRef<number | null>(null)
  const timeUpdateHandlerRef = useRef<((ev: Event) => void) | null>(null)
  const activeAudioRef = useRef<HTMLAudioElement | null>(null)
  /** Bumped on stop to cancel a Play-both chain mid-flight. */
  const chainTokenRef = useRef(0)
  const endResolverRef = useRef<((completed: boolean) => void) | null>(null)

  // Rebuild object URL only when the take audio identity changes — not when
  // analysis/reference metadata updates after Compare (avoids Safari “Error”).
  const takeAudioKey = take ? `${take.id}:${take.blob.size}:${take.blob.type}` : ''
  useEffect(() => {
    if (!take) {
      setAlexiaUrl(null)
      return
    }
    let cancelled = false
    const created: string[] = []
    const blob = take.blob
    void (async () => {
      let url: string
      try {
        const revived = await reviveAudioBlob(blob)
        url = URL.createObjectURL(revived)
      } catch {
        url = URL.createObjectURL(blob)
      }
      created.push(url)
      if (cancelled) {
        URL.revokeObjectURL(url)
        return
      }
      setAlexiaUrl(url)
    })()
    return () => {
      cancelled = true
      created.forEach((u) => URL.revokeObjectURL(u))
    }
    // takeAudioKey captures id/size/type; blob read above from current take
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takeAudioKey])

  useEffect(() => {
    if (!refBlob) {
      setRefUrl(null)
      return
    }
    const url = URL.createObjectURL(refBlob)
    setRefUrl(url)
    return () => {
      URL.revokeObjectURL(url)
    }
  }, [refBlob])

  useEffect(() => {
    return () => {
      clearPlaybackTimers()
      const audio = activeAudioRef.current
      if (audio && timeUpdateHandlerRef.current) {
        audio.removeEventListener('timeupdate', timeUpdateHandlerRef.current)
      }
      endResolverRef.current?.(false)
      endResolverRef.current = null
      alexiaAudioRef.current?.pause()
      refAudioRef.current?.pause()
    }
  }, [])

  function clearPlaybackTimers() {
    if (stopTimerRef.current != null) {
      window.clearTimeout(stopTimerRef.current)
      stopTimerRef.current = null
    }
  }

  function finishClip(completed: boolean) {
    const resolve = endResolverRef.current
    endResolverRef.current = null
    resolve?.(completed)
  }

  function stopPlayback() {
    chainTokenRef.current += 1
    clearPlaybackTimers()
    const audio = activeAudioRef.current
    if (audio && timeUpdateHandlerRef.current) {
      audio.removeEventListener('timeupdate', timeUpdateHandlerRef.current)
    }
    timeUpdateHandlerRef.current = null
    activeAudioRef.current = null
    alexiaAudioRef.current?.pause()
    refAudioRef.current?.pause()
    finishClip(false)
    setPlaying(null)
  }

  /**
   * Play one section clip. Resolves true when the clip ends naturally,
   * false if stopped or failed. Does not clear a pending Play-both chain token.
   */
  function playSectionClip(
    sec: SectionAnalysis,
    source: 'alexia' | 'reference',
    opts?: { keepPlayingUi?: PlayingClip },
  ): Promise<boolean> {
    clearPlaybackTimers()
    const prevAudio = activeAudioRef.current
    if (prevAudio && timeUpdateHandlerRef.current) {
      prevAudio.removeEventListener('timeupdate', timeUpdateHandlerRef.current)
    }
    timeUpdateHandlerRef.current = null
    activeAudioRef.current = null
    alexiaAudioRef.current?.pause()
    refAudioRef.current?.pause()
    finishClip(false)

    const audio = source === 'alexia' ? alexiaAudioRef.current : refAudioRef.current
    if (!audio) return Promise.resolve(false)

    const startSec = source === 'alexia' ? sec.startSec : (sec.refStartSec ?? sec.startSec)
    const endSec = source === 'alexia' ? sec.endSec : (sec.refEndSec ?? sec.endSec)
    if (!(endSec > startSec)) return Promise.resolve(false)

    return new Promise((resolve) => {
      endResolverRef.current = resolve
      activeAudioRef.current = audio

      const complete = () => {
        audio.pause()
        if (timeUpdateHandlerRef.current === onTimeUpdate) {
          audio.removeEventListener('timeupdate', onTimeUpdate)
          timeUpdateHandlerRef.current = null
          activeAudioRef.current = null
        }
        clearPlaybackTimers()
        finishClip(true)
      }

      const onTimeUpdate = () => {
        if (audio.currentTime >= endSec - 0.02) {
          complete()
        }
      }
      timeUpdateHandlerRef.current = onTimeUpdate
      audio.addEventListener('timeupdate', onTimeUpdate)

      const durationMs = Math.max(50, (endSec - startSec) * 1000) + 200
      stopTimerRef.current = window.setTimeout(() => {
        complete()
      }, durationMs)

      const ui: PlayingClip =
        opts?.keepPlayingUi ??
        ({ sectionIndex: sec.index, source, label: sec.label } satisfies NonNullable<PlayingClip>)

      try {
        audio.currentTime = startSec
        setPlaying(ui)
        void audio.play().catch((err) => {
          console.error(err)
          chainTokenRef.current += 1
          clearPlaybackTimers()
          if (timeUpdateHandlerRef.current === onTimeUpdate) {
            audio.removeEventListener('timeupdate', onTimeUpdate)
            timeUpdateHandlerRef.current = null
            activeAudioRef.current = null
          }
          finishClip(false)
          setPlaying(null)
          setError('Could not play that section. Try again, or re-upload the audio.')
        })
      } catch (err) {
        console.error(err)
        finishClip(false)
        setPlaying(null)
        setError('Could not play that section. Try again, or re-upload the audio.')
      }
    })
  }

  async function playSection(sec: SectionAnalysis, source: 'alexia' | 'reference') {
    chainTokenRef.current += 1
    const completed = await playSectionClip(sec, source)
    if (completed) setPlaying(null)
  }

  async function playBoth(sec: SectionAnalysis) {
    const token = ++chainTokenRef.current
    const bothAlexia: PlayingClip = {
      sectionIndex: sec.index,
      source: 'both',
      phase: 'alexia',
      label: sec.label,
    }
    const okAlexia = await playSectionClip(sec, 'alexia', { keepPlayingUi: bothAlexia })
    if (!okAlexia || chainTokenRef.current !== token) return

    // Short gap between clips (one clip at a time; sequential).
    await new Promise<void>((r) => {
      window.setTimeout(r, 180)
    })
    if (chainTokenRef.current !== token) return

    const bothRef: PlayingClip = {
      sectionIndex: sec.index,
      source: 'both',
      phase: 'reference',
      label: sec.label,
    }
    const okRef = await playSectionClip(sec, 'reference', { keepPlayingUi: bothRef })
    if (chainTokenRef.current === token && okRef) setPlaying(null)
  }

  const runAnalysis = async (mode: 'solo' | 'comparison') => {
    if (!take) return
    stopPlayback()
    setError(null)
    setBusy(true)
    try {
      let analysis: AnalysisResult
      if (mode === 'comparison') {
        if (!refBlob) {
          setError('Choose a reference audio file you own (CD rip / mp3 / Voice Memo) first.')
          setBusy(false)
          return
        }
        // Revive blobs before decode — helps Safari after IndexedDB restore.
        const student = await reviveAudioBlob(take.blob)
        const reference = await reviveAudioBlob(
          refBlob,
          refBlob.type || undefined,
        )
        analysis = await analyzeComparison(student, reference, {
          referenceFileName: refFileName ?? undefined,
        })
        setResult(analysis)
        // Keep in-memory analysis even if IDB persist of reference later fails.
        onAnalyzed(take.id, {
          result: analysis,
          reference: { blob: reference, fileName: refFileName ?? undefined },
        })
      } else {
        const student = await reviveAudioBlob(take.blob)
        analysis = await analyzeSolo(student)
        setResult(analysis)
        onAnalyzed(take.id, { result: analysis })
      }
    } catch (err) {
      console.error(err)
      if (err instanceof AudioDecodeError) {
        setError(err.message)
      } else if (err instanceof Error && err.message) {
        setError(`Analysis failed: ${err.message}`)
      } else {
        setError(
          'Analysis failed. Try a .m4a / .wav / .mp3 reference, or Download the take and re-import.',
        )
      }
    } finally {
      setBusy(false)
    }
  }

  if (!take) {
    return (
      <div className="comparison card">
        <h2>Practice hone</h2>
        <p className="hint">Select a saved take to analyse tempo stability and dynamics.</p>
      </div>
    )
  }

  const display = result ?? take.analysis ?? null
  const hasReferenceAudio = Boolean(refUrl && refBlob)
  const isComparison = display?.mode === 'comparison'

  return (
    <div className="comparison card">
      <h2>Practice hone</h2>
      <p className="hint">
        YouTube audio cannot be fetched in the browser (CORS). For a true “vs model” compare, upload a
        reference file you already own. Without it, we still check consistency inside Alexia’s take.
      </p>

      <audio ref={alexiaAudioRef} src={alexiaUrl ?? undefined} preload="metadata" />
      <audio ref={refAudioRef} src={refUrl ?? undefined} preload="metadata" />

      <div className="ref-upload">
        <label className="file-label">
          Optional reference audio (your CD / mp3 / Voice Memo)
          <input
            type="file"
            accept="audio/*,.mp3,.wav,.m4a,.ogg,.webm"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null
              stopPlayback()
              if (f) {
                setRefFileName(f.name)
                void (async () => {
                  try {
                    const name = f.name.toLowerCase()
                    let preferred: string | undefined
                    if (name.endsWith('.m4a') || name.endsWith('.mp4')) preferred = 'audio/mp4'
                    else if (name.endsWith('.mp3')) preferred = 'audio/mpeg'
                    else if (name.endsWith('.wav')) preferred = 'audio/wav'
                    const revived = await reviveAudioBlob(f, preferred || f.type || undefined)
                    setRefBlob(revived)
                  } catch {
                    setRefBlob(f)
                  }
                })()
              } else {
                setRefBlob(null)
                setRefFileName(null)
              }
            }}
          />
        </label>
        {refFileName && (
          <p className="file-name">
            {take.referenceBlob && refBlob === take.referenceBlob
              ? `Saved reference: ${refFileName}`
              : `Selected: ${refFileName}`}
          </p>
        )}
      </div>

      <div className="recorder-actions">
        <button type="button" className="btn primary" disabled={busy} onClick={() => runAnalysis('solo')}>
          {busy ? 'Analysing…' : 'Analyse take alone'}
        </button>
        <button
          type="button"
          className="btn secondary"
          disabled={busy || !refBlob}
          onClick={() => runAnalysis('comparison')}
        >
          Compare to reference
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {display && (
        <div className="analysis-result">
          <div className={`mode-banner ${display.mode}`}>
            {display.mode === 'solo'
              ? 'Solo consistency check — not a YouTube match'
              : 'Compared to reference — sections defined on the model, DTW-aligned to Alexia'}
          </div>
          <p className="summary">{display.summary}</p>
          {display.honeSections.length > 0 && (
            <p className="hone">
              <strong>Hone:</strong> {display.honeSections.join(', ')}
            </p>
          )}

          {playing && (
            <p className="now-playing" role="status">
              {playing.source === 'both'
                ? `Play both · ${playing.phase === 'reference' ? 'reference' : 'Alexia'} · ${playing.label}`
                : `Playing ${playing.source === 'alexia' ? 'Alexia' : 'reference'} · ${playing.label}`}
              <button type="button" className="btn tiny ghost stop-inline" onClick={stopPlayback}>
                Stop
              </button>
            </p>
          )}

          {!hasReferenceAudio && (
            <p className="play-hint-banner">
              Upload your Voice Memo / CD track above, then Compare to reference.
            </p>
          )}

          <div className="section-grid">
            {display.sections.map((sec) => {
              const isThisPlaying = playing?.sectionIndex === sec.index
              const alexiaActive =
                isThisPlaying &&
                ((playing?.source === 'alexia') ||
                  (playing?.source === 'both' && playing?.phase === 'alexia'))
              const refActive =
                isThisPlaying &&
                ((playing?.source === 'reference') ||
                  (playing?.source === 'both' && playing?.phase === 'reference'))
              const bothActive = isThisPlaying && playing?.source === 'both'
              const refStart = sec.refStartSec
              const refEnd = sec.refEndSec

              return (
                <div
                  key={sec.index}
                  className={`section-card overall-${sec.overall}${isThisPlaying ? ' is-playing' : ''}`}
                >
                  <div className="section-top">
                    <strong>{sec.label}</strong>
                    <span className="time">
                      {isComparison && refStart != null && refEnd != null ? (
                        <>
                          <span className="time-line">Alexia {formatRange(sec.startSec, sec.endSec)}</span>
                          <span className="time-line">Ref {formatRange(refStart, refEnd)}</span>
                        </>
                      ) : (
                        formatRange(sec.startSec, sec.endSec)
                      )}
                    </span>
                  </div>
                  <div className="score-row">
                    <span className={scoreClass(sec.tempoScore)}>Tempo {sec.tempoScore}</span>
                    <span className={scoreClass(sec.volumeScore)}>Volume {sec.volumeScore}</span>
                  </div>
                  <p className="section-notes">{sec.notes}</p>

                  <div className="section-play">
                    <button
                      type="button"
                      className={`btn tiny ${alexiaActive && !bothActive ? 'primary' : 'ghost'}`}
                      onClick={() => {
                        if (alexiaActive && !bothActive) stopPlayback()
                        else void playSection(sec, 'alexia')
                      }}
                      disabled={!alexiaUrl || busy}
                    >
                      {alexiaActive && !bothActive ? 'Stop Alexia' : 'Play Alexia'}
                    </button>

                    <button
                      type="button"
                      className={`btn tiny ${refActive && !bothActive ? 'secondary' : 'ghost'}`}
                      onClick={() => {
                        if (!hasReferenceAudio) return
                        if (refActive && !bothActive) stopPlayback()
                        else void playSection(sec, 'reference')
                      }}
                      disabled={!hasReferenceAudio || busy}
                      title={
                        hasReferenceAudio
                          ? refStart != null && refEnd != null
                            ? `Reference ${formatRange(refStart, refEnd)}`
                            : 'Play matching reference section'
                          : 'Upload a reference and Compare first'
                      }
                    >
                      {refActive && !bothActive ? 'Stop reference' : 'Play reference'}
                    </button>

                    <button
                      type="button"
                      className={`btn tiny ${bothActive ? 'primary' : 'ghost'}`}
                      onClick={() => {
                        if (!hasReferenceAudio) return
                        if (bothActive) stopPlayback()
                        else void playBoth(sec)
                      }}
                      disabled={!hasReferenceAudio || !alexiaUrl || busy}
                      title="Alexia’s section, then the matching reference"
                    >
                      {bothActive ? 'Stop both' : 'Play both'}
                    </button>
                  </div>
                  {bothActive && (
                    <p className="play-phase">
                      Now: {playing?.phase === 'reference' ? 'reference' : 'Alexia'}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
          <p className="legend">
            <span className="score green">Green</span> close / steady ·{' '}
            <span className="score amber">Amber</span> worth a listen ·{' '}
            <span className="score red">Red</span> hone this section
          </p>
          <p className="playback-hint">
            <strong>Play both</strong> plays the same musical section: Alexia first (DTW-aligned),
            then the reference phrase it was compared to.
            {isComparison && hasReferenceAudio
              ? ' Sections are defined on the reference so tempo differences still line up.'
              : ' Upload a reference and run Compare to unlock Play reference / Play both.'}
          </p>
        </div>
      )}
    </div>
  )
}
