import { createElement, useSyncExternalStore, type ComponentType } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the connection Context merge and the plugins section's SlotMap
// entry ('settings.plugin.item').
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { TypewriterAssistantNodeView } from './TypewriterAssistantNodeView.tsx'
import { wrapFollowNodeView, type FollowWrapProps } from './TypewriterToolNodeView.tsx'
import { wrapTurnPreludeNodeView } from './TurnPreludeUserNodeView.tsx'
import { ConversationCard } from './ConversationCard.tsx'
import { ConversationCardController } from './conversation-ui-card-controller.ts'
import { DeliverablesCard } from './DeliverablesCard.tsx'
import { deliverablesDefinition, selectDeliverables } from './deliverables.ts'
import { createConversationSettingsApi } from './conversation-ui-settings-api.ts'
import { NS as SETTINGS_NS, en, zh } from './locales.ts'
import { DEFAULT_CONVERSATION_CONFIG, CONVERSATION_BOOT_GLOBAL, type ConversationConfig } from '../config.ts'
import { DEFAULT_CONVERSATION_SETTINGS } from '../settings.ts'

/**
 * Cordis services required by the browser half. Only `slots` is load-bearing
 * for the stream itself; locale and Connection power the configuration card
 * and are wired through `ctx.inject` below so a deployment without them still
 * streams with defaults.
 */
export const inject = ['slots']

type AssistantProps = ChatNodeViewProps<'assistant-step'>

const CONVERSATION_MODES: readonly string[] = ['typewriter', 'teleprompter']
const CONVERSATION_PRESETS: readonly string[] = ['realtime', 'balanced', 'silky']

/** Steering/command rows stay untouched; `assistant-step` is replaced. */
const SKIP_WRAP = new Set(['assistant-step', 'steering', 'command-input'])

/**
 * Read the Host-bridged boot config. The inline script is produced by this
 * plugin's Host half from a schema-validated value, so only the structural
 * guarantees that could break between the two halves are re-checked: the
 * global is absent when the client runs without its Host entry (defaults
 * apply), and any present-but-malformed value fails loudly instead of
 * rendering a half-configured view.
 * @returns The resolved configuration for the assistant node view.
 */
function readBootConfig(): ConversationConfig {
  const raw = (globalThis as Record<string, unknown>)[CONVERSATION_BOOT_GLOBAL]
  if (raw === undefined) {
    console.info('[dsh-conversation-ui] no host config bridge; using defaults')
    return DEFAULT_CONVERSATION_CONFIG
  }
  if (
    typeof raw !== 'object' || raw === null
    || !CONVERSATION_MODES.includes((raw as ConversationConfig).mode)
    || !CONVERSATION_PRESETS.includes((raw as ConversationConfig).preset)
    || typeof (raw as ConversationConfig).revealCharsPerSec !== 'number'
    || typeof (raw as ConversationConfig).scrollSpeedPxPerSec !== 'number'
    || typeof (raw as ConversationConfig).maxScrollSpeedPxPerSec !== 'number'
  ) {
    throw new Error(`[dsh-conversation-ui] malformed ${CONVERSATION_BOOT_GLOBAL} boot global: ${JSON.stringify(raw)}`)
  }
  return raw as ConversationConfig
}

/**
 * Wrap every keyed Chat row except `assistant-step` in place. A second
 * register with the same `children` table throws because the child slot is
 * already declared, and only the winning entry receives `renderSlot`;
 * swapping `entry.component` keeps the original children, locale, and inject
 * seats. `assistant-step` is replaced below so text and Think use the
 * Codex-style Assistant presentation.
 * @param ctx - Browser context carrying the slot registry.
 * @returns Restorer that puts the original components back.
 */
function wrapGrowingChatRows(ctx: ClientContext, config: ConversationConfig): () => void {
  const restores: Array<() => void> = []
  const wrapped = new WeakSet<object>()

  const wrapAll = (): void => {
    for (const entry of ctx.slots.entries('conversation.chat.node')) {
      const key = entry.options.key
      if (key === undefined || SKIP_WRAP.has(key)) continue
      const current = entry.component
      if (
        (typeof current !== 'function' && (typeof current !== 'object' || current === null))
        || wrapped.has(current)
      ) continue
      const inner = current as ComponentType<FollowWrapProps>
      const next = key === 'user'
        ? wrapTurnPreludeNodeView(inner)
        : wrapFollowNodeView(inner, {
            minSpeedPxPerSec: config.scrollSpeedPxPerSec,
            maxSpeedPxPerSec: config.maxScrollSpeedPxPerSec,
          })
      wrapped.add(next)
      entry.component = next
      restores.push(() => {
        if (entry.component === next) entry.component = inner
      })
    }
  }

  wrapAll()
  const off = ctx.on('slots/changed', (key: string) => {
    if (key === 'conversation.chat.node') wrapAll()
  })
  return () => {
    off()
    for (const restore of restores) restore()
  }
}

