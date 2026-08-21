import { createElement, useEffect, useState, type ComponentType } from 'react'
import {
  IconChevronDownOutline14,
  IconChevronRightOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { FollowWrapProps } from './TypewriterToolNodeView.tsx'
import {
  turnProcessBoundaryId,
  useTurnProcessFold,
  type TurnFoldAddress,
} from './turnProcessFold.ts'
import { formatTurnProcessed, type TurnElapsedTranslator } from './turnElapsed.ts'
import css from './TypewriterAssistantNodeView.module.css'

interface TimelineTurn {
  readonly turn: number
  readonly status: 'open' | 'closed' | 'unknown'
  readonly start?: { readonly seq?: number; readonly time?: number } | undefined
  readonly end?: { readonly seq?: number } | undefined
}

function nodeKey(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object' || !('key' in node)) return undefined
  return typeof (node as { key: unknown }).key === 'string' ? (node as { key: string }).key : undefined
}

function userSeq(node: unknown): number | undefined {
  if (node === null || typeof node !== 'object' || !('data' in node)) return undefined
  const data = (node as { data: unknown }).data
  if (data === null || typeof data !== 'object' || !('seq' in data)) return undefined
  return typeof (data as { seq: unknown }).seq === 'number' ? (data as { seq: number }).seq : undefined
}

function userTime(node: unknown): number | undefined {
  if (node === null || typeof node !== 'object' || !('data' in node)) return undefined
  const data = (node as { data: unknown }).data
  if (data === null || typeof data !== 'object' || !('time' in data)) return undefined
  return typeof (data as { time: unknown }).time === 'number' ? (data as { time: number }).time : undefined
}

function chatParts(snapshot: unknown): {
  readonly order: readonly unknown[]
  readonly get: (key: string) => unknown
  readonly turns: ReadonlyMap<number, TimelineTurn>
  readonly turnOrder: readonly number[]
} | undefined {
  if (snapshot === null || typeof snapshot !== 'object' || !('chat' in snapshot)) return undefined
  const chat = (snapshot as { chat: unknown }).chat
  if (chat === null || typeof chat !== 'object') return undefined
  if (!('order' in chat) || !Array.isArray((chat as { order: unknown }).order)) return undefined
  if (!('nodes' in chat) || !('timeline' in chat)) return undefined
  const nodes = (chat as { nodes: unknown }).nodes
  const timeline = (chat as { timeline: unknown }).timeline
  if (nodes === null || typeof nodes !== 'object' || !('get' in nodes)) return undefined
  if (timeline === null || typeof timeline !== 'object' || !('turns' in timeline) || !('turnOrder' in timeline)) return undefined
  const get = (nodes as { get: unknown }).get
  const turns = (timeline as { turns: unknown }).turns
  const turnOrder = (timeline as { turnOrder: unknown }).turnOrder
  if (typeof get !== 'function' || !(turns instanceof Map) || !Array.isArray(turnOrder)) return undefined
  return {
    order: (chat as { order: readonly unknown[] }).order,
    get: (key: string) => get.call(nodes, key),
    turns: turns as ReadonlyMap<number, TimelineTurn>,
    turnOrder: turnOrder as readonly number[],
  }
}

function associatedTurn(snapshot: unknown, currentKey: string, currentSeq: number): TimelineTurn | undefined {
  const chat = chatParts(snapshot)
  if (chat === undefined) return undefined
  const currentIndex = chat.order.indexOf(currentKey)
  if (currentIndex === -1) return undefined
  const current = chat.get(currentKey)
  if (current !== null && typeof current === 'object' && 'location' in current) {
    const location = (current as { location: unknown }).location
    if (
      location !== null
      && typeof location === 'object'
      && 'kind' in location
      && ((location as { kind: unknown }).kind === 'turn' || (location as { kind: unknown }).kind === 'step')
      && 'turn' in location
    ) {
      const turn = (location as { turn: unknown }).turn
      if (turn !== null && typeof turn === 'object' && 'turn' in turn) return turn as TimelineTurn
    }
  }
  let closest: TimelineTurn | undefined
  let closestStartSeq = Number.NEGATIVE_INFINITY
  for (const turnNumber of chat.turnOrder) {
    const turn = chat.turns.get(turnNumber)
    const startSeq = turn?.start?.seq
    const endSeq = turn?.end?.seq
    if (
      turn !== undefined
      && typeof startSeq === 'number'
      && startSeq < currentSeq
      && (typeof endSeq !== 'number' || currentSeq < endSeq)
      && startSeq > closestStartSeq
    ) {
      closest = turn
      closestStartSeq = startSeq
    }
  }
  return closest
}

function isLatestUser(snapshot: unknown, currentKey: string): boolean {
  const chat = chatParts(snapshot)
  if (chat === undefined) return false
  for (let index = chat.order.length - 1; index >= 0; index -= 1) {
    const key = chat.order[index]
    if (typeof key !== 'string') continue
    const candidate = chat.get(key)
    if (candidate === null || typeof candidate !== 'object' || !('kind' in candidate)) continue
    if ((candidate as { kind: unknown }).kind === 'user') return key === currentKey
  }
  return false
}

function isRunning(snapshot: unknown): boolean {
  return snapshot !== null
    && typeof snapshot === 'object'
    && 'running' in snapshot
    && (snapshot as { running: unknown }).running === true
}

function useElapsedNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

function TurnPrelude({
  active,
  address,
  boundaryId,
  boundaryOrder,
  startTime,
  t,
}: {
  readonly active: boolean
  readonly address: TurnFoldAddress | undefined
  readonly boundaryId: string
  readonly boundaryOrder: number
  readonly startTime: number
  readonly t: TurnElapsedTranslator
}) {
  const fold = useTurnProcessFold(address, { boundaryId, boundaryOrder })
  const running = active && !fold.completed
  const now = useElapsedNow(running)
  if (!running && !fold.completed) return null
  const label = fold.completed ? fold.label : formatTurnProcessed(now - startTime, t)
  if (label === undefined) return null
  return (
    <div className={css.turnPrelude} data-turn-prelude="">
      <div
        className={css.turnFoldRow}
        data-turn-fold-row=""
        data-turn-fold-state={fold.completed ? 'completed' : 'running'}
      >
        {fold.completed ? (
          <button
            type="button"
            className={css.turnFoldButton}
            aria-expanded={!fold.collapsed}
            aria-controls={fold.controls}
            onClick={fold.toggle}
          >
            <span>{label}</span>
            {fold.collapsed ? <IconChevronRightOutline14 /> : <IconChevronDownOutline14 />}
          </button>
        ) : (
          <span className={css.turnFoldLabel} aria-live="off">{label}</span>
        )}
      </div>
      {running && !fold.hasMembers && (
        <div className={css.turnWaiting} data-turn-waiting="" role="status" aria-live="polite">
          思考中
        </div>
      )}
    </div>
  )
}

/** Add an immediate Turn status boundary directly after an ordinary user row. */
export function wrapTurnPreludeNodeView(Inner: ComponentType<FollowWrapProps>) {
  return function TurnPreludeUserNodeView(props: FollowWrapProps) {
    const key = nodeKey(props.node)
    const seq = userSeq(props.node)
    const time = userTime(props.node)
    const useSession = props.useSession
    if (
      key === undefined
      || seq === undefined
      || time === undefined
      || typeof props.sessionId !== 'string'
      || typeof useSession !== 'function'
      || typeof props.t !== 'function'
    ) return createElement(Inner, props)
    return (
      <TurnPreludeUserWithSession
        Inner={Inner}
        props={props}
        nodeKey={key}
        nodeSeq={seq}
        nodeTime={time}
        sessionId={props.sessionId}
        useSession={useSession as (selector: (snapshot: unknown) => unknown) => unknown}
        t={props.t as TurnElapsedTranslator}
      />
    )
  }
}

function TurnPreludeUserWithSession({
  Inner,
  props,
  nodeKey: currentKey,
  nodeSeq,
  nodeTime,
  sessionId,
  useSession,
  t,
}: {
  readonly Inner: ComponentType<FollowWrapProps>
  readonly props: FollowWrapProps
  readonly nodeKey: string
  readonly nodeSeq: number
  readonly nodeTime: number
  readonly sessionId: string
  readonly useSession: (selector: (snapshot: unknown) => unknown) => unknown
  readonly t: TurnElapsedTranslator
}) {
  const turn = useSession(snapshot => associatedTurn(snapshot, currentKey, nodeSeq)) as TimelineTurn | undefined
  const running = useSession(isRunning) as boolean
  const latestUser = useSession(snapshot => isLatestUser(snapshot, currentKey)) as boolean
  const address = turn === undefined ? undefined : { sessionId, turn: turn.turn }
  const active = turn?.status === 'open' || (turn === undefined && running && latestUser)
  const startTime = typeof turn?.start?.time === 'number' ? turn.start.time : nodeTime
  return (
    <>
      {createElement(Inner, props)}
      <TurnPrelude
        active={active}
        address={address}
        boundaryId={turnProcessBoundaryId(sessionId, currentKey)}
        boundaryOrder={nodeSeq}
        startTime={startTime}
        t={t}
      />
    </>
  )
}
