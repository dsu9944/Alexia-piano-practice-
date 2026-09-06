import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import {
  PLAYBACK_RETRY_TYPES,
  reviveAudioBlob,
} from '../lib/audioMime'
import type { Take } from '../types'

interface Props {
  take: Take | null
}

export interface TakePlayerHandle {
  ready: boolean
  play: () => Promise<void>
  stop: () => void
  getCurrentTime: () => number
  seekTo: (sec: number) => void
  playClip: (startSec: number, endSec: number) => Promise<void>
  stopClip: () => void
}

function formatDur(ms: number): string {
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

export const TakePlayer = forwardRef<TakePlayerHandle, Props>(function TakePlayer(
  { take },
  ref,
) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const clipEndRef = useRef<number | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryIndex, setRetryIndex] = useState(0)

  const stopClipWatch = () => {
    clipEndRef.current = null
  }

  const stop = () => {
    const audio = audioRef.current
    stopClipWatch()
    if (!audio) return
    audio.pause()
    audio.currentTime = 0
    setPlaying(false)
  }

  const play = async () => {
    const audio = audioRef.current
    if (!audio) return
    stopClipWatch()
    try {
      await audio.play()
    } catch (err) {
      console.warn(err)
      setError('Playback was blocked — tap Play again, or check browser autoplay settings.')
    }
  }

  const getCurrentTime = () => audioRef.current?.currentTime ?? 0

  const seekTo = (sec: number) => {
    const audio = audioRef.current
    if (!audio) return
    const duration = Number.isFinite(audio.duration) ? audio.duration : Number.POSITIVE_INFINITY
    audio.currentTime = Math.max(0, Math.min(duration, sec))
  }

  const playClip = async (startSec: number, endSec: number) => {
    const audio = audioRef.current
    if (!audio) return
    const start = Math.max(0, startSec)
    const end = Math.max(start + 0.15, endSec)
    stopClipWatch()
    clipEndRef.current = end
    audio.currentTime = start
    try {
      await audio.play()
    } catch (err) {
      console.warn(err)
      setError('Playback was blocked — tap Play again, or check browser autoplay settings.')
    }
  }

  useImperativeHandle(
    ref,
    () => ({
      ready: !!url && !error,
      play,
      stop,
      getCurrentTime,
      seekTo,
      playClip,
      stopClip: stop,
    }),
    [url, error],
  )

  useEffect(() => {
    let cancelled = false
    let created: string | null = null
    setPlaying(false)
    setError(null)
    setRetryIndex(0)
    setUrl(null)
    stopClipWatch()

    if (!take) return

    void (async () => {
      try {
        const revived = await reviveAudioBlob(take.blob)
        const objectUrl = URL.createObjectURL(revived)
        created = objectUrl
        if (!cancelled) setUrl(objectUrl)
        else URL.revokeObjectURL(objectUrl)
      } catch {
        const objectUrl = URL.createObjectURL(take.blob)
        created = objectUrl
        if (!cancelled) setUrl(objectUrl)
        else URL.revokeObjectURL(objectUrl)
      }
    })()

    return () => {
      cancelled = true
      stopClipWatch()
      if (audioRef.current) {
        audioRef.current.pause()
      }
      if (created) URL.revokeObjectURL(created)
    }
  }, [take?.id, take?.blob])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onEnded = () => {
      stopClipWatch()
      setPlaying(false)
    }
    const onTimeUpdate = () => {
      const limit = clipEndRef.current
      if (limit != null && audio.currentTime >= limit - 0.05) {
        audio.pause()
        stopClipWatch()
        setPlaying(false)
      }
    }
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('timeupdate', onTimeUpdate)
    return () => {
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('timeupdate', onTimeUpdate)
    }
  }, [url])

  const handleError = async () => {
    if (!take) return
    if (retryIndex < PLAYBACK_RETRY_TYPES.length) {
      const nextType = PLAYBACK_RETRY_TYPES[retryIndex]
      try {
        const rewrapped = await reviveAudioBlob(take.blob, nextType)
        const objectUrl = URL.createObjectURL(rewrapped)
        setUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev)
          return objectUrl
        })
        setRetryIndex((i) => i + 1)
        return
      } catch (err) {
        console.warn('Playback rewrap failed', nextType, err)
        setRetryIndex((i) => i + 1)
        return
      }
    }
    setError(
      'Couldn’t play this take in the browser. Use Download on the take, then open it in QuickTime or another player.',
    )
  }

  return (
    <div className="take-player card">
      <h2>Alexia’s take</h2>
      <p className="compare-tip">
        Play the full take here, or use Practice sections below to mark and compare short clips.
      </p>
      {!take ? (
        <p className="hint">Select a saved take below (or record a new one).</p>
      ) : (
        <>
          <p className="take-player-meta">
            Selected: {formatDate(take.createdAt)} · {formatDur(take.durationMs)}
          </p>
          <div className="take-player-actions" role="group" aria-label="Alexia take playback">
            <button
              type="button"
              className="btn primary large"
              onClick={() => void play()}
              disabled={!url || !!error}
            >
              {playing ? '▶ Playing…' : '▶ Play Alexia'}
            </button>
            <button type="button" className="btn danger large" onClick={stop} disabled={!url}>
              ■ Stop
            </button>
          </div>
          {url && (
            <div className="playback">
              <p className="label">Scrub here, then use Mark Alexia start/end in Practice sections</p>
              <audio
                ref={audioRef}
                controls
                src={url}
                preload="auto"
                onError={() => {
                  void handleError()
                }}
              />
            </div>
          )}
          {error && <p className="error">{error}</p>}
        </>
      )}
    </div>
  )
})
