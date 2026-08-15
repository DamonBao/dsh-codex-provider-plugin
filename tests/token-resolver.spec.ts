import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthResult, Credential, CredentialStore, OAuthCredential } from '@earendil-works/pi-ai'
import { CODEX_PROVIDER } from '../src/credential-store.ts'
import { CodexTokenRefresher, isTerminalRefreshError } from '../src/token-resolver.ts'
import type { CodexRefreshSink, CodexTokenRefresherOptions } from '../src/token-resolver.ts'
import type { CodexUsageModels } from '../src/usage-service.ts'

const HOUR = 3_600_000

function oauth(expires: number): Credential {
  return { type: 'oauth', access: 'access-token', refresh: 'refresh-token', expires }
}

type MutableStore = CredentialStore & {
  current: Credential | undefined
  failReads: (error: unknown) => void
  healReads: () => void
}

function store(): MutableStore {
  let readError: unknown
  const value: MutableStore = {
    current: undefined,
    failReads: (error) => { readError = error },
    healReads: () => { readError = undefined },
    read: async () => {
      if (readError !== undefined) throw readError
      return value.current
    },
    list: async () => [],
    modify: async (_provider, fn) => {
      const next = await fn(value.current)
      if (next !== undefined) value.current = next
      return value.current
    },
    delete: async () => { value.current = undefined },
  }
  return value
}

const AUTH: AuthResult = { auth: { apiKey: 'fresh-access-token' }, source: 'OAuth' }
const TERMINAL = new Error('OpenAI Codex token refresh failed (400): invalid_grant')
const TRANSIENT = new Error('OpenAI Codex token refresh error: fetch failed')

type RefreshFn = (credential: OAuthCredential) => Promise<OAuthCredential>

interface Fixture {
  credentials: MutableStore
  getAuth: ReturnType<typeof vi.fn<(providerId: string) => Promise<AuthResult | undefined>>>
  refresh: ReturnType<typeof vi.fn<RefreshFn>>
  authGeneration: { current: number }
  sink: Record<keyof CodexRefreshSink, ReturnType<typeof vi.fn>>
  refresher: CodexTokenRefresher
}

function fixture(options?: Partial<CodexTokenRefresherOptions>): Fixture {
  const credentials = store()
  const getAuth = vi.fn(async (): Promise<AuthResult | undefined> => AUTH)
  const refresh = vi.fn<RefreshFn>(async (current) => ({
    ...current,
    access: 'rotated-access-token',
    refresh: 'rotated-refresh-token',
    expires: Date.now() + HOUR,
  }))
  const authGeneration = { current: 0 }
  const sink = {
    getRefreshGeneration: vi.fn(() => authGeneration.current),
    noteRefreshSuccess: vi.fn(),
    noteRefreshFailure: vi.fn(),
  }
  const models: CodexUsageModels = { getAuth }
  const refresher = new CodexTokenRefresher(models, credentials, sink, { refresh, ...options })
  return { credentials, getAuth, refresh, authGeneration, sink, refresher }
}

describe('isTerminalRefreshError', () => {
  it.each([
    // pi-ai ModelsError-wrapped request-path failure.
    ['OAuth refresh failed for openai-codex: OpenAI Codex token refresh failed (400): invalid_grant', true],
    // Raw timer-path failures from the OAuth handler.
    ['OpenAI Codex token refresh failed (400): invalid_grant', true],
    ['OpenAI Codex token refresh failed (400): invalid_refresh_token', true],
    ['OpenAI Codex token refresh failed (400): refresh token expired', true],
    ['OpenAI Codex token refresh failed (400): refresh token revoked', true],
    ['OpenAI Codex token refresh failed (401): unauthorized', true],
    ['OpenAI Codex token refresh failed (403): forbidden', true],
    // Region rejection is terminal too: sign-in surfaces a region diagnostic,
    // while silent retries would keep a dead session looking connected.
    ['OpenAI Codex token refresh failed (403): unsupported_country_region_territory', true],
    // Transient refresh-path failures.
    ['OpenAI Codex token refresh error: fetch failed', false],
    ['OpenAI Codex token refresh response missing fields: {}', false],
    ['OpenAI Codex token refresh failed (500): internal server error', false],
    ['OpenAI Codex token refresh failed (500): proxy certificate expired', false],
    ['OpenAI Codex token refresh failed (400): service lease expired', false],
    ['OpenAI Codex token refresh failed (400): refresh token request hit an expired proxy certificate', false],
    // Failures outside the refresh path never condemn the stored token.
    ['Credential store modify failed for openai-codex: 403 forbidden', false],
    ['TypeError: fetch failed', false],
    ['socket hangup', false],
  ])('classifies %s as terminal=%s', (message, terminal) => {
    expect(isTerminalRefreshError(new Error(message))).toBe(terminal)
  })
})

