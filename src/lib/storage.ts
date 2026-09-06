import type { AnalysisResult, PieceNotes, Take } from '../types'

const DB_NAME = 'alexia-piano-practice'
/** v1 stores; optional referenceBlob/referenceFileName added without a version bump (graceful). */
const DB_VERSION = 1
const TAKES_STORE = 'takes'
const NOTES_STORE = 'notes'
const META_KEY = 'alexia-piano-meta'

interface TakeRecord {
  id: string
  pieceId: string
  createdAt: number
  durationMs: number
  blob: Blob
  notes: string
  analysisJson?: string
  /** Optional — older records omit these; IndexedDB put merges fine. */
  referenceBlob?: Blob
  referenceFileName?: string
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(TAKES_STORE)) {
        const store = db.createObjectStore(TAKES_STORE, { keyPath: 'id' })
        store.createIndex('pieceId', 'pieceId', { unique: false })
        store.createIndex('createdAt', 'createdAt', { unique: false })
      }
      if (!db.objectStoreNames.contains(NOTES_STORE)) {
        db.createObjectStore(NOTES_STORE, { keyPath: 'pieceId' })
      }
    }
  })
}

function recordToTake(r: TakeRecord): Take {
  return {
    id: r.id,
    pieceId: r.pieceId,
    createdAt: r.createdAt,
    durationMs: r.durationMs,
    blob: r.blob,
    notes: r.notes,
    analysis: r.analysisJson ? (JSON.parse(r.analysisJson) as AnalysisResult) : undefined,
    referenceBlob: r.referenceBlob,
    referenceFileName: r.referenceFileName,
  }
}

export async function saveTake(take: Take): Promise<void> {
  const db = await openDb()
  const record: TakeRecord = {
    id: take.id,
    pieceId: take.pieceId,
    createdAt: take.createdAt,
    durationMs: take.durationMs,
    blob: take.blob,
    notes: take.notes,
    analysisJson: take.analysis ? JSON.stringify(take.analysis) : undefined,
    referenceBlob: take.referenceBlob,
    referenceFileName: take.referenceFileName,
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TAKES_STORE, 'readwrite')
    tx.objectStore(TAKES_STORE).put(record)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function getTakesForPiece(pieceId: string): Promise<Take[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TAKES_STORE, 'readonly')
    const index = tx.objectStore(TAKES_STORE).index('pieceId')
    const req = index.getAll(pieceId)
    req.onsuccess = () => {
      const takes = (req.result as TakeRecord[]).map(recordToTake)
      takes.sort((a, b) => b.createdAt - a.createdAt)
      resolve(takes)
    }
    req.onerror = () => reject(req.error)
  })
}

export async function updateTakeNotes(id: string, notes: string): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TAKES_STORE, 'readwrite')
    const store = tx.objectStore(TAKES_STORE)
    const getReq = store.get(id)
    getReq.onsuccess = () => {
      const record = getReq.result as TakeRecord | undefined
      if (!record) {
        reject(new Error('Take not found'))
        return
      }
      record.notes = notes
      store.put(record)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export type ReferenceAudioUpdate = {
  blob: Blob
  fileName?: string
}

export async function updateTakeAnalysis(
  id: string,
  analysis: AnalysisResult,
  reference?: ReferenceAudioUpdate,
): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TAKES_STORE, 'readwrite')
    const store = tx.objectStore(TAKES_STORE)
    const getReq = store.get(id)
    getReq.onsuccess = () => {
      const record = getReq.result as TakeRecord | undefined
      if (!record) {
        reject(new Error('Take not found'))
        return
      }
      record.analysisJson = JSON.stringify(analysis)
      if (reference) {
        record.referenceBlob = reference.blob
        record.referenceFileName = reference.fileName
      }
      store.put(record)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function deleteTake(id: string): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TAKES_STORE, 'readwrite')
    tx.objectStore(TAKES_STORE).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function getPieceNotes(pieceId: string): Promise<PieceNotes | null> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(NOTES_STORE, 'readonly')
    const req = tx.objectStore(NOTES_STORE).get(pieceId)
    req.onsuccess = () => resolve((req.result as PieceNotes) ?? null)
    req.onerror = () => reject(req.error)
  })
}

export async function savePieceNotes(pieceId: string, text: string): Promise<void> {
  const db = await openDb()
  const notes: PieceNotes = { pieceId, text, updatedAt: Date.now() }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(NOTES_STORE, 'readwrite')
    tx.objectStore(NOTES_STORE).put(notes)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export function getSelectedPieceId(): string | null {
  try {
    const meta = JSON.parse(localStorage.getItem(META_KEY) || '{}') as { selectedPieceId?: string }
    return meta.selectedPieceId ?? null
  } catch {
    return null
  }
}

export function setSelectedPieceId(pieceId: string): void {
  try {
    const meta = JSON.parse(localStorage.getItem(META_KEY) || '{}') as Record<string, unknown>
    meta.selectedPieceId = pieceId
    localStorage.setItem(META_KEY, JSON.stringify(meta))
  } catch {
    // ignore
  }
}
