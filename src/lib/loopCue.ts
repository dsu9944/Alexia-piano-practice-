/**
 * Firm Web Audio beeps for the Loop gap between section repeats.
 * Clear / louder volume for a home piano room — obvious, not ear-splitting.
 * No asset files.
 */

let sharedCtx: AudioContext | null = null

type ActiveBeep = { osc: OscillatorNode; gain: GainNode }
const activeBeeps: ActiveBeep[] = []

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

/** Call from a user gesture (Play) so later gap beeps are allowed. */
export function unlockLoopCueAudio(): void {
  const ctx = getAudioContext()
  if (ctx?.state === 'suspended') {
    void ctx.resume()
  }
}

/** Silence any currently sounding gap beeps (e.g. on Stop). */
export function cancelLoopCueBeeps(): void {
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

function playTone(frequencyHz: number, durationSec: number, peakGain: number): void {
  const ctx = getAudioContext()
  if (!ctx) return
  if (ctx.state === 'suspended') {
    void ctx.resume()
  }
  const now = ctx.currentTime
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(frequencyHz, now)
  // Firm envelope — clear and obvious, not harsh
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.linearRampToValueAtTime(peakGain, now + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec)
  osc.connect(gain)
  gain.connect(ctx.destination)

  const entry: ActiveBeep = { osc, gain }
  activeBeeps.push(entry)
  osc.onended = () => {
    const i = activeBeeps.indexOf(entry)
    if (i >= 0) activeBeeps.splice(i, 1)
  }

  osc.start(now)
  osc.stop(now + durationSec + 0.03)
}

/**
 * One firm countdown beep during the 3s Loop gap.
 * Schedule at ~0s, ~1s, and ~2s; clip restarts at 3s.
 */
export function playLoopGapBeep(): void {
  playTone(880, 0.14, 0.22)
}
