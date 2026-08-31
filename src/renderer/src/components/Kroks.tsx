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
import whinnyMp3 from '../assets/rodeo/whinny.mp3'
import dBody from '../assets/ryu/body.svg'
import dHeadNormal from '../assets/ryu/head-normal.svg'
import dHeadOpen from '../assets/ryu/head-open.svg'
import dEyesOpen from '../assets/ryu/eyes-open.svg'
import dEyesClosed from '../assets/ryu/eyes-closed.svg'
import dMouth from '../assets/ryu/mouth-open.svg'
import dFlame from '../assets/ryu/flame.svg'
import dHornLeft from '../assets/ryu/horn-left.svg'
import dHornRight from '../assets/ryu/horn-right.svg'
import dTail from '../assets/ryu/tail.svg'
import dLimbLeft from '../assets/ryu/limb-left.svg'
import dLimbRight from '../assets/ryu/limb-right.svg'
import roarMp3 from '../assets/ryu/roar.mp3'
import '../kroks.css'

interface Cast {
  name: string
  body: string
  headNormal: string
  headOpen: string
  eyesOpen: string
  eyesClosed: string
  mouth: string
  /** Tongue, teeth, fire: the one extra layer a pose can add. */
  extra: string
  earLeft: string
  earRight: string
  tail: string
  /** Which pose shows `extra`. Fire belongs to the roar, a tongue to the wiggle. */
  extraOn?: 'happy' | 'call'
  /** The pet's voice, if it has a recording. Falls back to the cat's meow. */
  sound?: string
  /** How long the call pose is held. Defaults to the length of the three hops. */
  poseMs?: number
  /** Two symmetric layers behind the body: the dragon's forelimbs. */
  limbs?: [string, string]
  /** A flyer hovers instead of standing, so it drops the ground shadow. */
  flying?: boolean
  /** Backdrop painted behind the pet. */
  scene?: 'city'
}

export type PetVariant = 'cat' | 'horse' | 'dragon'

/**
 * Three casts share one rig. The paper-doll layers, timings and animations are
 * identical; only the artwork, the voice, and a few optional layers differ.
 */
const CASTS: Record<PetVariant, Cast> = {
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
    sound: whinnyMp3,
    // The recording runs 2.24s, well past the three hops.
    poseMs: 2400,
  },
  dragon: {
    name: 'Ryu',
    body: dBody,
    headNormal: dHeadNormal,
    headOpen: dHeadOpen,
    eyesOpen: dEyesOpen,
    eyesClosed: dEyesClosed,
    mouth: dMouth,
    extra: dFlame,
    // The horns sit in the ear slots, so poking one still lands on it.
    earLeft: dHornLeft,
    earRight: dHornRight,
    tail: dTail,
    extraOn: 'call',
    sound: roarMp3,
    // The recording runs 1.75s. Holding only for the hops would shut his jaw
    // while he is still roaring.
    poseMs: 1900,
    limbs: [dLimbLeft, dLimbRight],
    flying: true,
    scene: 'city',
  },
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

/**
 * One tile of skyline, in percentages of the tile. Two tiles side by side make
 * a band, and the band scrolls exactly one tile before looping, so the seam
 * never shows. Buildings are plain divs; the windows are a dot grid painted by
 * a radial-gradient rather than one element each.
 */
const SKYLINE: { left: number; width: number; height: number; neon: string }[] = [
  { left: 1, width: 13, height: 46, neon: '#7dd3fc' },
  { left: 15, width: 9, height: 72, neon: '#f472b6' },
  { left: 25, width: 16, height: 34, neon: '#5eead4' },
  { left: 42, width: 11, height: 60, neon: '#a78bfa' },
  { left: 54, width: 8, height: 88, neon: '#f472b6' },
  { left: 63, width: 14, height: 40, neon: '#7dd3fc' },
  { left: 78, width: 10, height: 66, neon: '#5eead4' },
  { left: 89, width: 10, height: 52, neon: '#a78bfa' },
]

