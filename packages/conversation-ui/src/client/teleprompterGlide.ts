/**
 * Conversation-port follow while an assistant reply streams.
 *
 * The demo's damped-spring lerp is driven from a float `animatedH` — the
 * smoothed content height — never from the rounded `scrollTop` the browser
 * reports back. A wrap raises the content height by a line; if the engine
 * were allowed to snap `scrollTop` to the new floor, the previous line would
 * hop up in one frame. This overlay:
 *
 * - exposes its current follow write through `data-follow-owned` for styling,
 *   diagnostics, and same-port coordination;
 * - sets `overflow-anchor: none` so CSS scroll-anchoring does not snap;
 * - restores `animatedH` in a ResizeObserver (before paint) so a layout
 *   pass cannot flash a snapped frame;
 * - while the port has scroll room, writes the interpolated lag as
 *   `translate3d` on `[data-chat-transcript]` (message rows only), so the
 *   turn-status chrome stays pinned at the floor;
 * - before the port has scroll room (content shorter than the viewport), the
 *   same lag is a content-height lag written as a negative translate on
 *   `[data-chat-turn-status]`, so the status label descends smoothly with
 *   each wrap instead of hopping a line at a time.
 *
 * A reader gesture that unpins the port first writes the effective visual top
 * (`engine - lag`) into `scrollTop` before clearing the transform, so that
 * frame stays continuous. Lifecycle teardown may retain the last same-geometry
 * visual snapshot for a small-lag close, but never derives a new handback from
 * stale `animatedH`: a changed geometry or near-top snapshot in a long Session
 * settles at the physical floor. Port migration does not rewrite the old port.
 * These guards prevent a newer `scrollHeight` from turning old lag into
 * `scrollTop = 0` and manufacturing reader intent in ChatView's ledger.
 *
 * Unpin is a real gesture (wheel / touch / pointer / key) that leaves the
 * floor; a `scrollTop` delta from our own write must not release the pin.
 */

import { useEffect, useRef, type RefObject } from 'react'

/**
 * Plugin-local marker containing the last programmatic `scrollTop`. DSH rc.6
 * and rc.7 do not consume this attribute; the actual write ownership is
 * enforced by {@link followDrivers} and {@link followOwners} below.
 */
const FOLLOW_OWNED_ATTR = 'data-follow-owned'

/** Demo `1 - exp(-dt / 18)` time constant, in ms. */
export const FOLLOW_LERP_DT_MS = 18

/** Floor / ceiling of the per-frame lerp fraction before the dt term. */
export const FOLLOW_LERP_MIN = 0.05
export const FOLLOW_LERP_MAX = 0.25

/** Lag (px) at which the lag term of the lerp saturates. */
export const FOLLOW_LERP_LAG_REF_PX = 160

/** Reveal cps at which the speed factor is 1. */
export const FOLLOW_SPEED_REF_CPS = 35

export const FOLLOW_SPEED_FACTOR_MIN = 0.7
export const FOLLOW_SPEED_FACTOR_MAX = 2.2

/** Reader-return / still-pinned boundary, matching ChatView + the demo. */
export const FOLLOW_SLACK_PX = 25

/**
 * Upward wheel/touch distance that releases the pin. The engine `scrollTop`
 * is held on the floor while following, so a small trackpad tick never
 * appears as `reportedLag` and cannot be judged against {@link FOLLOW_SLACK_PX}.
 */
export const FOLLOW_UNPIN_GESTURE_PX = 8

/** How long a gesture keeps `isUserInteracting` so the next scroll can unpin. */
export const FOLLOW_GESTURE_MS = 800

const GESTURE_EVENTS = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const

export interface FollowGlideInput {
  /** How far the interpolated top trails the floor, in px. */
  readonly lag: number
  /** Observed reveal rate in chars/s; 0 uses {@link FOLLOW_SPEED_REF_CPS}. */
  readonly speedEma: number
  /** Optional minimum visual follow speed from plugin configuration. */
  readonly minSpeedPxPerSec?: number | undefined
  /** Optional maximum visual follow speed from plugin configuration. */
  readonly maxSpeedPxPerSec?: number | undefined
}

