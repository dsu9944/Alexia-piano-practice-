import type { AnalysisResult, SectionAnalysis, SectionScore } from '../types'

const SECTION_COUNT = 6
const FRAME_SIZE = 2048
const HOP_SIZE = 512
/** Downsample length for DTW (balance quality vs browser CPU). */
const DTW_POINTS = 176
/** Relative + absolute RMS floors for silence trim. */
const SILENCE_REL = 0.02
const SILENCE_ABS = 0.0015
const SILENCE_PAD_SEC = 0.12
/** Clamp mapped section length vs expected (refLen * globalTempo). Prefer short. */
const DUR_CLAMP_LO = 0.5
const DUR_CLAMP_HI = 1.15

/** Guess mime from filename (Voice Memos are often .m4a with empty type). */
function guessMimeFromName(name?: string): string | undefined {
  if (!name) return undefined
  const lower = name.toLowerCase()
  if (lower.endsWith('.m4a') || lower.endsWith('.mp4') || lower.endsWith('.aac')) return 'audio/mp4'
  if (lower.endsWith('.mp3')) return 'audio/mpeg'
  if (lower.endsWith('.wav')) return 'audio/wav'
  if (lower.endsWith('.webm')) return 'audio/webm'
  if (lower.endsWith('.ogg') || lower.endsWith('.oga')) return 'audio/ogg'
  return undefined
}

const DECODE_MIME_CANDIDATES = [
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/mpeg',
  'audio/wav',
  'audio/webm',
  'audio/ogg',
] as const

export class AudioDecodeError extends Error {
  constructor(
    message: string,
    public readonly which: 'take' | 'reference' | 'audio',
  ) {
    super(message)
    this.name = 'AudioDecodeError'
  }
}

/**
 * Safari is strict: IndexedDB blobs / Voice Memos often need a fresh ArrayBuffer
 * copy (and sometimes an explicit mime wrap) before decodeAudioData succeeds —
 * even when <audio> can play the same bytes.
 */
export async function decodeAudioBlob(
  blob: Blob,
  opts?: { fileName?: string; which?: 'take' | 'reference' | 'audio' },
): Promise<AudioBuffer> {
  const which = opts?.which ?? 'audio'
  const raw = await blob.arrayBuffer()
  const bytes = new Uint8Array(raw)

  const types: string[] = []
  const push = (t?: string) => {
    if (!t) return
    const base = t.split(';')[0].trim()
    if (base && !types.includes(base)) types.push(base)
  }
  push(blob.type)
  push(guessMimeFromName(opts?.fileName))
  for (const t of DECODE_MIME_CANDIDATES) push(t)

  const ctx = new AudioContext()
  try {
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume()
      } catch {
        // ignore — still try decode
      }
    }

    let lastErr: unknown
    for (const type of types) {
      try {
        // Fresh copy each attempt — Safari may detach the buffer on failure.
        const copy = bytes.slice().buffer
        const wrapped = new Blob([copy], { type })
        const ab = await wrapped.arrayBuffer()
        return await ctx.decodeAudioData(ab.slice(0))
      } catch (err) {
        lastErr = err
      }
    }

    // Last resort: decode the raw copy with no Blob wrap
    try {
      return await ctx.decodeAudioData(bytes.slice().buffer)
    } catch (err) {
      lastErr = err
    }

    const label =
      which === 'take'
        ? "Couldn't read Alexia's take"
        : which === 'reference'
          ? "Couldn't read the reference file"
          : "Couldn't decode audio"
    const detail =
      lastErr instanceof Error && lastErr.message ? ` (${lastErr.message})` : ''
    void lastErr
    throw new AudioDecodeError(
      `${label}. Try Download on the take, or re-export the Voice Memo as .m4a / .wav.${detail}`,
      which,
    )
  } finally {
    try {
      await ctx.close()
    } catch {
      // ignore
    }
  }
}

function getMono(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels
  const length = buffer.length
  const mono = new Float32Array(length)
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < length; i++) {
      mono[i] += data[i] / channels
    }
  }
  return mono
}

/** RMS energy per analysis frame */
function computeRmsEnvelope(samples: Float32Array, sampleRate: number): { times: Float32Array; rms: Float32Array } {
  const frameCount = Math.max(1, Math.floor((samples.length - FRAME_SIZE) / HOP_SIZE) + 1)
  const times = new Float32Array(frameCount)
  const rms = new Float32Array(frameCount)
  for (let i = 0; i < frameCount; i++) {
    const start = i * HOP_SIZE
    let sum = 0
    const end = Math.min(start + FRAME_SIZE, samples.length)
    for (let j = start; j < end; j++) {
      sum += samples[j] * samples[j]
    }
    rms[i] = Math.sqrt(sum / Math.max(1, end - start))
    times[i] = (start + FRAME_SIZE / 2) / sampleRate
  }
  return { times, rms }
}

