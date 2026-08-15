import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthResult, Credential, CredentialStore } from '@earendil-works/pi-ai'
import { CODEX_PROVIDER } from '../src/credential-store.ts'
import { CodexTokenRefresher, isTerminalRefreshError } from '../src/token-resolver.ts'
import type { CodexRefreshSink, CodexTokenRefresherOptions } from '../src/token-resolver.ts'
import type { CodexUsageModels } from '../src/usage-service.ts'

const HOUR = 3_600_000

function oauth(expires: number): Credential {
  return { type: 'oauth', access: 'access-token', refresh: 'refresh-token', expires }
}

type MutableStore = CredentialStore & { current: Credential | undefined }

function store(): MutableStore {
  const value: MutableStore = {
    current: undefined,
    read: async () => value.current,
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
const TERMINAL = new Error('OAuth refresh failed for openai-codex: token refresh error: invalid_grant')
const TRANSIENT = new TypeError('fetch failed')

interface Fixture {
  credentials: MutableStore
  getAuth: ReturnType<typeof vi.fn<(providerId: string) => Promise<AuthResult | undefined>>>
  sink: Record<keyof CodexRefreshSink, ReturnType<typeof vi.fn>>
  refresher: CodexTokenRefresher
}

function fixture(options?: CodexTokenRefresherOptions): Fixture {
  const credentials = store()
  const getAuth = vi.fn(async (): Promise<AuthResult | undefined> => AUTH)
  const sink = { noteRefreshSuccess: vi.fn(), noteRefreshFailure: vi.fn() }
  const models: CodexUsageModels = { getAuth }
  const refresher = new CodexTokenRefresher(models, credentials, sink, options)
  return { credentials, getAuth, sink, refresher }
}

describe('isTerminalRefreshError', () => {
  it.each([
    [TERMINAL, true],
    [new Error('OpenAI Codex token refresh error (403): forbidden'), true],
    [TRANSIENT, false],
    [new Error('socket hangup'), false],
  ])('classifies %s as terminal=%s', (error, terminal) => {
    expect(isTerminalRefreshError(error)).toBe(terminal)
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
    getAuth.mockRejectedValue(TERMINAL)

    await expect(refresher.getAuth(CODEX_PROVIDER)).rejects.toBe(TERMINAL)
    expect(sink.noteRefreshFailure).toHaveBeenCalledWith(TERMINAL)
    expect(onRefreshFailure).toHaveBeenCalledWith(TERMINAL)
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
    getAuth.mockRejectedValueOnce(TERMINAL)
    await expect(refresher.getAuth(CODEX_PROVIDER)).rejects.toBe(TERMINAL)

    const rotated = Date.now() + HOUR
    credentials.current = oauth(rotated)
    await expect(refresher.getAuth(CODEX_PROVIDER)).resolves.toBe(AUTH)
    expect(sink.noteRefreshSuccess).toHaveBeenCalledWith(rotated)

    // A steady-state success stays silent afterwards.
    await refresher.getAuth(CODEX_PROVIDER)
    expect(sink.noteRefreshSuccess).toHaveBeenCalledTimes(1)
  })
})

describe('CodexTokenRefresher proactive timer', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('refreshes ahead of expiry and re-arms from the rotated credential', async () => {
    const { credentials, getAuth, refresher } = fixture({ marginMs: 5_000 })
    credentials.current = oauth(Date.now() + 60_000)
    getAuth.mockImplementation(async () => {
      // Rotate like pi-ai would under the modify lock.
      credentials.current = oauth(Date.now() + HOUR)
      return AUTH
    })

    await refresher.start()
    await vi.advanceTimersByTimeAsync(54_999)
    expect(getAuth).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(getAuth).toHaveBeenCalledTimes(1)

    // Re-armed at rotated expiry minus margin, measured from the first tick.
    await vi.advanceTimersByTimeAsync(HOUR - 5_000 - 1)
    expect(getAuth).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(getAuth).toHaveBeenCalledTimes(2)
    refresher.dispose()
  })

  it('skips the request when another path already rotated the credential', async () => {
    const { credentials, getAuth, refresher } = fixture({ marginMs: 5_000 })
    credentials.current = oauth(Date.now() + 60_000)

    await refresher.start()
    // A request-path refresh rotates the credential before the timer fires.
    credentials.current = oauth(Date.now() + HOUR)
    await vi.advanceTimersByTimeAsync(55_000)
    expect(getAuth).not.toHaveBeenCalled()

    // Re-armed against the rotated expiry: fires exactly at the new margin.
    await vi.advanceTimersByTimeAsync(HOUR - 60_000 - 1)
    expect(getAuth).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(getAuth).toHaveBeenCalledTimes(1)
    refresher.dispose()
  })

  it('stops after a terminal failure on the timer path', async () => {
    const onRefreshFailure = vi.fn()
    const { credentials, getAuth, sink, refresher } = fixture({ marginMs: 5_000, onRefreshFailure })
    credentials.current = oauth(Date.now() + 60_000)
    getAuth.mockRejectedValue(TERMINAL)

    await refresher.start()
    await vi.advanceTimersByTimeAsync(55_000)
    expect(getAuth).toHaveBeenCalledTimes(1)
    expect(sink.noteRefreshFailure).toHaveBeenCalledWith(TERMINAL)
    expect(onRefreshFailure).toHaveBeenCalledWith(TERMINAL)

    await vi.advanceTimersByTimeAsync(10 * HOUR)
    expect(getAuth).toHaveBeenCalledTimes(1)
    refresher.dispose()
  })

  it('retries transient failures with capped backoff and recovers', async () => {
    const { credentials, getAuth, sink, refresher } = fixture({ marginMs: 5_000 })
    credentials.current = oauth(Date.now() + 60_000)
    getAuth.mockRejectedValue(TRANSIENT)

    await refresher.start()
    await vi.advanceTimersByTimeAsync(55_000)
    expect(getAuth).toHaveBeenCalledTimes(1)
    expect(sink.noteRefreshFailure).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(59_999)
    expect(getAuth).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(getAuth).toHaveBeenCalledTimes(2)

    // Second retry waits the capped five-minute delay.
    await vi.advanceTimersByTimeAsync(299_999)
    expect(getAuth).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(getAuth).toHaveBeenCalledTimes(3)

    // Recovery re-arms from the rotated credential.
    getAuth.mockImplementation(async () => {
      credentials.current = oauth(Date.now() + HOUR)
      return AUTH
    })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(getAuth).toHaveBeenCalledTimes(4)
    expect(sink.noteRefreshFailure).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(HOUR - 5_000)
    expect(getAuth).toHaveBeenCalledTimes(5)
    refresher.dispose()
  })

  it('does not arm when proactive refresh is disabled', async () => {
    const { credentials, getAuth, refresher } = fixture({ proactive: false, marginMs: 5_000 })
    credentials.current = oauth(Date.now() + 60_000)

    await refresher.start()
    refresher.observe({ phase: 'connected', expiresAt: Date.now() + 60_000 })
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    expect(getAuth).not.toHaveBeenCalled()
    refresher.dispose()
  })

  it('stops the timer when auth state leaves connected', async () => {
    const { credentials, getAuth, refresher } = fixture({ marginMs: 5_000 })
    credentials.current = oauth(Date.now() + 60_000)

    await refresher.start()
    refresher.observe({ phase: 'reauth-required' })
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(getAuth).not.toHaveBeenCalled()
    refresher.dispose()
  })

  it('stops ticking after dispose', async () => {
    const { credentials, getAuth, refresher } = fixture({ marginMs: 5_000 })
    credentials.current = oauth(Date.now() + 60_000)

    await refresher.start()
    refresher.dispose()
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(getAuth).not.toHaveBeenCalled()
  })
})