/**
 * A live preference cell read by `useSyncExternalStore`. It starts on the
 * shared default and, once the plugin-owned settings controller is attached,
 * tracks the resolved `thinkAutoExpand` value. A composition (or test) that
 * ships no settings surface keeps the cell on the default.
 */
class PreferenceCell {
  private readonly listeners = new Set<() => void>()
  private card: ConversationCardController | undefined
  private value = DEFAULT_CONVERSATION_SETTINGS.thinkAutoExpand

  /** Re-point the cell at the plugin-owned settings controller. */
  attach(card: ConversationCardController): () => void {
    this.card = card
    this.refresh()
    const unsubscribe = card.subscribe(() => { this.refresh() })
    return () => {
      unsubscribe()
      if (this.card !== card) return
      this.card = undefined
      this.refresh()
    }
  }

  private read(): boolean {
    return this.card?.getSnapshot().thinkAutoExpand ?? DEFAULT_CONVERSATION_SETTINGS.thinkAutoExpand
  }

  private refresh(): void {
    const next = this.read()
    if (next === this.value) return
    this.value = next
    for (const listener of this.listeners) listener()
  }

  readonly getSnapshot = (): boolean => this.value

  readonly subscribe = (listener: () => void): () => void => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

/**
 * Register the Codex-style renderer after the conversation package declares the
 * keyed Chat node seat. A lower priority shadows the built-in assistant row;
 * every other growing row is wrapped in place so Tool cards, retries, and
 * workflow runs share conversation follow. The Host-bridged configuration
 * selects immediate or typewriter reveal, smoothing preset, and glide speed; the
 * plugin-owned settings RPC supplies the live auto-expand preference when the
 * settings surface is composed.
 * @param ctx - Browser context carrying the shared slot registry.
 */
export function apply(ctx: ClientContext): void {
  const config = readBootConfig()
  const preference = new PreferenceCell()

  // The native deliverables package already publishes successful file paths,
  // so the Codex card must register independently of our optional richer event
  // accumulator. Keeping the slot inside the service injection left Web with
  // only the built-in "产物" chips when that callback was not activated.
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    priority: -100,
    select: selectDeliverables,
    registrant: 'dsh-conversation-ui',
  }, DeliverablesCard))
  ctx.inject(['conversationEvents'], (deliverablesCtx) => {
    const events = deliverablesCtx.get('conversationEvents') as {
      register: (definition: typeof deliverablesDefinition) => () => void
    }
    return events.register(deliverablesDefinition)
  })

  // The card talks to the plugin-owned loopback RPC, so the core settings
  // namespace allowlist cannot make it disappear. The stream still applies
  // with defaults when the optional Settings UI or Connection is absent.
  ctx.inject(['slots', 'locale', 'connection'], (settingsCtx) => {
    const card = new ConversationCardController(
      // The shared Context augmentation also carries the Host-side Connection
      // shape. This browser entry runs after the client provider installs its
      // handle, so narrow through unknown to its client contract here.
      createConversationSettingsApi(settingsCtx.get('connection') as unknown as ConnectionHandle),
    )
    const detachPreference = preference.attach(card)
    card.start()
    settingsCtx.effect(() => settingsCtx.locale.register(SETTINGS_NS, { zh, en }), 'dsh-conversation-ui: settings dictionaries')
    settingsCtx.slots.inject('settings.plugin.item', () => settingsCtx.slots.register({
      name: 'settings.plugin.item',
      key: 'conversation-ui',
      locale: SETTINGS_NS,
      inject: () => card.inject(),
    }, ConversationCard))
    return () => {
      card.stop()
      detachPreference()
    }
  })

  const configured = function ConversationConfiguredView(props: AssistantProps) {
    const thinkAutoExpand = useSyncExternalStore(
      preference.subscribe,
      preference.getSnapshot,
      preference.getSnapshot,
    )
    return createElement(TypewriterAssistantNodeView, {
      ...props,
      mode: config.mode,
      preset: config.preset,
      revealCharsPerSec: config.revealCharsPerSec,
      scrollSpeedPxPerSec: config.scrollSpeedPxPerSec,
      maxScrollSpeedPxPerSec: config.maxScrollSpeedPxPerSec,
      thinkAutoExpand,
    })
  }
  ctx.slots.inject('conversation.chat.node', () => {
    const unwrap = wrapGrowingChatRows(ctx, config)
    const unshadow = ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'assistant-step',
      priority: -100,
      locale: 'conversation',
      registrant: 'dsh-conversation-ui',
    }, configured)
    return () => {
      unshadow()
      unwrap()
    }
  })
}