/**
 * Trim leading/trailing low-RMS silence. Returns a view into the active region
 * plus the offset (seconds) of that region in the original timeline so playback
 * times can be mapped back.
 */
function trimSilence(
  samples: Float32Array,
  sampleRate: number,
): { samples: Float32Array; offsetSec: number; activeDurationSec: number; originalDurationSec: number } {
  const originalDurationSec = samples.length / sampleRate
  if (samples.length < FRAME_SIZE * 2) {
    return {
      samples,
      offsetSec: 0,
      activeDurationSec: originalDurationSec,
      originalDurationSec,
    }
  }

  const { rms } = computeRmsEnvelope(samples, sampleRate)
  let peak = 0
  for (let i = 0; i < rms.length; i++) peak = Math.max(peak, rms[i])
  const threshold = Math.max(peak * SILENCE_REL, SILENCE_ABS)

  let first = 0
  while (first < rms.length && rms[first] < threshold) first++
  let last = rms.length - 1
  while (last > first && rms[last] < threshold) last--

  if (first >= last) {
    return {
      samples,
      offsetSec: 0,
      activeDurationSec: originalDurationSec,
      originalDurationSec,
    }
  }

  const padSamples = Math.floor(SILENCE_PAD_SEC * sampleRate)
  const startSample = Math.max(0, first * HOP_SIZE - padSamples)
  const endSample = Math.min(samples.length, last * HOP_SIZE + FRAME_SIZE + padSamples)
  const trimmed = samples.subarray(startSample, endSample)
  const offsetSec = startSample / sampleRate
  const activeDurationSec = trimmed.length / sampleRate

  return { samples: trimmed, offsetSec, activeDurationSec, originalDurationSec }
}

/** Onset strength: positive first difference of RMS, floored at 0 */
function onsetStrength(rms: Float32Array): Float32Array {
  const out = new Float32Array(rms.length)
  for (let i = 1; i < rms.length; i++) {
    out[i] = Math.max(0, rms[i] - rms[i - 1])
  }
  return out
}

function smoothEnvelope(arr: Float32Array, radius: number): Float32Array {
  const out = new Float32Array(arr.length)
  for (let i = 0; i < arr.length; i++) {
    let sum = 0
    let c = 0
    for (let j = Math.max(0, i - radius); j <= Math.min(arr.length - 1, i + radius); j++) {
      sum += arr[j]
      c++
    }
    out[i] = c > 0 ? sum / c : 0
  }
  return out
}

interface SectionMetrics {
  startSec: number
  endSec: number
  tempoProxy: number
  volumeRms: number
  onsetTimes: number[]
}

function sectionMetrics(
  times: Float32Array,
  rms: Float32Array,
  onsets: Float32Array,
  startSec: number,
  endSec: number,
): SectionMetrics {
  let rmsSum = 0
  let rmsCount = 0
  let onsetSum = 0
  const onsetTimes: number[] = []
  let onsetMean = 0
  let onsetCount = 0
  for (let i = 0; i < times.length; i++) {
    if (times[i] < startSec || times[i] > endSec) continue
    onsetMean += onsets[i]
    onsetCount++
  }
  onsetMean = onsetCount > 0 ? onsetMean / onsetCount : 0
  const threshold = Math.max(onsetMean * 1.8, 0.002)

  for (let i = 0; i < times.length; i++) {
    if (times[i] < startSec || times[i] > endSec) continue
    rmsSum += rms[i]
    rmsCount++
    onsetSum += onsets[i]
    if (
      onsets[i] > threshold &&
      (i === 0 || onsets[i] >= onsets[i - 1]) &&
      (i === onsets.length - 1 || onsets[i] >= onsets[i + 1])
    ) {
      onsetTimes.push(times[i])
    }
  }
  const duration = Math.max(0.001, endSec - startSec)
  const density = onsetTimes.length / duration
  const flux = onsetSum / Math.max(1, rmsCount) / duration
  const tempoProxy = density * 0.7 + flux * 30

  return {
    startSec,
    endSec,
    tempoProxy,
    volumeRms: rmsCount > 0 ? rmsSum / rmsCount : 0,
    onsetTimes,
  }
}

function scoreFromRatio(ratio: number, good = 0.15, ok = 0.35): SectionScore {
  const d = Math.abs(1 - ratio)
  if (d <= good) return 'green'
  if (d <= ok) return 'amber'
  return 'red'
}

function scoreSoloStability(values: number[]): SectionScore[] {
  if (values.length === 0) return []
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  if (mean < 1e-8) return values.map(() => 'amber' as SectionScore)
  return values.map((v) => {
    const d = Math.abs(v - mean) / mean
    if (d <= 0.2) return 'green'
    if (d <= 0.4) return 'amber'
    return 'red'
  })
}

