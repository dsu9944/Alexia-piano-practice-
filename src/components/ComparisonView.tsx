import { useState } from 'react'
import { analyzeComparison, analyzeSolo } from '../lib/audioAnalysis'
import type { AnalysisResult, SectionScore, Take } from '../types'

interface Props {
  take: Take | null
  onAnalyzed: (takeId: string, result: AnalysisResult) => void
}

function scoreClass(s: SectionScore): string {
  return `score ${s}`
}

export function ComparisonView({ take, onAnalyzed }: Props) {
  const [refFile, setRefFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AnalysisResult | null>(take?.analysis ?? null)
  const runAnalysis = async (mode: 'solo' | 'comparison') => {
    if (!take) return
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

  return (
    <div className="comparison card">
      <h2>Practice hone</h2>
      <p className="hint">
        YouTube audio cannot be fetched in the browser (CORS). For a true “vs model” compare, upload a
        reference file you already own. Without it, we still check consistency inside Alexia’s take.
      </p>

      <div className="ref-upload">
        <label className="file-label">
          Optional reference audio (your CD / mp3)
          <input
            type="file"
            accept="audio/*,.mp3,.wav,.m4a,.ogg,.webm"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null
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
          <div className="section-grid">
            {display.sections.map((sec) => (
              <div key={sec.index} className={`section-card overall-${sec.overall}`}>
                <div className="section-top">
                  <strong>{sec.label}</strong>
                  <span className="time">
                    {sec.startSec.toFixed(1)}s – {sec.endSec.toFixed(1)}s
                  </span>
                </div>
                <div className="score-row">
                  <span className={scoreClass(sec.tempoScore)}>Tempo {sec.tempoScore}</span>
                  <span className={scoreClass(sec.volumeScore)}>Volume {sec.volumeScore}</span>
                </div>
                <p className="section-notes">{sec.notes}</p>
              </div>
            ))}
          </div>
          <p className="legend">
            <span className="score green">Green</span> close / steady ·{' '}
            <span className="score amber">Amber</span> worth a listen ·{' '}
            <span className="score red">Red</span> hone this section
          </p>
        </div>
      )}
    </div>
  )
}
