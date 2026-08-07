import { useCallback, useEffect, useRef, useState } from 'react'
import { desk } from '../lib/api.js'

/**
 * A small YouTube player for background lofi.
 *
 * Deliberately uses the plain embed iframe and drives it with postMessage
 * (`enablejsapi=1`) rather than loading Google's iframe_api script, which would
 * mean widening the CSP to allow their JS in our page. Signing in is not
 * possible: Google blocks account sign-in from embedded browsers, so there is
 * an "open in browser" action for when you want your own account.
 */

export interface PlayerSource {
  kind: 'video' | 'playlist'
  id: string
  url: string
}

/** Accepts watch, youtu.be, shorts, embed, and playlist URLs. */
export function parseYouTube(raw: string): PlayerSource | null {
  const text = raw.trim()
  if (!text) return null
  let u: URL
  try {
    u = new URL(text.startsWith('http') ? text : `https://${text}`)
  } catch {
    // A bare 11-char id is a video id.
    return /^[\w-]{11}$/.test(text) ? { kind: 'video', id: text, url: text } : null
  }
  if (!/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(u.hostname)) return null

  const list = u.searchParams.get('list')
  const v = u.searchParams.get('v')
  if (v) return { kind: 'video', id: v, url: text }
  if (list) return { kind: 'playlist', id: list, url: text }

  const path = u.pathname.replace(/^\//, '')
  const seg = path.split('/')
  if (u.hostname.endsWith('youtu.be') && seg[0]) return { kind: 'video', id: seg[0], url: text }
  if (seg[0] === 'embed' && seg[1]) return { kind: 'video', id: seg[1], url: text }
  if (seg[0] === 'shorts' && seg[1]) return { kind: 'video', id: seg[1], url: text }
  if (seg[0] === 'playlist' && list) return { kind: 'playlist', id: list, url: text }
  return null
}

interface YTPlayer {
  destroy?: () => void
  playVideo: () => void
  pauseVideo: () => void
  setVolume: (v: number) => void
}

declare global {
  interface Window {
    YT?: {
      Player: new (
        el: HTMLElement,
        opts: {
          videoId?: string
          playerVars?: Record<string, string | number>
          events?: {
            onReady?: (e: { target: YTPlayer }) => void
            onStateChange?: (e: { data: number }) => void
            onError?: (e: { data: number }) => void
          }
        },
      ) => YTPlayer
    }
    onYouTubeIframeAPIReady?: () => void
  }
}

/** Loaded on first run and whenever nothing is saved yet. */
const DEFAULT_TRACK = 'https://www.youtube.com/watch?v=EPRCD7P7mVM'
/** The cowboy theme brings its own default. */
const COWBOY_TRACK = 'https://www.youtube.com/watch?v=HuvGir8xjJU'

/** Any track a theme installs by itself, so we know when we may replace it. */
const THEME_TRACKS = new Set([DEFAULT_TRACK, COWBOY_TRACK])

const PRESETS: { label: string; url: string }[] = [
  { label: 'default', url: DEFAULT_TRACK },
  { label: 'cowboy', url: COWBOY_TRACK },
  { label: 'lofi hip hop radio', url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk' },
  { label: 'lofi sleep/chill', url: 'https://www.youtube.com/watch?v=rUxyKA_-grg' },
]

export function Player({ theme = 'default' }: { theme?: string }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [src, setSrc] = useState<PlayerSource | null>(null)
  const [playing, setPlaying] = useState(false)
  const [volume, setVolume] = useState(35)
  const [error, setError] = useState<string | null>(null)
  const [showVideo, setShowVideo] = useState(false)
  const [ready, setReady] = useState(false)
  const hostRef = useRef<HTMLDivElement>(null)

  const themeTrack = theme.startsWith('cowboy') ? COWBOY_TRACK : DEFAULT_TRACK

  useEffect(() => {
    void desk.playerRead().then((s) => {
      const url = s?.url || themeTrack
      const parsed = parseYouTube(url)
      if (parsed) {
        setSrc(parsed)
        setInput(url)
      }
      if (typeof s?.volume === 'number') setVolume(s.volume)
    })
    // Only on mount: later theme changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Follow the theme, but never override a track you chose yourself. Only a
  // track another theme installed is fair game to replace.
  useEffect(() => {
    setSrc((current) => {
      if (current && !THEME_TRACKS.has(current.url)) return current
      if (current?.url === themeTrack) return current
      const parsed = parseYouTube(themeTrack)
      if (!parsed) return current
      setInput(themeTrack)
      setReady(false)
      void desk.playerWrite({ url: themeTrack })
      return parsed
    })
  }, [themeTrack])

  const playerRef = useRef<YTPlayer | null>(null)

  // The official IFrame Player API. The postMessage-only approach (no Google
  // script) never delivered onReady/onStateChange reliably and playback would
  // not start, so this loads their loader and pays for it with a slightly
  // wider script-src in the CSP.
  useEffect(() => {
    if (!src) return
    let cancelled = false

    const build = (): void => {
      if (cancelled || !hostRef.current) return
      playerRef.current?.destroy?.()
      playerRef.current = new window.YT!.Player(hostRef.current, {
        videoId: src.kind === 'video' ? src.id : undefined,
        playerVars: {
          autoplay: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          ...(src.kind === 'playlist'
            ? { list: src.id, listType: 'playlist' }
            : { loop: 1, playlist: src.id }),
        },
        events: {
          onReady: (e) => {
            setReady(true)
            e.target.setVolume(volume)
            e.target.playVideo()
          },
          onStateChange: (e) => {
            // 1 playing, 3 buffering, 2 paused, 0 ended
            if (e.data === 1 || e.data === 3) setPlaying(true)
            if (e.data === 2 || e.data === 0) setPlaying(false)
          },
          onError: (e) => {
            // 2 invalid parameter, 5 HTML5 player error, 100 not found,
            // 101/150 embedding disabled by the uploader.
            const why: Record<number, string> = {
              2: 'the player rejected a parameter',
              5: 'the HTML5 player failed',
              100: 'the video was not found',
              101: 'the uploader disabled embedding',
              150: 'the uploader disabled embedding',
            }
            setError(`YouTube error ${e.data}: ${why[e.data] ?? 'unknown'}.`)
          },
        },
      })
    }

    if (window.YT?.Player) {
      build()
    } else {
      // The loader calls this global exactly once when the API is ready.
      const prev = window.onYouTubeIframeAPIReady
      window.onYouTubeIframeAPIReady = () => {
        prev?.()
        build()
      }
      if (!document.getElementById('yt-iframe-api')) {
        const tag = document.createElement('script')
        tag.id = 'yt-iframe-api'
        tag.src = 'https://www.youtube.com/iframe_api'
        document.head.appendChild(tag)
      }
    }

    return () => {
      cancelled = true
    }
    // volume is intentionally not a dep: it is pushed separately below, and
    // rebuilding the player on every slider tick would restart playback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src])

  useEffect(() => {
    playerRef.current?.setVolume?.(volume)
  }, [volume])

  const load = useCallback(
    (raw: string) => {
      const parsed = parseYouTube(raw)
      if (!parsed) {
        setError('Not a YouTube video or playlist link.')
        return
      }
      setError(null)
      setReady(false)
      setSrc(parsed)
      void desk.playerWrite({ url: raw.trim(), volume })
    },
    [volume],
  )

  const toggle = useCallback(() => {
    const p = playerRef.current
    if (!p) return
    // No optimistic flip: onStateChange sets `playing` once it really happens.
    if (playing) p.pauseVideo()
    else p.playVideo()
  }, [playing])

  return (
    <div className="player">
      <div className="player-bar">
        <button className="player-toggle" onClick={() => setOpen((o) => !o)} title="Music">
          ♪
        </button>
        {src ? (
          <>
            <button className="player-play" onClick={toggle} title={playing ? 'Pause' : 'Play'}>
              {playing ? '❚❚' : '▶'}
            </button>
            <span className="player-label">
              {ready ? (src.kind === 'playlist' ? 'playlist' : 'lofi') : 'connecting'}
            </span>
          </>
        ) : (
          <span className="player-label">no track</span>
        )}
        <input
          className="player-vol"
          type="range"
          min={0}
          max={100}
          value={volume}
          onChange={(e) => {
            const v = Number(e.target.value)
            setVolume(v)
            if (src) void desk.playerWrite({ url: src.url, volume: v })
          }}
          title={`Volume ${volume}`}
        />
      </div>

      {open && (
        <div className="player-panel">
          <div className="player-row">
            <input
              className="filter player-input"
              placeholder="Paste a YouTube video or playlist link"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') load(input)
              }}
            />
            <button className="btn" onClick={() => load(input)}>
              Load
            </button>
          </div>
          {error && <p className="panel-hint player-err">{error}</p>}

          <div className="player-presets">
            {PRESETS.map((p) => (
              <button
                key={p.url}
                className="chip"
                onClick={() => {
                  setInput(p.url)
                  load(p.url)
                }}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="player-row player-links">
            <label className="player-check">
              <input type="checkbox" checked={showVideo} onChange={(e) => setShowVideo(e.target.checked)} />
              show video
            </label>
            {src && (
              <button className="linkish" onClick={() => void desk.openExternal(src.url)}>
                Open in browser
              </button>
            )}
          </div>

        </div>
      )}

      {/* Kept mounted so audio survives collapsing the panel. The API
          replaces this element with its own iframe. */}
      <div className={`player-frame-wrap ${showVideo && open ? 'is-visible' : ''}`}>
        <div ref={hostRef} />
      </div>
    </div>
  )
}
