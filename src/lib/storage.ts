import type { AnalysisResult, PieceNotes, PieceSectionMap, Take } from '../types'
import { reviveAudioBlob } from './audioMime'

const DB_NAME = 'alexia-piano-practice'
/** v2: pieceSectionMap for durable reference phrase cuts. */
const DB_VERSION = 2
const TAKES_STORE = 'takes'
const NOTES_STORE = 'notes'
const SECTION_MAP_STORE = 'pieceSectionMap'
const META_KEY = 'alexia-piano-meta'

interface TakeRecord {
  id: string
  pieceId: string
  createdAt: number
  durationMs: number
  blob?: Blob
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
      if (!db.objectStoreNames.contains(SECTION_MAP_STORE)) {
        const store = db.createObjectStore(SECTION_MAP_STORE, { keyPath: 'id' })
        store.createIndex('pieceId', 'pieceId', { unique: false })
      }
    }
  })
}

/** Key for matching the same reference file across practice sessions. */
export function referenceFileKey(fileName: string | undefined, blob: Blob): string {
  const name = (fileName || 'reference').trim().toLowerCase()
  const type = (blob.type || '').split(';')[0].trim().toLowerCase()
  return `${name}|${blob.size}|${type}`
}

export function sectionMapId(pieceId: string, refKey: string): string {
  return `${pieceId}::${refKey}`
}

export async function getPieceSectionMap(
  pieceId: string,
  refKey: string,
): Promise<PieceSectionMap | null> {
  const db = await openDb()
  const id = sectionMapId(pieceId, refKey)
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SECTION_MAP_STORE, 'readonly')
    const req = tx.objectStore(SECTION_MAP_STORE).get(id)
    req.onsuccess = () => resolve((req.result as PieceSectionMap) ?? null)
    req.onerror = () => reject(req.error)
  })
}

export async function savePieceSectionMap(map: PieceSectionMap): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SECTION_MAP_STORE, 'readwrite')
    tx.objectStore(SECTION_MAP_STORE).put(map)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function deletePieceSectionMap(pieceId: string, refKey: string): Promise<void> {
  const db = await openDb()
  const id = sectionMapId(pieceId, refKey)
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SECTION_MAP_STORE, 'readwrite')
    tx.objectStore(SECTION_MAP_STORE).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** Any saved section map for this piece (newest by updatedAt). */
export async function getLatestSectionMapForPiece(
  pieceId: string,
): Promise<PieceSectionMap | null> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SECTION_MAP_STORE, 'readonly')
    const index = tx.objectStore(SECTION_MAP_STORE).index('pieceId')
    const req = index.getAll(pieceId)
    req.onsuccess = () => {
      const rows = (req.result as PieceSectionMap[]) || []
      if (rows.length === 0) {
        resolve(null)
        return
      }
      rows.sort((a, b) => b.updatedAt - a.updatedAt)
      resolve(rows[0])
    }
    req.onerror = () => reject(req.error)
  })
}

function parseAnalysis(json: string | undefined): AnalysisResult | undefined {
  if (!json) return undefined
  try {
    return JSON.parse(json) as AnalysisResult
  } catch (err) {
    console.warn('Skipping corrupt analysis JSON for a take; keeping audio.', err)
    return undefined
  }
}

/** Map a DB record to a Take. Returns null if the audio blob is missing/unusable. */
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

  let referenceBlob = r.referenceBlob
  if (referenceBlob && referenceBlob instanceof Blob && referenceBlob.size > 0) {
    try {
      referenceBlob = await reviveAudioBlob(referenceBlob)
    } catch {
      // keep original
    }
  } else {
    referenceBlob = undefined
  }

  return {
    id: r.id,
    pieceId: r.pieceId,
    createdAt: r.createdAt,
    durationMs: r.durationMs,
    blob,
    notes: r.notes ?? '',
    analysis: parseAnalysis(r.analysisJson),
    referenceBlob,
    referenceFileName: r.referenceFileName,
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

/** All takes across pieces — for recovery / empty-piece hints. */
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

/** Counts of recoverable takes per pieceId (audio present). */
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

export type ReferenceAudioUpdate = {
  blob: Blob
  fileName?: string
}

function putRecord(db: IDBDatabase, record: TakeRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TAKES_STORE, 'readwrite')
    tx.objectStore(TAKES_STORE).put(record)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function updateTakeAnalysis(
  id: string,
  analysis: AnalysisResult,
  reference?: ReferenceAudioUpdate,
): Promise<void> {
  const db = await openDb()
  const existing = await new Promise<TakeRecord>((resolve, reject) => {
    const tx = db.transaction(TAKES_STORE, 'readonly')
    const req = tx.objectStore(TAKES_STORE).get(id)
    req.onsuccess = () => {
      const r = req.result as TakeRecord | undefined
      if (!r) reject(new Error('Take not found'))
      else resolve(r)
    }
    req.onerror = () => reject(req.error)
  })

  const analysisJson = JSON.stringify(analysis)
  const base: TakeRecord = {
    ...existing,
    analysisJson,
  }

  // Prefer saving analysis + new reference together.
  if (reference) {
    try {
      await putRecord(db, {
        ...base,
        referenceBlob: reference.blob,
        referenceFileName: reference.fileName,
      })
      return
    } catch (err) {
      console.warn(
        'Could not save reference audio (likely quota). Keeping analysis without the new reference.',
        err,
      )
    }
  }

  // Analysis with whatever reference was already stored (or none).
  try {
    await putRecord(db, base)
    return
  } catch (err) {
    console.warn('Retrying analysis save without reference blobs (quota).', err)
  }

  // Last resort: keep take audio + analysis only — never fail silently / corrupt.
  await putRecord(db, {
    id: existing.id,
    pieceId: existing.pieceId,
    createdAt: existing.createdAt,
    durationMs: existing.durationMs,
    blob: existing.blob,
    notes: existing.notes,
    analysisJson,
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
