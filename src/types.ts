export interface Piece {
  id: string
  title: string
  youtubeId: string
  composer?: string
}

export interface Take {
  id: string
  pieceId: string
  createdAt: number
  durationMs: number
  blob: Blob
  notes: string
}

export interface PieceNotes {
  pieceId: string
  text: string
  updatedAt: number
}

/** YouTube window for a named practice bit — shared across takes for a piece. */
export interface PracticeSection {
  id: string
  label: string
  youtubeStartSec: number
  youtubeEndSec: number
}

export interface PiecePracticeSections {
  pieceId: string
  sections: PracticeSection[]
  updatedAt: number
}

/** Alexia take windows keyed by practice section id. */
export interface TakeSectionTimes {
  takeId: string
  /** sectionId → start/end on this take */
  bySection: Record<string, { startSec: number; endSec: number }>
  updatedAt: number
}