export interface FollowGlideStep {
  /** Pixels to advance `animatedH` this frame (fractional). */
  readonly advancePx: number
  /** Applied lerp fraction, for tests. */
  readonly lerpStep: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * One spring-lerp frame from the silky markdown demo.
 * @param dtMs - Frame delta in ms.
 * @param input - Current lag (from the float top, not the rounded engine top) and reveal-speed EMA.
 * @returns The fractional advance and the lerp fraction.
 */
export function computeFollowStep(dtMs: number, input: FollowGlideInput): FollowGlideStep {
  if (input.lag <= 0.1 || dtMs <= 0) return { advancePx: 0, lerpStep: 0 }
  const speed = input.speedEma > 0 ? input.speedEma : FOLLOW_SPEED_REF_CPS
  const speedFactor = clamp(speed / FOLLOW_SPEED_REF_CPS, FOLLOW_SPEED_FACTOR_MIN, FOLLOW_SPEED_FACTOR_MAX)
  const baseLerp = clamp((input.lag / FOLLOW_LERP_LAG_REF_PX) * speedFactor, FOLLOW_LERP_MIN, FOLLOW_LERP_MAX)
  const lerpStep = baseLerp * (1 - Math.exp(-dtMs / FOLLOW_LERP_DT_MS))
  const desired = input.lag * lerpStep
  const minAdvance = Math.max(0, input.minSpeedPxPerSec ?? 0) * dtMs / 1000
  const maxAdvance = Math.max(0, input.maxSpeedPxPerSec ?? Number.POSITIVE_INFINITY) * dtMs / 1000
  const upper = Math.min(input.lag, maxAdvance)
  const lower = Math.min(upper, minAdvance)
  return { advancePx: clamp(desired, lower, upper), lerpStep }
}

/** The message-rows box the lag transform rides on, when the host has one. */
function shiftRootOf(port: HTMLElement): HTMLElement | null {
  return port.querySelector('[data-chat-transcript]')
}

/**
 * Row wrappers that carry only messages/tools. Hosts without a transcript
 * box keep the turn-status chrome as a sibling of the rows inside
 * `[data-chat-flow]`, so shifting that whole flow would drag the chrome
 * along; shifting the rows individually leaves every non-message sibling
 * (turn status, steering bubbles) pinned while the text glides.
 *
 * Only the outermost rows are shifted: a tool call nests its subcalls as
 * descendant `[data-chat-anchor-key]` rows, and writing the lag on each of
 * them would double (or further multiply) the shift, tearing the subcalls
 * away from their parent every frame. Descendants ride the parent's
 * transform instead.
 */
function shiftRowsOf(port: HTMLElement): HTMLElement[] {
  return [...port.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')]
    .filter(row => row.parentElement?.closest('[data-chat-anchor-key]') === null)
}

/** Element whose resize signals flow growth for the before-paint restore. */
function resizeProxyOf(port: HTMLElement): HTMLElement | null {
  return port.querySelector('[data-chat-transcript]') ?? port.querySelector('[data-chat-flow]')
}

/** True when the glide expresses its lag as transforms instead of engine top. */
function hasShiftSurface(port: HTMLElement): boolean {
  return shiftRootOf(port) !== null || shiftRowsOf(port).length > 0
}

function setShift(element: HTMLElement, px: number, negative = false): void {
  const value = negative ? -px : px
  if (Math.abs(value) > 0.01) {
    element.style.transform = `translate3d(0, ${value}px, 0)`
    element.style.willChange = 'transform'
  } else {
    element.style.transform = ''
    element.style.willChange = ''
  }
}

/**
 * The running-turn label. Before the port scrolls (content shorter than the
 * viewport) the content-height lag has no `scrollTop` room to ride, so it is
 * expressed as a negative translate on this sibling: the label descends
 * smoothly with each wrap instead of hopping down a line at a time.
 */
function chromeShiftOf(port: HTMLElement): HTMLElement | null {
  return port.querySelector<HTMLElement>('[data-chat-turn-status]')
}

/**
 * Render the single smoothed extent `animatedH`. Before the port scrolls
 * (content shorter than the viewport) `animatedH` is clamped to the content
 * height and the content-height lag rides a negative translate on the
 * turn-status label; once the port has scroll room the engine is pinned at
 * the floor and the lag rides `[data-chat-transcript]` (or each message row
 * when the host has no transcript box) so the chrome stays put. Without any
 * shift surface the engine itself carries the interpolated top. Returns the
 * effective visual top produced by the same geometry write.
 */
function applyVisual(port: HTMLElement, animatedH: number): number {
  const contentHeight = Math.max(0, port.scrollHeight)
  const floor = Math.max(0, contentHeight - port.clientHeight)
  const extent = Math.min(contentHeight, Math.max(0, animatedH))
  const lag = contentHeight - extent
  port.style.overflowAnchor = 'none'
  port.style.scrollBehavior = 'auto'
  const shiftRoot = shiftRootOf(port)
  if (shiftRoot !== null) {
    if (floor <= 0) {
      port.scrollTop = 0
      port.setAttribute(FOLLOW_OWNED_ATTR, String(port.scrollTop))
      const chrome = chromeShiftOf(port)
      if (chrome !== null) setShift(chrome, lag, true)
      setShift(shiftRoot, 0)
      return port.scrollTop
    }
    port.scrollTop = floor
    port.setAttribute(FOLLOW_OWNED_ATTR, String(port.scrollTop))
    setShift(shiftRoot, lag)
    return Math.min(floor, Math.max(0, port.scrollTop - lag))
  }
  const rows = shiftRowsOf(port)
  if (rows.length > 0) {
    if (floor <= 0) {
      port.scrollTop = 0
      port.setAttribute(FOLLOW_OWNED_ATTR, String(port.scrollTop))
      const chrome = chromeShiftOf(port)
      if (chrome !== null) setShift(chrome, lag, true)
      for (const row of rows) setShift(row, 0)
      return port.scrollTop
    }
    port.scrollTop = floor
    port.setAttribute(FOLLOW_OWNED_ATTR, String(port.scrollTop))
    for (const row of rows) setShift(row, lag)
    return Math.min(floor, Math.max(0, port.scrollTop - lag))
  }
  port.scrollTop = Math.min(floor, Math.max(0, extent))
  port.setAttribute(FOLLOW_OWNED_ATTR, String(port.scrollTop))
  return port.scrollTop
}

function clearVisual(port: HTMLElement): void {
  port.removeAttribute(FOLLOW_OWNED_ATTR)
  port.style.overflowAnchor = ''
  port.style.scrollBehavior = ''
  const shiftRoot = shiftRootOf(port)
  if (shiftRoot !== null) {
    shiftRoot.style.transform = ''
    shiftRoot.style.willChange = ''
  } else {
    for (const row of shiftRowsOf(port)) {
      row.style.transform = ''
      row.style.willChange = ''
    }
  }
  const chrome = chromeShiftOf(port)
  if (chrome !== null) {
    chrome.style.transform = ''
    chrome.style.willChange = ''
  }
}

interface FollowVisualSnapshot {
  readonly scrollHeight: number
  readonly clientHeight: number
  readonly top: number
}

/** Active visual holders per port, normally zero or the elected driver. */
const followOwners = new WeakMap<HTMLElement, number>()

/** Bound active FollowHosts, including loops that did not win the driver token. */
const followParticipants = new WeakMap<HTMLElement, number>()

/** Safe final snapshot retained while a driver token is changing hands. */
const pendingHandoffs = new WeakMap<HTMLElement, FollowVisualSnapshot>()

/**
 * Only one animation loop may write a conversation port at a time. Multiple
 * active FollowHosts can exist during a streamed turn (for example, the
 * assistant body and a tool row); independent loops would fight over
 * scrollTop and transforms and make the transcript jump.
 */
const followDrivers = new WeakMap<HTMLElement, symbol>()

function acquireFollow(port: HTMLElement): void {
  followOwners.set(port, (followOwners.get(port) ?? 0) + 1)
}

function releaseFollow(port: HTMLElement): number {
  const next = (followOwners.get(port) ?? 1) - 1
  if (next <= 0) {
    followOwners.delete(port)
    return 0
  }
  followOwners.set(port, next)
  return next
}

function acquireParticipant(port: HTMLElement): void {
  followParticipants.set(port, (followParticipants.get(port) ?? 0) + 1)
}

function releaseParticipant(port: HTMLElement): number {
  const next = (followParticipants.get(port) ?? 1) - 1
  if (next <= 0) {
    followParticipants.delete(port)
    return 0
  }
  followParticipants.set(port, next)
  return next
}

/**
 * Own the conversation scrollport's bottom-follow while `active` is true.
 *
 * @param rootRef - An element inside the conversation scrollport.
 * @param active - True while the reply is still revealing.
 * @param speedCpsRef - Live reveal-rate EMA from the smoother.
 */
export function useConversationFollow(
  rootRef: RefObject<HTMLElement | null>,
  active: boolean,
  speedCpsRef: { current: number },
  minSpeedPxPerSec?: number,
  maxSpeedPxPerSec?: number,
): void {
  const activeRef = useRef(active)
  useEffect(() => {
    activeRef.current = active
  }, [active])

  useEffect(() => {
    if (!active) return
    const driverToken = Symbol('conversation-follow')
    let rafId = 0
    let last = performance.now()
    let following = true
    let primed = false
    let animatedH = 0
    let interacting = false
    let interactTimer: ReturnType<typeof setTimeout> | null = null
    let port: HTMLElement | null = null
    let resize: ResizeObserver | null = null
    let holding: HTMLElement | null = null
    let awayPx = 0
    let readerIntent = false
    let lastVisual: FollowVisualSnapshot | null = null

    const hold = (next: HTMLElement): void => {
      if (holding === next) return
      if (holding !== null) {
        const previous = holding
        const remaining = releaseFollow(previous)
        if (remaining === 0) clearVisual(previous)
      }
      acquireFollow(next)
      holding = next
    }

    const drop = (next: HTMLElement): void => {
      if (holding !== next) return
      const remaining = releaseFollow(next)
      holding = null
      if (remaining === 0) clearVisual(next)
    }

    /**
     * Give the reader the visual position the glide was showing before the
     * transforms go away. While transforms carry the lag, the engine sits at
     * the floor and the effective visual top is `engine - lag`; writing that
     * keeps the handover frame-continuous, and the write shows up in
     * ChatView's ledger as reader movement, disarming its snap-follow.
     * Without a shift surface the engine already holds the interpolated top,
     * so there is nothing to compensate.
     */
    const handBackVisual = (next: HTMLElement): void => {
      if (!hasShiftSurface(next)) return
      const floor = Math.max(0, next.scrollHeight - next.clientHeight)
      if (floor <= 0) return
      const lag = Math.max(0, next.scrollHeight - animatedH)
      next.scrollTop = Math.min(floor, Math.max(0, next.scrollTop - lag))
    }

    const applyCurrentVisual = (next: HTMLElement): void => {
      const top = applyVisual(next, animatedH)
      lastVisual = {
        scrollHeight: next.scrollHeight,
        clientHeight: next.clientHeight,
        top,
      }
    }

    const markGesture = (event: Event): void => {
      interacting = true
      if (event instanceof WheelEvent && event.deltaY < 0) {
        readerIntent = true
        awayPx += -event.deltaY
      } else if (event.type === 'touchmove' || event.type === 'pointerdown' || event.type === 'keydown') {
        // Record intent synchronously: the stream may settle before the next
        // animation frame gets a chance to release follow.
        readerIntent = true
        awayPx += FOLLOW_UNPIN_GESTURE_PX
      }
      if (readerIntent && port !== null) pendingHandoffs.delete(port)
      if (interactTimer !== null) clearTimeout(interactTimer)
      interactTimer = setTimeout(() => {
        interacting = false
        interactTimer = null
        awayPx = 0
      }, FOLLOW_GESTURE_MS)
    }

    const restoreBeforePaint = (): void => {
      if (
        !primed
        || !following
        || port === null
        || holding !== port
        || followDrivers.get(port) !== driverToken
      ) return
      applyCurrentVisual(port)
    }

    const bindPort = (next: HTMLElement): void => {
      if (port === next) return
      if (port !== null) {
        const previous = port
        const drovePrevious = followDrivers.get(previous) === driverToken
        for (const name of GESTURE_EVENTS) previous.removeEventListener(name, markGesture)
        resize?.disconnect()
        resize = null
        if (holding === previous) {
          const remaining = releaseFollow(previous)
          holding = null
          if (remaining === 0) clearVisual(previous)
        }
        releaseParticipant(previous)
        if (drovePrevious) followDrivers.delete(previous)
        primed = false
        following = true
        animatedH = 0
        awayPx = 0
        readerIntent = false
        lastVisual = null
      }
      port = next
      acquireParticipant(next)
      for (const name of GESTURE_EVENTS) {
        port.addEventListener(name, markGesture, { passive: true })
      }
      if (typeof ResizeObserver !== 'undefined') {
        resize = new ResizeObserver(restoreBeforePaint)
        resize.observe(port)
        const proxy = resizeProxyOf(port)
        if (proxy !== null) resize.observe(proxy)
      }
    }

    const frame = (now: number) => {
      rafId = requestAnimationFrame(frame)
      const dt = Math.min(50, now - last)
      last = now
      const root = rootRef.current
      if (root === null) return
      const nextPort = root.closest<HTMLElement>('[data-conversation-scroll]')
      if (nextPort === null) return
      bindPort(nextPort)
      const owner = followDrivers.get(nextPort)
      const inherited = owner === undefined ? pendingHandoffs.get(nextPort) ?? null : null
      if (owner === undefined) followDrivers.set(nextPort, driverToken)
      if (followDrivers.get(nextPort) !== driverToken) return

      if (!primed && inherited !== null && !readerIntent) {
        const geometryMatches = inherited.scrollHeight === nextPort.scrollHeight
          && inherited.clientHeight === nextPort.clientHeight
        if (geometryMatches) {
          animatedH = hasShiftSurface(nextPort)
            ? Math.min(nextPort.scrollHeight, nextPort.clientHeight + inherited.top)
            : inherited.top
          following = true
          hold(nextPort)
          applyCurrentVisual(nextPort)
          primed = true
          pendingHandoffs.delete(nextPort)
          return
        }
      }
      pendingHandoffs.delete(nextPort)
      if (owner === undefined && (followOwners.get(nextPort) ?? 0) === 0) clearVisual(nextPort)

      const floor = Math.max(0, nextPort.scrollHeight - nextPort.clientHeight)
      const reportedLag = floor - nextPort.scrollTop
      // Visual extent (content-height equivalent of the reader's scroll top):
      // content shorter than the viewport has no scrollTop to derive from, so
      // the extent is just the content height.
      const extent = Math.min(nextPort.scrollHeight, Math.max(0, nextPort.scrollHeight - reportedLag))

      if (!primed) {
        animatedH = extent
        following = reportedLag <= FOLLOW_SLACK_PX
        if (following) {
          hold(nextPort)
          applyCurrentVisual(nextPort)
        }
        primed = true
        return
      }

      if (!following && !interacting && reportedLag <= FOLLOW_SLACK_PX) {
        following = true
        readerIntent = false
        animatedH = extent
        hold(nextPort)
      } else if (following && interacting && awayPx >= FOLLOW_UNPIN_GESTURE_PX) {
        following = false
        awayPx = 0
        // Compensate before the transform clears, or the flow (turn-status
        // chrome included) jumps up by the whole lag in one frame.
        handBackVisual(nextPort)
        animatedH = nextPort.scrollHeight
        drop(nextPort)
      }

      if (!activeRef.current || !following) return
      hold(nextPort)

      const lag = nextPort.scrollHeight - animatedH
      const step = computeFollowStep(dt, {
        lag,
        speedEma: speedCpsRef.current,
        minSpeedPxPerSec,
        maxSpeedPxPerSec,
      })
      if (lag <= 0.1) {
        animatedH = nextPort.scrollHeight
      } else {
        animatedH = Math.min(nextPort.scrollHeight, animatedH + step.advancePx)
      }
      applyCurrentVisual(nextPort)
    }

    rafId = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(rafId)
      if (interactTimer !== null) clearTimeout(interactTimer)
      resize?.disconnect()
      const root = rootRef.current
      const rootHost = root?.closest<HTMLElement>('[data-conversation-scroll]') ?? null
      // Once a frame has bound a port, that exact port owns this effect's
      // driver/visual state. A root moved into another Session must not make
      // this cleanup release or rewrite the new Session's scrollport.
      const host = port ?? rootHost
      const droveHost = host !== null && followDrivers.get(host) === driverToken
      let remainingParticipants = host === null ? 0 : (followParticipants.get(host) ?? 0)
      if (port !== null) {
        for (const name of GESTURE_EVENTS) port.removeEventListener(name, markGesture)
        remainingParticipants = releaseParticipant(port)
      }
      const ownSnapshot = host !== null
        && rootHost === host
        && droveHost
        && primed
        && following
        && holding === host
        && !readerIntent
        ? lastVisual
        : null
      if (host !== null) {
        if (readerIntent) pendingHandoffs.delete(host)
        else if (ownSnapshot !== null && remainingParticipants > 0) pendingHandoffs.set(host, ownSnapshot)

        if (remainingParticipants === 0) {
          const snapshot = ownSnapshot ?? pendingHandoffs.get(host) ?? null
          pendingHandoffs.delete(host)
          if (rootHost === host && !readerIntent && snapshot !== null) {
            const floor = Math.max(0, host.scrollHeight - host.clientHeight)
            const snapshotValid = snapshot.scrollHeight === host.scrollHeight
              && snapshot.clientHeight === host.clientHeight
            const snapshotTop = snapshotValid
              ? Math.min(floor, Math.max(0, snapshot.top))
              : floor
            // Keep normal small-lag close continuity, but never turn a large
            // stale lag into a jump to the first viewport. Geometry changes
            // and near-top snapshots settle at the physical floor instead.
            const nearTopOfScrollablePort = floor > FOLLOW_SLACK_PX && snapshotTop <= FOLLOW_SLACK_PX
            host.scrollTop = snapshotValid && !nearTopOfScrollablePort ? snapshotTop : floor
          }
        }
      }
      if (droveHost) followDrivers.delete(host)
      if (holding !== null) {
        const held = holding
        const remaining = releaseFollow(held)
        holding = null
        const preserveForSuccessor = held === host
          && remainingParticipants > 0
          && pendingHandoffs.has(held)
        if (remaining === 0 && !preserveForSuccessor) clearVisual(held)
      }
      if (
        host !== null
        && remainingParticipants === 0
        && (followOwners.get(host) ?? 0) === 0
      ) clearVisual(host)
    }
  }, [active, rootRef, speedCpsRef, minSpeedPxPerSec, maxSpeedPxPerSec])
}