describe('CodexTokenRefresher request path', () => {
  it('passes through successful auth without sink noise', async () => {
    const { refresher, sink } = fixture()
    await expect(refresher.getAuth(CODEX_PROVIDER)).resolves.toBe(AUTH)
    expect(sink.noteRefreshSuccess).not.toHaveBeenCalled()
    expect(sink.noteRefreshFailure).not.toHaveBeenCalled()
  })

  it('surfaces a terminal refresh failure and rethrows', async () => {
    const onRefreshFailure = vi.fn()
    const { getAuth, sink, refresher } = fixture({ onRefreshFailure })
    getAuth.mockRejectedValue(new Error(`OAuth refresh failed for openai-codex: ${TERMINAL.message}`))

    await expect(refresher.getAuth(CODEX_PROVIDER)).rejects.toThrow('invalid_grant')
    expect(sink.noteRefreshFailure).toHaveBeenCalledTimes(1)
    expect(onRefreshFailure).toHaveBeenCalledTimes(1)
    expect(sink.noteRefreshSuccess).not.toHaveBeenCalled()
  })

  it('treats a network refresh failure as transient', async () => {
    const { getAuth, sink, refresher } = fixture()
    getAuth.mockRejectedValue(TRANSIENT)

    await expect(refresher.getAuth(CODEX_PROVIDER)).rejects.toBe(TRANSIENT)
    expect(sink.noteRefreshFailure).not.toHaveBeenCalled()
  })

  it('recovers once a refresh succeeds after a terminal failure', async () => {
    const { credentials, getAuth, sink, refresher } = fixture()
    credentials.current = oauth(Date.now() + 60_000)
    getAuth.mockRejectedValueOnce(new Error(`OAuth refresh failed for openai-codex: ${TERMINAL.message}`))
    await expect(refresher.getAuth(CODEX_PROVIDER)).rejects.toThrow('invalid_grant')

    const rotated = Date.now() + HOUR
    credentials.current = oauth(rotated)
    await expect(refresher.getAuth(CODEX_PROVIDER)).resolves.toBe(AUTH)
    expect(sink.noteRefreshSuccess).toHaveBeenCalledWith(rotated, 0)

    // A steady-state success stays silent afterwards.
    await refresher.getAuth(CODEX_PROVIDER)
    expect(sink.noteRefreshSuccess).toHaveBeenCalledTimes(1)
  })

  it('does not recover when getAuth merely returns the still-valid failed credential', async () => {
    const { credentials, getAuth, sink, refresher } = fixture()
    const live = Date.now() + 60_000
    credentials.current = oauth(live)
    getAuth.mockRejectedValueOnce(new Error(`OAuth refresh failed for openai-codex: ${TERMINAL.message}`))
    await expect(refresher.getAuth(CODEX_PROVIDER)).rejects.toThrow('invalid_grant')

    // pi-ai returns the unexpired token without refreshing: no rotation, no recovery.
    await expect(refresher.getAuth(CODEX_PROVIDER)).resolves.toBe(AUTH)
    expect(sink.noteRefreshSuccess).not.toHaveBeenCalled()

    // A later success after the credential actually rotated does recover.
    const rotated = live + HOUR
    credentials.current = oauth(rotated)
    await refresher.getAuth(CODEX_PROVIDER)
    expect(sink.noteRefreshSuccess).toHaveBeenCalledWith(rotated, 0)
  })

  it('recovers from a later future credential when the failure baseline read hiccups', async () => {
    const { credentials, getAuth, sink, refresher } = fixture()
    credentials.current = oauth(Date.now() - 1)
    getAuth.mockRejectedValueOnce(new Error(`OAuth refresh failed for openai-codex: ${TERMINAL.message}`))
    credentials.failReads(new Error('Harness credential backend unavailable'))

    await expect(refresher.getAuth(CODEX_PROVIDER)).rejects.toThrow('invalid_grant')
    credentials.healReads()
    const rotated = Date.now() + HOUR
    credentials.current = oauth(rotated)

    await refresher.getAuth(CODEX_PROVIDER)
    expect(sink.noteRefreshSuccess).toHaveBeenCalledWith(rotated, 0)
  })

  it('ignores a terminal result from an older auth generation', async () => {
    const { credentials, getAuth, authGeneration, sink, refresher } = fixture()
    credentials.current = oauth(Date.now() + 60_000)
    let rejectOld!: (error: unknown) => void
    getAuth.mockImplementationOnce(() => new Promise<AuthResult | undefined>((_resolve, reject) => {
      rejectOld = reject
    }))

    const stale = refresher.getAuth(CODEX_PROVIDER)
    await vi.waitFor(() => { expect(getAuth).toHaveBeenCalledTimes(1) })
    authGeneration.current += 1 // successful reconnect/logout invalidates the request
    rejectOld(new Error(`OAuth refresh failed for openai-codex: ${TERMINAL.message}`))

    await expect(stale).rejects.toThrow('invalid_grant')
    expect(sink.noteRefreshFailure).not.toHaveBeenCalled()
  })

  it('ignores a request-path outcome that settles after dispose', async () => {
    const { getAuth, sink, refresher } = fixture()
    let rejectOld!: (error: unknown) => void
    getAuth.mockImplementationOnce(() => new Promise<AuthResult | undefined>((_resolve, reject) => {
      rejectOld = reject
    }))

    const stale = refresher.getAuth(CODEX_PROVIDER)
    await vi.waitFor(() => { expect(getAuth).toHaveBeenCalledTimes(1) })
    refresher.dispose()
    rejectOld(new Error(`OAuth refresh failed for openai-codex: ${TERMINAL.message}`))

    await expect(stale).rejects.toThrow('invalid_grant')
    expect(sink.noteRefreshFailure).not.toHaveBeenCalled()
  })
})