function worse(a: SectionScore, b: SectionScore): SectionScore {
  const rank = { green: 0, amber: 1, red: 2 }
  return rank[a] >= rank[b] ? a : b
}

function labelFor(i: number, n: number): string {
  if (n <= 4) {
    const names = ['Opening', 'Middle A', 'Middle B', 'Ending']
    return names[i] ?? `Section ${i + 1}`
  }
  return `Section ${i + 1}`
}

function downsample(arr: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n)
  if (arr.length === 0) return out
  for (let i = 0; i < n; i++) {
    const start = Math.floor((i / n) * arr.length)
    const end = Math.floor(((i + 1) / n) * arr.length)
    let sum = 0
    let c = 0
    for (let j = start; j < Math.max(start + 1, end); j++) {
      sum += arr[j]
      c++
    }
    out[i] = c > 0 ? sum / c : 0
  }
  const max = Math.max(...out, 1e-9)
  for (let i = 0; i < n; i++) out[i] /= max
  return out
}

/** Combined onset + energy feature for alignment (normalized 0–1). */
function alignmentFeature(rms: Float32Array, onsets: Float32Array, n: number): Float32Array {
  const r = downsample(rms, n)
  const o = downsample(onsets, n)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = 0.45 * r[i] + 0.55 * o[i]
  const max = Math.max(...out, 1e-9)
  for (let i = 0; i < n; i++) out[i] /= max
  return out
}

function dtwPath(a: Float32Array, b: Float32Array): [number, number][] {
  const n = a.length
  const m = b.length
  const INF = 1e12
  const cost = Array.from({ length: n }, () => new Float64Array(m).fill(INF))
  cost[0][0] = Math.abs(a[0] - b[0])
  for (let i = 1; i < n; i++) cost[i][0] = cost[i - 1][0] + Math.abs(a[i] - b[0])
  for (let j = 1; j < m; j++) cost[0][j] = cost[0][j - 1] + Math.abs(a[0] - b[j])
  for (let i = 1; i < n; i++) {
    for (let j = 1; j < m; j++) {
      const d = Math.abs(a[i] - b[j])
      cost[i][j] = d + Math.min(cost[i - 1][j], cost[i][j - 1], cost[i - 1][j - 1])
    }
  }
  const path: [number, number][] = []
  let i = n - 1
  let j = m - 1
  path.push([i, j])
  while (i > 0 || j > 0) {
    if (i === 0) {
      j--
    } else if (j === 0) {
      i--
    } else {
      const opts = [
        { v: cost[i - 1][j - 1], di: -1, dj: -1 },
        { v: cost[i - 1][j], di: -1, dj: 0 },
        { v: cost[i][j - 1], di: 0, dj: -1 },
      ]
      opts.sort((x, y) => x.v - y.v)
      i += opts[0].di
      j += opts[0].dj
    }
    path.push([i, j])
  }
  path.reverse()
  return path
}

/**
 * Map a reference time (seconds) → student time via DTW path.
 * path entries are [studentFrame, refFrame] in downsampled index space.
 * Times are on the *active* (silence-trimmed) timelines.
 */
function mapRefTimeToStudent(
  refSec: number,
  path: [number, number][],
  refDuration: number,
  studentDuration: number,
  nRef: number,
  nStudent: number,
): number {
  if (refDuration <= 0) return 0
  const target = Math.max(0, Math.min(nRef - 1, (refSec / refDuration) * (nRef - 1)))
  let bestSi = 0
  let bestDist = Infinity
  let sumSi = 0
  let count = 0
  for (const [si, ri] of path) {
    const d = Math.abs(ri - target)
    if (d < bestDist) {
      bestDist = d
      bestSi = si
    }
    if (d <= 1.5) {
      sumSi += si
      count++
    }
  }
  const si = count > 0 ? sumSi / count : bestSi
  const t = (si / Math.max(1, nStudent - 1)) * studentDuration
  return Math.max(0, Math.min(studentDuration, t))
}

/**
 * Walk left from a valley/lull frame to the *start* of that lull so the previous
 * section ends before the next phrase’s attack (prefer early cuts over late spill).
 */
function startOfLullIndex(
  smoothRms: Float32Array,
  smoothOnsets: Float32Array,
  meanRms: number,
  meanOnset: number,
  idx: number,
): number {
  let i = idx
  while (i > 1) {
    const prev = i - 1
    const stillQuiet =
      (meanRms <= 1e-9 || smoothRms[prev] <= meanRms * 0.92) &&
      (meanOnset <= 1e-9 || smoothOnsets[prev] <= meanOnset * 0.7)
    const rising = smoothRms[prev] < smoothRms[i] * 0.85 && smoothOnsets[i] > meanOnset * 0.8
    if (!stillQuiet || rising) break
    i = prev
  }
  return i
}

