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

export async function getTakeSectionTimesMany(
  takeIds: string[],
): Promise<Record<string, TakeSectionTimes>> {
  const out: Record<string, TakeSectionTimes> = {}
  if (takeIds.length === 0) return out
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TAKE_SECTION_TIMES_STORE, 'readonly')
    const store = tx.objectStore(TAKE_SECTION_TIMES_STORE)
    let pending = takeIds.length
    for (const id of takeIds) {
      const req = store.get(id)
      req.onsuccess = () => {
        const row = req.result as TakeSectionTimes | undefined
        if (row) out[id] = row
        pending -= 1
        if (pending === 0) resolve(out)
      }
      req.onerror = () => reject(req.error)
    }
  })
}

/**
 * Write take section times. Merges with any existing stars/stickers so time-only
 * saves never wipe gamification fields.
 */
export async function saveTakeSectionTimes(row: TakeSectionTimes): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TAKE_SECTION_TIMES_STORE, 'readwrite')
    const store = tx.objectStore(TAKE_SECTION_TIMES_STORE)
    const getReq = store.get(row.takeId)
    getReq.onsuccess = () => {
      const prev = getReq.result as TakeSectionTimes | undefined
      const merged: TakeSectionTimes = {
        takeId: row.takeId,
        bySection: row.bySection,
        updatedAt: row.updatedAt,
        starsBySection:
          row.starsBySection !== undefined
            ? row.starsBySection
            : (prev?.starsBySection ?? {}),
        stickers: row.stickers !== undefined ? row.stickers : (prev?.stickers ?? []),
        stickersBySection:
          row.stickersBySection !== undefined
            ? row.stickersBySection
            : (prev?.stickersBySection ?? {}),
      }
      store.put(merged)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** Patch stars / stickers on a take without touching section times. */
export async function patchTakeGamification(
  takeId: string,
  patch: {
    starsBySection?: Record<string, number>
    stickers?: string[]
    stickersBySection?: Record<string, string[]>
  },
): Promise<TakeSectionTimes> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TAKE_SECTION_TIMES_STORE, 'readwrite')
    const store = tx.objectStore(TAKE_SECTION_TIMES_STORE)
    const getReq = store.get(takeId)
    getReq.onsuccess = () => {
      const prev = (getReq.result as TakeSectionTimes | undefined) ?? {
        takeId,
        bySection: {},
        starsBySection: {},
        stickers: [],
        stickersBySection: {},
        updatedAt: Date.now(),
      }
      const next: TakeSectionTimes = {
        ...prev,
        takeId,
        bySection: prev.bySection ?? {},
        starsBySection:
          patch.starsBySection !== undefined
            ? patch.starsBySection
            : (prev.starsBySection ?? {}),
        stickers: patch.stickers !== undefined ? patch.stickers : (prev.stickers ?? []),
        stickersBySection:
          patch.stickersBySection !== undefined
            ? patch.stickersBySection
            : (prev.stickersBySection ?? {}),
        updatedAt: Date.now(),
      }
      store.put(next)
      tx.oncomplete = () => resolve(next)
    }
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

/** One-time pieceId remaps after list rename (localStorage flag). */
const MIGRATE_FLAG = 'alexia-piano-id-migrate-v1'

/**
 * Legacy / transient ids → current piece ids.
 * - Early pieces: restore base ids; copy from accidental *-both if needed.
 * - minuet-2 (pre-split): → minuet-2-both.
 */
export const PIECE_ID_MIGRATE: Record<string, string> = {
  // Accidental early *-both / *-rh from the brief full RH+Both list → restored base ids
  'ecossaise-both': 'ecossaise',
  'ecossaise-rh': 'ecossaise',
  'short-story-both': 'short-story',
  'short-story-rh': 'short-story',
  'happy-farmer-both': 'happy-farmer',
  'happy-farmer-rh': 'happy-farmer',
  'minuet-1-both': 'minuet-1',
  'minuet-1-rh': 'minuet-1',
  // Pre-split Minuet 2 → both-hands
  'minuet-2': 'minuet-2-both',
}

