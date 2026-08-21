import { createPortal } from 'react-dom'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
} from 'react'
import {
  IconChevronDownOutline14,
  IconChevronRightOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  useTurnProcessFold,
  type TurnFoldAddress,
} from './turnProcessFold.ts'
import { TurnProcessMember } from './TurnProcessMember.tsx'
import css from './TypewriterAssistantNodeView.module.css'

export type ToolActivityGroupPosition = 'start' | 'middle' | 'end'

export interface ToolActivityGroupInfo {
  readonly id: string
  readonly domId: string
  readonly semantic: string
  readonly label: string
  readonly count: number
  readonly position: ToolActivityGroupPosition
  readonly hasGrowing: boolean
}

interface ToolActivityGroupState {
  collapsed: boolean
  readonly listeners: Set<() => void>
}

interface ToolActivityMount {
  target: HTMLElement | null
  readonly listeners: Set<() => void>
}

const groupStates = new Map<string, ToolActivityGroupState>()
const groupMounts = new Map<string, ToolActivityMount>()

function groupState(id: string): ToolActivityGroupState {
  const current = groupStates.get(id)
  if (current !== undefined) return current
  const created: ToolActivityGroupState = { collapsed: false, listeners: new Set() }
  groupStates.set(id, created)
  return created
}

function groupMount(id: string): ToolActivityMount {
  const current = groupMounts.get(id)
  if (current !== undefined) return current
  const created: ToolActivityMount = { target: null, listeners: new Set() }
  groupMounts.set(id, created)
  return created
}

function notify(listeners: Set<() => void>): void {
  for (const listener of listeners) listener()
}

function subscribeGroup(id: string, listener: () => void): () => void {
  const state = groupState(id)
  state.listeners.add(listener)
  return () => {
    state.listeners.delete(listener)
    if (state.listeners.size === 0) groupStates.delete(id)
  }
}

function subscribeMount(id: string, listener: () => void): () => void {
  const mount = groupMount(id)
  mount.listeners.add(listener)
  return () => {
    mount.listeners.delete(listener)
    if (mount.listeners.size === 0 && mount.target === null) groupMounts.delete(id)
  }
}

function setMount(id: string, target: HTMLElement | null): void {
  const mount = groupMount(id)
  if (mount.target === target) return
  mount.target = target
  notify(mount.listeners)
}

function hash(value: string): string {
  let result = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16_777_619)
  }
  return (result >>> 0).toString(36)
}

/** Stable identity for one contiguous semantic tool group in a Turn. */
export function toolActivityGroupId(
  sessionId: string,
  turn: number,
  semantic: string,
  firstNodeKey: string,
): string {
  return `dsh-tool-group-${hash(`${sessionId}\u0000${turn}\u0000${semantic}\u0000${firstNodeKey}`)}`
}

function useToolActivityFold(id: string): { collapsed: boolean; toggle: () => void; collapse: () => void } {
  const subscribe = useCallback((listener: () => void) => subscribeGroup(id, listener), [id])
  const collapsed = useSyncExternalStore(
    subscribe,
    () => groupState(id).collapsed,
    () => false,
  )
  const toggle = useCallback(() => {
    const state = groupState(id)
    state.collapsed = !state.collapsed
    notify(state.listeners)
  }, [id])
  const collapse = useCallback(() => {
    const state = groupState(id)
    if (state.collapsed) return
    state.collapsed = true
    notify(state.listeners)
  }, [id])
  return { collapsed, toggle, collapse }
}

function useToolActivityMount(id: string): HTMLElement | null {
  const subscribe = useCallback((listener: () => void) => subscribeMount(id, listener), [id])
  return useSyncExternalStore(
    subscribe,
    () => groupMount(id).target,
    () => null,
  )
}

interface ScrollPositionSnapshot {
  readonly port: HTMLElement
  readonly top: number
  readonly bottomGap: number
}

function restoreScrollPosition(snapshot: ScrollPositionSnapshot): void {
  const floor = Math.max(0, snapshot.port.scrollHeight - snapshot.port.clientHeight)
  const target = snapshot.bottomGap <= 25
    ? floor
    : Math.min(snapshot.top, floor)
  snapshot.port.scrollTop = target
}

