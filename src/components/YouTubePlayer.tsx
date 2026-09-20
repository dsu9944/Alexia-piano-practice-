import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'

interface Props {
  youtubeId: string
  title: string
}

export interface YouTubePlayerHandle {
  ready: boolean
  play: () => void
  pause: () => void
  getCurrentTime: () => number
  seekTo: (sec: number) => void
  /** Seek to start, play, pause when end is reached. */
  playClip: (startSec: number, endSec: number) => void
  stopClip: () => void
}

declare global {
  interface Window {
    YT?: {
      Player: new (
        elementId: string | HTMLElement,
        config: {
          videoId: string
          playerVars?: Record<string, number | string>
          events?: {
            onReady?: (e: { target: YtPlayer }) => void
            onStateChange?: (e: { data: number; target: YtPlayer }) => void
          }
        },
      ) => YtPlayer
      PlayerState: { PLAYING: number; PAUSED: number; ENDED: number }
    }
    onYouTubeIframeAPIReady?: () => void
  }
}

interface YtPlayer {
  playVideo: () => void
  pauseVideo: () => void
  seekTo: (seconds: number, allowSeekAhead: boolean) => void
  getCurrentTime: () => number
  getDuration: () => number
  loadVideoById: (videoId: string) => void
  cueVideoById: (videoId: string) => void
  destroy: () => void
}

const SKIP_SEC = 10

let apiLoadPromise: Promise<void> | null = null

function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve()
  if (apiLoadPromise) return apiLoadPromise
  apiLoadPromise = new Promise((resolve) => {
    const prior = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      prior?.()
      resolve()
    }
    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const tag = document.createElement('script')
      tag.src = 'https://www.youtube.com/iframe_api'
      document.head.appendChild(tag)
    }
    if (window.YT?.Player) resolve()
  })
  return apiLoadPromise
}