/**
 * Define phrase-like section boundaries on the REFERENCE timeline.
 * Prefer energy valleys / onset lulls; place the cut at the *start* of the lull
 * (slightly early) so section N doesn’t spill ~0.5–1s into section N+1.
 * Returns sorted boundary times including 0 and duration (length = count + 1).
 */
function referenceSectionBoundaries(
  times: Float32Array,
  rms: Float32Array,
  onsets: Float32Array,
  duration: number,
  count: number,
): number[] {
  if (duration <= 0.05 || times.length < 4) {
    return Array.from({ length: count + 1 }, (_, i) => (i / count) * Math.max(duration, 0.001))
  }

  const smoothRms = smoothEnvelope(rms, 4)
  const smoothOnsets = smoothEnvelope(onsets, 3)
  const meanRms = smoothRms.reduce((a, b) => a + b, 0) / smoothRms.length
  const meanOnset = smoothOnsets.reduce((a, b) => a + b, 0) / Math.max(1, smoothOnsets.length)

  const minGap = Math.max(0.6, duration / (count * 2.2))
  const candidates: { t: number; score: number }[] = []

  for (let i = 2; i < times.length - 2; i++) {
    const t = times[i]
    if (t < minGap || t > duration - minGap) continue
    const isValley =
      smoothRms[i] <= smoothRms[i - 1] &&
      smoothRms[i] <= smoothRms[i + 1] &&
      smoothRms[i] <= meanRms * 0.85
    const onsetLull = smoothOnsets[i] <= meanOnset * 0.55
    if (!isValley && !onsetLull) continue
    const depth = meanRms > 1e-9 ? 1 - smoothRms[i] / meanRms : 0
    const lull = meanOnset > 1e-9 ? 1 - smoothOnsets[i] / Math.max(meanOnset, 1e-9) : 0
    const startIdx = startOfLullIndex(smoothRms, smoothOnsets, meanRms, meanOnset, i)
    const tCut = times[startIdx]
    if (tCut < minGap || tCut > duration - minGap) continue
    candidates.push({ t: tCut, score: depth * 0.6 + lull * 0.4 })
  }

  candidates.sort((a, b) => b.score - a.score)
  const picked: number[] = []
  for (const c of candidates) {
    if (picked.every((p) => Math.abs(p - c.t) >= minGap)) {
      picked.push(c.t)
    }
    if (picked.length >= count * 3) break
  }
  picked.sort((a, b) => a - b)

  let interiors: number[]
  if (picked.length >= count - 1) {
    interiors = pickEvenlyFromCandidates(picked, count - 1, duration)
  } else {
    interiors = cumulativeOnsetBoundaries(times, onsets, duration, count - 1)
  }

  // Extra early bias (~0.45s): previous section must not eat the next attack.
  const EARLY_PULL_SEC = 0.45
  const minWidth = Math.max(0.35, duration / (count * 4))
  const pulled: number[] = []
  for (let idx = 0; idx < interiors.length; idx++) {
    const floor = (idx === 0 ? 0 : pulled[idx - 1]) + minWidth
    const raw = interiors[idx]
    const earlyTarget = raw - EARLY_PULL_SEC
    let best = earlyTarget
    let bestDist = Infinity
    for (let i = 1; i < times.length - 1; i++) {
      const t = times[i]
      if (t < earlyTarget - 0.2 || t > raw) continue
      const quiet =
        (meanRms <= 1e-9 || smoothRms[i] <= meanRms * 0.9) &&
        (meanOnset <= 1e-9 || smoothOnsets[i] <= meanOnset * 0.65)
      if (!quiet) continue
      const d = Math.abs(t - earlyTarget)
      if (d < bestDist) {
        bestDist = d
        best = t
      }
    }
    pulled.push(Math.max(floor, Math.min(best, raw)))
  }

  const bounds = [0, ...pulled, duration]
  for (let i = 1; i < bounds.length; i++) {
    if (bounds[i] < bounds[i - 1] + minWidth) {
      bounds[i] = Math.min(duration, bounds[i - 1] + minWidth)
    }
  }
  bounds[bounds.length - 1] = duration
  return bounds
}