function CityTile({ scale }: { scale: number }): React.ReactElement {
  return (
    <div className="kroks-city-tile">
      {SKYLINE.map((b, i) => (
        <div
          key={i}
          className={`kroks-b ${i % 3 === 0 ? 'is-flicker' : ''}`}
          style={{
            left: `${b.left}%`,
            width: `${b.width}%`,
            height: `${b.height * scale}%`,
            // Consumed by the window dots, the roof line and the halo.
            ['--neon' as string]: b.neon,
          }}
        />
      ))}
    </div>
  )
}

/** The neon city the dragon flies through. Two parallax bands, no assets. */
function City(): React.ReactElement {
  return (
    <div className="kroks-city" aria-hidden="true">
      <div className="kroks-city-moon" />
      <div className="kroks-city-band kroks-city-far">
        <CityTile scale={0.62} />
        <CityTile scale={0.62} />
      </div>
      <div className="kroks-city-band kroks-city-near">
        <CityTile scale={1} />
        <CityTile scale={1} />
      </div>
      <div className="kroks-city-haze" />
    </div>
  )
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

  // Swapping cast mid-run must not leave the previous animal's face behind. A
  // napping pet keeps napping through it rather than snapping awake.
  useEffect(() => {
    if (sleepingRef.current) setFace({ head: cast.headOpen, eyes: cast.eyesClosed, mouth: false, tongue: false })
    else idleFace()
  }, [idleFace, cast])

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
    const a = audioRef.current
    if (!a) return
    a.currentTime = 0
    // Autoplay can reject before any user gesture; a silent pet is fine.
    void a.play().catch(() => undefined)
  }, [])

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
    setFace({ head: cast.headOpen, eyes: cast.eyesOpen, mouth: true, tongue: cast.extraOn === 'call' })
    restart(catRef.current, 'meow')
    window.clearTimeout(poseTimer.current)
    // Hold the pose through all three hops (3 x 0.42s), or longer if the
    // cast's voice outlasts them.
    poseTimer.current = window.setTimeout(() => {
      catRef.current?.classList.remove('meow')
      idleFace()
      busyRef.current = false
    }, cast.poseMs ?? 1350)
  }, [wakeUp, playSound, idleFace, cast])

  const showHappy = useCallback(
    (opts: { closedEyes?: boolean; heart?: boolean } = {}) => {
      busyRef.current = true
      setFace({
        head: cast.headNormal,
        eyes: opts.closedEyes ? cast.eyesClosed : cast.eyesOpen,
        mouth: false,
        // A cat's tongue is a happy face; a jet of fire is not.
        tongue: cast.extraOn !== 'call',
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
            setFace((f) => ({ ...f, eyes: cast.eyesClosed }))
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
      <audio ref={audioRef} src={cast.sound ?? meowMp3} preload="auto" />

      <div className="kroks-stage">
        {cast.scene === 'city' && <City />}
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
          className={`kroks-cat is-${variant} ${cast.flying ? 'is-flying' : ''} ${sleeping ? 'state-sleep' : ''} ${
            working && !sleeping ? 'excited' : ''
          }`}
          onClick={onPet}
          onMouseMove={onMove}
          onMouseLeave={onLeave}
          title={sleeping ? `${cast.name} is napping. Click to wake him.` : `Click to pet ${cast.name}`}
        >
          <div className="kroks-stack">
            {cast.limbs && (
              <>
                <img className="kroks-layer kroks-limb-l" src={cast.limbs[0]} draggable={false} alt="" />
                <img className="kroks-layer kroks-limb-r" src={cast.limbs[1]} draggable={false} alt="" />
              </>
            )}
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
          {/* Nothing to cast a shadow onto when the pet is airborne, and the
              city would paint over it anyway. */}
          {!cast.flying && <img className="kroks-shadow" src={shadow} draggable={false} alt="" />}
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
