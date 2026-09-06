import type { AnalysisResult, SectionAnalysis, SectionScore } from '../types'

const SECTION_COUNT = 6
const FRAME_SIZE = 2048
const HOP_SIZE = 512

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
  // Adaptive peak threshold from section onset mean
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
    if (onsets[i] > threshold && (i === 0 || onsets[i] >= onsets[i - 1]) && (i === onsets.length - 1 || onsets[i] >= onsets[i + 1])) {
      onsetTimes.push(times[i])
    }
  }
  const duration = Math.max(0.001, endSec - startSec)
  // Tempo proxy: onset density (onsets per second) weighted with energy flux
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

/**
 * Simple duration-normalized alignment: stretch reference timeline to student duration,
 * then compare matching time windows. Good enough MVP when performances are similar length.
 */
function alignSections(
  studentDuration: number,
  refDuration: number,
  count: number,
): { sStart: number; sEnd: number; rStart: number; rEnd: number }[] {
  const out = []
  for (let i = 0; i < count; i++) {
    out.push({
      sStart: (i / count) * studentDuration,
      sEnd: ((i + 1) / count) * studentDuration,
      rStart: (i / count) * refDuration,
      rEnd: ((i + 1) / count) * refDuration,
    })
  }
  return out
}

/**
 * Lightweight DTW on coarse RMS envelopes to refine section boundaries on the reference.
 * Returns mapping of student section index -> refined ref [start, end] in seconds.
 */
function dtwRefineRefWindows(
  studentRms: Float32Array,
  studentTimes: Float32Array,
  refRms: Float32Array,
  refTimes: Float32Array,
  studentDuration: number,
  count: number,
): { rStart: number; rEnd: number }[] {
  // Downsample to ~80 points for DTW
  const N = 80
  const s = downsample(studentRms, N)
  const r = downsample(refRms, N)
  const path = dtwPath(s, r)

  const windows: { rStart: number; rEnd: number }[] = []
  for (let i = 0; i < count; i++) {
    const s0 = Math.floor((i / count) * (N - 1))
    const s1 = Math.floor(((i + 1) / count) * (N - 1))
    const matched = path.filter(([si]) => si >= s0 && si <= s1).map(([, ri]) => ri)
    if (matched.length === 0) {
      windows.push({
        rStart: (i / count) * (refTimes[refTimes.length - 1] || studentDuration),
        rEnd: ((i + 1) / count) * (refTimes[refTimes.length - 1] || studentDuration),
      })
      continue
    }
    const rMin = Math.min(...matched)
    const rMax = Math.max(...matched)
    const t0 = refTimes[Math.min(refTimes.length - 1, Math.floor((rMin / (N - 1)) * (refTimes.length - 1)))]
    const t1 = refTimes[Math.min(refTimes.length - 1, Math.floor((rMax / (N - 1)) * (refTimes.length - 1)))]
    windows.push({ rStart: Math.min(t0, t1), rEnd: Math.max(t0, t1) + 0.001 })
  }
  // silence unused student vars warning by referencing
  void studentTimes
  void studentDuration
  return windows
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
  // Normalize
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
  // Backtrack
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
  const aligned = alignSections(studentBuf.duration, refBuf.duration, count)
  const refined = dtwRefineRefWindows(
    sEnv.rms,
    sEnv.times,
    rEnv.rms,
    rEnv.times,
    studentBuf.duration,
    count,
  )

  const sections: SectionAnalysis[] = []
  for (let i = 0; i < count; i++) {
    const sM = sectionMetrics(sEnv.times, sEnv.rms, sOnsets, aligned[i].sStart, aligned[i].sEnd)
    const rM = sectionMetrics(rEnv.times, rEnv.rms, rOnsets, refined[i].rStart, refined[i].rEnd)

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
  const durDiff = Math.abs(studentBuf.duration - refBuf.duration) / Math.max(refBuf.duration, 0.001)
  const durNote =
    durDiff > 0.25
      ? ` Note: take length differs from reference by ${Math.round(durDiff * 100)}% — alignment is approximate.`
      : ''

  const summary =
    hone.length === 0
      ? `Nice work — sections look close to your reference (tempo proxy + volume).${durNote}`
      : `Hone these sections: ${hone.join(', ')}. Compared using DTW-aligned sections (onset density + RMS volume).${durNote}`

  return {
    mode: 'comparison',
    sections,
    summary,
    honeSections: hone,
    durationSec: studentBuf.duration,
  }
}
