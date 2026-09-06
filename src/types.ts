export interface Piece {
  id: string
  title: string
  youtubeId: string
  composer?: string
}

export type SectionScore = 'green' | 'amber' | 'red'

export interface SectionAnalysis {
  index: number
  label: string
  startSec: number
  endSec: number
  /** Reference window (comparison mode only; DTW-aligned). */
  refStartSec?: number
  refEndSec?: number
  tempoScore: SectionScore
  volumeScore: SectionScore
  overall: SectionScore
  notes: string
  studentTempoProxy: number
  studentVolumeRms: number
  referenceTempoProxy?: number
  referenceVolumeRms?: number
}

export interface AnalysisResult {
  mode: 'solo' | 'comparison'
  sections: SectionAnalysis[]
  summary: string
  honeSections: string[]
  durationSec: number
}

export interface Take {
  id: string
  pieceId: string
  createdAt: number
  durationMs: number
  blob: Blob
  notes: string
  analysis?: AnalysisResult
  /** Persisted when a comparison is run so Play reference survives refresh. */
  referenceBlob?: Blob
  referenceFileName?: string
}

export interface PieceNotes {
  pieceId: string
  text: string
  updatedAt: number
}
