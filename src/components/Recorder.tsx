import { useCallback, useEffect, useRef, useState } from 'react'
import {
  baseAudioMime,
  mimeFromFileName,
  pickRecorderMimeType,
  reviveAudioBlob,
} from '../lib/audioMime'

interface Props {
  onSave: (blob: Blob, durationMs: number) => void
  disabled?: boolean
}

const UPLOAD_ACCEPT = 'audio/*,.m4a,.mp3,.wav,.aac,.caf,.webm,.ogg'

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  const tenths = Math.floor((ms % 1000) / 100)
  return `${m}:${s.toString().padStart(2, '0')}.${tenths}`
}

/** Prefer AudioContext decode; fall back to HTMLAudioElement duration. */
async function estimateDurationMs(blob: Blob): Promise<number> {
  const buf = await blob.arrayBuffer()
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (Ctx) {
      const ctx = new Ctx()
      try {
        const audioBuf = await ctx.decodeAudioData(buf.slice(0))
        const ms = Math.round(audioBuf.duration * 1000)
        if (ms > 0 && Number.isFinite(ms)) return ms
      } finally {
        void ctx.close()
      }
    }
  } catch {
    // decode can fail for some containers; try element metadata next
  }

  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const audio = new Audio()
    let settled = false
    const finish = (ms: number) => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(url)
      resolve(ms > 0 && Number.isFinite(ms) ? ms : 0)
    }
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => {
      const d = audio.duration
      finish(Number.isFinite(d) ? Math.round(d * 1000) : 0)
    }
    audio.onerror = () => finish(0)
    window.setTimeout(() => finish(0), 8000)
    audio.src = url
  })
}

export function Recorder({ onSave, disabled }: Props) {
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [pendingBlob, setPendingBlob] = useState<Blob | null>(null)
  const [pendingDuration, setPendingDuration] = useState(0)
  const [uploading, setUploading] = useState(false)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const startTimeRef = useRef(0)
  const timerRef = useRef<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current)
      stopTracks()
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [stopTracks, previewUrl])

  const startRecording = async () => {
    setError(null)
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl)
      setPreviewUrl(null)
    }
    setPendingBlob(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      // Safari: prefer mp4/aac; Chromium: webm. Pick the first supported.
      const mime = pickRecorderMimeType()
      const recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream)
      mediaRecorderRef.current = recorder
      chunksRef.current = []
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = () => {
        const durationMs = Date.now() - startTimeRef.current
        // Keep the exact mime the recorder produced so IndexedDB/Safari can play later.
        const type = recorder.mimeType || mime || 'audio/mp4'
        const blob = new Blob(chunksRef.current, { type })
        stopTracks()
        setPendingBlob(blob)
        setPendingDuration(durationMs)
        setPreviewUrl(URL.createObjectURL(blob))
        setRecording(false)
        if (timerRef.current) {
          window.clearInterval(timerRef.current)
          timerRef.current = null
        }
      }
      startTimeRef.current = Date.now()
      setElapsed(0)
      recorder.start(200)
      setRecording(true)
      timerRef.current = window.setInterval(() => {
        setElapsed(Date.now() - startTimeRef.current)
      }, 100)
    } catch (err) {
      console.error(err)
      setError('Could not access the microphone. Check browser permission and try again.')
      stopTracks()
    }
  }

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop()
    }
  }

  const saveTake = () => {
    if (!pendingBlob) return
    onSave(pendingBlob, pendingDuration)
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreviewUrl(null)
    setPendingBlob(null)
    setElapsed(0)
  }

  const discard = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreviewUrl(null)
    setPendingBlob(null)
    setElapsed(0)
  }

  const handleUpload = async (file: File | undefined) => {
    if (!file || uploading || recording || disabled) return
    setError(null)
    setUploading(true)
    try {
      const preferred =
        baseAudioMime(file.type) || mimeFromFileName(file.name) || 'audio/mp4'
      const blob = await reviveAudioBlob(file, preferred)
      const durationMs = await estimateDurationMs(blob)
      if (durationMs <= 0) {
        setError(
          'Could not read the audio duration. Try another format (m4a, mp3, wav) or re-export from Voice Memos.',
        )
        return
      }
      // Same save path as mic takes → IndexedDB, auto-select, section marking.
      onSave(blob, durationMs)
    } catch (err) {
      console.error(err)
      setError('Could not upload that recording. Try m4a, mp3, or wav.')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const idle = !recording && !pendingBlob

  return (
    <div className="recorder card">
      <h2>Record Alexia</h2>
      <p className="hint">
        Uses the computer microphone. Allow access when the browser asks. Chrome or Edge are often
        more reliable for mic apps; Safari is supported (records as MP4/AAC when available).
      </p>
      <div className="timer" aria-live="polite">
        {formatTime(recording || pendingBlob ? elapsed || pendingDuration : 0)}
      </div>
      <div className="recorder-actions">
        {idle && (
          <>
            <button type="button" className="btn primary" onClick={startRecording} disabled={disabled}>
              ● Start recording
            </button>
            <label className={`btn secondary upload-btn${disabled || uploading ? ' is-disabled' : ''}`}>
              {uploading ? 'Uploading…' : '⬆ Upload recording'}
              <input
                ref={fileInputRef}
                type="file"
                accept={UPLOAD_ACCEPT}
                disabled={disabled || uploading}
                onChange={(e) => void handleUpload(e.target.files?.[0])}
                hidden
              />
            </label>
          </>
        )}
        {recording && (
          <button type="button" className="btn danger" onClick={stopRecording}>
            ■ Stop
          </button>
        )}
        {pendingBlob && !recording && (
          <>
            <button type="button" className="btn primary" onClick={saveTake}>
              Save take
            </button>
            <button type="button" className="btn ghost" onClick={discard}>
              Discard
            </button>
          </>
        )}
      </div>
      {idle && (
        <p className="hint upload-hint">
          Or record on iPhone, AirDrop to this Mac, then upload here.
        </p>
      )}
      {previewUrl && (
        <div className="playback">
          <p className="label">Preview before saving</p>
          <audio controls src={previewUrl} />
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  )
}