function ToolActivityGroupFrame({
  group,
  collapsed,
  toggle,
  header,
  children,
}: {
  readonly group: ToolActivityGroupInfo
  readonly collapsed: boolean
  readonly toggle: () => void
  readonly header: ReactNode
  readonly children: ReactNode
}) {
  const frameRef = useRef<HTMLDivElement | null>(null)
  const pendingScroll = useRef<ScrollPositionSnapshot | null>(null)
  const register = useCallback((element: HTMLDivElement | null) => {
    frameRef.current = element
    setMount(group.id, element)
  }, [group.id])
  const toggleWithScroll = useCallback(() => {
    const port = frameRef.current?.closest<HTMLElement>('[data-conversation-scroll]')
    if (port !== null && port !== undefined) {
      const floor = Math.max(0, port.scrollHeight - port.clientHeight)
      pendingScroll.current = {
        port,
        top: port.scrollTop,
        bottomGap: floor - port.scrollTop,
      }
    }
    toggle()
  }, [toggle])
  useLayoutEffect(() => {
    const snapshot = pendingScroll.current
    if (snapshot === null) return
    pendingScroll.current = null
    restoreScrollPosition(snapshot)
    if (typeof window === 'undefined') return
    const frame = window.requestAnimationFrame(() => restoreScrollPosition(snapshot))
    return () => window.cancelAnimationFrame(frame)
  }, [collapsed])
  return (
    <div
      ref={register}
      id={group.domId}
      className={css.toolGroupFrame}
      data-stream-tool-group={group.semantic}
      data-stream-tool-group-frame=""
      data-stream-tool-group-position={group.position}
      data-stream-tool-group-count={group.count}
      data-stream-tool-group-collapsed={collapsed || undefined}
    >
      <button
        type="button"
        className={css.toolGroupHeader}
        aria-expanded={!collapsed}
        aria-controls={group.domId}
        data-stream-tool-group-toggle=""
        onClick={toggleWithScroll}
      >
        {header}
        <span className={css.toolGroupHeaderChevron} aria-hidden>
          {collapsed ? <IconChevronRightOutline14 size={14} /> : <IconChevronDownOutline14 size={14} />}
        </span>
      </button>
      {children}
    </div>
  )
}

interface ToolActivityGroupMemberProps {
  readonly group: ToolActivityGroupInfo
  readonly address: TurnFoldAddress
  readonly memberId: string
  readonly memberOrder: number
  readonly turnStartTime?: number | undefined
  readonly formatRunningElapsed?: ((ms: number) => string) | undefined
  readonly memberRef?: Ref<HTMLDivElement> | undefined
  readonly eventAttributes?: Readonly<Record<string, string | undefined>>
  readonly header: ReactNode
  readonly children: ReactNode
}

/**
 * Mount the first member as a group host and portal subsequent tool members
 * into the same host. The Turn fold remains shared with ordinary process rows,
 * while a contiguous run of commands gets one Codex-style disclosure block.
 */
export function ToolActivityGroupMember({
  group,
  address,
  memberId,
  memberOrder,
  turnStartTime,
  formatRunningElapsed,
  memberRef,
  eventAttributes,
  header,
  children,
}: ToolActivityGroupMemberProps) {
  const fold = useTurnProcessFold(address, { memberId, memberOrder })
  const activity = useToolActivityFold(group.id)
  const mount = useToolActivityMount(group.id)

  // Codex leaves a running tool group open while work is arriving, then folds
  // the completed batch automatically. A manual toggle after completion still
  // wins because this effect only reacts to the growing -> settled transition.
  useEffect(() => {
    if (group.position === 'start' && !group.hasGrowing) activity.collapse()
  }, [activity.collapse, group.hasGrowing, group.position])

  if (group.position === 'start') {
    return (
      <TurnProcessMember
        address={address}
        memberId={memberId}
        memberOrder={memberOrder}
        turnStartTime={turnStartTime}
        formatRunningElapsed={formatRunningElapsed}
        className={css.toolGroupAnchor}
        data-stream-tool-group-anchor=""
      >
        <ToolActivityGroupFrame
          group={group}
          collapsed={activity.collapsed}
          toggle={activity.toggle}
          header={header}
        >
          <div
            {...eventAttributes}
            ref={memberRef}
            className={css.eventRow}
            data-stream-tool-group-member=""
            data-stream-tool-group-position="start"
            data-stream-tool-group-collapsed={activity.collapsed || undefined}
          >
            {children}
          </div>
        </ToolActivityGroupFrame>
      </TurnProcessMember>
    )
  }

  const hidden = fold.collapsed || activity.collapsed
  const member = (
    <div
      id={memberId}
      data-turn-process=""
      data-tool-group-member=""
      data-tool-group-hidden={hidden || undefined}
      hidden={hidden}
    >
      <div
        {...eventAttributes}
        ref={memberRef}
        className={css.eventRow}
        data-stream-tool-group-member=""
        data-stream-tool-group-position={group.position}
        data-stream-tool-group-collapsed={activity.collapsed || undefined}
      >
        {children}
      </div>
    </div>
  )

  if (mount === null) return member
  return (
    <span data-tool-group-proxy="" aria-hidden>
      {createPortal(member, mount)}
    </span>
  )
}

/** Render the group heading with the semantic icon supplied by the tool view. */
export function ToolActivityGroupHeader({
  label,
  icon,
}: {
  readonly label: string
  readonly icon: ReactNode
}) {
  return (
    <>
      <span className={css.toolGroupHeaderIcon} aria-hidden>{icon}</span>
      <span className={css.toolGroupHeaderLabel}>{label}</span>
    </>
  )
}
