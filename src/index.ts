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
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { CodexAuthService, codexAuthModels } from './auth-service.ts'
import { startCodexIpv6CallbackBridge } from './callback-bridge.ts'
import { CODEX_PROVIDER, CodexCredentialStore } from './credential-store.ts'
import { CodexNetworkManager } from './network.ts'
import { codexDispatchProvider } from './provider.ts'
import { CODEX_AUTH_RPC_CHANNEL, handleCodexAuthRpc } from './rpc.ts'
import { CodexTokenRefresher } from './token-resolver.ts'
import type { CodexNetworkState, CodexProxyMode } from './types.ts'
import { CodexUsageService } from './usage-service.ts'

export { CodexAuthService } from './auth-service.ts'
export type { CodexAuthModels } from './auth-service.ts'
export { CodexTokenRefresher } from './token-resolver.ts'
export type { CodexRefreshSink, CodexTokenRefresherOptions } from './token-resolver.ts'
export { CodexUsageService, parseCodexUsagePayload } from './usage-service.ts'
export type { CodexUsageModels } from './usage-service.ts'
export type * from './types.ts'
export { CODEX_PROVIDER, CodexCredentialStore } from './credential-store.ts'

/** Stable Cordis plugin name. */
export const name = 'llm-openai-codex'
/** Required Host services. Connection is optional so headless profiles still work. */
export const inject = ['llm', 'credentials', 'settings']

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
  ipv6CallbackBridge?: boolean
  proactiveRefresh?: boolean
  proxyMode?: CodexProxyMode
}

const CodexTransportSchema = z.union(['sse', 'websocket', 'websocket-cached', 'auto'])
const CodexProxyModeSchema = z.union(['auto', 'environment', 'off'])
const StreamIdleTimeoutSchema = z.number()
  .min(Number.MIN_VALUE)
  .max(MAX_TIMER_DELAY_MS)
  .default(DEFAULT_STREAM_IDLE_TIMEOUT_MS)

/** Persisted user setting for the next Host startup. */
export interface CodexProviderSettings {
  proxyMode: CodexProxyMode
}

/** Settings namespace written to `$DSH_HOME/settings.yaml`. */
export const CODEX_SETTINGS_NAMESPACE = settingsNamespace('openai-codex')
/** Restart-applied settings schema exposed to Harness configuration surfaces. */
export const CodexProviderSettings: z<CodexProviderSettings> = z.object({
  proxyMode: CodexProxyModeSchema.default('auto'),
})

/** Runtime schema for provider configuration. */
export const Config: z<Config> = z.object({
  credentialRef: z.string().role('credential-ref').default(DEFAULT_CREDENTIAL_REF),
  transport: CodexTransportSchema,
  timeoutMs: z.natural(),
  websocketConnectTimeoutMs: z.natural(),
  streamIdleTimeoutMs: StreamIdleTimeoutSchema,
  retryPolicy: RetryPolicySchema,
  ipv6CallbackBridge: z.boolean().default(true),
  proactiveRefresh: z.boolean().default(true),
  proxyMode: CodexProxyModeSchema.default('auto'),
})