function pickEvenlyFromCandidates(candidates: number[], need: number, duration: number): number[] {
  if (need <= 0) return []
  if (candidates.length <= need) return candidates.slice()
  const targets = Array.from({ length: need }, (_, i) => ((i + 1) / (need + 1)) * duration)
  const used = new Set<number>()
  const out: number[] = []
  for (const target of targets) {
    let bestIdx = -1
    let bestDist = Infinity
    for (let i = 0; i < candidates.length; i++) {
      if (used.has(i)) continue
      const d = Math.abs(candidates[i] - target)
      if (d < bestDist) {
        bestDist = d
        bestIdx = i
      }
    }
    if (bestIdx >= 0) {
      used.add(bestIdx)
      out.push(candidates[bestIdx])
    }
  }
  return out.sort((a, b) => a - b)
}

function cumulativeOnsetBoundaries(
  times: Float32Array,
  onsets: Float32Array,
  duration: number,
  need: number,
): number[] {
  if (need <= 0) return []
  const cum = new Float32Array(onsets.length)
  let total = 0
  for (let i = 0; i < onsets.length; i++) {
    total += onsets[i]
    cum[i] = total
  }
  if (total < 1e-9) {
    return Array.from({ length: need }, (_, i) => ((i + 1) / (need + 1)) * duration)
  }
  const out: number[] = []
  for (let k = 1; k <= need; k++) {
    const target = (k / (need + 1)) * total
    let idx = 0
    while (idx < cum.length - 1 && cum[idx] < target) idx++
    out.push(times[idx] ?? (k / (need + 1)) * duration)
  }
  return out
}

/**
 * Pull Alexia's section end earlier to a nearby energy valley / onset lull
 * so playback does not spill into the next phrase. Prefers shorter windows.
 */
function snapStudentEndEarlier(
  times: Float32Array,
  rms: Float32Array,
  onsets: Float32Array,
  sStart: number,
  sEnd: number,
  hardCap: number,
  minWidth: number,
): number {
  const cap = Math.min(sEnd, hardCap)
  const earliest = sStart + minWidth
  if (cap <= earliest + 0.02) {
    return Math.max(sStart + Math.min(minWidth, 0.08), Math.min(cap, hardCap))
  }

  const smoothRms = smoothEnvelope(rms, 3)
  const smoothOnsets = smoothEnvelope(onsets, 2)
  let sumR = 0
  let sumO = 0
  let n = 0
  for (let i = 0; i < times.length; i++) {
    const t = times[i]
    if (t < earliest || t > cap) continue
    sumR += smoothRms[i]
    sumO += smoothOnsets[i]
    n++
  }
  const meanRms = n > 0 ? sumR / n : 0
  const meanOnset = n > 0 ? sumO / n : 0

  let bestT = cap
  let bestScore = -1
  const span = Math.max(1e-6, cap - earliest)

  for (let i = 1; i < times.length - 1; i++) {
    const t = times[i]
    if (t < earliest || t > cap) continue
    const isValley =
      smoothRms[i] <= smoothRms[i - 1] &&
      smoothRms[i] <= smoothRms[i + 1] &&
      (meanRms <= 1e-9 || smoothRms[i] <= meanRms * 0.9)
    const onsetLull = meanOnset <= 1e-9 || smoothOnsets[i] <= meanOnset * 0.6
    if (!isValley && !onsetLull) continue

    const depth = meanRms > 1e-9 ? 1 - smoothRms[i] / meanRms : 0.5
    const lull = meanOnset > 1e-9 ? 1 - smoothOnsets[i] / meanOnset : 0.5
    // Bias toward earlier cut (shorter Alexia window) while still rewarding clear valleys.
    const shortBias = (cap - t) / span
    const score = depth * 0.45 + lull * 0.25 + shortBias * 0.5
    if (score > bestScore) {
      bestScore = score
      bestT = t
    }
  }

  return Math.min(bestT, hardCap)
}

/**
 * Map each reference section to Alexia's timeline via DTW.
 * Prefers SHORTER Alexia windows (clamp ~[0.5, 1.2]× expected), anchors at the
 * DTW start (does not center-expand), snaps end earlier to a valley, and never
 * extends past the DTW-mapped start of the next section. Overlaps: cut earlier end only.
 */
