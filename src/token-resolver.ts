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
 * Upstream does not guarantee `invalid_grant`, so explicit expiry and
 * revocation rejections count as terminal too.
 */
export function isTerminalRefreshError(error: unknown): boolean {
  const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).toLowerCase()
  if (!message.includes('token refresh') && !message.includes('oauth refresh failed')) return false
  return message.includes('invalid_grant')
    || message.includes('invalid_refresh_token')
    || message.includes('expired')
    || message.includes('revoked')
    || /\b(?:401|403)\b/.test(message)
}

/** Result of one locked rotation attempt. */
type RefreshOutcome =
  | { outcome: 'missing' }
  | { outcome: 'skipped' | 'rotated'; expires: number }

/**
 * Wrap pi-ai token resolution so every request-path refresh reports its
 * outcome, and rotate the stored credential ahead of expiry by running the
 * provider's `refresh` under the credential-store lock — the same pattern
 * pi-ai uses, with a margin-aware check instead of an expiry check.
 *
 * Success is never inferred from a resolved `getAuth` alone: pi-ai returns
 * the still-valid token without refreshing, so recovery requires evidence
 * that the credential which failed actually rotated.
 */
export class CodexTokenRefresher implements CodexUsageModels {
  private timer: ReturnType<typeof setTimeout> | undefined
  private inFlight: Promise<void> | undefined
  /** Invalidates an in-flight tick's scheduling decisions on stop/dispose. */
  private generation = 0
  private retryIndex = 0
  private refreshFailed = false
  /** Expiry of the credential whose refresh failed; recovery must differ from it. */
  private failedExpires: number | undefined
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
      await this.noteSuccess()
      return result
    } catch (error) {
      if (isTerminalRefreshError(error)) {
        let failedExpires: number | undefined
        try {
          failedExpires = await this.readExpires()
        } catch {
          // Keep the previous baseline when the store cannot be read.
        }
        this.handleRefreshFailure(error, failedExpires)
      }
      throw error
    }
  }

  /** Arm the proactive timer from the currently stored credential, if any. */
  start(): Promise<void> {
    return this.settle()
  }

  /** Re-arm or stop the proactive timer from externally published auth state. */
  observe(state: CodexAuthState): void {
    switch (state.phase) {
      case 'connected':
        // A connected publish means the Host proved life (login, or a
        // rotation this refresher reported), so any failure baseline kept
        // here is obsolete.
        this.refreshFailed = false
        this.failedExpires = undefined
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

  /** Stop the proactive timer and invalidate an in-flight tick's scheduling. */
  stop(): void {
    this.generation += 1
    this.clearTimer()
  }

  /** Stop all background work during plugin teardown. */
  dispose(): void {
    this.disposed = true
    this.generation += 1
    this.clearTimer()
  }

  private get margin(): number {
    return this.options.marginMs ?? DEFAULT_REFRESH_MARGIN_MS
  }

  private get proactive(): boolean {
    return this.options.proactive ?? true
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && this.generation === generation
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
      .finally(() => {
        this.inFlight = undefined
        void this.settle()
      })
    return this.inFlight
  }

  /**
   * After an interrupted tick, settle the schedule from ground truth: a live
   * credential re-arms, a missing credential stays quiet, a read hiccup
   * retries, and a known-dead credential keeps the timer stopped.
   */
  private async settle(): Promise<void> {
    if (this.disposed || !this.proactive || this.refreshFailed) return
    if (this.timer !== undefined || this.inFlight !== undefined) return
    let expires: number | undefined
    try {
      expires = await this.readExpires()
    } catch {
      this.scheduleRetry()
      return
    }
    if (expires !== undefined) this.arm(expires)
  }

  private async runTick(): Promise<void> {
    this.clearTimer()
    if (this.disposed) return
    const generation = this.generation
    let storedExpires: number | undefined
    try {
      storedExpires = await this.readExpires()
    } catch {
      // A credential-store hiccup is transient; keep the schedule alive.
      if (this.isCurrent(generation)) this.scheduleRetry()
      return
    }
    if (!this.isCurrent(generation)) return
    if (storedExpires === undefined) return // logged out meanwhile; stop quietly
    if (Date.now() < storedExpires - this.margin) {
      // Another path already rotated the credential; re-arm without a request.
      this.rearm(storedExpires)
      return
    }
    try {
      const outcome = await this.refreshStored()
      // A completed rotation is ground truth and survives a concurrent
      // stop(); only its scheduling consequences are invalidated.
      if (outcome.outcome === 'missing') return
      if (this.isCurrent(generation)) this.rearm(outcome.expires)
      this.noteRotated(outcome.expires, outcome.outcome === 'rotated')
    } catch (error) {
      if (!this.isCurrent(generation)) return
      this.handleRefreshFailure(error, storedExpires)
      if (!isTerminalRefreshError(error)) this.scheduleRetry()
    }
  }

  /**
   * Rotate the stored credential under the store lock once it enters the
   * margin. Reports whether a rotation actually happened so callers never
   * mistake an untouched credential for a successful refresh.
   */
  private async refreshStored(): Promise<RefreshOutcome> {
    let outcome: RefreshOutcome = { outcome: 'missing' }
    await this.credentials.modify(CODEX_PROVIDER, async (current) => {
      if (current?.type !== 'oauth') return undefined
      outcome = { outcome: 'skipped', expires: current.expires }
      if (Date.now() < current.expires - this.margin) return undefined // another path rotated first
      const next = await this.options.refresh(current)
      if (next.expires <= current.expires) {
        throw new Error('OpenAI Codex token refresh did not advance the expiry')
      }
      outcome = { outcome: 'rotated', expires: next.expires }
      return next
    })
    return outcome
  }

  /** Recovery from a terminal failure requires evidence the failed credential rotated. */
  private async noteSuccess(): Promise<void> {
    if (!this.refreshFailed) return
    let expires: number | undefined
    try {
      expires = await this.readExpires()
    } catch {
      return // keep the flag; the next success retries
    }
    if (expires === undefined) return // logged out meanwhile
    this.noteRotated(expires, false)
  }

  /** A proven rotation clears any earlier terminal failure and notifies the sink. */
  private noteRotated(expires: number, rotated: boolean): void {
    if (!this.refreshFailed) return
    if (!rotated) {
      // The same expiry pi-ai already failed to refresh proves nothing.
      if (this.failedExpires === undefined || expires === this.failedExpires) return
    }
    this.refreshFailed = false
    this.failedExpires = undefined
    this.sink.noteRefreshSuccess(expires)
  }

  /** Terminal failures stop the timer and surface reauth; transient ones do neither. */
  private handleRefreshFailure(error: unknown, failedExpires?: number): void {
    if (!isTerminalRefreshError(error)) return
    this.refreshFailed = true
    if (failedExpires !== undefined) this.failedExpires = failedExpires
    this.stop()
    this.options.onRefreshFailure?.(error)
    this.sink.noteRefreshFailure(error)
  }

  private async readExpires(): Promise<number | undefined> {
    const stored = await this.credentials.read(CODEX_PROVIDER)
    return stored?.type === 'oauth' ? stored.expires : undefined
  }
}
