/** Browser adapter for the Host-owned conversation-ui settings RPC. */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import {
  CONVERSATION_SETTINGS_RPC,
  CONVERSATION_SETTINGS_RPC_CHANNEL,
  type ConversationSettingsView,
  type ConversationUpgradeView,
} from '../settings-api.ts'

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function settingsView(value: unknown): ConversationSettingsView {
  const data = record(value)
  if (data === undefined
    || typeof data.version !== 'string'
    || !['npm', 'development', 'unmanaged'].includes(data.installation as string)
    || typeof data.writable !== 'boolean'
    || typeof data.thinkAutoExpand !== 'boolean'
    || typeof data.canUpgrade !== 'boolean') {
    throw new Error('dsh-conversation-ui: malformed settings response')
  }
  return data as unknown as ConversationSettingsView
}

function upgradeView(value: unknown): ConversationUpgradeView {
  const data = record(value)
  if (data?.restartRequired !== true) throw new Error('dsh-conversation-ui: malformed update response')
  return { restartRequired: true }
}

function accepted(result: Awaited<ReturnType<ConnectionHandle['rpc']['call']>>): unknown {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Narrow client contract consumed by the staged settings-card controller. */
export interface ConversationSettingsApi {
  read(): Promise<ConversationSettingsView>
  write(thinkAutoExpand: boolean): Promise<ConversationSettingsView>
  upgrade(): Promise<ConversationUpgradeView>
}

/** Build the typed facade over the generic Connection RPC service. */
export function createConversationSettingsApi(connection: ConnectionHandle): ConversationSettingsApi {
  return {
    async read(): Promise<ConversationSettingsView> {
      return settingsView(accepted(await connection.rpc.call(CONVERSATION_SETTINGS_RPC_CHANNEL, CONVERSATION_SETTINGS_RPC.read, {})))
    },
    async write(thinkAutoExpand: boolean): Promise<ConversationSettingsView> {
      return settingsView(accepted(await connection.rpc.call(
        CONVERSATION_SETTINGS_RPC_CHANNEL,
        CONVERSATION_SETTINGS_RPC.write,
        { thinkAutoExpand },
      )))
    },
    async upgrade(): Promise<ConversationUpgradeView> {
      return upgradeView(accepted(await connection.rpc.call(CONVERSATION_SETTINGS_RPC_CHANNEL, CONVERSATION_SETTINGS_RPC.upgrade, {})))
    },
  }
}