function mapRefSectionsToStudent(
  refBounds: number[],
  path: [number, number][],
  refActiveDur: number,
  studentActiveDur: number,
  nRef: number,
  nStudent: number,
  studentTimes: Float32Array,
  studentRms: Float32Array,
  studentOnsets: Float32Array,
): { rStart: number; rEnd: number; sStart: number; sEnd: number }[] {
  const count = refBounds.length - 1
  const globalTempo = studentActiveDur / Math.max(1e-6, refActiveDur)
  const minWidth = Math.max(0.12, studentActiveDur / (count * 12))
  const gapEps = 0.02

  // Precompute DTW-mapped starts so each section can hard-cap before the next.
  const mappedStarts: number[] = []
  const mappedEnds: number[] = []
  for (let i = 0; i < count; i++) {
    let sStart = mapRefTimeToStudent(refBounds[i], path, refActiveDur, studentActiveDur, nRef, nStudent)
    let sEnd = mapRefTimeToStudent(refBounds[i + 1], path, refActiveDur, studentActiveDur, nRef, nStudent)
    if (sEnd < sStart) {
      const tmp = sStart
      sStart = sEnd
      sEnd = tmp
    }
    mappedStarts.push(sStart)
    mappedEnds.push(sEnd)
  }

  const windows: { rStart: number; rEnd: number; sStart: number; sEnd: number }[] = []
  for (let i = 0; i < count; i++) {
    const rStart = refBounds[i]
    const rEnd = refBounds[i + 1]
    let sStart = mappedStarts[i]
    let sEndMapped = mappedEnds[i]

    const nextMappedStart =
      i + 1 < count ? mappedStarts[i + 1] : studentActiveDur
    // Never spill past the DTW start of the next reference section.
    const hardCap = Math.max(sStart + minWidth * 0.5, nextMappedStart - gapEps)

    const refLen = Math.max(0.001, rEnd - rStart)
    const expected = refLen * globalTempo
    const lo = DUR_CLAMP_LO * expected
    const hi = DUR_CLAMP_HI * expected

    // Anchor at DTW start — do NOT center-expand (that spills into the next phrase).
    sStart = Math.max(0, Math.min(studentActiveDur, sStart))
    // Prefer mapped end, but never longer than hi×expected and never past hardCap.
    let sEnd = Math.min(sEndMapped, sStart + hi, hardCap, studentActiveDur)
    // If DTW mapped absurdly short, allow up to lo — still capped by hardCap / mapped end.
    // Prefer ending at mapped boundary rather than expanding to fill gaps.
    if (sEnd - sStart < Math.min(lo, minWidth * 2)) {
      sEnd = Math.min(hardCap, studentActiveDur, Math.max(sEnd, Math.min(sEndMapped, sStart + lo)))
    }
    if (sEnd < sStart + minWidth) {
      sEnd = Math.min(hardCap, studentActiveDur, sStart + minWidth)
    }

    sEnd = snapStudentEndEarlier(
      studentTimes,
      studentRms,
      studentOnsets,
      sStart,
      sEnd,
      hardCap,
      minWidth,
    )

    // Final short bias: if still longer than expected*1.05, pull end in (valley already preferred).
    const softHi = Math.min(hi, expected * 1.05)
    if (sEnd - sStart > softHi) {
      const pulled = Math.min(sEnd, sStart + softHi)
      sEnd = snapStudentEndEarlier(
        studentTimes,
        studentRms,
        studentOnsets,
        sStart,
        pulled,
        hardCap,
        minWidth,
      )
      // If no better valley, accept the softHi cut.
      if (sEnd - sStart > softHi) sEnd = Math.min(sEnd, sStart + softHi, hardCap)
    }

    windows.push({ rStart, rEnd, sStart, sEnd: Math.max(sStart + Math.min(minWidth, 0.08), sEnd) })
  }

  // Overlap repair: cut the earlier section's end only — never push the later start later.
  for (let i = 0; i < windows.length - 1; i++) {
    if (windows[i].sEnd > windows[i + 1].sStart - gapEps) {
      windows[i].sEnd = Math.max(
        windows[i].sStart + Math.min(minWidth, 0.08),
        windows[i + 1].sStart - gapEps,
      )
    }
  }

  return windows
}

export async function analyzeSolo(studentBlob: Blob): Promise<AnalysisResult> {
  const buffer = await decodeAudioBlob(studentBlob, { which: 'take' })
  const mono = getMono(buffer)
  const { times, rms } = computeRmsEnvelope(mono, buffer.sampleRate)
  const onsets = onsetStrength(rms)
  const duration = buffer.duration
  const count = SECTION_COUNT
  const metrics: SectionMetrics[] = []
  for (let i = 0; i < count; i++) {
    const start = (i / count) * duration
    const end = ((i + 1) / count) * duration
    metrics.push(sectionMetrics(times, rms, onsets, start, end))
  }

  const tempoScores = scoreSoloStability(metrics.map((m) => m.tempoProxy))
  const volumeScores = scoreSoloStability(metrics.map((m) => m.volumeRms))

  const sections: SectionAnalysis[] = metrics.map((m, i) => {
    const overall = worse(tempoScores[i], volumeScores[i])
    const notesParts: string[] = []
    if (tempoScores[i] !== 'green') notesParts.push('tempo feels uneven vs other sections')
    if (volumeScores[i] !== 'green') notesParts.push('volume level shifts vs other sections')
    if (notesParts.length === 0) notesParts.push('stable relative to your take')
    return {
      index: i,
      label: labelFor(i, count),
      startSec: m.startSec,
      endSec: m.endSec,
      tempoScore: tempoScores[i],
      volumeScore: volumeScores[i],
      overall,
      notes: notesParts.join('; '),
      studentTempoProxy: m.tempoProxy,
      studentVolumeRms: m.volumeRms,
    }
  })

  const hone = sections.filter((s) => s.overall !== 'green').map((s) => s.label)
  const summary =
    hone.length === 0
      ? 'Your take looks steady across sections (tempo stability and dynamic consistency). Upload a reference recording you own for a true match against a model performance — YouTube audio cannot be compared directly in the browser.'
      : `Solo analysis (no reference upload): hone ${hone.join(', ')}. Colors show consistency within THIS take only — not a match to YouTube. Upload your own CD/mp3 reference for full comparison.`

  return {
    mode: 'solo',
    sections,
    summary,
    honeSections: hone,
    durationSec: duration,
  }
}

