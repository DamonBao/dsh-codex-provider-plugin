/** Host-owned OpenAI Codex OAuth lifecycle. */

import type {
  AuthInteraction,
  AuthPrompt,
  Credential,
  CredentialStore,
  Models,
} from '@earendil-works/pi-ai'
import type { CodexCallbackBridge, CodexCallbackBridgeFactory } from './callback-bridge.ts'
import { CODEX_PROVIDER } from './credential-store.ts'
import type { CodexAuthFailureReason, CodexAuthState, CodexLoginMethod } from './types.ts'

const ACCOUNT_ACCESS_MARKERS = [
  'access_denied',
  'accountid',
  'chatgpt_account_id',
  'forbidden',
  'mfa',
  'organization',
  'unauthorized',
  'workspace',
] as const
const CALLBACK_PORT_MARKERS = [
  'cannot listen on 127.0.0.1:',
  'could not listen on [::1]:',
  'eaddrinuse',
] as const
const BROWSER_CALLBACK_MARKERS = [
  'callback',
  'missing authorization code',
  'state mismatch',
  'localhost:1455',
] as const
const NETWORK_MARKERS = [
  'certificate',
  'econnrefused',
  'econnreset',
  'enotfound',
  'etimedout',
  'fetch failed',
  'network',
  'socket',
  'tls',
] as const

/** Bound a browser flow that pi-ai would otherwise wait on indefinitely. */
export const CODEX_BROWSER_CALLBACK_TIMEOUT_MS = 10 * 60_000

class CodexBrowserCallbackTimeoutError extends Error {
  constructor() {
    super('Codex browser callback timed out waiting for authorization')
    this.name = 'CodexBrowserCallbackTimeoutError'
  }
}

function containsAny(message: string, markers: readonly string[]): boolean {
  return markers.some(marker => message.includes(marker))
}

/** Classify a Host-side OAuth exception without returning its potentially sensitive text. */
export function classifyCodexLoginFailure(error: unknown): CodexAuthFailureReason {
  const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).toLowerCase()
  if (message.includes('device code login is not enabled')
    || message.includes('deviceauth_not_enabled')) return 'device-code-disabled'
  if (message.includes('unsupported_country_region_territory')) return 'unsupported-region'
  if (message.includes('browser callback timed out')) return 'browser-callback-timeout'
  if (containsAny(message, CALLBACK_PORT_MARKERS)) return 'browser-callback-port'
  if (containsAny(message, ACCOUNT_ACCESS_MARKERS) || /\b(?:401|403)\b/.test(message)) {
    return 'account-access'
  }
  if (containsAny(message, BROWSER_CALLBACK_MARKERS)) return 'browser-callback'
  if (message.includes('token exchange')
    || message.includes('token response missing fields')
    || message.includes('invalid_grant')) return 'token-exchange'
  if (containsAny(message, NETWORK_MARKERS)) return 'network'
  return 'unknown'
}

/** Narrow pi-ai surface used by the auth service and its tests. */
export interface CodexAuthModels {
  login(providerId: string, type: 'oauth', interaction: AuthInteraction): Promise<Credential>
  logout(providerId: string): Promise<void>
}

/** Host-only sink for full provider errors that must not cross the browser RPC. */
export type CodexLoginFailureReporter = (error: unknown, method: CodexLoginMethod) => void

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(typeof signal.reason === 'string' ? signal.reason : 'Codex login cancelled')
}

function waitForAbort(first: AbortSignal | undefined, second: AbortSignal): Promise<never> {
  const signal = first === undefined ? second : AbortSignal.any([first, second])
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => { reject(abortError(signal)) }, { once: true })
  })
}

interface ActiveLogin {
  readonly controller: AbortController
  readonly method: CodexLoginMethod
  task: Promise<void>
}

