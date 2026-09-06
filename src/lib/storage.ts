import type {
  PieceNotes,
  PiecePracticeSections,
  Take,
  TakeSectionTimes,
} from '../types'
import { reviveAudioBlob } from './audioMime'

const DB_NAME = 'alexia-piano-practice'
/** v3: practiceSections (YT per piece) + takeSectionTimes (Alexia per take). */
const DB_VERSION = 3
const TAKES_STORE = 'takes'
const NOTES_STORE = 'notes'
const SECTION_MAP_STORE = 'pieceSectionMap'
const PRACTICE_SECTIONS_STORE = 'practiceSections'
const TAKE_SECTION_TIMES_STORE = 'takeSectionTimes'
const META_KEY = 'alexia-piano-meta'

interface TakeRecord {
  id: string
  pieceId: string
  createdAt: number
  durationMs: number
  blob?: Blob
  notes: string
  /** Legacy fields — ignored by the ear-compare UI. */
  analysisJson?: string
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
      if (!db.objectStoreNames.contains(SECTION_MAP_STORE)) {
        const store = db.createObjectStore(SECTION_MAP_STORE, { keyPath: 'id' })
        store.createIndex('pieceId', 'pieceId', { unique: false })
      }
      if (!db.objectStoreNames.contains(PRACTICE_SECTIONS_STORE)) {
        db.createObjectStore(PRACTICE_SECTIONS_STORE, { keyPath: 'pieceId' })
      }
      if (!db.objectStoreNames.contains(TAKE_SECTION_TIMES_STORE)) {
        db.createObjectStore(TAKE_SECTION_TIMES_STORE, { keyPath: 'takeId' })
      }
    }
  })
}

async function recordToTake(r: TakeRecord): Promise<Take | null> {
  if (!r.blob || !(r.blob instanceof Blob) || r.blob.size === 0) {
    console.warn('Skipping take with missing/empty audio blob:', r.id, r.pieceId)
    return null
  }
  let blob: Blob
  try {
    blob = await reviveAudioBlob(r.blob)
  } catch (err) {
    console.warn('Could not revive audio blob; using stored blob as-is:', r.id, err)
    blob = r.blob
  }

  return {
    id: r.id,
    pieceId: r.pieceId,
    createdAt: r.createdAt,
    durationMs: r.durationMs,
    blob,
    notes: r.notes ?? '',
  }
}

async function recordsToTakes(records: TakeRecord[]): Promise<Take[]> {
  const takes: Take[] = []
  for (const r of records) {
    try {
      const take = await recordToTake(r)
      if (take) takes.push(take)
    } catch (err) {
      console.warn('Skipping unreadable take record:', r.id, err)
    }
  }
  takes.sort((a, b) => b.createdAt - a.createdAt)
  return takes
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
      void recordsToTakes(req.result as TakeRecord[])
        .then(resolve)
        .catch((err) => {
          console.error('Failed to map takes for piece; returning empty list.', err)
          resolve([])
        })
    }
    req.onerror = () => reject(req.error)
  })
}

export async function listAllTakes(): Promise<Take[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TAKES_STORE, 'readonly')
    const req = tx.objectStore(TAKES_STORE).getAll()
    req.onsuccess = () => {
      void recordsToTakes(req.result as TakeRecord[])
        .then(resolve)
        .catch((err) => {
          console.error('Failed to map all takes; returning empty list.', err)
          resolve([])
        })
    }
    req.onerror = () => reject(req.error)
  })
}

export async function countTakesByPiece(): Promise<Record<string, number>> {
  const all = await listAllTakes()
  const counts: Record<string, number> = {}
  for (const t of all) {
    counts[t.pieceId] = (counts[t.pieceId] ?? 0) + 1
  }
  return counts
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

export async function deleteTake(id: string): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction([TAKES_STORE, TAKE_SECTION_TIMES_STORE], 'readwrite')
    tx.objectStore(TAKES_STORE).delete(id)
    tx.objectStore(TAKE_SECTION_TIMES_STORE).delete(id)
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

export async function getPiecePracticeSections(
  pieceId: string,
): Promise<PiecePracticeSections | null> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PRACTICE_SECTIONS_STORE, 'readonly')
    const req = tx.objectStore(PRACTICE_SECTIONS_STORE).get(pieceId)
    req.onsuccess = () => resolve((req.result as PiecePracticeSections) ?? null)
    req.onerror = () => reject(req.error)
  })
}

export async function savePiecePracticeSections(
  row: PiecePracticeSections,
): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PRACTICE_SECTIONS_STORE, 'readwrite')
    tx.objectStore(PRACTICE_SECTIONS_STORE).put(row)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function getTakeSectionTimes(takeId: string): Promise<TakeSectionTimes | null> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TAKE_SECTION_TIMES_STORE, 'readonly')
    const req = tx.objectStore(TAKE_SECTION_TIMES_STORE).get(takeId)
    req.onsuccess = () => resolve((req.result as TakeSectionTimes) ?? null)
    req.onerror = () => reject(req.error)
  })
}

export async function saveTakeSectionTimes(row: TakeSectionTimes): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TAKE_SECTION_TIMES_STORE, 'readwrite')
    tx.objectStore(TAKE_SECTION_TIMES_STORE).put(row)
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
