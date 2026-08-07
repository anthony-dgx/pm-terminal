import { useCallback, useEffect, useRef, useState } from 'react'
import body from '../assets/kroks/body.svg'
import headNormal from '../assets/kroks/head-normal.svg'
import headOpen from '../assets/kroks/head-meow.svg'
import eyesOpen from '../assets/kroks/eyes-open.svg'
import eyesClosed from '../assets/kroks/eyes-closed.svg'
import mouthMeow from '../assets/kroks/mouth-meow.svg'
import tongue from '../assets/kroks/tongue.svg'
import earLeft from '../assets/kroks/ear-left.svg'
import earRight from '../assets/kroks/ear-right.svg'
import tail from '../assets/kroks/tail.svg'
import shadow from '../assets/kroks/shadow.svg'
import heartSvg from '../assets/kroks/heart.svg'
import meowMp3 from '../assets/kroks/meow.mp3'
import hBody from '../assets/rodeo/body.svg'
import hHeadNormal from '../assets/rodeo/head-normal.svg'
import hHeadOpen from '../assets/rodeo/head-open.svg'
import hEyesOpen from '../assets/rodeo/eyes-open.svg'
import hEyesClosed from '../assets/rodeo/eyes-closed.svg'
import hMouth from '../assets/rodeo/mouth-open.svg'
import hTeeth from '../assets/rodeo/teeth.svg'
import hEarLeft from '../assets/rodeo/ear-left.svg'
import hEarRight from '../assets/rodeo/ear-right.svg'
import hTail from '../assets/rodeo/tail.svg'
import '../kroks.css'

/**
 * Two casts share one rig. The paper-doll layers, timings and animations are
 * identical; only the artwork and the voice differ.
 */
const CASTS = {
  cat: {
    name: 'Kroks',
    body,
    headNormal,
    headOpen,
    eyesOpen,
    eyesClosed,
    mouth: mouthMeow,
    extra: tongue,
    earLeft,
    earRight,
    tail,
  },
  horse: {
    name: 'Rodeo',
    body: hBody,
    headNormal: hHeadNormal,
    headOpen: hHeadOpen,
    eyesOpen: hEyesOpen,
    eyesClosed: hEyesClosed,
    mouth: hMouth,
    extra: hTeeth,
    earLeft: hEarLeft,
    earRight: hEarRight,
    tail: hTail,
  },
} as const

export type PetVariant = keyof typeof CASTS

/**
 * A short whinny. There is no horse recording bundled, and a cat meow coming
 * out of a horse would be worse than a synthesised one.
 */
function whinny(): void {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  if (!Ctx) return
  const ctx = new Ctx()
  const now = ctx.currentTime
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  const vib = ctx.createOscillator()
  const vibGain = ctx.createGain()

  osc.type = 'sawtooth'
  osc.frequency.setValueAtTime(760, now)
  osc.frequency.exponentialRampToValueAtTime(360, now + 0.55)
  // The warble is what makes it read as a horse rather than a slide whistle.
  vib.frequency.setValueAtTime(26, now)
  vibGain.gain.setValueAtTime(55, now)
  vib.connect(vibGain).connect(osc.frequency)

  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(0.16, now + 0.05)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.7)

  osc.connect(gain).connect(ctx.destination)
  osc.start(now)
  vib.start(now)
  osc.stop(now + 0.72)
  vib.stop(now + 0.72)
  window.setTimeout(() => void ctx.close(), 1000)
}

/**
 * Kroks, ported from Lab/black-cat-pet. Same paper-doll layers and idle
 * behaviour, but anchored into the sidebar instead of a floating always-on-top
 * window: no dragging, no click-through, no tray, no hook server. Reactions are
 * driven by this app's own session events rather than the CLI hook bridge.
 */

const SLEEP_AFTER_MS = 90_000

export type KroksReaction = { kind: 'meow' | 'perk'; seq: number } | null

interface Props {
  /** Bumped by the host to trigger a one-off reaction. */
  reaction: KroksReaction
  /** True while the agent is mid-turn; drives the fast "excited" tail. */
  working: boolean
  /** Which cast to render. The cowboy theme swaps in the horse. */
  variant?: PetVariant
}

