import { useEffect, useRef, useState } from 'react'
import { analyzeComparison, analyzeSolo } from '../lib/audioAnalysis'
import type { AnalysisResult, SectionAnalysis, SectionScore, Take } from '../types'

interface Props {
  take: Take | null
  onAnalyzed: (takeId: string, result: AnalysisResult) => void
}

type PlayingClip = {
  sectionIndex: number
  source: 'alexia' | 'reference'
  label: string
} | null

function scoreClass(s: SectionScore): string {
  return `score ${s}`
}

function formatRange(start: number, end: number): string {
  return `${start.toFixed(1)}s – ${end.toFixed(1)}s`
}

export function ComparisonView({ take, onAnalyzed }: Props) {
  const [refFile, setRefFile] = useState<File | null>(null)
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

  useEffect(() => {
    if (!take) {
      setAlexiaUrl(null)
      return
    }
    const url = URL.createObjectURL(take.blob)
    setAlexiaUrl(url)
    return () => {
      URL.revokeObjectURL(url)
    }
  }, [take])

  useEffect(() => {
    if (!refFile) {
      setRefUrl(null)
      return
    }
    const url = URL.createObjectURL(refFile)
    setRefUrl(url)
    return () => {
      URL.revokeObjectURL(url)
    }
  }, [refFile])

  useEffect(() => {
    return () => {
      clearPlaybackTimers()
      const audio = activeAudioRef.current
      if (audio && timeUpdateHandlerRef.current) {
        audio.removeEventListener('timeupdate', timeUpdateHandlerRef.current)
      }
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

  function stopPlayback() {
    clearPlaybackTimers()
    const audio = activeAudioRef.current
    if (audio && timeUpdateHandlerRef.current) {
      audio.removeEventListener('timeupdate', timeUpdateHandlerRef.current)
    }
    timeUpdateHandlerRef.current = null
    activeAudioRef.current = null
    alexiaAudioRef.current?.pause()
    refAudioRef.current?.pause()
    setPlaying(null)
  }

  async function playSection(
    sec: SectionAnalysis,
    source: 'alexia' | 'reference',
  ) {
    stopPlayback()

    const audio = source === 'alexia' ? alexiaAudioRef.current : refAudioRef.current
    if (!audio) return

    const startSec = source === 'alexia' ? sec.startSec : (sec.refStartSec ?? sec.startSec)
    const endSec = source === 'alexia' ? sec.endSec : (sec.refEndSec ?? sec.endSec)
    if (!(endSec > startSec)) return

    activeAudioRef.current = audio
    const onTimeUpdate = () => {
      if (audio.currentTime >= endSec - 0.02) {
        audio.pause()
        audio.removeEventListener('timeupdate', onTimeUpdate)
        if (timeUpdateHandlerRef.current === onTimeUpdate) {
          timeUpdateHandlerRef.current = null
          activeAudioRef.current = null
        }
        clearPlaybackTimers()
        setPlaying(null)
      }
    }
    timeUpdateHandlerRef.current = onTimeUpdate
    audio.addEventListener('timeupdate', onTimeUpdate)

    const durationMs = Math.max(50, (endSec - startSec) * 1000) + 200
    stopTimerRef.current = window.setTimeout(() => {
      audio.pause()
      audio.removeEventListener('timeupdate', onTimeUpdate)
      if (timeUpdateHandlerRef.current === onTimeUpdate) {
        timeUpdateHandlerRef.current = null
        activeAudioRef.current = null
      }
      setPlaying(null)
    }, durationMs)

    try {
      audio.currentTime = startSec
      setPlaying({ sectionIndex: sec.index, source, label: sec.label })
      await audio.play()
    } catch (err) {
      console.error(err)
      stopPlayback()
      setError('Could not play that section. Try again, or re-upload the audio.')
    }
  }

  const runAnalysis = async (mode: 'solo' | 'comparison') => {
    if (!take) return
    stopPlayback()
    setError(null)
    setBusy(true)
    try {
      let analysis: AnalysisResult
      if (mode === 'comparison') {
        if (!refFile) {
          setError('Choose a reference audio file you own (CD rip / mp3) first.')
          setBusy(false)
          return
        }
        analysis = await analyzeComparison(take.blob, refFile)
      } else {
        analysis = await analyzeSolo(take.blob)
      }
      setResult(analysis)
      onAnalyzed(take.id, analysis)
    } catch (err) {
      console.error(err)
      setError('Analysis failed. Try a different audio format (wav/mp3/m4a/webm).')
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
  const hasReferenceAudio = Boolean(refUrl)
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
          Optional reference audio (your CD / mp3)
          <input
            type="file"
            accept="audio/*,.mp3,.wav,.m4a,.ogg,.webm"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null
              stopPlayback()
              setRefFile(f)
            }}
          />
        </label>
        {refFile && <p className="file-name">Selected: {refFile.name}</p>}
      </div>

      <div className="recorder-actions">
        <button type="button" className="btn primary" disabled={busy} onClick={() => runAnalysis('solo')}>
          {busy ? 'Analysing…' : 'Analyse take alone'}
        </button>
        <button
          type="button"
          className="btn secondary"
          disabled={busy || !refFile}
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
              : 'Compared to your uploaded reference'}
          </div>
          <p className="summary">{display.summary}</p>
          {display.honeSections.length > 0 && (
            <p className="hone">
              <strong>Hone:</strong> {display.honeSections.join(', ')}
            </p>
          )}

          {playing && (
            <p className="now-playing" role="status">
              Playing {playing.source === 'alexia' ? 'Alexia' : 'reference'} · {playing.label}
              <button type="button" className="btn tiny ghost stop-inline" onClick={stopPlayback}>
                Stop
              </button>
            </p>
          )}

          <div className="section-grid">
            {display.sections.map((sec) => {
              const isThisPlaying = playing?.sectionIndex === sec.index
              const alexiaActive = isThisPlaying && playing?.source === 'alexia'
              const refActive = isThisPlaying && playing?.source === 'reference'
              const refStart = sec.refStartSec
              const refEnd = sec.refEndSec

              return (
                <div
                  key={sec.index}
                  className={`section-card overall-${sec.overall}${isThisPlaying ? ' is-playing' : ''}`}
                >
                  <div className="section-top">
                    <strong>{sec.label}</strong>
                    <span className="time">{formatRange(sec.startSec, sec.endSec)}</span>
                  </div>
                  <div className="score-row">
                    <span className={scoreClass(sec.tempoScore)}>Tempo {sec.tempoScore}</span>
                    <span className={scoreClass(sec.volumeScore)}>Volume {sec.volumeScore}</span>
                  </div>
                  <p className="section-notes">{sec.notes}</p>

                  <div className="section-play">
                    <button
                      type="button"
                      className={`btn tiny ${alexiaActive ? 'primary' : 'ghost'}`}
                      onClick={() => {
                        if (alexiaActive) stopPlayback()
                        else void playSection(sec, 'alexia')
                      }}
                      disabled={!alexiaUrl || busy}
                    >
                      {alexiaActive ? 'Stop Alexia' : 'Play Alexia'}
                    </button>

                    {isComparison ? (
                      hasReferenceAudio ? (
                        <button
                          type="button"
                          className={`btn tiny ${refActive ? 'secondary' : 'ghost'}`}
                          onClick={() => {
                            if (refActive) stopPlayback()
                            else void playSection(sec, 'reference')
                          }}
                          disabled={busy}
                          title={
                            refStart != null && refEnd != null
                              ? `Reference ${formatRange(refStart, refEnd)}`
                              : 'Play matching reference section'
                          }
                        >
                          {refActive ? 'Stop reference' : 'Play reference'}
                        </button>
                      ) : (
                        <span className="play-note">Re-select reference to hear it</span>
                      )
                    ) : (
                      <span className="play-note">No reference in solo mode</span>
                    )}
                  </div>
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
            Use <strong>Play Alexia</strong> to hear just that part of her take
            {isComparison
              ? ', and Play reference for the matching stretch of your uploaded model recording.'
              : '. Upload a reference and run Compare to also hear the model side-by-side.'}
          </p>
        </div>
      )}
    </div>
  )
}