/** Base id for a *-both / *-rh current id (PracticeSections empty fallback). */
export function legacyBasePieceId(pieceId: string): string | null {
  if (pieceId.endsWith('-both')) return pieceId.slice(0, -'-both'.length)
  if (pieceId.endsWith('-rh')) return pieceId.slice(0, -'-rh'.length)
  return null
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}

function remapSelectedPieceId(): boolean {
  try {
    const meta = JSON.parse(localStorage.getItem(META_KEY) || '{}') as {
      selectedPieceId?: string
    }
    const cur = meta.selectedPieceId
    if (!cur) return false
    const next = PIECE_ID_MIGRATE[cur]
    if (!next || next === cur) return false
    meta.selectedPieceId = next
    localStorage.setItem(META_KEY, JSON.stringify(meta))
    return true
  } catch {
    return false
  }
}

export type PieceIdMigrateResult = {
  ran: boolean
  restoredTemplates: string[]
  remappedTakes: number
  remappedNotes: number
  remappedSectionMaps: number
  remappedSelected: boolean
}

/**
 * One-time migration: remap / copy IndexedDB rows keyed by legacy pieceIds.
 * Safe to call every boot — no-ops after localStorage flag is set.
 * Uses read-all then write-all transactions to avoid IDB auto-commit races.
 */
export async function migratePieceIdsOnce(): Promise<PieceIdMigrateResult> {
  const empty: PieceIdMigrateResult = {
    ran: false,
    restoredTemplates: [],
    remappedTakes: 0,
    remappedNotes: 0,
    remappedSectionMaps: 0,
    remappedSelected: false,
  }
  try {
    if (localStorage.getItem(MIGRATE_FLAG) === '1') return empty
  } catch {
    // still attempt migrate
  }

  const remappedSelected = remapSelectedPieceId()
  const restoredTemplates: string[] = []
  let remappedTakes = 0
  let remappedNotes = 0
  let remappedSectionMaps = 0

  const db = await openDb()

  // --- practiceSections: copy old → new when new missing ---
  if (db.objectStoreNames.contains(PRACTICE_SECTIONS_STORE)) {
    const all = await new Promise<PiecePracticeSections[]>((resolve, reject) => {
      const tx = db.transaction(PRACTICE_SECTIONS_STORE, 'readonly')
      const req = tx.objectStore(PRACTICE_SECTIONS_STORE).getAll()
      req.onsuccess = () => resolve((req.result as PiecePracticeSections[]) ?? [])
      req.onerror = () => reject(req.error)
    })
    const byId = new Map(all.map((r) => [r.pieceId, r]))
    const toWrite: PiecePracticeSections[] = []
    for (const [oldId, newId] of Object.entries(PIECE_ID_MIGRATE)) {
      const oldRow = byId.get(oldId)
      if (!oldRow?.sections?.length) continue
      const newRow = byId.get(newId)
      if (newRow?.sections?.length) continue
      toWrite.push({
        pieceId: newId,
        sections: oldRow.sections,
        updatedAt: Date.now(),
      })
      restoredTemplates.push(newId)
    }
    if (toWrite.length > 0) {
      const tx = db.transaction(PRACTICE_SECTIONS_STORE, 'readwrite')
      const store = tx.objectStore(PRACTICE_SECTIONS_STORE)
      for (const row of toWrite) store.put(row)
      await txDone(tx)
    }
  }

  // --- takes: update pieceId in place ---
  if (db.objectStoreNames.contains(TAKES_STORE)) {
    const all = await new Promise<TakeRecord[]>((resolve, reject) => {
      const tx = db.transaction(TAKES_STORE, 'readonly')
      const req = tx.objectStore(TAKES_STORE).getAll()
      req.onsuccess = () => resolve((req.result as TakeRecord[]) ?? [])
      req.onerror = () => reject(req.error)
    })
    const toWrite = all
      .map((rec) => {
        const next = PIECE_ID_MIGRATE[rec.pieceId]
        if (!next || next === rec.pieceId) return null
        return { ...rec, pieceId: next }
      })
      .filter((r): r is TakeRecord => r != null)
    if (toWrite.length > 0) {
      const tx = db.transaction(TAKES_STORE, 'readwrite')
      const store = tx.objectStore(TAKES_STORE)
      for (const rec of toWrite) store.put(rec)
      await txDone(tx)
      remappedTakes = toWrite.length
    }
  }

  // --- notes: copy old → new when new empty ---
  if (db.objectStoreNames.contains(NOTES_STORE)) {
    const all = await new Promise<PieceNotes[]>((resolve, reject) => {
      const tx = db.transaction(NOTES_STORE, 'readonly')
      const req = tx.objectStore(NOTES_STORE).getAll()
      req.onsuccess = () => resolve((req.result as PieceNotes[]) ?? [])
      req.onerror = () => reject(req.error)
    })
    const byId = new Map(all.map((r) => [r.pieceId, r]))
    const toWrite: PieceNotes[] = []
    for (const [oldId, newId] of Object.entries(PIECE_ID_MIGRATE)) {
      const oldRow = byId.get(oldId)
      if (!oldRow) continue
      const newRow = byId.get(newId)
      if (newRow && (newRow.text?.trim() ?? '') !== '') continue
      toWrite.push({
        pieceId: newId,
        text: oldRow.text,
        updatedAt: Date.now(),
      })
    }
    if (toWrite.length > 0) {
      const tx = db.transaction(NOTES_STORE, 'readwrite')
      const store = tx.objectStore(NOTES_STORE)
      for (const row of toWrite) store.put(row)
      await txDone(tx)
      remappedNotes = toWrite.length
    }
  }

  // --- pieceSectionMap (legacy): remap pieceId ---
  if (db.objectStoreNames.contains(SECTION_MAP_STORE)) {
    type SectionMapRow = { id: string; pieceId: string } & Record<string, unknown>
    const all = await new Promise<SectionMapRow[]>((resolve, reject) => {
      const tx = db.transaction(SECTION_MAP_STORE, 'readonly')
      const req = tx.objectStore(SECTION_MAP_STORE).getAll()
      req.onsuccess = () => resolve((req.result as SectionMapRow[]) ?? [])
      req.onerror = () => reject(req.error)
    })
    const toWrite = all
      .map((rec) => {
        const next = PIECE_ID_MIGRATE[rec.pieceId]
        if (!next || next === rec.pieceId) return null
        return { ...rec, pieceId: next }
      })
      .filter((r): r is SectionMapRow => r != null)
    if (toWrite.length > 0) {
      const tx = db.transaction(SECTION_MAP_STORE, 'readwrite')
      const store = tx.objectStore(SECTION_MAP_STORE)
      for (const rec of toWrite) store.put(rec)
      await txDone(tx)
      remappedSectionMaps = toWrite.length
    }
  }

  try {
    localStorage.setItem(MIGRATE_FLAG, '1')
  } catch {
    // ignore
  }

  return {
    ran: true,
    restoredTemplates,
    remappedTakes,
    remappedNotes,
    remappedSectionMaps,
    remappedSelected,
  }
}