export function Kroks({ reaction, working, variant = 'cat' }: Props): React.ReactElement {
  const cast = CASTS[variant]
  const rootRef = useRef<HTMLDivElement>(null)
  const catRef = useRef<HTMLDivElement>(null)
  const headFollowRef = useRef<HTMLDivElement>(null)
  const eyesRef = useRef<HTMLImageElement>(null)
  const earLRef = useRef<HTMLImageElement>(null)
  const earRRef = useRef<HTMLImageElement>(null)

  const [face, setFace] = useState({ head: cast.headNormal, eyes: cast.eyesOpen, mouth: false, tongue: false })
  const [sleeping, setSleeping] = useState(false)
  const [muted, setMuted] = useState(false)
  const [floaters, setFloaters] = useState<{ id: number; kind: 'heart' | 'zzz'; left: number }[]>([])

  // Refs mirror state for use inside timers that must not re-subscribe.
  const busyRef = useRef(false)
  const sleepingRef = useRef(false)
  const mutedRef = useRef(false)
  const sleepTimer = useRef<number | undefined>(undefined)
  const poseTimer = useRef<number | undefined>(undefined)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const floaterId = useRef(0)

  sleepingRef.current = sleeping
  mutedRef.current = muted

  const addFloater = useCallback((kind: 'heart' | 'zzz', left: number) => {
    const id = ++floaterId.current
    setFloaters((f) => [...f, { id, kind, left }])
    window.setTimeout(() => setFloaters((f) => f.filter((x) => x.id !== id)), kind === 'heart' ? 1100 : 2400)
  }, [])

  const idleFace = useCallback(() => {
    setFace({ head: cast.headNormal, eyes: cast.eyesOpen, mouth: false, tongue: false })
  }, [cast])

  // Swapping cast mid-run must not leave the previous animal's face behind.
  useEffect(() => {
    idleFace()
  }, [idleFace])

  // ---- sleep / wake ------------------------------------------------------

  const goToSleep = useCallback(() => {
    if (sleepingRef.current) return
    sleepingRef.current = true
    busyRef.current = false
    window.clearTimeout(poseTimer.current)
    setSleeping(true)
    // Sleepy pose: open-mouth head with closed eyes, no mouth or tongue art.
    setFace({ head: cast.headOpen, eyes: cast.eyesClosed, mouth: false, tongue: false })
  }, [cast])

  const resetSleepTimer = useCallback(() => {
    window.clearTimeout(sleepTimer.current)
    sleepTimer.current = window.setTimeout(goToSleep, SLEEP_AFTER_MS)
  }, [goToSleep])

  const wakeUp = useCallback(() => {
    if (sleepingRef.current) {
      sleepingRef.current = false
      setSleeping(false)
      idleFace()
    }
    resetSleepTimer()
  }, [idleFace, resetSleepTimer])

  // ---- reactions ---------------------------------------------------------

  const playSound = useCallback(() => {
    if (mutedRef.current) return
    if (variant === 'horse') {
      whinny()
      return
    }
    const a = audioRef.current
    if (!a) return
    a.currentTime = 0
    // Autoplay can reject before any user gesture; a silent pet is fine.
    void a.play().catch(() => undefined)
  }, [variant])

  /** Restart a CSS animation class that may already be applied. */
  const restart = (el: HTMLElement | null, cls: string): void => {
    if (!el) return
    el.classList.remove(cls)
    void el.offsetWidth
    el.classList.add(cls)
  }

  const meow = useCallback(() => {
    wakeUp()
    playSound()
    busyRef.current = true
    setFace({ head: cast.headOpen, eyes: cast.eyesOpen, mouth: true, tongue: false })
    restart(catRef.current, 'meow')
    window.clearTimeout(poseTimer.current)
    // Hold the pose through all three hops (3 x 0.42s).
    poseTimer.current = window.setTimeout(() => {
      catRef.current?.classList.remove('meow')
      idleFace()
      busyRef.current = false
    }, 1350)
  }, [wakeUp, playSound, idleFace, cast])

  const showHappy = useCallback(
    (opts: { closedEyes?: boolean; heart?: boolean } = {}) => {
      busyRef.current = true
      setFace({
        head: cast.headNormal,
        eyes: opts.closedEyes ? cast.eyesClosed : cast.eyesOpen,
        mouth: false,
        tongue: true,
      })
      restart(catRef.current, 'happy')
      if (opts.heart) {
        for (let i = 0; i < 3; i++) {
          window.setTimeout(() => addFloater('heart', 42 + Math.random() * 18), i * 120)
        }
      }
      window.clearTimeout(poseTimer.current)
      poseTimer.current = window.setTimeout(() => {
        catRef.current?.classList.remove('happy')
        idleFace()
        busyRef.current = false
      }, 600)
    },
    [addFloater, idleFace, cast],
  )

  const perkUp = useCallback(() => {
    wakeUp()
    showHappy()
  }, [wakeUp, showHappy])

  // ---- host-driven reactions --------------------------------------------

  const lastSeq = useRef(0)
  useEffect(() => {
    if (!reaction || reaction.seq === lastSeq.current) return
    lastSeq.current = reaction.seq
    if (reaction.kind === 'meow') meow()
    else perkUp()
  }, [reaction, meow, perkUp])

  // ---- idle loops --------------------------------------------------------

  useEffect(() => {
    resetSleepTimer()

    let blinkTimer: number
    const scheduleBlink = (): void => {
      blinkTimer = window.setTimeout(
        () => {
          if (!busyRef.current && !sleepingRef.current) {
            setFace((f) => ({ ...f, eyes: eyesClosed }))
            window.setTimeout(() => {
              if (!busyRef.current && !sleepingRef.current) setFace((f) => ({ ...f, eyes: cast.eyesOpen }))
            }, 150)
          }
          scheduleBlink()
        },
        2000 + Math.random() * 4000,
      )
    }
    scheduleBlink()

    // A little unprompted hop now and then, purely for character.
    const playTimer = window.setInterval(() => {
      if (!busyRef.current && !sleepingRef.current && Math.random() < 0.3) showHappy()
    }, 12_000)

    // Float a "z" while napping.
    const zzzTimer = window.setInterval(() => {
      if (sleepingRef.current) addFloater('zzz', 58 + Math.random() * 8)
    }, 1300)

    return () => {
      window.clearTimeout(blinkTimer)
      window.clearTimeout(sleepTimer.current)
      window.clearTimeout(poseTimer.current)
      window.clearInterval(playTimer)
      window.clearInterval(zzzTimer)
    }
  }, [resetSleepTimer, showHappy, addFloater, cast])

  // ---- pointer interaction ----------------------------------------------

  const onMove = (e: React.MouseEvent): void => {
    if (sleepingRef.current) return
    const el = catRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const rx = (e.clientX - r.left) / r.width - 0.5
    const ry = (e.clientY - r.top) / r.height - 0.5
    if (headFollowRef.current) {
      headFollowRef.current.style.transform = `translate(${rx * 4}px, ${ry * 3}px)`
    }
    if (eyesRef.current) {
      eyesRef.current.style.transform = `translate(${rx * 3}px, ${ry * 2}px)`
    }
  }

  const onLeave = (): void => {
    if (headFollowRef.current) headFollowRef.current.style.transform = ''
    if (eyesRef.current) eyesRef.current.style.transform = ''
  }

  const pokeEar = (which: 'l' | 'r') => (e: React.MouseEvent) => {
    e.stopPropagation()
    wakeUp()
    const el = which === 'l' ? earLRef.current : earRRef.current
    restart(el, 'poke')
    window.setTimeout(() => el?.classList.remove('poke'), 500)
  }

  const onPet = (): void => {
    if (sleepingRef.current) {
      // Let a sleeping cat wake gently rather than jumping straight to petting.
      wakeUp()
      showHappy()
      return
    }
    wakeUp()
    showHappy({ closedEyes: true, heart: true })
  }

  return (
    <div className="kroks" ref={rootRef}>
      <audio ref={audioRef} src={meowMp3} preload="auto" />

      <div className="kroks-stage">
        {floaters.map((f) =>
          f.kind === 'heart' ? (
            <img key={f.id} className="kroks-heart" src={heartSvg} style={{ left: `${f.left}%` }} alt="" />
          ) : (
            <div key={f.id} className="kroks-zzz" style={{ left: `${f.left}%` }}>
              z
            </div>
          ),
        )}

        <div
          ref={catRef}
          className={`kroks-cat ${sleeping ? 'state-sleep' : ''} ${working && !sleeping ? 'excited' : ''}`}
          onClick={onPet}
          onMouseMove={onMove}
          onMouseLeave={onLeave}
          title={sleeping ? `${cast.name} is napping. Click to wake him.` : `Click to pet ${cast.name}`}
        >
          <div className="kroks-stack">
            <img className="kroks-layer kroks-tail" src={cast.tail} draggable={false} alt="" />
            <img className="kroks-layer" src={cast.body} draggable={false} alt="" />
            <div className="kroks-head-group">
              <div className="kroks-head-follow" ref={headFollowRef}>
                <img className="kroks-layer kroks-head" src={face.head} draggable={false} alt="" />
                {face.mouth && <img className="kroks-layer" src={cast.mouth} draggable={false} alt="" />}
                {face.tongue && <img className="kroks-layer" src={cast.extra} draggable={false} alt="" />}
                <img className="kroks-layer kroks-eyes" ref={eyesRef} src={face.eyes} draggable={false} alt="" />
                <img
                  className="kroks-layer kroks-ear-l"
                  ref={earLRef}
                  src={cast.earLeft}
                  draggable={false}
                  alt=""
                />
                <img
                  className="kroks-layer kroks-ear-r"
                  ref={earRRef}
                  src={cast.earRight}
                  draggable={false}
                  alt=""
                />
              </div>
            </div>
          </div>
          <div className="kroks-ear-hot kroks-ear-hot-l" onClick={pokeEar('l')} />
          <div className="kroks-ear-hot kroks-ear-hot-r" onClick={pokeEar('r')} />
          <img className="kroks-shadow" src={shadow} draggable={false} alt="" />
        </div>
      </div>

      <div className="kroks-bar">
        <span className="kroks-name">{cast.name}</span>
        <button
          className="kroks-mute"
          onClick={() => setMuted((m) => !m)}
          title={muted ? `Unmute ${cast.name}` : `Mute ${cast.name}`}
        >
          {muted ? 'muted' : 'sound'}
        </button>
      </div>
    </div>
  )
}