/** Own one background Codex login flow and expose secret-free state. */
export class CodexAuthService {
  private active: ActiveLogin | undefined
  private current: CodexAuthState = { phase: 'disconnected' }
  private stateListener: ((state: CodexAuthState) => void) | undefined
  /**
   * Sticks once a refresh fails terminally, independent of the displayed
   * phase, until a refresh, login, or logout succeeds. Survives status
   * recomputation, so a still-stored dead credential cannot reappear as
   * connected after startup, a cancelled reconnect, or a failed one.
   */
  private refreshFailed = false
  /** Invalidates request-path refresh outcomes started before login/logout. */
  private refreshGeneration = 0
  private disposed = false

  constructor(
    private readonly models: CodexAuthModels,
    private readonly credentials: CredentialStore,
    private readonly startBrowserCallbackBridge?: CodexCallbackBridgeFactory,
    private readonly reportLoginFailure?: CodexLoginFailureReporter,
    private readonly browserCallbackTimeoutMs = CODEX_BROWSER_CALLBACK_TIMEOUT_MS,
  ) {}

  /** Monotonic credential generation captured by refresh operations. */
  getRefreshGeneration(): number {
    return this.refreshGeneration
  }

  /** Register a Host-only observer notified after every published state change. */
  setStateListener(listener: ((state: CodexAuthState) => void) | undefined): void {
    this.stateListener = listener
  }

  private publish(state: CodexAuthState): CodexAuthState {
    this.current = state
    try {
      this.stateListener?.(state)
    } catch {
      // A broken Host-side observer must never corrupt the login state machine.
    }
    return state
  }

  private interaction(active: ActiveLogin): AuthInteraction {
    return {
      signal: active.controller.signal,
      prompt: (prompt: AuthPrompt): Promise<string> => {
        if (prompt.type === 'select') {
          const selected = active.method === 'browser' ? 'browser' : 'device_code'
          if (!prompt.options.some(option => option.id === selected)) {
            return Promise.reject(new Error(`Codex OAuth does not offer ${active.method} login`))
          }
          return Promise.resolve(selected)
        }
        if (prompt.type === 'manual_code') return waitForAbort(prompt.signal, active.controller.signal)
        return Promise.reject(new Error(`Codex OAuth requested unsupported prompt ${JSON.stringify(prompt.type)}`))
      },
      notify: (event) => {
        if (event.type === 'auth_url') {
          this.publish({ phase: 'awaiting-browser', authorizationUrl: event.url })
        }
        if (event.type === 'device_code') {
          this.publish({
            phase: 'awaiting-device',
            verificationUri: event.verificationUri,
            userCode: event.userCode,
          })
        }
      },
    }
  }

  /** Read current stored or in-progress state without exposing token values. */
  async status(): Promise<CodexAuthState> {
    if (this.active !== undefined) return this.current
    const stored = await this.credentials.read(CODEX_PROVIDER)
    if (stored?.type === 'oauth') {
      // A recent reconnect failure carries a far more useful diagnostic than
      // the generic reauth state (for example an unsupported region); keep it
      // visible while the dead-refresh flag sticks.
      if (this.current.phase === 'failed') return this.current
      // A stored credential outranks nothing once refresh has terminally failed:
      // the refresh token is dead even though the credential file still exists.
      if (this.refreshFailed) return this.publish({ phase: 'reauth-required' })
      return this.publish({ phase: 'connected', expiresAt: stored.expires })
    }
    if (this.current.phase === 'failed') return this.current
    return this.publish({ phase: 'disconnected' })
  }

  /** Record a terminal token-refresh failure; Host-only and secret-free. */
  noteRefreshFailure(_error: unknown, generation?: number, failedExpires?: number): void {
    if (this.disposed) return
    if (generation !== undefined && generation !== this.refreshGeneration) return
    // A failure for credential A must not condemn credential B after a
    // successful reconnect, even if the old request settles later.
    if (failedExpires !== undefined
      && this.current.phase === 'connected'
      && this.current.expiresAt !== failedExpires) return
    this.refreshFailed = true
    if (this.active !== undefined) return
    if (this.current.phase === 'connected') this.publish({ phase: 'reauth-required' })
  }

