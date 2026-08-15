/** Proactive Codex OAuth refresh with terminal-failure surfacing. */

import type { AuthResult, CredentialStore } from '@earendil-works/pi-ai'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { classifyCodexLoginFailure } from './auth-service.ts'
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
  /** Refresh this long before expiry. */
  marginMs?: number
  /** Retry delays after transient refresh failures; the last delay repeats. */
  retryDelaysMs?: readonly number[]
  /** Set false to disable the proactive timer while keeping failure surfacing. */
  proactive?: boolean
  /** Host-side logger for refresh failures; receives the raw error, which never crosses RPC. */
  onRefreshFailure?: (error: unknown) => void
}

/** A dead refresh token requires sign-in; an unreachable network does not. */
export function isTerminalRefreshError(error: unknown): boolean {
  const reason = classifyCodexLoginFailure(error)
  return reason === 'token-exchange' || reason === 'account-access'
}

/**
 * Wrap pi-ai token resolution so every request-path and timer-path refresh
 * reports its outcome, and schedule proactive refreshes ahead of expiry.
 * Refresh rotation itself stays inside pi-ai's double-checked modify lock.
 */
export class CodexTokenRefresher implements CodexUsageModels {
  private timer: ReturnType<typeof setTimeout> | undefined
  private armedExpiresAt: number | undefined
  private retryIndex = 0
  private refreshFailed = false
  private disposed = false

  constructor(
    private readonly models: CodexUsageModels,
    private readonly credentials: CredentialStore,
    private readonly sink: CodexRefreshSink,
    private readonly options: CodexTokenRefresherOptions = {},
  ) {}

  /** Resolve one fresh bearer token, surfacing terminal refresh failures. */
  async getAuth(providerId: string): Promise<AuthResult | undefined> {
    try {
      const result = await this.models.getAuth(providerId)
      if (this.refreshFailed) {
        this.refreshFailed = false
        const expires = await this.currentExpires()
        if (expires !== undefined) this.sink.noteRefreshSuccess(expires)
      }
      return result
    } catch (error) {
      if (isTerminalRefreshError(error)) {
        this.refreshFailed = true
        this.stop()
        this.options.onRefreshFailure?.(error)
        this.sink.noteRefreshFailure(error)
      }
      throw error
    }
  }

  /** Arm the proactive timer from the currently stored credential, if any. */
  async start(): Promise<void> {
    if (this.disposed || !this.proactive) return
    const expires = await this.currentExpires()
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
    this.armedExpiresAt = undefined
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

  /** Arm the proactive timer for one expiry instant; idempotent per expiry. */
  private arm(expiresAt: number): void {
    if (this.disposed || !this.proactive) return
    if (this.timer !== undefined && this.armedExpiresAt === expiresAt) return
    this.clearTimer()
    this.retryIndex = 0
    this.armedExpiresAt = expiresAt
    const delay = Math.min(Math.max(expiresAt - this.margin - Date.now(), 0), MAX_TIMER_DELAY_MS)
    this.setTimer(delay)
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

  private async tick(): Promise<void> {
    this.timer = undefined
    this.armedExpiresAt = undefined
    if (this.disposed) return
    let stored: Awaited<ReturnType<CredentialStore['read']>>
    try {
      stored = await this.credentials.read(CODEX_PROVIDER)
    } catch {
      // A credential-store hiccup is transient; keep the schedule alive.
      this.scheduleRetry()
      return
    }
    if (stored?.type !== 'oauth') return // logged out meanwhile; stop quietly
    if (Date.now() < stored.expires - this.margin) {
      // Another path already rotated the credential; re-arm without a request.
      this.arm(stored.expires)
      return
    }
    try {
      await this.getAuth(CODEX_PROVIDER)
      this.retryIndex = 0
      const expires = await this.currentExpires()
      if (expires !== undefined) this.arm(expires)
    } catch (error) {
      // Terminal failures already stopped the timer and notified the sink.
      if (isTerminalRefreshError(error)) return
      this.scheduleRetry()
    }
  }

  private async currentExpires(): Promise<number | undefined> {
    try {
      const stored = await this.credentials.read(CODEX_PROVIDER)
      return stored?.type === 'oauth' ? stored.expires : undefined
    } catch {
      return undefined
    }
  }
}