/**
 * Load practice sections; if empty, try legacy id once and copy forward.
 */
export async function getPiecePracticeSectionsWithLegacyFallback(
  pieceId: string,
): Promise<{ row: PiecePracticeSections | null; restoredFromLegacy: boolean }> {
  const row = await getPiecePracticeSections(pieceId)
  if (row?.sections?.length) {
    return { row, restoredFromLegacy: false }
  }

  let legacyId: string | null = null
  for (const [oldId, newId] of Object.entries(PIECE_ID_MIGRATE)) {
    if (newId === pieceId) {
      legacyId = oldId
      break
    }
  }
  if (!legacyId) legacyId = legacyBasePieceId(pieceId)
  if (!legacyId || legacyId === pieceId) {
    return { row: row ?? null, restoredFromLegacy: false }
  }

  const legacy = await getPiecePracticeSections(legacyId)
  if (!legacy?.sections?.length) {
    return { row: row ?? null, restoredFromLegacy: false }
  }

  const copied: PiecePracticeSections = {
    pieceId,
    sections: legacy.sections,
    updatedAt: Date.now(),
  }
  try {
    await savePiecePracticeSections(copied)
  } catch (err) {
    console.warn('Could not copy legacy practice sections forward', err)
  }
  return { row: copied, restoredFromLegacy: true }
}
