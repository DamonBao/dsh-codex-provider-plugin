/** Proactive Codex OAuth refresh with terminal-failure surfacing. */

import type { AuthResult, CredentialStore, OAuthCredential } from '@earendil-works/pi-ai'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { CODEX_PROVIDER } from './credential-store.ts'
import type { CodexAuthState } from './types.ts'
import type { CodexUsageModels } from './usage-service.ts'

/** Default lead time before access-token expiry at which the Host refreshes. */
export const DEFAULT_REFRESH_MARGIN_MS = 300_000
/** Transient refresh failures retry after these delays; the last one repeats. */
export const DEFAULT_REFRESH_RETRY_DELAYS_MS: readonly number[] = [60_000, 300_000]

/** Host-only recipient of background refresh outcomes. */
export interface CodexRefreshSink {
  noteRefreshSuccess(expiresAt: number): void
  noteRefreshFailure(error: unknown): void
}

/** Tunable proactive-refresh behavior. */
export interface CodexTokenRefresherOptions {
  /** pi-ai OAuth handler's token exchange; this refresher runs it under the store lock. */
  refresh: (credential: OAuthCredential) => Promise<OAuthCredential>
  /** Refresh this long before expiry. */
  marginMs?: number
  /** Retry delays after transient refresh failures; the last delay repeats. */
  retryDelaysMs?: readonly number[]
  /** Set false to disable the proactive timer while keeping failure surfacing. */
  proactive?: boolean
  /** Host-side logger for refresh failures; receives the raw error, which never crosses RPC. */
  onRefreshFailure?: (error: unknown) => void
}

/**
 * A dead refresh token requires sign-in; an unreachable network does not.
 * Only failures carrying pi-ai's token-refresh markers qualify: a
 * credential-store or transport error must never condemn the stored token.
 */
export function isTerminalRefreshError(error: unknown): boolean {
  const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).toLowerCase()
  if (!message.includes('token refresh') && !message.includes('oauth refresh failed')) return false
  return message.includes('invalid_grant') || /\b(?:401|403)\b/.test(message)
}

/**
 * Wrap pi-ai token resolution so every request-path refresh reports its
 * outcome, and rotate the stored credential ahead of expiry by running the
 * provider's `refresh` under the credential-store lock — the same pattern
 * pi-ai uses, with a margin-aware check instead of an expiry check.
 */
export class CodexTokenRefresher implements CodexUsageModels {
  private timer: ReturnType<typeof setTimeout> | undefined
  private inFlight: Promise<void> | undefined
  private retryIndex = 0
  private refreshFailed = false
  private disposed = false

  constructor(
    private readonly models: CodexUsageModels,
    private readonly credentials: CredentialStore,
    private readonly sink: CodexRefreshSink,
    private readonly options: CodexTokenRefresherOptions,
  ) {}

  /** Resolve one fresh bearer token, surfacing terminal refresh failures. */
  async getAuth(providerId: string): Promise<AuthResult | undefined> {
    try {
      const result = await this.models.getAuth(providerId)
      if (this.refreshFailed) {
        this.refreshFailed = false
        try {
          const expires = await this.readExpires()
          if (expires !== undefined) this.sink.noteRefreshSuccess(expires)
        } catch {
          // The store read hiccuped; keep the flag so the next success retries.
          this.refreshFailed = true
        }
      }
      return result
    } catch (error) {
      this.handleRefreshFailure(error)
      throw error
    }
  }

  /** Arm the proactive timer from the currently stored credential, if any. */
  async start(): Promise<void> {
    if (this.disposed || !this.proactive) return
    let expires: number | undefined
    try {
      expires = await this.readExpires()
    } catch {
      // A credential-store hiccup is transient; retry instead of going silent.
      this.scheduleRetry()
      return
    }
    if (expires !== undefined) this.arm(expires)
  }

  /** Re-arm or stop the proactive timer from externally published auth state. */
  observe(state: CodexAuthState): void {
    switch (state.phase) {
      case 'connected':
        this.arm(state.expiresAt)
        break
      case 'reauth-required':
      case 'disconnected':
        this.stop()
        break
      default:
        break
    }
  }

  /** Stop the proactive timer. */
  stop(): void {
    this.clearTimer()
  }

  /** Stop all background work during plugin teardown. */
  dispose(): void {
    this.disposed = true
    this.clearTimer()
  }

