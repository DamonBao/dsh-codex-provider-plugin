import { createElement, useCallback, useLayoutEffect, useRef, useState, type ComponentType, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { FiTool } from 'react-icons/fi'
import {
  IconAgentPresetOutline16,
  IconApiOutline14,
  IconBrowseOutline16,
  IconChecklistOutline14,
  IconCordisPluginOutline14,
  IconDataOutline16,
  IconEditOutline16,
  IconGlobeOutline14,
  IconQuestionOutline14,
  IconSearchOutline16,
  IconSettingsOutline16,
  IconSkillOutline16,
  StateDot,
  type IconProps,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { FollowHost } from './FollowHost.tsx'
import { ToolActivityGroupHeader, ToolActivityGroupMember, toolActivityGroupId, type ToolActivityGroupInfo } from './ToolActivityGroup.tsx'
import { TurnProcessMember } from './TurnProcessMember.tsx'
import { turnProcessMemberId, type TurnFoldAddress } from './turnProcessFold.ts'
import { formatTurnProcessed, type TurnElapsedTranslator } from './turnElapsed.ts'
import css from './TypewriterAssistantNodeView.module.css'

/** Props forwarded through a follow wrap; extra kit seats pass through. */
export type FollowWrapProps = {
  node?: unknown
  renderSlot?: unknown
} & Record<string, unknown>

interface FollowMotionConfig {
  readonly minSpeedPxPerSec?: number | undefined
  readonly maxSpeedPxPerSec?: number | undefined
}

export type ToolSemanticKind =
  | 'search'
  | 'read'
  | 'edit'
  | 'terminal'
  | 'data'
  | 'web'
  | 'code'
  | 'skill'
  | 'agent'
  | 'plugin'
  | 'question'
  | 'settings'
  | 'checklist'
  | 'other'

const TOOL_ICONS: Record<ToolSemanticKind, ComponentType<IconProps>> = {
  search: IconSearchOutline16,
  read: IconBrowseOutline16,
  edit: IconEditOutline16,
  terminal: IconApiOutline14,
  data: IconDataOutline16,
  web: IconGlobeOutline14,
  code: FiTool as ComponentType<IconProps>,
  skill: IconSkillOutline16,
  agent: IconAgentPresetOutline16,
  plugin: IconCordisPluginOutline14,
  question: IconQuestionOutline14,
  settings: IconSettingsOutline16,
  checklist: IconChecklistOutline14,
  other: FiTool as ComponentType<IconProps>,
}

const CONVERSATION_NODE_ICONS: Readonly<Partial<Record<string, ComponentType<IconProps>>>> = {
  context: IconBrowseOutline16,
}

function toolTokens(toolName: string): readonly string[] {
  return toolName
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(Boolean)
}

/**
 * Map a wire Tool name onto the closest Harness icon family. Custom plugins
 * do not have to register UI code: descriptive names such as
 * `smops_knowledge_search` still receive a meaningful search glyph.
 */
export function semanticToolKind(toolName: string): ToolSemanticKind {
  const tokens = toolTokens(toolName)
  const has = (...terms: readonly string[]) => terms.some(term => tokens.includes(term))

  // Domain nouns outrank generic action verbs: `load_skill` is a Skill action,
  // and `create_subagent` is an Agent action—not a file read/edit operation.
  if (has('skill', 'skills')) return 'skill'
  if (has('agent', 'subagent', 'delegate')) return 'agent'
  if (has('cordis', 'plugin', 'plugins')) return 'plugin'
  if (has('question', 'ask', 'clarify', 'input')) return 'question'
  if (has('scope', 'config', 'settings', 'setting')) return 'settings'
  if (has('database', 'db', 'sql', 'schema', 'table', 'record', 'records', 'dataset', 'memory')) return 'data'
  if (has('plan', 'todo', 'task', 'checklist', 'goal')) return 'checklist'
  if (has('edit', 'write', 'patch', 'replace', 'create', 'delete', 'remove', 'move', 'copy')) return 'edit'
  if (has('bash', 'shell', 'terminal', 'exec', 'command', 'cmd', 'powershell', 'pwsh')) return 'terminal'
  if (has('web', 'browser', 'url', 'http', 'https', 'crawl', 'scrape')) return 'web'
  if (has('read', 'load', 'open', 'file', 'files')) return 'read'
  if (has('search', 'find', 'grep', 'glob', 'query', 'lookup', 'knowledge', 'retrieve', 'index', 'log', 'logs', 'trace')) return 'search'
  if (has('code', 'codegraph', 'graph', 'python', 'javascript', 'typescript', 'node', 'program')) return 'code'
  return 'other'
}

type ToolPresentation = {
  readonly name: string
  readonly semantic: ToolSemanticKind
  readonly state: 'error' | 'stopped' | null
}

function toolPresentation(node: unknown): ToolPresentation | null {
  if (node === null || typeof node !== 'object' || !('data' in node)) return null
  const data = (node as { data: unknown }).data
  if (data === null || typeof data !== 'object' || !('root' in data)) return null
  const root = (data as { root: unknown }).root
  if (root === null || typeof root !== 'object') return null

  const name = 'name' in root && typeof (root as { name: unknown }).name === 'string'
    ? (root as { name: string }).name
    : 'call' in root
      && (root as { call: unknown }).call !== null
      && typeof (root as { call: unknown }).call === 'object'
      && 'name' in ((root as { call: object }).call)
      && typeof ((root as { call: { name: unknown } }).call.name) === 'string'
        ? (root as { call: { name: string } }).call.name
        : ''
  if (name === '') return null

  const isError = ('isError' in root && (root as { isError: unknown }).isError === true)
    || ('error' in root && (root as { error: unknown }).error !== null && (root as { error: unknown }).error !== undefined)
  const errorCode = 'error' in root
    && (root as { error: unknown }).error !== null
    && typeof (root as { error: unknown }).error === 'object'
    && 'code' in ((root as { error: object }).error)
    && typeof ((root as { error: { code: unknown } }).error.code) === 'string'
      ? (root as { error: { code: string } }).error.code.toLowerCase()
      : ''
  const stopped = /cancel|interrupt|abort|stop/.test(errorCode)
  return {
    name,
    semantic: semanticToolKind(name),
    state: stopped ? 'stopped' : isError ? 'error' : null,
  }
}

function diffLineCount(value: unknown): number {
  if (typeof value !== 'string' || value === '') return 0
  const body = value.endsWith('\n')
    ? value.slice(0, -1)
    : value.endsWith('\\n') ? value.slice(0, -2) : value
  return body === '' ? 0 : body.split(/\r?\n|\\n/).length
}

/**
 * Derive the compact +/- suffix shown beside an edit file path. The native
 * edit card already owns the actual diff body; this only mirrors its counts
 * into the collapsed summary row.
 */
export function editDiffFilePath(node: unknown): string | undefined {
  const presentation = toolPresentation(node)
  if (presentation?.semantic !== 'edit' || presentation.state !== null || node === null || typeof node !== 'object') return undefined
  const data = (node as { data?: unknown }).data
  if (data === null || typeof data !== 'object' || !('root' in data)) return undefined
  const root = (data as { root: unknown }).root
  if (root === null || typeof root !== 'object') return undefined
  const view = 'resultView' in root
    ? (root as { resultView: unknown; callView?: unknown }).resultView ?? (root as { callView?: unknown }).callView
    : 'callView' in root ? (root as { callView: unknown }).callView : undefined
  if (view === null || typeof view !== 'object' || (view as { card?: unknown }).card !== 'diff') return undefined
  const diffs = (view as { diffs?: unknown }).diffs
  if (!Array.isArray(diffs)) return undefined
  const first = diffs.find(diff => diff !== null && typeof diff === 'object' && typeof (diff as { path?: unknown }).path === 'string')
  return first === undefined ? undefined : (first as { path: string }).path
}

export function editDiffStats(node: unknown): string | undefined {
  const presentation = toolPresentation(node)
  if (presentation?.semantic !== 'edit' || presentation.state !== null || node === null || typeof node !== 'object') return undefined
  const data = (node as { data?: unknown }).data
  if (data === null || typeof data !== 'object' || !('root' in data)) return undefined
  const root = (data as { root: unknown }).root
  if (root === null || typeof root !== 'object') return undefined
  const view = 'resultView' in root
    ? (root as { resultView: unknown; callView?: unknown }).resultView ?? (root as { callView?: unknown }).callView
    : 'callView' in root ? (root as { callView: unknown }).callView : undefined
  if (view === null || typeof view !== 'object' || (view as { card?: unknown }).card !== 'diff') return undefined
  const diffs = (view as { diffs?: unknown }).diffs
  if (!Array.isArray(diffs)) return undefined
  let added = 0
  let removed = 0
  for (const diff of diffs) {
    if (diff === null || typeof diff !== 'object') continue
    added += diffLineCount((diff as { newText?: unknown }).newText)
    removed += diffLineCount((diff as { oldText?: unknown }).oldText)
  }
  return added === 0 && removed === 0 ? undefined : `+${added} -${removed}`
}

const TOOL_GROUP_LABELS: Readonly<Record<ToolSemanticKind, string>> = {
  search: '搜索',
  read: '读取了文件',
  edit: '编辑了文件',
  terminal: '运行了命令',
  data: '查询了数据',
  web: '浏览了网页',
  code: '运行了代码',
  skill: '使用了技能',
  agent: '调用了智能体',
  plugin: '调用了插件',
  question: '发起了提问',
  settings: '更新了设置',
  checklist: '更新了清单',
  other: '执行了操作',
}

const NATIVE_GROUP_LABELS: Readonly<Record<string, string>> = {
  context: '注入了 Prompt',
}

function visibleNode(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return false
  return !('visibility' in node) || (node as { visibility: unknown }).visibility === 'visible'
}

function sameActivityGroupNode(
  node: unknown,
  nodeKind: string,
  turn: number,
  semantic: string,
  requiresTurn: boolean,
): boolean {
  return visibleNode(node)
    && chatNodeKind(node) === nodeKind
    && (!requiresTurn || turnDetailsFromNode(node)?.turn === turn)
    && (nodeKind !== 'tool-call' || toolPresentation(node)?.semantic === semantic)
}

function activityGroup(
  snapshot: unknown,
  currentKey: string,
  sessionId: string,
  turn: number,
  nodeKind: string,
  semantic: string,
  label: string,
  requiresTurn: boolean,
): ToolActivityGroupInfo | undefined {
  if (snapshot === null || typeof snapshot !== 'object' || !('chat' in snapshot)) return undefined
  const chat = (snapshot as { chat: unknown }).chat
  if (chat === null || typeof chat !== 'object' || !('order' in chat) || !('nodes' in chat)) return undefined
  const order = (chat as { order: unknown }).order
  const nodes = (chat as { nodes: unknown }).nodes
  if (!Array.isArray(order) || nodes === null || typeof nodes !== 'object' || !('get' in nodes)) return undefined
  const get = (nodes as { get: unknown }).get
  if (typeof get !== 'function') return undefined
  const currentIndex = order.indexOf(currentKey)
  if (currentIndex === -1) return undefined
  const read = (index: number): unknown => {
    const key = order[index]
    return typeof key === 'string' ? get.call(nodes, key) : undefined
  }
  const same = (node: unknown) => sameActivityGroupNode(node, nodeKind, turn, semantic, requiresTurn)
  if (!same(read(currentIndex))) return undefined
  let first = currentIndex
  let last = currentIndex
  while (first > 0 && same(read(first - 1))) first -= 1
  while (last + 1 < order.length && same(read(last + 1))) last += 1
  const count = last - first + 1
  if (count < 2) return undefined
  const firstKey = order[first]
  if (typeof firstKey !== 'string') return undefined
  let hasGrowing = false
  for (let index = first; index <= last; index += 1) {
    if (isGrowingChatNode(read(index))) {
      hasGrowing = true
      break
    }
  }
  const groupId = toolActivityGroupId(sessionId, turn, semantic, firstKey)
  return {
    id: groupId,
    domId: `${groupId}-frame`,
    semantic,
    label,
    count,
    position: currentIndex === first ? 'start' : currentIndex === last ? 'end' : 'middle',
    hasGrowing,
  }
}

/** Find one contiguous same-kind Tool run inside a Turn. */
export function toolActivityGroup(
  snapshot: unknown,
  currentKey: string,
  sessionId: string,
  turn: number,
  semantic: ToolSemanticKind,
): ToolActivityGroupInfo | undefined {
  return activityGroup(
    snapshot,
    currentKey,
    sessionId,
    turn,
    'tool-call',
    semantic,
    TOOL_GROUP_LABELS[semantic],
    true,
  )
}

/** Find one contiguous run of a native Stream activity such as Prompt context. */
export function nativeActivityGroup(
  snapshot: unknown,
  currentKey: string,
  sessionId: string,
  turn: number,
  kind: string,
): ToolActivityGroupInfo | undefined {
  const label = NATIVE_GROUP_LABELS[kind]
  return label === undefined ? undefined : activityGroup(
    snapshot,
    currentKey,
    sessionId,
    turn,
    kind,
    kind,
    label,
    false,
  )
}

function ToolSemanticIcon({
  presentation,
  className = css.toolSemanticIcon,
}: {
  readonly presentation: ToolPresentation
  readonly className?: string | undefined
}) {
  const Icon = TOOL_ICONS[presentation.semantic]
  const glyph = presentation.semantic === 'code' || presentation.semantic === 'other'
    ? 'wrench'
    : presentation.semantic
  return (
    <span
      className={className}
      data-tool-semantic-icon={presentation.semantic}
      data-tool-glyph={glyph}
      aria-hidden
    >
      {presentation.state === 'error'
        ? <StateDot state="error" />
        : presentation.state === 'stopped'
          ? <StateDot state="warning" />
          : <Icon size={14} />}
    </span>
  )
}

interface NestedToolIconTarget {
  readonly key: string
  readonly target: HTMLElement
  readonly presentation: ToolPresentation
}

function sameNestedToolIconTargets(
  current: readonly NestedToolIconTarget[],
  next: readonly NestedToolIconTarget[],
): boolean {
  return current.length === next.length && current.every((item, index) => {
    const candidate = next[index]
    return candidate !== undefined
      && item.key === candidate.key
      && item.target === candidate.target
      && item.presentation.name === candidate.presentation.name
      && item.presentation.semantic === candidate.presentation.semantic
      && item.presentation.state === candidate.presentation.state
  })
}

/** Find expandable nested Tool headers rendered by the Harness Tool tree. */
export function nestedToolIconTargets(root: HTMLElement): NestedToolIconTarget[] {
  const targets: NestedToolIconTarget[] = []
  const callRows = root.querySelectorAll<HTMLElement>('[data-subcalls] [data-chat-call-id]')
  callRows.forEach((callRow, index) => {
    const slot = Array.from(callRow.children).find(child => (
      child instanceof HTMLElement && child.matches('[data-slot="tool.call.toolview"]')
    )) as HTMLElement | undefined
    if (slot === undefined) return

    const toolRoot = slot.querySelector<HTMLElement>(':scope > [data-tool]')
    const bashRoot = slot.querySelector<HTMLElement>(':scope > * > [data-sample="bash"]')
    const target = toolRoot?.querySelector<HTMLElement>(
      ':scope > * > [data-disclosure-row][aria-expanded]',
    ) ?? (bashRoot?.matches('[aria-expanded]') === true ? bashRoot : null)
    if (target === null) return

    const name = toolRoot?.getAttribute('data-tool') ?? 'bash'
    const stateName = toolRoot?.getAttribute('data-state') ?? bashRoot?.getAttribute('data-state')
    const state = stateName === 'error'
      ? 'error'
      : stateName === 'stopped' ? 'stopped' : null
    targets.push({
      key: callRow.getAttribute('data-chat-call-id') ?? `${name}-${index}`,
      target,
      presentation: { name, semantic: semanticToolKind(name), state },
    })
  })
  return targets
}

/**
 * Nested DisclosureRows replace their leading icon with a chevron when open.
 * A portal owned by this plugin keeps a semantic icon mounted in each header
 * across that internal state change while Harness continues to own the body.
 */
function NestedToolSemanticIcons({
  owner,
  revision,
}: {
  readonly owner: HTMLDivElement | null
  readonly revision: unknown
}) {
  const [targets, setTargets] = useState<readonly NestedToolIconTarget[]>([])
  useLayoutEffect(() => {
    const next = owner === null ? [] : nestedToolIconTargets(owner)
    setTargets(current => sameNestedToolIconTargets(current, next) ? current : next)
  }, [owner, revision])

  return targets.map(({ key, target, presentation }) => {
    const Icon = TOOL_ICONS[presentation.semantic]
    return createPortal(
      <span
        className={css.nestedToolSemanticIcon}
        data-stream-nested-tool-icon={presentation.semantic}
        aria-hidden
      >
        {presentation.state === 'error'
          ? <StateDot state="error" />
          : presentation.state === 'stopped'
            ? <StateDot state="warning" />
            : <Icon size={14} />}
      </span>,
      target,
      key,
    )
  })
}

function ConversationNodeSemanticIcon({
  kind,
  className = css.streamSemanticIcon,
}: {
  readonly kind: string
  readonly className?: string | undefined
}) {
  const Icon = CONVERSATION_NODE_ICONS[kind]
  if (Icon === undefined) return null
  return (
    <span
      className={className}
      data-stream-semantic-icon={kind}
      aria-hidden
    >
      <Icon size={14} />
    </span>
  )
}

function chatNodeKind(node: unknown): string {
  if (node === null || typeof node !== 'object' || !('kind' in node)) return 'unknown'
  const kind = (node as { kind: unknown }).kind
  return typeof kind === 'string' ? kind : 'unknown'
}

const KEEP_VISIBLE_KINDS = new Set(['turn-tail', 'turn-error', 'turn-max-tokens'])

interface TurnDetails {
  readonly turn: number
  readonly startTime: number | undefined
}

function turnDetailsFromNode(node: unknown): TurnDetails | undefined {
  if (node === null || typeof node !== 'object' || !('location' in node)) return undefined
  const location = (node as { location: unknown }).location
  if (location === null || typeof location !== 'object' || !('kind' in location)) return undefined
  const kind = (location as { kind: unknown }).kind
  if (kind !== 'turn' && kind !== 'step') return undefined
  const turn = (location as { turn?: unknown }).turn
  if (turn === null || typeof turn !== 'object' || !('turn' in turn)) return undefined
  const turnNumber = (turn as { turn: unknown }).turn
  if (typeof turnNumber !== 'number') return undefined
  const start = 'start' in turn ? (turn as { start: unknown }).start : undefined
  const startTime = start !== null
    && typeof start === 'object'
    && 'time' in start
    && typeof (start as { time: unknown }).time === 'number'
      ? (start as { time: number }).time
      : undefined
  return { turn: turnNumber, startTime }
}

function processAddress(node: unknown, sessionId: unknown): TurnFoldAddress | undefined {
  if (typeof sessionId !== 'string') return undefined
  const details = turnDetailsFromNode(node)
  return details === undefined ? undefined : { sessionId, turn: details.turn }
}

function nodeKey(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object' || !('key' in node)) return undefined
  const key = (node as { key: unknown }).key
  return typeof key === 'string' ? key : undefined
}

function nodeOrder(node: unknown): number {
  if (node === null || typeof node !== 'object' || !('anchorSeq' in node)) return 0
  const anchorSeq = (node as { anchorSeq: unknown }).anchorSeq
  return typeof anchorSeq === 'number' ? anchorSeq : 0
}

function followingTurn(snapshot: unknown, currentKey: string): TurnDetails | undefined {
  if (snapshot === null || typeof snapshot !== 'object' || !('chat' in snapshot)) return undefined
  const chat = (snapshot as { chat: unknown }).chat
  if (chat === null || typeof chat !== 'object' || !('order' in chat) || !('nodes' in chat)) return undefined
  const order = (chat as { order: unknown }).order
  const nodes = (chat as { nodes: unknown }).nodes
  if (!Array.isArray(order) || nodes === null || typeof nodes !== 'object' || !('get' in nodes)) return undefined
  const get = (nodes as { get: unknown }).get
  if (typeof get !== 'function') return undefined
  const start = order.indexOf(currentKey)
  if (start === -1) return undefined
  for (let index = start + 1; index < order.length; index += 1) {
    const key = order[index]
    if (typeof key !== 'string') continue
    const turn = turnDetailsFromNode(get.call(nodes, key))
    if (turn !== undefined) return turn
  }
  return undefined
}

/**
 * Keep the latest settled Tool visibly active while the Agent is still
 * running but has not published its next Chat row yet. A later visible row
 * ends this handoff state; `turn-tail` is presentation metadata rather than
 * the next piece of model/process output.
 */
function isAwaitingNextTurnNode(snapshot: unknown, currentKey: string, turnNumber: number): boolean {
  if (
    snapshot === null
    || typeof snapshot !== 'object'
    || !('running' in snapshot)
    || (snapshot as { running: unknown }).running !== true
    || !('chat' in snapshot)
  ) return false
  const chat = (snapshot as { chat: unknown }).chat
  if (chat === null || typeof chat !== 'object' || !('order' in chat) || !('nodes' in chat)) return false
  const order = (chat as { order: unknown }).order
  const nodes = (chat as { nodes: unknown }).nodes
  if (!Array.isArray(order) || nodes === null || typeof nodes !== 'object' || !('get' in nodes)) return false
  const get = (nodes as { get: unknown }).get
  if (typeof get !== 'function') return false

  if ('timeline' in chat) {
    const timeline = (chat as { timeline: unknown }).timeline
    if (timeline !== null && typeof timeline === 'object' && 'turns' in timeline) {
      const turns = (timeline as { turns: unknown }).turns
      if (turns instanceof Map) {
        const turn = turns.get(turnNumber)
        if (
          turn !== undefined
          && turn !== null
          && typeof turn === 'object'
          && 'status' in turn
          && (turn as { status: unknown }).status !== 'open'
        ) return false
      }
    }
  }

  const currentIndex = order.indexOf(currentKey)
  if (currentIndex === -1) return false
  for (let index = currentIndex + 1; index < order.length; index += 1) {
    const key = order[index]
    if (typeof key !== 'string') continue
    const candidate = get.call(nodes, key)
    if (candidate === null || typeof candidate !== 'object') continue
    if ('visibility' in candidate && (candidate as { visibility: unknown }).visibility !== 'visible') continue
    if ('kind' in candidate && (candidate as { kind: unknown }).kind === 'turn-tail') continue
    return false
  }
  return true
}

/**
 * True while a Chat node is still growing: an assistant/workflow `status:
 * 'running'` payload, a Tool root that has not settled (`kind` absent), or a
 * model-retry whose current attempt is still `scheduled`.
 * @param node - The Chat node's view `node` prop.
 * @returns whether this row should own conversation follow.
 */
export function isGrowingChatNode(node: unknown): boolean {
  if (node === null || typeof node !== 'object' || !('data' in node)) return false
  const data = (node as { data: unknown }).data
  if (data === null || typeof data !== 'object') return false
  if ('status' in data && (data as { status: unknown }).status === 'running') return true
  if ('root' in data) {
    const root = (data as { root: unknown }).root
    if (root !== null && typeof root === 'object' && !('kind' in root)) return true
  }
  if ('current' in data) {
    const current = (data as { current: unknown }).current
    if (
      current !== null
      && typeof current === 'object'
      && 'retryState' in current
      && (current as { retryState: unknown }).retryState === 'scheduled'
    ) return true
  }
  return false
}

/**
 * Wrap a prior Chat node renderer so a growing row shares conversation
 * follow. Presentation stays with the wrapped component; kit seats
 * (`renderSlot`, locale, inject) pass through unchanged.
 * @param Inner - The already-registered row component.
 * @returns A follow-hosted row.
 */
export function wrapFollowNodeView(Inner: ComponentType<FollowWrapProps>, motion: FollowMotionConfig = {}) {
  return function TypewriterFollowNodeView(props: FollowWrapProps) {
    const kind = chatNodeKind(props.node)
    const directAddress = KEEP_VISIBLE_KINDS.has(kind) ? undefined : processAddress(props.node, props.sessionId)
    const key = nodeKey(props.node)
    const useSession = props.useSession
    if (
      directAddress !== undefined
      && kind === 'tool-call'
      && key !== undefined
      && typeof useSession === 'function'
    ) {
      return (
        <TailAwareToolFollowNodeView
          Inner={Inner}
          motion={motion}
          props={props}
          address={directAddress}
          nodeKey={key}
          useSession={useSession as (selector: (snapshot: unknown) => unknown) => unknown}
        />
      )
    }
    if (
      directAddress === undefined
      && !KEEP_VISIBLE_KINDS.has(kind)
      && key !== undefined
      && typeof props.sessionId === 'string'
      && typeof useSession === 'function'
    ) {
      return (
        <InferredTurnFollowNodeView
          Inner={Inner}
          motion={motion}
          props={props}
          nodeKey={key}
          sessionId={props.sessionId}
          useSession={useSession as (selector: (snapshot: unknown) => unknown) => unknown}
        />
      )
    }
    return <FollowNodeView Inner={Inner} motion={motion} props={props} address={directAddress} />
  }
}

function TailAwareToolFollowNodeView({
  Inner,
  motion,
  props,
  address,
  nodeKey: currentKey,
  useSession,
}: {
  readonly Inner: ComponentType<FollowWrapProps>
  readonly motion: FollowMotionConfig
  readonly props: FollowWrapProps
  readonly address: TurnFoldAddress
  readonly nodeKey: string
  readonly useSession: (selector: (snapshot: unknown) => unknown) => unknown
}) {
  const awaitingNext = useSession(snapshot => isAwaitingNextTurnNode(snapshot, currentKey, address.turn)) as boolean
  const presentation = toolPresentation(props.node)
  const group = typeof props.sessionId === 'string' && presentation !== null
    ? useSession(snapshot => toolActivityGroup(
        snapshot,
        currentKey,
        props.sessionId as string,
        address.turn,
        presentation.semantic,
      )) as ToolActivityGroupInfo | undefined
    : undefined
  return (
    <FollowNodeView
      Inner={Inner}
      motion={motion}
      props={props}
      address={address}
      awaitingNext={awaitingNext}
      toolGroup={group}
    />
  )
}

function InferredTurnFollowNodeView({
  Inner,
  motion,
  props,
  nodeKey: currentKey,
  sessionId,
  useSession,
}: {
  readonly Inner: ComponentType<FollowWrapProps>
  readonly motion: FollowMotionConfig
  readonly props: FollowWrapProps
  readonly nodeKey: string
  readonly sessionId: string
  readonly useSession: (selector: (snapshot: unknown) => unknown) => unknown
}) {
  const turn = useSession(snapshot => followingTurn(snapshot, currentKey)) as TurnDetails | undefined
  const address = turn === undefined ? undefined : { sessionId, turn: turn.turn }
  const kind = chatNodeKind(props.node)
  const group = useSession(snapshot => kind === 'context' && turn !== undefined
    ? nativeActivityGroup(snapshot, currentKey, sessionId, turn.turn, kind)
    : undefined) as ToolActivityGroupInfo | undefined
  return (
    <FollowNodeView
      Inner={Inner}
      motion={motion}
      props={props}
      address={address}
      toolGroup={group}
      turnStartTime={turn?.startTime}
    />
  )
}

function FollowNodeView({
  Inner,
  motion,
  props,
  address,
  awaitingNext = false,
  toolGroup,
  turnStartTime = turnDetailsFromNode(props.node)?.startTime,
}: {
  readonly Inner: ComponentType<FollowWrapProps>
  readonly motion: FollowMotionConfig
  readonly props: FollowWrapProps
  readonly address: TurnFoldAddress | undefined
  readonly awaitingNext?: boolean | undefined
  readonly toolGroup?: ToolActivityGroupInfo | undefined
  readonly turnStartTime?: number | undefined
}) {
  const speedCpsRef = useRef(35)
  const [eventElement, setEventElement] = useState<HTMLDivElement | null>(null)
  const eventRef = useCallback((element: HTMLDivElement | null) => {
    setEventElement(element)
  }, [])
  const growing = isGrowingChatNode(props.node)
  const kind = chatNodeKind(props.node)
  const staticCompaction = kind === 'compaction' || kind === 'manual-compaction'
  useLayoutEffect(() => {
    if (!staticCompaction || eventElement === null) return
    const disclosure = eventElement.querySelector<HTMLElement>('[data-compaction-disclosure]')
    const button = disclosure?.closest<HTMLButtonElement>('button')
    if (button === null || button === undefined) return
    const previousDisabled = button.disabled
    const previousExpanded = button.getAttribute('aria-expanded')
    button.disabled = true
    button.removeAttribute('aria-expanded')
    return () => {
      button.disabled = previousDisabled
      if (previousExpanded === null) button.removeAttribute('aria-expanded')
      else button.setAttribute('aria-expanded', previousExpanded)
    }
  }, [eventElement, props.node, staticCompaction])
  const preventCompactionExpand = staticCompaction
    ? (event: MouseEvent<HTMLDivElement>) => {
        event.preventDefault()
        event.stopPropagation()
      }
    : undefined
  const tool = kind === 'tool-call' ? toolPresentation(props.node) : null
  const editStats = tool === null ? undefined : editDiffStats(props.node)
  const [editStatsRow, setEditStatsRow] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const row = editStats === undefined || eventElement === null
      ? null
      : eventElement.querySelector<HTMLElement>('[data-disclosure-row]')
    setEditStatsRow(previous => previous === row ? previous : row)
  }, [editStats, eventElement, props.node])
  const ownsStreamSemanticIcon = tool === null && CONVERSATION_NODE_ICONS[kind] !== undefined
  const toolProgressActive = tool !== null && (growing || awaitingNext)
  const key = nodeKey(props.node)
  const memberId = address === undefined || key === undefined ? undefined : turnProcessMemberId(address, key)
  const translate = typeof props.t === 'function' ? props.t as TurnElapsedTranslator : undefined
  const formatRunningElapsed = translate === undefined
    ? undefined
    : (ms: number) => formatTurnProcessed(ms, translate)
  const inner = (
    <>
      {tool !== null && <ToolSemanticIcon presentation={tool} />}
      {ownsStreamSemanticIcon && <ConversationNodeSemanticIcon kind={kind} />}
      {createElement(Inner, props)}
      {tool !== null && <NestedToolSemanticIcons owner={eventElement} revision={props.node} />}
      {editStats !== undefined && editStatsRow !== null && createPortal(
        <span
          className={css.editStats}
          data-stream-edit-stats=""
          data-stream-edit-file={editDiffFilePath(props.node)}
          onClick={event => {
            event.stopPropagation()
            event.currentTarget.closest<HTMLElement>('[data-disclosure-row][data-expandable]')?.click()
          }}
        >
          {editStats}
        </span>,
        editStatsRow,
      )}
    </>
  )
  const activityRunning = growing || toolGroup?.hasGrowing === true
  const headerIcon = tool !== null
    ? <ToolSemanticIcon presentation={tool} className={css.toolGroupHeaderGlyph} />
    : ownsStreamSemanticIcon
      ? <ConversationNodeSemanticIcon kind={kind} className={css.toolGroupHeaderGlyph} />
      : null
  const eventAttributes = {
    'data-stream-node': kind,
    'data-stream-turn': address === undefined ? undefined : String(address.turn),
    'data-stream-state': activityRunning ? 'running' : 'settled',
    'data-stream-progress': toolProgressActive ? 'active' : undefined,
    'data-stream-tool-row': tool === null ? undefined : '',
    'data-stream-native-disclosure': tool === null ? '' : undefined,
    'data-stream-semantic-icon-owned': ownsStreamSemanticIcon ? kind : undefined,
    'data-tool-semantic': tool?.semantic,
    'data-tool-name': tool?.name,
  }
  const activityHeader = toolGroup !== undefined && headerIcon !== null
    ? <ToolActivityGroupHeader label={toolGroup.label} icon={headerIcon} />
    : null
  return (
    <FollowHost
      active={activityRunning}
      speedCpsRef={speedCpsRef}
      minSpeedPxPerSec={motion.minSpeedPxPerSec}
      maxSpeedPxPerSec={motion.maxSpeedPxPerSec}
    >
      {memberId !== undefined && address !== undefined && toolGroup !== undefined && activityHeader !== null ? (
        <ToolActivityGroupMember
          group={toolGroup}
          address={address}
          memberId={memberId}
          memberOrder={nodeOrder(props.node)}
          turnStartTime={turnStartTime}
          formatRunningElapsed={formatRunningElapsed}
          memberRef={eventRef}
          eventAttributes={eventAttributes}
          header={activityHeader}
        >
          {inner}
        </ToolActivityGroupMember>
      ) : memberId !== undefined && address !== undefined ? (
        <TurnProcessMember
          address={address}
          memberId={memberId}
          memberOrder={nodeOrder(props.node)}
          turnStartTime={turnStartTime}
          formatRunningElapsed={formatRunningElapsed}
          memberRef={eventRef}
          className={css.eventRow}
          onClickCapture={preventCompactionExpand}
          data-stream-node={kind}
          data-stream-turn={address.turn}
          data-stream-state={growing ? 'running' : 'settled'}
          data-stream-progress={toolProgressActive ? 'active' : undefined}
          data-stream-tool-row={tool === null ? undefined : ''}
          data-stream-native-disclosure={tool === null ? '' : undefined}
          data-stream-semantic-icon-owned={ownsStreamSemanticIcon ? kind : undefined}
          data-tool-semantic={tool?.semantic}
          data-tool-name={tool?.name}
        >
          {inner}
        </TurnProcessMember>
      ) : (
        <div
          ref={eventRef}
          className={css.eventRow}
          onClickCapture={preventCompactionExpand}
          data-stream-node={kind}
          data-stream-state={growing ? 'running' : 'settled'}
          data-stream-progress={toolProgressActive ? 'active' : undefined}
          data-stream-tool-row={tool === null ? undefined : ''}
          data-stream-native-disclosure={tool === null ? '' : undefined}
          data-stream-semantic-icon-owned={ownsStreamSemanticIcon ? kind : undefined}
          data-tool-semantic={tool?.semantic}
          data-tool-name={tool?.name}
        >
          {inner}
        </div>
      )}
    </FollowHost>
  )
}