  /** Record a successful token refresh after a terminal failure. */
  noteRefreshSuccess(expiresAt: number, generation?: number): void {
    if (this.disposed) return
    if (generation !== undefined && generation !== this.refreshGeneration) return
    this.refreshFailed = false
    if (this.active !== undefined) return
    if (this.current.phase === 'reauth-required' || this.current.phase === 'failed') {
      this.publish({ phase: 'connected', expiresAt })
    }
  }

  /** Start browser-callback or device-code OAuth in background. */
  login(method: CodexLoginMethod): CodexAuthState {
    if (this.active !== undefined) return this.current
    this.refreshGeneration += 1
    const active: ActiveLogin = {
      controller: new AbortController(),
      method,
      task: Promise.resolve(),
    }
    this.active = active
    const starting = this.publish({ phase: 'starting', method })
    active.task = this.completeLogin(active)
    return starting
  }

  private async completeLogin(active: ActiveLogin): Promise<void> {
    let bridge: CodexCallbackBridge | undefined
    let timeout: NodeJS.Timeout | undefined
    try {
      if (active.method === 'browser') {
        bridge = await this.startBrowserCallbackBridge?.()
        timeout = setTimeout(() => {
          active.controller.abort(new CodexBrowserCallbackTimeoutError())
        }, this.browserCallbackTimeoutMs)
        timeout.unref()
      }
      const credential = await this.models.login(CODEX_PROVIDER, 'oauth', this.interaction(active))
      if (credential.type !== 'oauth') throw new Error('Codex OAuth returned a non-OAuth credential')
      this.refreshFailed = false
      this.publish({ phase: 'connected', expiresAt: credential.expires })
    } catch (error: unknown) {
      const timeoutError = active.controller.signal.reason instanceof CodexBrowserCallbackTimeoutError
      if (!active.controller.signal.aborted || timeoutError) {
        const reportedError = timeoutError ? active.controller.signal.reason : error
        this.reportLoginFailure?.(reportedError, active.method)
        this.publish({
          phase: 'failed',
          method: active.method,
          reason: timeoutError ? 'browser-callback-timeout' : classifyCodexLoginFailure(error),
        })
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      try {
        await bridge?.close()
      } catch {
        // Swallow only bridge teardown failures; they cannot change the completed OAuth result or stored credential.
      }
      if (this.active === active) this.active = undefined
    }
  }

  /** Cancel the active login without deleting an earlier usable credential. */
  async cancel(): Promise<CodexAuthState> {
    await this.stopActive('Codex login cancelled')
    const stored = await this.credentials.read(CODEX_PROVIDER)
    if (stored?.type !== 'oauth') return this.publish({ phase: 'disconnected' })
    // Preserve a fresh reconnect diagnostic instead of hiding it behind reauth.
    if (this.current.phase === 'failed') return this.current
    if (this.refreshFailed) return this.publish({ phase: 'reauth-required' })
    return this.publish({ phase: 'connected', expiresAt: stored.expires })
  }

  /** Cancel active work and remove the stored credential. */
  async logout(): Promise<CodexAuthState> {
    this.refreshGeneration += 1
    await this.stopActive('Codex logout requested')
    await this.models.logout(CODEX_PROVIDER)
    this.refreshFailed = false
    return this.publish({ phase: 'disconnected' })
  }

  private async stopActive(reason: string): Promise<void> {
    const active = this.active
    if (active === undefined) return
    active.controller.abort(reason)
    await active.task
  }

  /** Drain background login work during plugin teardown and reject stale outcomes. */
  dispose(): Promise<void> {
    this.disposed = true
    this.refreshGeneration += 1
    return this.stopActive('Codex provider disposed')
  }
}

/** Narrow a real pi-ai collection to authentication operations. */
export function codexAuthModels(models: Models): CodexAuthModels {
  return models
}