/** Fully resolved provider profile settings. */
export interface ResolvedConfig {
  credentialRef: CredentialRef
  transport?: Transport
  timeoutMs?: number
  websocketConnectTimeoutMs?: number
  streamIdleTimeoutMs: number
  retryPolicy: ResolvedRetryPolicy
  ipv6CallbackBridge: boolean
  proactiveRefresh: boolean
  proxyMode: CodexProxyMode
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
    ipv6CallbackBridge: config.ipv6CallbackBridge ?? true,
    proactiveRefresh: config.proactiveRefresh ?? true,
    proxyMode: config.proxyMode ?? 'auto',
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
  const networkSettings = ctx.settings.register(
    CODEX_SETTINGS_NAMESPACE,
    CodexProviderSettings,
    { base: { proxyMode: resolved.proxyMode }, applies: 'restart' },
  )
  const activeProxyMode = networkSettings.get().proxyMode
  const network = new CodexNetworkManager(activeProxyMode)
  const networkSnapshot = (): CodexNetworkState => {
    const configuredProxyMode = networkSettings.get().proxyMode
    return {
      ...network.status(),
      activeProxyMode,
      configuredProxyMode,
      restartRequired: configuredProxyMode !== activeProxyMode,
    }
  }
  const networkState = networkSnapshot()
  if (networkState.issue !== undefined) {
    ctx.logger('dsh-codex-provider').warn(
      `OpenAI Codex proxy auto-detection warning: ${networkState.issue}`,
    )
  }
  ctx.effect(
    () => () => network.dispose(),
    '@jcy2387/dsh-codex-provider-plugin: restore network dispatcher',
  )
  const credentials = new CodexCredentialStore(ctx.credentials, resolved.credentialRef)
  const piProvider = openaiCodexProvider()
  assertCodexCatalog(piProvider)
  const piOauth = piProvider.auth.oauth
  if (piOauth === undefined) {
    throw new Error('@jcy2387/dsh-codex-provider-plugin: Codex provider exposes no OAuth handler')
  }

  const authModels = createModels({ credentials })
  authModels.setProvider(piProvider)
  const auth = new CodexAuthService(
    codexAuthModels(authModels),
    credentials,
    () => startCodexIpv6CallbackBridge(
      undefined,
      process.env.PI_OAUTH_CALLBACK_HOST,
      resolved.ipv6CallbackBridge,
    ),
    (error, method) => {
      ctx.logger('dsh-codex-provider').warn(
        new Error(`OpenAI Codex ${method} login failed`, { cause: error }),
      )
    },
  )
  const refresher = new CodexTokenRefresher(authModels, credentials, auth, {
    // The same locked rotation pi-ai performs lazily, driven ahead of expiry.
    refresh: credential => piOauth.refresh(credential),
    proactive: resolved.proactiveRefresh,
    onRefreshFailure: (error) => {
      ctx.logger('dsh-codex-provider').warn(
        new Error('OpenAI Codex token refresh failed', { cause: error }),
      )
    },
  })
  auth.setStateListener(state => refresher.observe(state))

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
    resolveApiKey: async () => (await refresher.getAuth(CODEX_PROVIDER))?.auth.apiKey,
    resolveAttachments: (): AttachmentStore | undefined => ctx.get('attachments'),
  })
  ctx.llm.registerAdapter([CODEX_PROVIDER], adapter)

  const usage = new CodexUsageService(refresher, credentials)
  const rpcService = {
    status: () => auth.status(),
    network: async () => networkSnapshot(),
    setProxyMode: async (mode: CodexProxyMode) => {
      await networkSettings.update({ proxyMode: mode })
      return networkSnapshot()
    },
    usage: async () => {
      try {
        return await usage.load()
      } catch (error) {
        ctx.logger('dsh-codex-provider').warn(new Error('OpenAI Codex usage lookup failed', { cause: error }))
        throw error
      }
    },
    login: (method: Parameters<CodexAuthService['login']>[0]) => auth.login(method),
    cancel: () => auth.cancel(),
    logout: () => auth.logout(),
  }
  ctx.effect(() => () => auth.dispose(), '@jcy2387/dsh-codex-provider-plugin: drain OAuth')
  ctx.effect(
    () => () => { refresher.dispose() },
    '@jcy2387/dsh-codex-provider-plugin: drain token refresher',
  )
  // Arm proactive refresh from a credential stored before this Host started.
  void refresher.start()
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(
      () => connectionCtx.connection.rpc.handle(
        CODEX_AUTH_RPC_CHANNEL,
        (_endpoint, _payload) => handleCodexAuthRpc(rpcService, _endpoint, _payload),
        { authority: 'loopback' },
      ),
      '@jcy2387/dsh-codex-provider-plugin: account RPC',
    )
  })
}
