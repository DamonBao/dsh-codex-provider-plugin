/** Browser half: native OpenAI Codex account management in Settings. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createCodexAuthRpcClient } from '../rpc-contract.ts'
import { CodexSettingsSection } from './CodexSettingsSection.tsx'
import { CodexAuthCardController } from './controller.ts'
import type { CodexAuthCardFace } from './controller.ts'
import { en, zh, type CodexSettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Codex connection settings copy. */
    'settings.codexProvider': CodexSettingsKey
  }
}

const NS = 'settings.codexProvider'

/** Required browser services. */
export const inject = ['slots', 'locale', 'connection']

/** Register one removable, independently navigable Codex settings page. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), '@jcy2387/dsh-codex-provider-plugin: dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle
  const controller = new CodexAuthCardController(createCodexAuthRpcClient(connection.rpc))
  const face: CodexAuthCardFace = controller.face(connection.isLoopback)
  const t = ctx.locale.bind(NS)

  ctx.on('connection/reset', () => { void controller.load() })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'openai-codex',
    order: 11,
    label: () => t('title'),
    locale: NS,
    inject: (): CodexAuthCardFace => face,
  }, CodexSettingsSection))
}
