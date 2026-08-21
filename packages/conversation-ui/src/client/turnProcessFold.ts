import { useCallback, useLayoutEffect, useSyncExternalStore } from 'react'

export interface TurnFoldAddress {
  readonly sessionId: string
  readonly turn: number
}

interface TurnFoldEntry {
  collapsed: boolean
  completed: boolean
  label: string | undefined
  readonly boundaries: Map<string, number>
  readonly members: Map<string, number>
  readonly listeners: Set<() => void>
}

interface TurnProcessFoldState {
  readonly collapsed: boolean
  readonly completed: boolean
  readonly boundary: boolean
  readonly controls: string
  readonly hasMembers: boolean
  readonly label: string | undefined
  readonly toggle: () => void
}

const entries = new Map<string, TurnFoldEntry>()

function addressKey(address: TurnFoldAddress): string {
  return `${address.sessionId}\u0000${address.turn}`
}

function entryFor(key: string): TurnFoldEntry {
  const current = entries.get(key)
  if (current !== undefined) return current
  const created: TurnFoldEntry = {
    collapsed: false,
    completed: false,
    label: undefined,
    boundaries: new Map(),
    members: new Map(),
    listeners: new Set(),
  }
  entries.set(key, created)
  return created
}

function notify(entry: TurnFoldEntry): void {
  for (const listener of entry.listeners) listener()
}

function discardUnused(key: string, entry: TurnFoldEntry): void {
  if (entry.listeners.size === 0 && entry.boundaries.size === 0 && entry.members.size === 0) entries.delete(key)
}

function subscribe(key: string, listener: () => void): () => void {
  const entry = entryFor(key)
  entry.listeners.add(listener)
  return () => {
    entry.listeners.delete(listener)
    discardUnused(key, entry)
  }
}

function orderedMembers(entry: TurnFoldEntry): readonly string[] {
  return [...entry.members]
    .sort(([leftId, leftOrder], [rightId, rightOrder]) => leftOrder - rightOrder || leftId.localeCompare(rightId))
    .map(([id]) => id)
}

function orderedBoundaries(entry: TurnFoldEntry): readonly string[] {
  return [...entry.boundaries]
    .sort(([leftId, leftOrder], [rightId, rightOrder]) => leftOrder - rightOrder || leftId.localeCompare(rightId))
    .map(([id]) => id)
}

function complete(key: string, label: string): void {
  const entry = entryFor(key)
  if (entry.completed) {
    if (entry.label === label) return
    entry.label = label
    notify(entry)
    return
  }
  entry.completed = true
  entry.label = label
  entry.collapsed = true
  notify(entry)
}

function registerMember(key: string, memberId: string, memberOrder: number): () => void {
  const entry = entryFor(key)
  entry.members.set(memberId, memberOrder)
  notify(entry)
  return () => {
    entry.members.delete(memberId)
    notify(entry)
    discardUnused(key, entry)
  }
}

function registerBoundary(key: string, boundaryId: string, boundaryOrder: number): () => void {
  const entry = entryFor(key)
  entry.boundaries.set(boundaryId, boundaryOrder)
  notify(entry)
  return () => {
    entry.boundaries.delete(boundaryId)
    notify(entry)
    discardUnused(key, entry)
  }
}

function hash(value: string): string {
  let result = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16_777_619)
  }
  return (result >>> 0).toString(36)
}

/** Stable DOM id for one flat Chat node controlled by a Turn disclosure. */
export function turnProcessMemberId(address: TurnFoldAddress, nodeKey: string): string {
  return `dsh-turn-process-${address.turn}-${hash(`${address.sessionId}\u0000${nodeKey}`)}`
}

/** Stable DOM/store identity for the user-anchored Turn disclosure. */
export function turnProcessBoundaryId(sessionId: string, nodeKey: string): string {
  return `dsh-turn-boundary-${hash(`${sessionId}\u0000${nodeKey}`)}`
}

/**
 * Share one collapse state across flat Chat siblings belonging to the same
 * Session Turn. A successful final node marks the Turn complete; process
 * members contribute their DOM ids to the disclosure's `aria-controls` list.
 */
export function useTurnProcessFold(
  address: TurnFoldAddress | undefined,
  options: {
    readonly boundaryId?: string | undefined
    readonly boundaryOrder?: number | undefined
    readonly completedLabel?: string | undefined
    readonly memberId?: string | undefined
    readonly memberOrder?: number | undefined
  } = {},
): TurnProcessFoldState {
  const key = address === undefined ? undefined : addressKey(address)
  const subscribeToKey = useCallback((listener: () => void) => (
    key === undefined ? () => {} : subscribe(key, listener)
  ), [key])
  const collapsed = useSyncExternalStore(
    subscribeToKey,
    () => key === undefined ? false : entries.get(key)?.collapsed ?? false,
    () => false,
  )
  const completed = useSyncExternalStore(
    subscribeToKey,
    () => key === undefined ? false : entries.get(key)?.completed ?? false,
    () => false,
  )
  const controls = useSyncExternalStore(
    subscribeToKey,
    () => {
      if (key === undefined) return ''
      const entry = entries.get(key)
      return entry === undefined ? '' : orderedMembers(entry).join(' ')
    },
    () => '',
  )
  const boundaryId = useSyncExternalStore(
    subscribeToKey,
    () => {
      if (key === undefined) return undefined
      const entry = entries.get(key)
      if (entry === undefined) return undefined
      return orderedBoundaries(entry)[0] ?? orderedMembers(entry)[0]
    },
    () => undefined,
  )
  const hasMembers = useSyncExternalStore(
    subscribeToKey,
    () => key !== undefined && (entries.get(key)?.members.size ?? 0) > 0,
    () => false,
  )
  const label = useSyncExternalStore(
    subscribeToKey,
    () => key === undefined ? undefined : entries.get(key)?.label,
    () => undefined,
  )

  useLayoutEffect(() => {
    if (key === undefined || options.boundaryId === undefined || options.boundaryOrder === undefined) return
    return registerBoundary(key, options.boundaryId, options.boundaryOrder)
  }, [key, options.boundaryId, options.boundaryOrder])

  useLayoutEffect(() => {
    if (key === undefined || options.memberId === undefined || options.memberOrder === undefined) return
    return registerMember(key, options.memberId, options.memberOrder)
  }, [key, options.memberId, options.memberOrder])

  useLayoutEffect(() => {
    if (key === undefined || options.completedLabel === undefined) return
    complete(key, options.completedLabel)
  }, [key, options.completedLabel])

  const toggle = useCallback(() => {
    if (key === undefined) return
    const entry = entryFor(key)
    if (!entry.completed || entry.members.size === 0) return
    entry.collapsed = !entry.collapsed
    notify(entry)
  }, [key])

  return {
    collapsed,
    completed,
    boundary: (options.boundaryId !== undefined && boundaryId === options.boundaryId)
      || (options.memberId !== undefined && boundaryId === options.memberId),
    controls,
    hasMembers,
    label,
    toggle,
  }
}
