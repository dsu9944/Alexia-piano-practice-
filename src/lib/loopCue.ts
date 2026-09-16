/**
 * Soft Web Audio beeps for the Loop gap between section repeats.
 * Moderate volume for a home piano room / ~9yo ears. No asset files.
 */

let sharedCtx: AudioContext | null = null

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
  // Gentle envelope — clear but not harsh
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.linearRampToValueAtTime(peakGain, now + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(now)
  osc.stop(now + durationSec + 0.03)
}

/** Soft cue near the start of the 3s Loop gap. */
export function playLoopGapBeepSoft(): void {
  playTone(660, 0.11, 0.065)
}

/** Slightly brighter “get ready” cue ~0.4s before the next repeat. */
export function playLoopGapBeepReady(): void {
  playTone(880, 0.13, 0.095)
}