export const YouTubePlayer = forwardRef<YouTubePlayerHandle, Props>(
  function YouTubePlayer({ youtubeId, title }, ref) {
    const reactId = useId().replace(/:/g, '')
    const containerId = `yt-player-${reactId}`
    const hostRef = useRef<HTMLDivElement | null>(null)
    const playerRef = useRef<YtPlayer | null>(null)
    const clipTimerRef = useRef<number | null>(null)
    const clipEndRef = useRef<number | null>(null)
    const youtubeIdRef = useRef(youtubeId)
    const titleRef = useRef(title)
    const [ready, setReady] = useState(false)
    const [playing, setPlaying] = useState(false)
    const [error, setError] = useState<string | null>(null)

    youtubeIdRef.current = youtubeId
    titleRef.current = title

    const clearClipWatch = () => {
      if (clipTimerRef.current != null) {
        window.clearInterval(clipTimerRef.current)
        clipTimerRef.current = null
      }
      clipEndRef.current = null
    }

    const pause = () => {
      clearClipWatch()
      playerRef.current?.pauseVideo()
    }

    const play = () => {
      clearClipWatch()
      playerRef.current?.playVideo()
    }

    const getCurrentTime = () => {
      try {
        return playerRef.current?.getCurrentTime() ?? 0
      } catch {
        return 0
      }
    }

    const seekTo = (sec: number) => {
      const player = playerRef.current
      if (!player) return
      const duration = (() => {
        try {
          return player.getDuration() || Number.POSITIVE_INFINITY
        } catch {
          return Number.POSITIVE_INFINITY
        }
      })()
      const next = Math.max(0, Math.min(duration, sec))
      player.seekTo(next, true)
    }

    const playClip = (startSec: number, endSec: number) => {
      const player = playerRef.current
      if (!player) return
      const start = Math.max(0, startSec)
      const end = Math.max(start + 0.15, endSec)
      clearClipWatch()
      clipEndRef.current = end
      player.seekTo(start, true)
      player.playVideo()
      clipTimerRef.current = window.setInterval(() => {
        try {
          const t = player.getCurrentTime()
          const limit = clipEndRef.current
          if (limit != null && t >= limit - 0.05) {
            player.pauseVideo()
            clearClipWatch()
          }
        } catch {
          clearClipWatch()
        }
      }, 100)
    }

    useImperativeHandle(
      ref,
      () => ({
        ready,
        play,
        pause,
        getCurrentTime,
        seekTo,
        playClip,
        stopClip: pause,
      }),
      [ready],
    )

    /** Ensure a fresh empty mount target exists inside the stable host wrapper. */
    const ensureMountEl = (): HTMLElement | null => {
      const host = hostRef.current
      if (!host) return null
      let el = document.getElementById(containerId)
      if (el && host.contains(el)) return el
      // After destroy(), YT may remove/replace the inner div — re-insert a fresh one.
      host.replaceChildren()
      el = document.createElement('div')
      el.id = containerId
      el.title = `YouTube: ${titleRef.current}`
      host.appendChild(el)
      return el
    }

    const destroyPlayer = () => {
      if (!playerRef.current) return
      try {
        playerRef.current.destroy()
      } catch {
        // ignore
      }
      playerRef.current = null
    }

    const createPlayer = (videoId: string): boolean => {
      if (!window.YT?.Player) return false
      const el = ensureMountEl()
      if (!el) return false
      playerRef.current = new window.YT.Player(el, {
        videoId,
        playerVars: {
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          enablejsapi: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: (e) => {
            const wanted = youtubeIdRef.current
            if (wanted && wanted !== videoId) {
              try {
                e.target.cueVideoById(wanted)
              } catch {
                // ignore
              }
            }
            setReady(true)
            setError(null)
          },
          onStateChange: (e) => {
            const playingState = window.YT?.PlayerState.PLAYING
            setPlaying(playingState !== undefined && e.data === playingState)
          },
        },
      })
      return true
    }

    // Create once on mount; destroy only on unmount.
    useEffect(() => {
      let cancelled = false
      setReady(false)
      setPlaying(false)
      setError(null)

      void (async () => {
        try {
          await loadYouTubeApi()
          if (cancelled || !window.YT) return
          destroyPlayer()
          createPlayer(youtubeIdRef.current)
        } catch (err) {
          console.error(err)
          if (!cancelled) setError('Could not load YouTube controls. Try refreshing the page.')
        }
      })()

      return () => {
        cancelled = true
        clearClipWatch()
        destroyPlayer()
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/unmount only
    }, [containerId])

    // When only youtubeId changes: cue/load on the existing player — do not destroy.
    useEffect(() => {
      const player = playerRef.current
      if (!player || !ready) return
      clearClipWatch()
      setPlaying(false)
      try {
        player.cueVideoById(youtubeId)
        setError(null)
      } catch (err) {
        console.warn('cueVideoById failed; recreating player with fresh mount div', err)
        destroyPlayer()
        setReady(false)
        try {
          if (!createPlayer(youtubeId)) {
            setError('Could not load YouTube controls. Try refreshing the page.')
          }
        } catch (err2) {
          console.error(err2)
          setError('Could not load YouTube controls. Try refreshing the page.')
        }
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps -- swap video only
    }, [youtubeId, ready])

    const skip = (delta: number) => {
      seekTo(getCurrentTime() + delta)
    }

    return (
      <div className="youtube-wrap">
        <h2 className="sr-only">YouTube reference</h2>
        <p className="hint">
          Use Play / Pause / Skip to find a bit, then Mark start/end in Practice sections above.
          Audio stays on YouTube — nothing is downloaded.
        </p>
        <div className="video-frame">
          {/* Stable parent: YT.Player may replace/remove the inner mount div on destroy. */}
          <div ref={hostRef} className="yt-host">
            <div id={containerId} title={`YouTube: ${title}`} />
          </div>
        </div>
        <div className="yt-controls" role="group" aria-label="YouTube playback">
          <button type="button" className="btn primary" onClick={play} disabled={!ready}>
            ▶ Play
          </button>
          <button type="button" className="btn secondary" onClick={pause} disabled={!ready}>
            ⏸ Pause
          </button>
          <button type="button" className="btn ghost" onClick={() => skip(-SKIP_SEC)} disabled={!ready}>
            ⏪ Skip ~{SKIP_SEC}s back
          </button>
          <button type="button" className="btn ghost" onClick={() => skip(SKIP_SEC)} disabled={!ready}>
            Skip ~{SKIP_SEC}s forward ⏩
          </button>
        </div>
        {ready && (
          <p className="yt-status hint" aria-live="polite">
            {playing ? 'Playing…' : 'Paused'}
          </p>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    )
  },
)
