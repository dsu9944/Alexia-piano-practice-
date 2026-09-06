import { PIECES } from '../data/pieces'
import type { Piece } from '../types'

interface Props {
  selectedId: string
  onSelect: (piece: Piece) => void
}

export function PiecePicker({ selectedId, onSelect }: Props) {
  return (
    <div className="piece-picker">
      <h2>Choose a piece</h2>
      <p className="hint">Suzuki Piano School Book 2 — tap a piece to listen and practice.</p>
      <ul className="piece-list">
        {PIECES.map((piece, i) => (
          <li key={piece.id}>
            <button
              type="button"
              className={`piece-btn${selectedId === piece.id ? ' active' : ''}`}
              onClick={() => onSelect(piece)}
            >
              <span className="piece-num">{i + 1}</span>
              <span className="piece-text">
                <span className="piece-title">{piece.title}</span>
                {piece.composer && <span className="piece-composer">{piece.composer}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
