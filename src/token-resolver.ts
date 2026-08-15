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
  /** Monotonic login/logout generation used to reject outcomes from stale requests. */
  getRefreshGeneration(): number
  noteRefreshSuccess(expiresAt: number, generation: number): void
  noteRefreshFailure(error: unknown, generation: number, failedExpires?: number): void
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

  // Server and rate-limit failures stay retryable even when their diagnostic
  // body happens to contain words such as "expired".
  const status = /\((\d{3})\)/.exec(message)?.[1]
  if (status !== undefined && Number(status) >= 500) return false
  if (status === '429') return false

  const explicitTokenRejection = message.includes('invalid_grant')
    || message.includes('invalid_refresh_token')
    || /refresh[ _-]?token(?:[ _-]+(?:is|has|was))?[ _-]+(?:expired|revoked)/.test(message)
    || /(?:expired|revoked)[ _-]+refresh[ _-]?token/.test(message)
  return explicitTokenRejection || status === '401' || status === '403'
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
  /** Invalidates every asynchronous scheduling decision on stop/dispose. */
  private generation = 0
  /** Whether background scheduling is currently desired. */
  private scheduling = false
  private retryIndex = 0
  private refreshFailed = false
  /** Expiry of the credential whose refresh failed; recovery must differ from it. */
  private failedExpires: number | undefined
  /** Upper bound for a failed lazy refresh when its credential could not be read. */
  private failedBeforeOrAt: number | undefined
  private disposed = false

  constructor(
    private readonly models: CodexUsageModels,
    private readonly credentials: CredentialStore,
    private readonly sink: CodexRefreshSink,
    private readonly options: CodexTokenRefresherOptions,
  ) {}

  /** Resolve one fresh bearer token, surfacing terminal refresh failures. */
  async getAuth(providerId: string): Promise<AuthResult | undefined> {
    const authGeneration = this.currentAuthGeneration()
    try {
      const result = await this.models.getAuth(providerId)
      await this.noteSuccess(authGeneration)
      return result
    } catch (error) {
      if (isTerminalRefreshError(error) && this.isAuthCurrent(authGeneration)) {
        // A lazy pi-ai refresh can only fail after the credential expires. Keep
        // that time as rotation evidence when the credential backend hiccups.
        const failedBeforeOrAt = Date.now()
        let failedExpires: number | undefined
        try {
          failedExpires = await this.readExpires()
        } catch {
          // The time bound above still lets a later, future-dated credential
          // prove that a real rotation happened.
        }
        if (this.isAuthCurrent(authGeneration)) {
          this.handleRefreshFailure(error, failedExpires, failedBeforeOrAt, authGeneration)
        }
      }
      throw error
    }
  }

  /** Arm the proactive timer from the currently stored credential, if any. */
  start(): Promise<void> {
    if (this.disposed || !this.proactive) return Promise.resolve()
    if (!this.scheduling) {
      this.scheduling = true
      this.generation += 1
    }
    return this.settle(this.generation)
  }

  /** Re-arm or stop the proactive timer from externally published auth state. */
  observe(state: CodexAuthState): void {
    switch (state.phase) {
      case 'connected':
        // A connected publish means the Host proved life (login, or a
        // rotation this refresher reported), so any failure baseline kept
        // here is obsolete and background scheduling may start a new epoch.
        this.refreshFailed = false
        this.failedExpires = undefined
        this.failedBeforeOrAt = undefined
        if (!this.scheduling) {
          this.scheduling = true
          this.generation += 1
        }
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

  /** Stop the proactive timer and invalidate every pending scheduling decision. */
  stop(): void {
    this.scheduling = false
    this.generation += 1
    this.clearTimer()
  }

  /** Stop all background work during plugin teardown. */
  dispose(): void {
    this.disposed = true
    this.scheduling = false
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
    return !this.disposed && this.scheduling && this.generation === generation
  }

  private currentAuthGeneration(): number {
    return this.sink.getRefreshGeneration()
  }

  private isAuthCurrent(generation: number): boolean {
    return !this.disposed && this.currentAuthGeneration() === generation
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
    if (this.disposed || !this.proactive || !this.scheduling
      || this.timer !== undefined || this.inFlight !== undefined) return
    this.setTimer(this.delayFor(expiresAt))
  }

  /** Re-arm from within a tick, replacing the consumed (or stale) timer. */
  private rearm(expiresAt: number): void {
    if (this.disposed || !this.proactive || !this.scheduling) return
    this.clearTimer()
    this.retryIndex = 0
    this.setTimer(this.delayFor(expiresAt))
  }

  private scheduleRetry(): void {
    if (this.disposed || !this.proactive || !this.scheduling || this.timer !== undefined) return
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
    const generation = this.generation
    this.inFlight ??= this.runTick(generation)
      .catch(() => undefined) // scheduling must never produce an unhandled rejection
      .finally(() => {
        this.inFlight = undefined
        // Honor the latest desired state: stop() leaves scheduling false,
        // while a newer connected/start epoch should establish a fresh timer.
        void this.settle(this.generation)
      })
    return this.inFlight
  }

  /**
   * After an interrupted tick, settle the schedule from ground truth: a live
   * credential re-arms, a missing credential stays quiet, a read hiccup
   * retries, and a known-dead credential keeps the timer stopped.
   */
  private async settle(generation: number): Promise<void> {
    if (!this.isCurrent(generation) || !this.proactive || this.refreshFailed) return
    if (this.timer !== undefined || this.inFlight !== undefined) return
    let expires: number | undefined
    try {
      expires = await this.readExpires()
    } catch {
      if (this.isCurrent(generation)) this.scheduleRetry()
      return
    }
    if (!this.isCurrent(generation) || this.refreshFailed) return
    if (expires !== undefined) this.arm(expires)
  }

  private async runTick(generation: number): Promise<void> {
    this.clearTimer()
    if (!this.isCurrent(generation)) return
    const authGeneration = this.currentAuthGeneration()
    let storedExpires: number | undefined
    try {
      storedExpires = await this.readExpires()
    } catch {
      // A credential-store hiccup is transient; keep the schedule alive only
      // for the same scheduler and authenticated credential generation.
      if (this.isCurrent(generation) && this.isAuthCurrent(authGeneration)) this.scheduleRetry()
      return
    }
    if (!this.isCurrent(generation) || !this.isAuthCurrent(authGeneration)) return
    if (storedExpires === undefined) return // logged out meanwhile; stop quietly
    if (Date.now() < storedExpires - this.margin) {
      // Another path already rotated the credential; re-arm without a request.
      this.rearm(storedExpires)
      return
    }
    try {
      const outcome = await this.refreshStored()
      if (!this.isAuthCurrent(authGeneration)) return
      // A completed rotation is ground truth and may disprove a concurrent
      // terminal failure; only stale scheduling consequences are discarded.
      if (outcome.outcome === 'missing') return
      if (this.isCurrent(generation)) this.rearm(outcome.expires)
      this.noteRotated(outcome.expires, outcome.outcome === 'rotated', authGeneration)
    } catch (error) {
      if (!this.isCurrent(generation) || !this.isAuthCurrent(authGeneration)) return
      this.handleRefreshFailure(error, storedExpires, storedExpires, authGeneration)
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
  private async noteSuccess(authGeneration: number): Promise<void> {
    if (!this.refreshFailed || !this.isAuthCurrent(authGeneration)) return
    let expires: number | undefined
    try {
      expires = await this.readExpires()
    } catch {
      return // keep the flag; the next success retries
    }
    if (!this.isAuthCurrent(authGeneration) || expires === undefined) return
    this.noteRotated(expires, false, authGeneration)
  }

  /** A proven rotation clears any earlier terminal failure and notifies the sink. */
  private noteRotated(expires: number, rotated: boolean, authGeneration: number): void {
    if (!this.refreshFailed || !this.isAuthCurrent(authGeneration)) return
    if (!rotated) {
      // The same expiry pi-ai already failed to refresh proves nothing. When
      // that baseline was unreadable, a future expiry beyond the lazy
      // failure instant proves pi-ai or another process actually rotated it.
      if (this.failedExpires !== undefined && expires === this.failedExpires) return
      if (this.failedExpires === undefined
        && (this.failedBeforeOrAt === undefined || expires <= this.failedBeforeOrAt)) return
    }
    this.refreshFailed = false
    this.failedExpires = undefined
    this.failedBeforeOrAt = undefined
    try {
      this.sink.noteRefreshSuccess(expires, authGeneration)
    } catch {
      // A Host observer must never turn a successful token resolution into a failure.
    }
  }

  /** Terminal failures stop the timer and surface reauth; transient ones do neither. */
  private handleRefreshFailure(
    error: unknown,
    failedExpires: number | undefined,
    failedBeforeOrAt: number,
    authGeneration: number,
  ): void {
    if (!isTerminalRefreshError(error) || !this.isAuthCurrent(authGeneration)) return
    this.refreshFailed = true
    this.failedExpires = failedExpires
    this.failedBeforeOrAt = failedBeforeOrAt
    this.stop()
    try {
      this.options.onRefreshFailure?.(error)
    } catch {
      // Logging must not replace the provider's original refresh exception.
    }
    try {
      this.sink.noteRefreshFailure(error, authGeneration, failedExpires)
    } catch {
      // State observers are best-effort; the request still receives the original error.
    }
  }

  private async readExpires(): Promise<number | undefined> {
    const stored = await this.credentials.read(CODEX_PROVIDER)
    return stored?.type === 'oauth' ? stored.expires : undefined
  }
}
