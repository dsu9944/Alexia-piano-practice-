import { PIECES } from '../data/pieces'
import type { Piece } from '../types'

interface Props {
  selectedId: string
  onSelect: (piece: Piece) => void
}

export function PiecePicker({ selectedId, onSelect }: Props) {
  const handleChange = (e: { target: { value: string } }) => {
    const piece = PIECES.find((p) => p.id === e.target.value)
    if (piece) onSelect(piece)
  }

  return (
    <div className="piece-picker">
      <label htmlFor="piece-select" className="piece-select-label">
        Choose a piece
      </label>
      <p className="hint">Suzuki Piano School Book 2 — pick a piece to listen and practice.</p>
      <select
        id="piece-select"
        className="piece-select"
        value={selectedId}
        onChange={handleChange}
      >
        {PIECES.map((piece, i) => (
          <option key={piece.id} value={piece.id}>
            {i + 1}. {piece.title}
            {piece.composer ? ` — ${piece.composer}` : ''}
          </option>
        ))}
      </select>
    </div>
  )
}
