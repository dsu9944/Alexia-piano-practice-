/**
 * Firm Web Audio beeps for the Loop gap between section repeats.
 * Safari needs a real unlock (silent buffer) during the user gesture —
 * resume() alone is often not enough. No asset files.
 */

let sharedCtx: AudioContext | null = null

type ActiveBeep = { osc: OscillatorNode; gain: GainNode }
const activeBeeps: ActiveBeep[] = []

/** setTimeout IDs when AudioContext scheduling isn't available */
const fallbackTimerIds: number[] = []

/** HTMLAudioElement beeps used as last-resort fallback */
const fallbackAudioEls: HTMLAudioElement[] = []

const BEEP_FREQ_HZ = 880
const BEEP_DURATION_SEC = 0.18
const BEEP_PEAK_GAIN = 0.62
const BEEP_OFFSETS_SEC = [0, 1, 2] as const

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const AC =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return null
  if (!sharedCtx || sharedCtx.state === 'closed') {
    sharedCtx = new AC()
  }
  return sharedCtx
}

async function ensureResumed(ctx: AudioContext): Promise<void> {
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume()
    } catch {
      /* ignore */
    }
  }
}

/** Near-silent buffer + oscillator so Safari truly unlocks during a user gesture. */
function playSilentUnlock(ctx: AudioContext): void {
  try {
    const buffer = ctx.createBuffer(1, 1, ctx.sampleRate || 22050)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    source.start(0)
  } catch {
    /* ignore */
  }
  try {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    gain.gain.value = 0.00001
    osc.connect(gain)
    gain.connect(ctx.destination)
    const t = ctx.currentTime
    osc.start(t)
    osc.stop(t + 0.05)
  } catch {
    /* ignore */
  }
}

/**
 * Call from a user gesture (Play) so later gap beeps are allowed.
 * Awaits resume + plays a silent unlock tone (Safari requirement).
 */
export async function unlockLoopCueAudio(): Promise<void> {
  const ctx = getAudioContext()
  if (!ctx) return
  await ensureResumed(ctx)
  playSilentUnlock(ctx)
  await ensureResumed(ctx)
}

/** Silence any currently sounding / scheduled gap beeps (e.g. on Stop). */
export function cancelLoopCueBeeps(): void {
  for (const id of fallbackTimerIds) {
    window.clearTimeout(id)
  }
  fallbackTimerIds.length = 0

  for (const el of fallbackAudioEls) {
    try {
      el.pause()
      el.removeAttribute('src')
      el.load()
    } catch {
      /* ignore */
    }
  }
  fallbackAudioEls.length = 0

  const ctx = sharedCtx
  const now = ctx && ctx.state !== 'closed' ? ctx.currentTime : 0
  for (const { osc, gain } of activeBeeps) {
    try {
      gain.gain.cancelScheduledValues(now)
      gain.gain.setValueAtTime(0.0001, now)
      osc.stop(now)
    } catch {
      /* already stopped */
    }
  }
  activeBeeps.length = 0
}

function scheduleToneAt(
  ctx: AudioContext,
  when: number,
  frequencyHz: number,
  durationSec: number,
  peakGain: number,
): void {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  // Triangle is more audible than soft sine; still less harsh than square.
  osc.type = 'triangle'
  osc.frequency.setValueAtTime(frequencyHz, when)
  gain.gain.setValueAtTime(0.0001, when)
  gain.gain.linearRampToValueAtTime(peakGain, when + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, when + durationSec)
  osc.connect(gain)
  gain.connect(ctx.destination)

  const entry: ActiveBeep = { osc, gain }
  activeBeeps.push(entry)
  osc.onended = () => {
    const i = activeBeeps.indexOf(entry)
    if (i >= 0) activeBeeps.splice(i, 1)
  }

  osc.start(when)
  osc.stop(when + durationSec + 0.03)
}

/** Tiny 16-bit mono WAV data-URI for HTMLAudioElement fallback. */
let cachedBeepDataUri: string | null = null

function getBeepDataUri(): string {
  if (cachedBeepDataUri) return cachedBeepDataUri
  const sampleRate = 22050
  const duration = BEEP_DURATION_SEC
  const numSamples = Math.floor(sampleRate * duration)
  const dataSize = numSamples * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)

  const amp = Math.floor(0.55 * 32767)
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate
    // Soft attack/release envelope
    const env =
      t < 0.012 ? t / 0.012 : t > duration - 0.04 ? Math.max(0, (duration - t) / 0.04) : 1
    // Triangle-ish via folded sine approximation; square-ish alternate
    const phase = (t * BEEP_FREQ_HZ) % 1
    const tri = phase < 0.5 ? phase * 4 - 1 : 3 - phase * 4
    const sample = Math.max(-1, Math.min(1, tri * env)) * amp
    view.setInt16(44 + i * 2, sample, true)
  }

  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  cachedBeepDataUri = `data:audio/wav;base64,${btoa(binary)}`
  return cachedBeepDataUri
}

function playHtmlAudioBeep(): void {
  try {
    const el = new Audio(getBeepDataUri())
    el.volume = 0.9
    fallbackAudioEls.push(el)
    void el.play().catch(() => {
      /* autoplay blocked — nothing more we can do */
    })
    el.onended = () => {
      const i = fallbackAudioEls.indexOf(el)
      if (i >= 0) fallbackAudioEls.splice(i, 1)
    }
  } catch {
    /* ignore */
  }
}

function playToneNow(): void {
  const ctx = getAudioContext()
  if (ctx && ctx.state === 'running') {
    scheduleToneAt(ctx, ctx.currentTime, BEEP_FREQ_HZ, BEEP_DURATION_SEC, BEEP_PEAK_GAIN)
    return
  }
  if (ctx && ctx.state === 'suspended') {
    void ctx.resume().then(() => {
      if (ctx.state === 'running') {
        scheduleToneAt(ctx, ctx.currentTime, BEEP_FREQ_HZ, BEEP_DURATION_SEC, BEEP_PEAK_GAIN)
      } else {
        playHtmlAudioBeep()
      }
    })
    return
  }
  playHtmlAudioBeep()
}

/**
 * One firm countdown beep (immediate). Prefer scheduleLoopGapBeeps for the gap.
 */
export function playLoopGapBeep(): void {
  playToneNow()
}

/**
 * Schedule three countdown beeps at 0s / 1s / 2s (clip restarts at 3s).
 * Uses AudioContext timeline when running; falls back to setTimeout + HTMLAudio.
 */
export async function scheduleLoopGapBeeps(): Promise<void> {
  cancelLoopCueBeeps()
  const ctx = getAudioContext()
  if (ctx) {
    await ensureResumed(ctx)
    if (ctx.state === 'running') {
      const base = ctx.currentTime
      for (const offset of BEEP_OFFSETS_SEC) {
        scheduleToneAt(
          ctx,
          base + offset,
          BEEP_FREQ_HZ,
          BEEP_DURATION_SEC,
          BEEP_PEAK_GAIN,
        )
      }
      return
    }
  }
  // Fallback: wall-clock timers + Web Audio / HTMLAudio per beep
  for (const offset of BEEP_OFFSETS_SEC) {
    const id = window.setTimeout(() => {
      playToneNow()
    }, offset * 1000)
    fallbackTimerIds.push(id)
  }
}