export type ComparisonOutcome = {
  result: AnalysisResult
  /** Silence-trimmed reference boundaries (persist these for durable cuts). */
  boundsActive: number[]
  activeDurationSec: number
  boundsSource: 'saved' | 'computed'
}

function adaptSavedBounds(
  saved: number[],
  savedDur: number,
  currentDur: number,
  count: number,
): number[] | null {
  if (!saved || saved.length !== count + 1) return null
  if (!(savedDur > 0) || !(currentDur > 0)) return null
  const scale = currentDur / savedDur
  const out = saved.map((t) => Math.max(0, Math.min(currentDur, t * scale)))
  out[0] = 0
  out[out.length - 1] = currentDur
  for (let i = 1; i < out.length; i++) {
    if (out[i] < out[i - 1] + 0.05) out[i] = Math.min(currentDur, out[i - 1] + 0.05)
  }
  out[out.length - 1] = currentDur
  return out
}

export async function analyzeComparison(
  studentBlob: Blob,
  referenceBlob: Blob,
  opts?: {
    referenceFileName?: string
    /** Reuse durable phrase cuts (silence-trimmed). */
    savedBoundsActive?: number[]
    savedActiveDurationSec?: number
    /** Ignore saved bounds and recompute valleys. */
    forceRecomputeBounds?: boolean
  },
): Promise<ComparisonOutcome> {
  // Decode separately so Safari failures name take vs reference clearly.
  let studentBuf: AudioBuffer
  try {
    studentBuf = await decodeAudioBlob(studentBlob, { which: 'take' })
  } catch (err) {
    if (err instanceof AudioDecodeError) throw err
    throw new AudioDecodeError(
      "Couldn't read Alexia's take. Try Download, or record again in this browser.",
      'take',
    )
  }
  let refBuf: AudioBuffer
  try {
    refBuf = await decodeAudioBlob(referenceBlob, {
      which: 'reference',
      fileName: opts?.referenceFileName,
    })
  } catch (err) {
    if (err instanceof AudioDecodeError) throw err
    throw new AudioDecodeError(
      "Couldn't read the reference file. Voice Memos usually work as .m4a — try Export or a .wav/.mp3.",
      'reference',
    )
  }
  const sFull = getMono(studentBuf)
  const rFull = getMono(refBuf)

  // Trim leading/trailing silence so DTW/section mapping ignore dead air.
  const sTrim = trimSilence(sFull, studentBuf.sampleRate)
  const rTrim = trimSilence(rFull, refBuf.sampleRate)

  const sEnv = computeRmsEnvelope(sTrim.samples, studentBuf.sampleRate)
  const rEnv = computeRmsEnvelope(rTrim.samples, refBuf.sampleRate)
  const sOnsets = onsetStrength(sEnv.rms)
  const rOnsets = onsetStrength(rEnv.rms)

  const count = SECTION_COUNT
  const refActiveDur = rTrim.activeDurationSec
  const studentActiveDur = sTrim.activeDurationSec
  const studentDuration = studentBuf.duration

  // Metrics for scoring need times on the original timeline (playback uses offsets).
  // Rebuild full envelopes for sectionMetrics on original audio.
  const sFullEnv = computeRmsEnvelope(sFull, studentBuf.sampleRate)
  const rFullEnv = computeRmsEnvelope(rFull, refBuf.sampleRate)
  const sFullOnsets = onsetStrength(sFullEnv.rms)
  const rFullOnsets = onsetStrength(rFullEnv.rms)

  // 1) Reference phrase cuts — reuse saved map when present (durable UX).
  let boundsSource: 'saved' | 'computed' = 'computed'
  let refBoundsActive: number[]
  if (
    !opts?.forceRecomputeBounds &&
    opts?.savedBoundsActive &&
    opts.savedBoundsActive.length === count + 1
  ) {
    const adapted = adaptSavedBounds(
      opts.savedBoundsActive,
      opts.savedActiveDurationSec ?? opts.savedBoundsActive[opts.savedBoundsActive.length - 1],
      refActiveDur,
      count,
    )
    if (adapted) {
      refBoundsActive = adapted
      boundsSource = 'saved'
    } else {
      refBoundsActive = referenceSectionBoundaries(rEnv.times, rEnv.rms, rOnsets, refActiveDur, count)
    }
  } else {
    refBoundsActive = referenceSectionBoundaries(rEnv.times, rEnv.rms, rOnsets, refActiveDur, count)
  }

  // 2) DTW-align on silence-trimmed onset/energy features.
  const n = DTW_POINTS
  const sFeat = alignmentFeature(sEnv.rms, sOnsets, n)
  const rFeat = alignmentFeature(rEnv.rms, rOnsets, n)
  const path = dtwPath(sFeat, rFeat) // [studentFrame, refFrame]
  const windowsActive = mapRefSectionsToStudent(
    refBoundsActive,
    path,
    refActiveDur,
    studentActiveDur,
    n,
    n,
    sEnv.times,
    sEnv.rms,
    sOnsets,
  )

  const sections: SectionAnalysis[] = []
  for (let i = 0; i < count; i++) {
    const { rStart, rEnd, sStart, sEnd } = windowsActive[i]
    // Map active-region times back onto original audio timelines for playback.
    const sStartOrig = sStart + sTrim.offsetSec
    const sEndOrig = sEnd + sTrim.offsetSec
    const rStartOrig = rStart + rTrim.offsetSec
    const rEndOrig = rEnd + rTrim.offsetSec

    const sM = sectionMetrics(sFullEnv.times, sFullEnv.rms, sFullOnsets, sStartOrig, sEndOrig)
    const rM = sectionMetrics(rFullEnv.times, rFullEnv.rms, rFullOnsets, rStartOrig, rEndOrig)

    const tempoRatio = rM.tempoProxy > 1e-8 ? sM.tempoProxy / rM.tempoProxy : 1
    const volRatio = rM.volumeRms > 1e-8 ? sM.volumeRms / rM.volumeRms : 1
    const tempoScore = scoreFromRatio(tempoRatio, 0.18, 0.4)
    const volumeScore = scoreFromRatio(volRatio, 0.22, 0.45)
    const overall = worse(tempoScore, volumeScore)

    const notesParts: string[] = []
    if (tempoScore === 'red') notesParts.push('tempo (onset density) differs a lot from reference')
    else if (tempoScore === 'amber') notesParts.push('tempo slightly off vs reference')
    else notesParts.push('tempo close to reference')
    if (volumeScore === 'red') notesParts.push('volume envelope differs a lot')
    else if (volumeScore === 'amber') notesParts.push('dynamics a bit different')
    else notesParts.push('dynamics similar')

    sections.push({
      index: i,
      label: labelFor(i, count),
      startSec: sM.startSec,
      endSec: sM.endSec,
      refStartSec: rM.startSec,
      refEndSec: rM.endSec,
      tempoScore,
      volumeScore,
      overall,
      notes: notesParts.join('; '),
      studentTempoProxy: sM.tempoProxy,
      studentVolumeRms: sM.volumeRms,
      referenceTempoProxy: rM.tempoProxy,
      referenceVolumeRms: rM.volumeRms,
    })
  }

  const hone = sections.filter((s) => s.overall !== 'green').map((s) => s.label)
  const activeDurDiff =
    Math.abs(studentActiveDur - refActiveDur) / Math.max(refActiveDur, 0.001)
  const durNote =
    activeDurDiff > 0.25
      ? ` Note: active take length differs from reference by ${Math.round(activeDurDiff * 100)}% — section windows follow DTW (clamped), not full-file padding.`
      : ''

  const savedNote =
    boundsSource === 'saved'
      ? ' Using your saved section cuts for this piece — only Alexia’s windows were remapped.'
      : ' Section cuts were computed from this reference and can be reused on the next take.'

  const summary =
    hone.length === 0
      ? `Nice work — sections look close to your reference (tempo proxy + volume). Sections are defined on the reference, then DTW-aligned to Alexia’s take (silence-trimmed).${savedNote}${durNote}`
      : `Hone these sections: ${hone.join(', ')}. Sections follow the reference performance; Alexia’s windows are DTW-aligned (silence-trimmed, duration-clamped).${savedNote}${durNote}`

  return {
    result: {
      mode: 'comparison',
      sections,
      summary,
      honeSections: hone,
      durationSec: studentDuration,
    },
    boundsActive: refBoundsActive.slice(),
    activeDurationSec: refActiveDur,
    boundsSource,
  }
}
