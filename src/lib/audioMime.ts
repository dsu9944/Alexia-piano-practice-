/** Preferred MediaRecorder mime types — Safari-friendly first, then Chromium. */
const RECORDER_MIME_CANDIDATES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/aac',
  'audio/webm;codecs=opus',
  'audio/webm',
] as const

export function pickRecorderMimeType(): string {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
    return ''
  }
  for (const mime of RECORDER_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime
  }
  return ''
}

/** Normalize a container mime for playback / download (strip codecs=…). */
export function baseAudioMime(type: string | undefined | null): string {
  const raw = (type || '').split(';')[0].trim().toLowerCase()
  if (raw === 'audio/mp4' || raw === 'audio/aac' || raw === 'audio/x-m4a' || raw === 'audio/m4a') {
    return 'audio/mp4'
  }
  if (raw === 'audio/webm') return 'audio/webm'
  if (raw === 'audio/ogg') return 'audio/ogg'
  return raw || ''
}

export function extensionForAudioMime(type: string | undefined | null): string {
  const base = baseAudioMime(type)
  if (base === 'audio/mp4' || base === 'audio/aac') return 'm4a'
  if (base === 'audio/webm') return 'webm'
  if (base === 'audio/ogg') return 'ogg'
  return 'm4a'
}

/**
 * Re-wrap bytes with an explicit mime. IndexedDB / Safari often lose or ignore
 * blob.type after sleep/refresh; reconstructing fixes many play failures.
 */
export async function reviveAudioBlob(
  blob: Blob,
  preferredType?: string,
): Promise<Blob> {
  const buf = await blob.arrayBuffer()
  const type =
    preferredType ||
    baseAudioMime(blob.type) ||
    'audio/mp4'
  return new Blob([buf], { type })
}

/** Types to try when <audio> fails to decode (Safari vs Chromium). */
export const PLAYBACK_RETRY_TYPES = ['audio/mp4', 'audio/webm', 'audio/aac'] as const

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke after the click has a chance to start
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}