describe('CodexTokenRefresher proactive timer', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('force-refreshes under the store lock ahead of expiry and re-arms once', async () => {
    const { credentials, getAuth, refresh, refresher } = fixture({ marginMs: 5_000 })
    credentials.current = oauth(Date.now() + 60_000)

    await refresher.start()
    await vi.advanceTimersByTimeAsync(54_999)
    expect(refresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    // Exactly one locked rotation per expiry window; the request path is untouched.
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(getAuth).not.toHaveBeenCalled()
    const rotated = credentials.current
    expect(rotated?.type === 'oauth' && rotated.expires > Date.now()).toBe(true)

    // Re-armed at rotated expiry minus margin, measured from the first tick.
    await vi.advanceTimersByTimeAsync(HOUR - 5_000 - 1)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledTimes(2)
    refresher.dispose()
  })

  it('never busy-loops when a refresh does not advance the expiry', async () => {
    const { credentials, refresh, refresher } = fixture({ marginMs: 5_000 })
    credentials.current = oauth(Date.now() + 60_000)
    // A pathological handler that keeps the same expiry must hit the backoff,
    // not a 0ms re-arm loop.
    refresh.mockImplementation(async current => current)

    await refresher.start()
    await vi.advanceTimersByTimeAsync(55_000)
    expect(refresh).toHaveBeenCalledTimes(1)

    // Nothing until the first one-minute backoff elapses — no hot re-arm loop.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(58_999)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledTimes(2)
    refresher.dispose()
  })

  it('skips the request when another path already rotated the credential', async () => {
    const { credentials, refresh, refresher } = fixture({ marginMs: 5_000 })
    credentials.current = oauth(Date.now() + 60_000)

    await refresher.start()
    // A request-path refresh rotates the credential before the timer fires.
    credentials.current = oauth(Date.now() + HOUR)
    await vi.advanceTimersByTimeAsync(55_000)
    expect(refresh).not.toHaveBeenCalled()

    // Re-armed against the rotated expiry: fires exactly at the new margin.
    await vi.advanceTimersByTimeAsync(HOUR - 60_000 - 1)
    expect(refresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    refresher.dispose()
  })

  it('stops after a terminal failure on the timer path', async () => {
    const onRefreshFailure = vi.fn()
    const { credentials, refresh, sink, refresher } = fixture({ marginMs: 5_000, onRefreshFailure })
    credentials.current = oauth(Date.now() + 60_000)
    refresh.mockRejectedValue(TERMINAL)

    await refresher.start()
    await vi.advanceTimersByTimeAsync(55_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(sink.noteRefreshFailure).toHaveBeenCalledWith(TERMINAL, 0, expect.any(Number))
    expect(onRefreshFailure).toHaveBeenCalledWith(TERMINAL)

    await vi.advanceTimersByTimeAsync(10 * HOUR)
    expect(refresh).toHaveBeenCalledTimes(1)
    refresher.dispose()
  })

  it('retries transient failures with capped backoff and recovers', async () => {
    const { credentials, refresh, sink, refresher } = fixture({ marginMs: 5_000 })
    credentials.current = oauth(Date.now() + 60_000)
    refresh.mockRejectedValue(TRANSIENT)

    await refresher.start()
    await vi.advanceTimersByTimeAsync(55_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(sink.noteRefreshFailure).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(59_999)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledTimes(2)

    // Second retry waits the capped five-minute delay.
    await vi.advanceTimersByTimeAsync(299_999)
    expect(refresh).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledTimes(3)

    // Recovery re-arms from the rotated credential.
    refresh.mockImplementation(async current => ({
      ...current,
      expires: Date.now() + HOUR,
    }))
    await vi.advanceTimersByTimeAsync(300_000)
    expect(refresh).toHaveBeenCalledTimes(4)
    expect(sink.noteRefreshFailure).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(HOUR - 5_000)
    expect(refresh).toHaveBeenCalledTimes(5)
    refresher.dispose()
  })

  it('keeps the schedule alive across a credential-store read hiccup', async () => {
    const { credentials, refresh, refresher } = fixture({ marginMs: 5_000 })
    credentials.current = oauth(Date.now() + 60_000)

    await refresher.start()
    credentials.failReads(new Error('Harness credential backend unavailable'))
    await vi.advanceTimersByTimeAsync(55_000)
    expect(refresh).not.toHaveBeenCalled()

    // The hiccup schedules a one-minute retry instead of killing the timer.
    credentials.healReads()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(HOUR - 5_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    refresher.dispose()
  })

  it('retries instead of going silent when the startup read fails', async () => {
    const { credentials, refresh, refresher } = fixture({ marginMs: 5_000 })
    credentials.current = oauth(Date.now() + 60_000)
    credentials.failReads(new Error('Harness credential backend unavailable'))

    await refresher.start()
    credentials.healReads()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    refresher.dispose()
  })

  it('runs ticks single-flight while a refresh is in progress', async () => {
    const { credentials, refresh, refresher } = fixture({ marginMs: 5_000 })
    credentials.current = oauth(Date.now() + 60_000)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    refresh.mockImplementation(async current => {
      await gate
      return { ...current, expires: Date.now() + HOUR }
    })

    await refresher.start()
    await vi.advanceTimersByTimeAsync(55_000)
    expect(refresh).toHaveBeenCalledTimes(1)

    // A concurrent connected publish must not start a second overlapping tick.
    refresher.observe({ phase: 'connected', expiresAt: Date.now() + 60_000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(1)

    release()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(refresh).toHaveBeenCalledTimes(2)
    refresher.dispose()
  })

  it('recovers when an in-flight timer refresh disproves a terminal failure', async () => {
    const { credentials, getAuth, refresh, sink, refresher } = fixture({ marginMs: 5_000 })
    credentials.current = oauth(Date.now() + 60_000)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    refresh.mockImplementation(async current => {
      await gate
      return { ...current, expires: Date.now() + HOUR }
    })

    await refresher.start()
    await vi.advanceTimersByTimeAsync(55_000)
    expect(refresh).toHaveBeenCalledTimes(1) // tick parked inside the locked refresh

    // A request-path terminal failure lands while the tick is still refreshing.
    getAuth.mockRejectedValueOnce(new Error(`OAuth refresh failed for openai-codex: ${TERMINAL.message}`))
    await expect(refresher.getAuth(CODEX_PROVIDER)).rejects.toThrow('invalid_grant')
    expect(sink.noteRefreshFailure).toHaveBeenCalledTimes(1)

    // The completed rotation is newer evidence than the failure and recovers.
    release()
    await vi.waitFor(() => { expect(sink.noteRefreshSuccess).toHaveBeenCalledTimes(1) })
    const rotated = credentials.current
    expect(rotated?.type === 'oauth' && rotated.expires > Date.now()).toBe(true)

    // AuthService publishes connected synchronously from the success sink while
    // the old tick is still settling; that newer epoch must get its own timer.
    if (rotated?.type !== 'oauth') throw new Error('expected rotated OAuth credential')
    refresher.observe({ phase: 'connected', expiresAt: rotated.expires })
    await vi.advanceTimersByTimeAsync(HOUR - 5_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    refresher.dispose()
  })

  it('does not arm when stop invalidates an in-flight startup read', async () => {
    const { credentials, refresh, refresher } = fixture({ marginMs: 5_000 })
    credentials.current = oauth(Date.now() + 60_000)
    const originalRead = credentials.read.bind(credentials)
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const reading = new Promise<void>(resolve => { entered = resolve })
    let first = true
    credentials.read = async (providerId) => {
      if (first) {
        first = false
        entered()
        await gate
      }
      return originalRead(providerId)
    }

    const starting = refresher.start()
    await reading
    refresher.stop()
    release()
    await starting
    await vi.advanceTimersByTimeAsync(HOUR)

    expect(refresh).not.toHaveBeenCalled()
    refresher.dispose()
  })

  it('does not settle a live credential back into the schedule after stop', async () => {
    const { credentials, refresh, refresher } = fixture({ marginMs: 5_000 })
    credentials.current = oauth(Date.now() + 60_000)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    refresh.mockImplementation(async current => {
      await gate
      return { ...current, expires: Date.now() + HOUR }
    })

    await refresher.start()
    await vi.advanceTimersByTimeAsync(55_000)
    expect(refresh).toHaveBeenCalledTimes(1)

    refresher.stop()
    release()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    expect(refresh).toHaveBeenCalledTimes(1)
    refresher.dispose()
  })

  it('does not re-arm or retry when logout stops an in-flight tick', async () => {
    const { credentials, refresh, refresher } = fixture({ marginMs: 5_000 })
    credentials.current = oauth(Date.now() + 60_000)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    refresh.mockImplementation(async () => {
      await gate
      throw TRANSIENT
    })

    await refresher.start()
    await vi.advanceTimersByTimeAsync(55_000)
    expect(refresh).toHaveBeenCalledTimes(1)

    // Logout mid-refresh: the late transient failure must schedule nothing.
    credentials.current = undefined
    refresher.observe({ phase: 'disconnected' })
    release()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    expect(refresh).toHaveBeenCalledTimes(1)
    refresher.dispose()
  })

  it('does not arm when proactive refresh is disabled', async () => {
    const { credentials, refresh, refresher } = fixture({ proactive: false, marginMs: 5_000 })
    credentials.current = oauth(Date.now() + 60_000)

    await refresher.start()
    refresher.observe({ phase: 'connected', expiresAt: Date.now() + 60_000 })
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    expect(refresh).not.toHaveBeenCalled()
    refresher.dispose()
  })

  it('stops the timer when auth state leaves connected', async () => {
    const { credentials, refresh, refresher } = fixture({ marginMs: 5_000 })
    credentials.current = oauth(Date.now() + 60_000)

    await refresher.start()
    refresher.observe({ phase: 'reauth-required' })
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(refresh).not.toHaveBeenCalled()
    refresher.dispose()
  })

  it('stops ticking after dispose', async () => {
    const { credentials, refresh, refresher } = fixture({ marginMs: 5_000 })
    credentials.current = oauth(Date.now() + 60_000)

    await refresher.start()
    refresher.dispose()
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(refresh).not.toHaveBeenCalled()
  })
})
