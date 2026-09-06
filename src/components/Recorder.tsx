import { useCallback, useEffect, useRef, useState } from 'react'

interface Props {
  onSave: (blob: Blob, durationMs: number) => void
  disabled?: boolean
}

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  const tenths = Math.floor((ms % 1000) / 100)
  return `${m}:${s.toString().padStart(2, '0')}.${tenths}`
}

export function Recorder({ onSave, disabled }: Props) {
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [pendingBlob, setPendingBlob] = useState<Blob | null>(null)
  const [pendingDuration, setPendingDuration] = useState(0)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const startTimeRef = useRef(0)
  const timerRef = useRef<number | null>(null)

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
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : ''
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
      mediaRecorderRef.current = recorder
      chunksRef.current = []
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = () => {
        const durationMs = Date.now() - startTimeRef.current
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
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

  return (
    <div className="recorder card">
      <h2>Record Alexia</h2>
      <p className="hint">Uses the computer microphone. Allow access when the browser asks.</p>
      <div className="timer" aria-live="polite">
        {formatTime(recording || pendingBlob ? elapsed || pendingDuration : 0)}
      </div>
      <div className="recorder-actions">
        {!recording && !pendingBlob && (
          <button type="button" className="btn primary" onClick={startRecording} disabled={disabled}>
            ● Start recording
          </button>
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
