import { useCallback, useEffect, useState } from 'react'
import { ComparisonView } from './components/ComparisonView'
import { PieceNotes } from './components/PieceNotes'
import { PiecePicker } from './components/PiecePicker'
import { Recorder } from './components/Recorder'
import { TakesList } from './components/TakesList'
import { YouTubePlayer } from './components/YouTubePlayer'
import { PIECES } from './data/pieces'
import {
  deleteTake,
  getPieceNotes,
  getSelectedPieceId,
  getTakesForPiece,
  savePieceNotes,
  saveTake,
  setSelectedPieceId,
  updateTakeAnalysis,
  updateTakeNotes,
} from './lib/storage'
import type { AnalysisResult, Piece, Take } from './types'
import './App.css'

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export default function App() {
  const initial =
    PIECES.find((p) => p.id === getSelectedPieceId()) ?? PIECES[0]

  const [piece, setPiece] = useState<Piece>(initial)
  const [takes, setTakes] = useState<Take[]>([])
  const [selectedTake, setSelectedTake] = useState<Take | null>(null)
  const [notes, setNotes] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)

  const refreshTakes = useCallback(async (pieceId: string) => {
    try {
      const list = await getTakesForPiece(pieceId)
      setTakes(list)
      setSelectedTake((prev) => {
        if (!prev) return list[0] ?? null
        return list.find((t) => t.id === prev.id) ?? list[0] ?? null
      })
    } catch (err) {
      console.error(err)
      setLoadError('Could not load saved takes from this browser.')
    }
  }, [])

  useEffect(() => {
    setSelectedPieceId(piece.id)
    void refreshTakes(piece.id)
    void getPieceNotes(piece.id).then((n) => setNotes(n?.text ?? ''))
  }, [piece.id, refreshTakes])

  const handleSelectPiece = (p: Piece) => {
    setPiece(p)
    setSelectedTake(null)
  }

  const handleSaveTake = async (blob: Blob, durationMs: number) => {
    const take: Take = {
      id: newId(),
      pieceId: piece.id,
      createdAt: Date.now(),
      durationMs,
      blob,
      notes: '',
    }
    await saveTake(take)
    await refreshTakes(piece.id)
    setSelectedTake(take)
  }

  const handleDelete = async (id: string) => {
    await deleteTake(id)
    await refreshTakes(piece.id)
  }

  const handleTakeNotes = async (id: string, text: string) => {
    await updateTakeNotes(id, text)
    setTakes((prev) => prev.map((t) => (t.id === id ? { ...t, notes: text } : t)))
    setSelectedTake((prev) => (prev && prev.id === id ? { ...prev, notes: text } : prev))
  }

  const handleAnalyzed = async (takeId: string, result: AnalysisResult) => {
    await updateTakeAnalysis(takeId, result)
    setTakes((prev) => prev.map((t) => (t.id === takeId ? { ...t, analysis: result } : t)))
    setSelectedTake((prev) => (prev && prev.id === takeId ? { ...prev, analysis: result } : prev))
  }

  const handleNotesChange = (text: string) => {
    setNotes(text)
    void savePieceNotes(piece.id, text)
  }

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">Suzuki Piano School · Book 2</p>
          <h1>Alexia Piano Practice</h1>
          <p className="tagline">
            Listen, record, and gently hone each piece — all on this device, no account needed.
          </p>
        </div>
      </header>

      {loadError && <p className="error banner-error">{loadError}</p>}

      <PiecePicker selectedId={piece.id} onSelect={handleSelectPiece} />

      <main className="main">
        <div className="piece-heading">
          <h2>{piece.title}</h2>
          {piece.composer && <p className="composer">{piece.composer}</p>}
        </div>

        <YouTubePlayer youtubeId={piece.youtubeId} title={piece.title} />
        <Recorder onSave={handleSaveTake} />
        <TakesList
          takes={takes}
          selectedId={selectedTake?.id ?? null}
          onSelect={setSelectedTake}
          onDelete={handleDelete}
          onUpdateNotes={handleTakeNotes}
        />
        <ComparisonView
          key={selectedTake?.id ?? 'none'}
          take={selectedTake}
          onAnalyzed={handleAnalyzed}
        />
        <PieceNotes value={notes} onChange={handleNotesChange} />
      </main>

      <footer className="footer">
        <p>
          Recordings and notes stay in this browser (IndexedDB). Reference compare needs an audio file
          you own — we never download YouTube audio.
        </p>
      </footer>
    </div>
  )
}
