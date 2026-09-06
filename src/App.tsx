import { useCallback, useEffect, useRef, useState } from 'react'
import { PieceNotes } from './components/PieceNotes'
import { PiecePicker } from './components/PiecePicker'
import { PracticeSections } from './components/PracticeSections'
import { Recorder } from './components/Recorder'
import { TakePlayer, type TakePlayerHandle } from './components/TakePlayer'
import { TakesList } from './components/TakesList'
import { YouTubePlayer, type YouTubePlayerHandle } from './components/YouTubePlayer'
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

  const youtubeRef = useRef<YouTubePlayerHandle | null>(null)
  const takePlayerRef = useRef<TakePlayerHandle | null>(null)

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
            Record Alexia’s take, mark her section times against the saved YouTube template, and
            compare by ear. All on this device — no account, no auto scoring.
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
        <TakePlayer ref={takePlayerRef} take={selectedTake} />

        <PracticeSections
          pieceId={piece.id}
          takeId={selectedTake?.id ?? null}
          youtubeRef={youtubeRef}
          takeRef={takePlayerRef}
        />

        <PieceNotes value={notes} onChange={handleNotesChange} />

        <details className="youtube-reference card">
          <summary className="youtube-reference-summary">
            YouTube reference (for cutting template)
          </summary>
          <p className="hint youtube-reference-hint">
            Optional — open when marking or tweaking the piece’s YouTube template. Daily practice can
            stay on record + Alexia times.
          </p>
          <YouTubePlayer ref={youtubeRef} youtubeId={piece.youtubeId} title={piece.title} />
        </details>
      </main>

      <footer className="footer">
        <p>
          Recordings, notes, and section marks stay in this browser (IndexedDB). YouTube audio is never
          downloaded — compare by ear with short clips you mark yourself.
        </p>
      </footer>
    </div>
  )
}
