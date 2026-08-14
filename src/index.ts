/**
 * OpenAI Codex as an installable DeepSeek Harness LLM provider.
 * The Host half owns OAuth and provider registration; the browser half is
 * published from `./client` and discovered through the `dsh.client` manifest.
 */

import { createModels } from '@earendil-works/pi-ai'
import type { Provider, Transport } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-connection'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { CodexAuthService, codexAuthModels } from './auth-service.ts'
import { CODEX_PROVIDER, CodexCredentialStore } from './credential-store.ts'
import { codexDispatchProvider } from './provider.ts'
import { CODEX_AUTH_RPC_CHANNEL, handleCodexAuthRpc } from './rpc.ts'

export { CodexAuthService } from './auth-service.ts'
export type { CodexAuthModels } from './auth-service.ts'
export type * from './types.ts'
export { CODEX_PROVIDER, CodexCredentialStore } from './credential-store.ts'

/** Stable Cordis plugin name. */
export const name = 'llm-openai-codex'
/** Required Host services. Connection is optional so headless profiles still work. */
export const inject = ['llm', 'credentials']

/** Default Harness credential reference holding serialized Codex OAuth state. */
export const DEFAULT_CREDENTIAL_REF = 'OPENAI_CODEX_OAUTH'
/** Default maximum idle interval while reading one Codex response stream. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** User-configurable provider settings. */
export interface Config {
  credentialRef?: string
  transport?: Transport
  timeoutMs?: number
  websocketConnectTimeoutMs?: number
  streamIdleTimeoutMs?: number
  retryPolicy?: RetryPolicyConfig
}

const CodexTransportSchema = z.union(['sse', 'websocket', 'websocket-cached', 'auto'])
const StreamIdleTimeoutSchema = z.number()
  .min(Number.MIN_VALUE)
  .max(MAX_TIMER_DELAY_MS)
  .default(DEFAULT_STREAM_IDLE_TIMEOUT_MS)

/** Runtime schema for provider configuration. */
export const Config: z<Config> = z.object({
  credentialRef: z.string().role('credential-ref').default(DEFAULT_CREDENTIAL_REF),
  transport: CodexTransportSchema,
  timeoutMs: z.natural(),
  websocketConnectTimeoutMs: z.natural(),
  streamIdleTimeoutMs: StreamIdleTimeoutSchema,
  retryPolicy: RetryPolicySchema,
})

/** Fully resolved provider profile settings. */
export interface ResolvedConfig {
  credentialRef: CredentialRef
  transport?: Transport
  timeoutMs?: number
  websocketConnectTimeoutMs?: number
  streamIdleTimeoutMs: number
  retryPolicy: ResolvedRetryPolicy
}

/** Resolve defaults and timer bounds before registering the route. */
export function resolveConfig(config: Config): ResolvedConfig {
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `@jcy2387/dsh-codex-provider-plugin: streamIdleTimeoutMs must be positive and no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  return {
    credentialRef: credentialRef(config.credentialRef ?? DEFAULT_CREDENTIAL_REF),
    ...config.transport === undefined ? {} : { transport: config.transport },
    ...config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs },
    ...config.websocketConnectTimeoutMs === undefined
      ? {}
      : { websocketConnectTimeoutMs: config.websocketConnectTimeoutMs },
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, '@jcy2387/dsh-codex-provider-plugin: retryPolicy'),
  }
}

/** Reject a catalog that cannot drive Harness context budgeting and compaction. */
export function assertCodexCatalog(provider: Provider): void {
  const models = provider.getModels()
  if (models.length === 0) throw new Error('Codex model catalog is empty')
  for (const model of models) {
    if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0) {
      throw new Error(`Codex model ${JSON.stringify(model.id)} has no positive contextWindow`)
    }
    if (!Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0) {
      throw new Error(`Codex model ${JSON.stringify(model.id)} has no positive maxTokens`)
    }
  }
}

/** Register the provider, OAuth lifecycle, and optional loopback-only Web RPC. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const credentials = new CodexCredentialStore(ctx.credentials, resolved.credentialRef)
  const piProvider = openaiCodexProvider()
  assertCodexCatalog(piProvider)

  const authModels = createModels({ credentials })
  authModels.setProvider(piProvider)
  const profile: ResolvedPiAiProviderProfile = {
    provider: CODEX_PROVIDER,
    displayName: piProvider.name,
    piProvider: codexDispatchProvider(piProvider),
    configuredMaxTokens: new Map(),
    streamIdleTimeoutMs: resolved.streamIdleTimeoutMs,
    retryPolicy: resolved.retryPolicy,
    ...resolved.transport === undefined ? {} : { transport: resolved.transport },
    ...resolved.timeoutMs === undefined ? {} : { timeoutMs: resolved.timeoutMs },
    ...resolved.websocketConnectTimeoutMs === undefined
      ? {}
      : { websocketConnectTimeoutMs: resolved.websocketConnectTimeoutMs },
  }
  const profiles = new Map([[CODEX_PROVIDER, profile]])
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => (await authModels.getAuth(CODEX_PROVIDER))?.auth.apiKey,
    resolveAttachments: (): AttachmentStore | undefined => ctx.get('attachments'),
  })
  ctx.llm.registerAdapter([CODEX_PROVIDER], adapter)

  const auth = new CodexAuthService(codexAuthModels(authModels), credentials)
  ctx.effect(() => () => auth.dispose(), '@jcy2387/dsh-codex-provider-plugin: drain OAuth')
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(
      () => connectionCtx.connection.rpc.handle(
        CODEX_AUTH_RPC_CHANNEL,
        (_endpoint, _payload) => handleCodexAuthRpc(auth, _endpoint, _payload),
        { authority: 'loopback' },
      ),
      '@jcy2387/dsh-codex-provider-plugin: authentication RPC',
    )
  })
}
