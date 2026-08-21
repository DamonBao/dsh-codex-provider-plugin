import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-client-runtime/client'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'

export const DELIVERABLES_DATA_KEY = 'dsh-conversation-ui-deliverables' as const

export interface DeliverableEntry {
  readonly path: string
  readonly seq: number
  readonly added: number
  readonly removed: number
  readonly kind: 'file' | 'website'
}

export interface ConversationDeliverablesData {
  readonly entries: readonly DeliverableEntry[]
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface ConversationTurnDataMap {
    'dsh-conversation-ui-deliverables': ConversationDeliverablesData
  }
}

interface CallRecord {
  readonly name: string
  readonly argsRaw: string | undefined
  readonly view: unknown
}

interface DeliverablesState extends ConversationDeliverablesData {
  readonly turn: number
  readonly calls: ReadonlyMap<string, CallRecord>
}

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' ? value as UnknownRecord : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function diffLines(value: unknown): number {
  const text = stringValue(value)
  if (text === undefined) return 0
  const body = text.endsWith('\n')
    ? text.slice(0, -1)
    : text.endsWith('\\n') ? text.slice(0, -2) : text
  return body === '' ? 0 : body.split(/\r?\n|\\n/).length
}

function jsonArgs(argsRaw: string | undefined): UnknownRecord {
  if (argsRaw === undefined) return {}
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    return record(parsed) ?? {}
  } catch {
    return {}
  }
}

function viewEntries(view: unknown): readonly Omit<DeliverableEntry, 'seq'>[] {
  const object = record(view)
  if (object === undefined) return []
  const card = object.card
  const locations = Array.isArray(object.locations) ? object.locations : []
  const locationPaths = locations.flatMap(location => {
    const path = stringValue(record(location)?.path)
    return path === undefined ? [] : [path]
  })
  if (card === 'diff') {
    const diffs = Array.isArray(object.diffs) ? object.diffs : []
    if (diffs.length === 0) return locationPaths.map(path => ({ path, added: 0, removed: 0, kind: 'file' as const }))
    return diffs.flatMap(diff => {
      const item = record(diff)
      const path = stringValue(item?.path)
      if (path === undefined) return []
      return [{
        path,
        added: diffLines(item?.newText),
        removed: diffLines(item?.oldText),
        kind: 'file' as const,
      }]
    })
  }
  if (card === 'generic' && object.kind === 'edit') {
    return locationPaths.map(path => ({ path, added: 0, removed: 0, kind: 'file' as const }))
  }
  const url = stringValue(object.url) ?? stringValue(object.href)
  return url === undefined || !/^https?:\/\//i.test(url)
    ? []
    : [{ path: url, added: 0, removed: 0, kind: 'website' as const }]
}