  private get margin(): number {
    return this.options.marginMs ?? DEFAULT_REFRESH_MARGIN_MS
  }

  private get proactive(): boolean {
    return this.options.proactive ?? true
  }

  private delayFor(expiresAt: number): number {
    return Math.min(Math.max(expiresAt - this.margin - Date.now(), 0), MAX_TIMER_DELAY_MS)
  }

  /**
   * Arm the timer for one expiry instant. A pending timer always re-evaluates
   * the store when it fires, so external arming never overrides an existing
   * schedule — least surprise for retry backoff and in-flight ticks.
   */
  private arm(expiresAt: number): void {
    if (this.disposed || !this.proactive || this.timer !== undefined || this.inFlight !== undefined) return
    this.setTimer(this.delayFor(expiresAt))
  }

  /** Re-arm from within a tick, replacing the consumed (or stale) timer. */
  private rearm(expiresAt: number): void {
    if (this.disposed || !this.proactive) return
    this.clearTimer()
    this.retryIndex = 0
    this.setTimer(this.delayFor(expiresAt))
  }

  private scheduleRetry(): void {
    if (this.disposed || !this.proactive || this.timer !== undefined) return
    const configured = this.options.retryDelaysMs ?? DEFAULT_REFRESH_RETRY_DELAYS_MS
    const delays = configured.length > 0 ? configured : DEFAULT_REFRESH_RETRY_DELAYS_MS
    // delays is non-empty here; the fallback only satisfies noUncheckedIndexedAccess.
    const delay = delays[Math.min(this.retryIndex, delays.length - 1)] ?? DEFAULT_REFRESH_MARGIN_MS
    this.retryIndex += 1
    this.setTimer(delay)
  }

  private setTimer(delay: number): void {
    const timer = setTimeout(() => { void this.tick() }, delay)
    // A background refresh must never hold the Host process open.
    ;(timer as { unref?: () => void }).unref?.()
    this.timer = timer
  }

  private clearTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Single-flight tick: concurrent fires share the running refresh. */
  private tick(): Promise<void> {
    this.inFlight ??= this.runTick()
      .catch(() => undefined) // scheduling must never produce an unhandled rejection
      .finally(() => { this.inFlight = undefined })
    return this.inFlight
  }

  private async runTick(): Promise<void> {
    this.clearTimer()
    if (this.disposed) return
    let storedExpires: number | undefined
    try {
      storedExpires = await this.readExpires()
    } catch {
      // A credential-store hiccup is transient; keep the schedule alive.
      this.scheduleRetry()
      return
    }
    if (storedExpires === undefined) return // logged out meanwhile; stop quietly
    if (Date.now() < storedExpires - this.margin) {
      // Another path already rotated the credential; re-arm without a request.
      this.rearm(storedExpires)
      return
    }
    try {
      const expires = await this.refreshStored()
      if (expires === null) return // credential disappeared mid-refresh
      this.rearm(expires)
    } catch (error) {
      this.handleRefreshFailure(error)
      if (!isTerminalRefreshError(error)) this.scheduleRetry()
    }
  }

  /**
   * Rotate the stored credential under the store lock once it enters the
   * margin. Returns the post-refresh expiry, or null when no OAuth
   * credential remains stored.
   */
  private async refreshStored(): Promise<number | null> {
    let expires: number | null = null
    await this.credentials.modify(CODEX_PROVIDER, async (current) => {
      if (current?.type !== 'oauth') return undefined
      expires = current.expires
      if (Date.now() < current.expires - this.margin) return undefined // another path rotated first
      const next = await this.options.refresh(current)
      if (next.expires <= current.expires) {
        throw new Error('OpenAI Codex token refresh did not advance the expiry')
      }
      expires = next.expires
      return next
    })
    return expires
  }

  /** Terminal failures stop the timer and surface reauth; transient ones do neither. */
  private handleRefreshFailure(error: unknown): void {
    if (!isTerminalRefreshError(error)) return
    this.refreshFailed = true
    this.stop()
    this.options.onRefreshFailure?.(error)
    this.sink.noteRefreshFailure(error)
  }

  private async readExpires(): Promise<number | undefined> {
    const stored = await this.credentials.read(CODEX_PROVIDER)
    return stored?.type === 'oauth' ? stored.expires : undefined
  }
}
