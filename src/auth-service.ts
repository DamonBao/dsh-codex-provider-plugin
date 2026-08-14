/** Host-owned OpenAI Codex OAuth lifecycle. */

import type {
  AuthInteraction,
  AuthPrompt,
  Credential,
  CredentialStore,
  Models,
} from '@earendil-works/pi-ai'
import { CODEX_PROVIDER } from './credential-store.ts'
import type { CodexAuthState, CodexLoginMethod } from './types.ts'

/** Narrow pi-ai surface used by the auth service and its tests. */
export interface CodexAuthModels {
  login(providerId: string, type: 'oauth', interaction: AuthInteraction): Promise<Credential>
  logout(providerId: string): Promise<void>
}

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

  constructor(
    private readonly models: CodexAuthModels,
    private readonly credentials: CredentialStore,
  ) {}

  private publish(state: CodexAuthState): CodexAuthState {
    this.current = state
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
    if (stored?.type === 'oauth') return this.publish({ phase: 'connected', expiresAt: stored.expires })
    if (this.current.phase === 'failed') return this.current
    return this.publish({ phase: 'disconnected' })
  }

  /** Start browser-callback or device-code OAuth in background. */
  login(method: CodexLoginMethod): CodexAuthState {
    if (this.active !== undefined) return this.current
    const active: ActiveLogin = {
      controller: new AbortController(),
      method,
      task: Promise.resolve(),
    }
    this.active = active
    const starting = this.publish({ phase: 'starting', method })
    active.task = this.models.login(CODEX_PROVIDER, 'oauth', this.interaction(active)).then((credential) => {
      if (credential.type !== 'oauth') throw new Error('Codex OAuth returned a non-OAuth credential')
      this.publish({ phase: 'connected', expiresAt: credential.expires })
    }).catch(() => {
      if (!active.controller.signal.aborted) this.publish({ phase: 'failed', reason: 'login-failed' })
    }).finally(() => {
      if (this.active === active) this.active = undefined
    })
    return starting
  }

  /** Cancel the active login without deleting an earlier usable credential. */
  async cancel(): Promise<CodexAuthState> {
    await this.stopActive('Codex login cancelled')
    const stored = await this.credentials.read(CODEX_PROVIDER)
    return this.publish(stored?.type === 'oauth'
      ? { phase: 'connected', expiresAt: stored.expires }
      : { phase: 'disconnected' })
  }

  /** Cancel active work and remove the stored credential. */
  async logout(): Promise<CodexAuthState> {
    await this.stopActive('Codex logout requested')
    await this.models.logout(CODEX_PROVIDER)
    return this.publish({ phase: 'disconnected' })
  }

  private async stopActive(reason: string): Promise<void> {
    const active = this.active
    if (active === undefined) return
    active.controller.abort(reason)
    await active.task
  }

  /** Drain background login work during plugin teardown. */
  dispose(): Promise<void> {
    return this.stopActive('Codex provider disposed')
  }
}

/** Narrow a real pi-ai collection to authentication operations. */
export function codexAuthModels(models: Models): CodexAuthModels {
  return models
}