function mutationPath(name: string, argsRaw: string | undefined): string | undefined {
  const args = jsonArgs(argsRaw)
  const path = stringValue(args.file_path) ?? stringValue(args.path) ?? stringValue(args.filename)
  if (path === undefined || /^https?:\/\//i.test(path)) return undefined
  const tokens = name.toLowerCase().split(/[^a-z\d]+/).filter(Boolean)
  return tokens.some(token => ['edit', 'write', 'patch', 'replace', 'create', 'insert', 'append'].includes(token))
    ? path
    : undefined
}

function websiteTool(name: string): boolean {
  const tokens = name.toLowerCase().split(/[^a-z\d]+/).filter(Boolean)
  return tokens.some(token => ['deploy', 'publish', 'preview', 'website', 'site', 'artifact'].includes(token))
}

function resultWebsiteEntries(name: string, value: unknown): readonly Omit<DeliverableEntry, 'seq'>[] {
  if (!websiteTool(name)) return []
  let text = ''
  try {
    text = JSON.stringify(value) ?? ''
  } catch {
    return []
  }
  const urls = text.match(/https?:\/\/[^\s"'<>\\]+/gi) ?? []
  return [...new Set(urls.map(url => url.replace(/[),.;]+$/g, '')))].map(path => ({
    path,
    added: 0,
    removed: 0,
    kind: 'website' as const,
  }))
}

function websiteUrl(name: string, argsRaw: string | undefined): string | undefined {
  const args = jsonArgs(argsRaw)
  const candidate = stringValue(args.url)
    ?? stringValue(args.href)
    ?? stringValue(args.preview_url)
    ?? stringValue(args.website_url)
  if (candidate === undefined || !/^https?:\/\//i.test(candidate)) return undefined
  const tokens = name.toLowerCase().split(/[^a-z\d]+/).filter(Boolean)
  return tokens.some(token => ['deploy', 'publish', 'preview', 'website', 'site', 'artifact'].includes(token))
    ? candidate
    : undefined
}

function appendEntries(
  current: readonly DeliverableEntry[],
  next: readonly Omit<DeliverableEntry, 'seq'>[],
  seq: number,
): readonly DeliverableEntry[] {
  const entries = [...current]
  for (const candidate of next) {
    const existing = entries.findIndex(entry => entry.path === candidate.path && entry.kind === candidate.kind)
    if (existing === -1) {
      entries.push({ ...candidate, seq })
      continue
    }
    const previous = entries[existing]
    if (previous === undefined) continue
    entries[existing] = {
      ...previous,
      seq,
      added: previous.added + candidate.added,
      removed: previous.removed + candidate.removed,
    }
  }
  return entries
}

function entriesForCall(call: CallRecord): readonly Omit<DeliverableEntry, 'seq'>[] {
  const fromView = viewEntries(call.view)
  if (fromView.length > 0) return fromView
  const path = mutationPath(call.name, call.argsRaw)
  if (path !== undefined) {
    const args = jsonArgs(call.argsRaw)
    return [{
      path,
      added: diffLines(args.new_string ?? args.new_text ?? args.content),
      removed: diffLines(args.old_string ?? args.old_text),
      kind: 'file',
    }]
  }
  const url = websiteUrl(call.name, call.argsRaw)
  return url === undefined ? [] : [{ path: url, added: 0, removed: 0, kind: 'website' }]
}

/** Conversation data used by the Codex-style delivery card. */
export const deliverablesDefinition: ConversationNodeDefinition<DeliverablesState> = {
  kind: DELIVERABLES_DATA_KEY,
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/call') return { id: String(event.data.turn), role: 'update' }
    if (event.type === 'tool/result' && isAppendSurfaceEvent(event)) {
      return { id: String(event.data.turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('deliverables start requires turn/start')
    return { turn: match.event.data.turn, calls: new Map(), entries: [] }
  },
  update: (context, match) => {
    if (match.event.type === 'tool/call') {
      const calls = new Map(context.state.calls)
      const view = match.view?.for === 'call' ? match.view.view : null
      const name = stringValue(match.event.data.name) ?? ''
      const argsRaw = stringValue(match.event.data.arguments)
      calls.set(String(match.event.data.callId), { name, argsRaw, view })
      return { ...context.state, calls }
    }
    if (match.event.type !== 'tool/result') return context.state
    if (match.event.data.message.content[0]?.isError === true) return context.state
    const callId = String(match.event.data.message.source.callId)
    const call = context.state.calls.get(callId)
    if (call === undefined) return context.state
    const resultView = match.view?.for === 'result' ? match.view.view : call.view
    const fromView = viewEntries(resultView)
    const fromCall = fromView.length > 0 ? fromView : entriesForCall({ ...call, view: resultView })
    const fromResult = resultWebsiteEntries(call.name, match.event.data.message)
    const entries = appendEntries(context.state.entries, [...fromCall, ...fromResult], match.event.seq)
    const unchanged = entries.length === context.state.entries.length
      && entries.every((entry, index) => {
        const previous = context.state.entries[index]
        return previous?.path === entry.path
          && previous.seq === entry.seq
          && previous.added === entry.added
          && previous.removed === entry.removed
          && previous.kind === entry.kind
      })
    return unchanged ? context.state : { ...context.state, entries }
  },
  buildLocationData: (context, scope) => scope !== 'turn' || context.state === undefined || context.state.entries.length === 0
    ? null
    : {
      kind: 'turn',
      turn: context.state.turn,
      key: DELIVERABLES_DATA_KEY,
      value: { entries: context.state.entries },
    },
}

function nativeProducedEntries(owner: TurnTailOwnerProps): readonly DeliverableEntry[] {
  const data = (owner.turn.data as unknown as { get(key: string): unknown }).get('deliverables')
  const produced = record(data)?.produced
  if (!Array.isArray(produced)) return []
  const entries: DeliverableEntry[] = []
  for (const item of produced) {
    const value = record(item)
    const path = stringValue(value?.path)
    const seq = typeof value?.seq === 'number' ? value.seq : Number.POSITIVE_INFINITY
    if (path === undefined || seq > owner.seq || entries.some(entry => entry.path === path)) continue
    entries.push({ path, seq, added: 0, removed: 0, kind: 'file' })
  }
  return entries
}

/** Select entries that were delivered before the closing assistant message. */
export function selectDeliverables(owner: TurnTailOwnerProps): readonly DeliverableEntry[] | null {
  const value = owner.turn.data.get(DELIVERABLES_DATA_KEY)
  if (value !== undefined) {
    const entries = value.entries.filter(entry => entry.seq <= owner.seq)
    return entries.length === 0 ? null : entries
  }
  const nativeEntries = nativeProducedEntries(owner)
  return nativeEntries.length === 0 ? null : nativeEntries
}
