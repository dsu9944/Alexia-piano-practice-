import { useCallback, useEffect, useState } from 'react'
import { ComparisonView, type AnalyzedPayload } from './components/ComparisonView'
import { PieceNotes } from './components/PieceNotes'
import { PiecePicker } from './components/PiecePicker'
import { Recorder } from './components/Recorder'
import { TakesList } from './components/TakesList'
import { YouTubePlayer } from './components/YouTubePlayer'
import { PIECES } from './data/pieces'
import {
  countTakesByPiece,
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
import type { Piece, Take } from './types'
import './App.css'

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function pieceTitle(pieceId: string): string {
  return PIECES.find((p) => p.id === pieceId)?.title ?? pieceId
}

export default function App() {
  const initial =
    PIECES.find((p) => p.id === getSelectedPieceId()) ?? PIECES[0]

  const [piece, setPiece] = useState<Piece>(initial)
  const [takes, setTakes] = useState<Take[]>([])
  const [selectedTake, setSelectedTake] = useState<Take | null>(null)
  const [notes, setNotes] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [otherPieceCounts, setOtherPieceCounts] = useState<{ id: string; title: string; count: number }[]>(
    [],
  )

  const refreshTakes = useCallback(async (pieceId: string) => {
    try {
      setLoadError(null)
      const list = await getTakesForPiece(pieceId)
      setTakes(list)
      setSelectedTake((prev) => {
        if (!prev) return list[0] ?? null
        return list.find((t) => t.id === prev.id) ?? list[0] ?? null
      })

      if (list.length === 0) {
        const counts = await countTakesByPiece()
        const others = Object.entries(counts)
          .filter(([id, n]) => id !== pieceId && n > 0)
          .map(([id, count]) => ({ id, title: pieceTitle(id), count }))
          .sort((a, b) => b.count - a.count)
        setOtherPieceCounts(others)
      } else {
        setOtherPieceCounts([])
      }
    } catch (err) {
      console.error(err)
      setLoadError(
        'Could not load saved takes from this browser. Your recordings are usually still on this device — try Retry, or check you are on the same browser/device.',
      )
      setTakes([])
      setOtherPieceCounts([])
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

  const handleAnalyzed = async (takeId: string, payload: AnalyzedPayload) => {
    const { result, reference } = payload
    // Always keep analysis in memory first — never wipe the take if IDB persist fails.
    const patch = (t: Take): Take => {
      if (t.id !== takeId) return t
      return {
        ...t,
        // Preserve the exact same blob reference so Saved Takes <audio> URLs stay valid.
        blob: t.blob,
        analysis: result,
        ...(reference
          ? { referenceBlob: reference.blob, referenceFileName: reference.fileName }
          : {}),
      }
    }
    setTakes((prev) => prev.map(patch))
    setSelectedTake((prev) => (prev && prev.id === takeId ? patch(prev) : prev))

    try {
      await updateTakeAnalysis(takeId, result, reference)
    } catch (err) {
      console.error('Failed to persist analysis (take audio + on-screen result are still safe):', err)
    }
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

      {loadError && (
        <div className="error banner-error load-error" role="alert">
          <p>{loadError}</p>
          <button type="button" className="btn secondary tiny" onClick={() => void refreshTakes(piece.id)}>
            Retry
          </button>
        </div>
      )}

      <PiecePicker selectedId={piece.id} onSelect={handleSelectPiece} />

      <main className="main">
        <div className="piece-heading">
          <h2>{piece.title}</h2>
          {piece.composer && <p className="composer">{piece.composer}</p>}
        </div>

        <YouTubePlayer youtubeId={piece.youtubeId} title={piece.title} />
        <Recorder onSave={handleSaveTake} />

        {!loadError && takes.length === 0 && otherPieceCounts.length > 0 && (
          <div className="recover-hint card" role="status">
            <p className="hint" style={{ marginBottom: '0.5rem' }}>
              No takes for this piece — check the piece dropdown. Recordings may be under another piece.
            </p>
            <ul className="recover-counts">
              {otherPieceCounts.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => {
                      const p = PIECES.find((x) => x.id === row.id)
                      if (p) handleSelectPiece(p)
                    }}
                  >
                    {row.title}
                  </button>
                  {' — '}
                  {row.count} take{row.count === 1 ? '' : 's'}
                </li>
              ))}
            </ul>
          </div>
        )}

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
          you own — we never download YouTube audio. After Compare, the reference is saved with the
          take so Play reference / Play both still work after refresh.
        </p>
      </footer>
    </div>
  )
}
