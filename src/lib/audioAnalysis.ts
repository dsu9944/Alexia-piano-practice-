import type { AnalysisResult, SectionAnalysis, SectionScore } from '../types'

const SECTION_COUNT = 6
const FRAME_SIZE = 2048
const HOP_SIZE = 512
/** Downsample length for DTW (balance quality vs browser CPU). */
const DTW_POINTS = 96

export async function decodeAudioBlob(blob: Blob): Promise<AudioBuffer> {
  const ctx = new AudioContext()
  try {
    const arrayBuffer = await blob.arrayBuffer()
    return await ctx.decodeAudioData(arrayBuffer.slice(0))
  } finally {
    await ctx.close()
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
 * Define phrase-like section boundaries on the REFERENCE timeline.
 * Prefer energy valleys / onset lulls; fall back to equal cumulative-onset quantiles
 * so sections follow musical activity rather than wall-clock alone.
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
    // Prefer deeper valleys / quieter lulls
    const depth = meanRms > 1e-9 ? 1 - smoothRms[i] / meanRms : 0
    const lull = meanOnset > 1e-9 ? 1 - smoothOnsets[i] / Math.max(meanOnset, 1e-9) : 0
    candidates.push({ t, score: depth * 0.6 + lull * 0.4 })
  }

  // Greedy pick of well-spaced high-score valleys
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
    // Choose count-1 boundaries closest to ideal equal-ish spacing by musical progress
    interiors = pickEvenlyFromCandidates(picked, count - 1, duration)
  } else {
    // Fallback: equal cumulative onset-energy quantiles on the reference
    interiors = cumulativeOnsetBoundaries(times, onsets, duration, count - 1)
  }

  const bounds = [0, ...interiors, duration]
  // Enforce monotonic + minimum width
  const minWidth = Math.max(0.35, duration / (count * 4))
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
 * Given reference section boundaries, map each to Alexia's timeline via DTW
 * on onset/energy envelopes so tempo differences stretch/compress sections.
 */
function mapRefSectionsToStudent(
  refBounds: number[],
  path: [number, number][],
  refDuration: number,
  studentDuration: number,
  nRef: number,
  nStudent: number,
): { rStart: number; rEnd: number; sStart: number; sEnd: number }[] {
  const count = refBounds.length - 1
  const raw = []
  for (let i = 0; i < count; i++) {
    const rStart = refBounds[i]
    const rEnd = refBounds[i + 1]
    const sStart = mapRefTimeToStudent(rStart, path, refDuration, studentDuration, nRef, nStudent)
    const sEnd = mapRefTimeToStudent(rEnd, path, refDuration, studentDuration, nRef, nStudent)
    raw.push({ rStart, rEnd, sStart, sEnd })
  }

  // Enforce contiguous, monotonic Alexia windows (no overlap / reordering).
  const minWidth = Math.max(0.2, studentDuration / (count * 5))
  const sBounds = new Array<number>(count + 1)
  sBounds[0] = 0
  sBounds[count] = studentDuration
  for (let i = 1; i < count; i++) {
    // Prefer mapped start of section i (≈ end of i-1)
    const mapped = 0.5 * (raw[i - 1].sEnd + raw[i].sStart)
    sBounds[i] = mapped
  }
  for (let i = 1; i < count; i++) {
    if (sBounds[i] < sBounds[i - 1] + minWidth) {
      sBounds[i] = sBounds[i - 1] + minWidth
    }
  }
  for (let i = count - 1; i >= 1; i--) {
    if (sBounds[i] > sBounds[i + 1] - minWidth) {
      sBounds[i] = Math.max(sBounds[i - 1] + minWidth, sBounds[i + 1] - minWidth)
    }
  }
  sBounds[0] = 0
  sBounds[count] = studentDuration

  return raw.map((w, i) => ({
    rStart: w.rStart,
    rEnd: w.rEnd,
    sStart: sBounds[i],
    sEnd: sBounds[i + 1],
  }))
}

export async function analyzeSolo(studentBlob: Blob): Promise<AnalysisResult> {
  const buffer = await decodeAudioBlob(studentBlob)
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

export async function analyzeComparison(studentBlob: Blob, referenceBlob: Blob): Promise<AnalysisResult> {
  const [studentBuf, refBuf] = await Promise.all([decodeAudioBlob(studentBlob), decodeAudioBlob(referenceBlob)])
  const sMono = getMono(studentBuf)
  const rMono = getMono(refBuf)
  const sEnv = computeRmsEnvelope(sMono, studentBuf.sampleRate)
  const rEnv = computeRmsEnvelope(rMono, refBuf.sampleRate)
  const sOnsets = onsetStrength(sEnv.rms)
  const rOnsets = onsetStrength(rEnv.rms)

  const count = SECTION_COUNT
  const refDuration = refBuf.duration
  const studentDuration = studentBuf.duration

  // 1) Sections come from the REFERENCE (phrase valleys / onset-energy progress).
  const refBounds = referenceSectionBoundaries(rEnv.times, rEnv.rms, rOnsets, refDuration, count)

  // 2) DTW-align Alexia ↔ reference on onset/energy so each ref section maps to her time range.
  const n = DTW_POINTS
  const sFeat = alignmentFeature(sEnv.rms, sOnsets, n)
  const rFeat = alignmentFeature(rEnv.rms, rOnsets, n)
  const path = dtwPath(sFeat, rFeat) // [studentFrame, refFrame]
  const windows = mapRefSectionsToStudent(refBounds, path, refDuration, studentDuration, n, n)

  const sections: SectionAnalysis[] = []
  for (let i = 0; i < count; i++) {
    const { rStart, rEnd, sStart, sEnd } = windows[i]
    const sM = sectionMetrics(sEnv.times, sEnv.rms, sOnsets, sStart, sEnd)
    const rM = sectionMetrics(rEnv.times, rEnv.rms, rOnsets, rStart, rEnd)

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
      // Alexia’s DTW-aligned window for this musical section
      startSec: sM.startSec,
      endSec: sM.endSec,
      // Canonical section on the reference performance
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
  const durDiff = Math.abs(studentDuration - refDuration) / Math.max(refDuration, 0.001)
  const durNote =
    durDiff > 0.25
      ? ` Note: take length differs from reference by ${Math.round(durDiff * 100)}% — DTW stretches sections to match.`
      : ''

  const summary =
    hone.length === 0
      ? `Nice work — sections look close to your reference (tempo proxy + volume). Sections are defined on the reference, then DTW-aligned to Alexia’s take.${durNote}`
      : `Hone these sections: ${hone.join(', ')}. Sections follow the reference performance (phrase/energy boundaries); Alexia’s windows are DTW-aligned so Play both compares the same musical part even if tempos differ.${durNote}`

  return {
    mode: 'comparison',
    sections,
    summary,
    honeSections: hone,
    durationSec: studentDuration,
  }
}
