import { describe, expect, it, vi } from 'vitest'
import type { Credential, CredentialStore } from '@earendil-works/pi-ai'
import {
  CODEX_USAGE_URL,
  CodexUsageService,
  parseCodexUsagePayload,
} from '../src/usage-service.ts'

const OAUTH: Credential = {
  type: 'oauth',
  access: 'stored-access-token',
  refresh: 'refresh-token',
  expires: Date.now() + 60_000,
  accountId: 'account-123',
}

function store(current: Credential | undefined): CredentialStore {
  return {
    read: async () => current,
    list: async () => [],
    modify: async (_provider, operation) => operation(current),
    delete: async () => {},
  }
}

describe('CodexUsageService', () => {
  it('uses refreshed Host auth and returns a redacted dynamic-window snapshot', async () => {
    const fetcher = vi.fn(async (_input: string, _init: RequestInit) => new Response(JSON.stringify({
      plan_type: 'plus',
      rate_limit: {
        limit_reached: false,
        primary_window: null,
        secondary_window: {
          used_percent: 24.4,
          reset_at: 1_738_900_000,
          limit_window_seconds: 604_800,
        },
      },
      credits: { has_credits: true, unlimited: false, balance: '820.69' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const service = new CodexUsageService({
      getAuth: vi.fn(async () => ({ auth: { apiKey: 'fresh-access-token' }, source: 'OAuth' })),
    }, store(OAUTH), fetcher)

    const usage = await service.load()

    expect(usage).toMatchObject({
      planType: 'plus',
      limitReached: false,
      primary: null,
      secondary: {
        usedPercent: 24.4,
        resetAt: 1_738_900_000_000,
        limitWindowSeconds: 604_800,
      },
      credits: { hasCredits: true, unlimited: false, balance: 820.69 },
    })
    expect(JSON.stringify(usage)).not.toContain('token')
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0] ?? []
    expect(url).toBe(CODEX_USAGE_URL)
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Bearer fresh-access-token')
    expect(headers.get('chatgpt-account-id')).toBe('account-123')
    expect(headers.get('accept')).toBe('application/json')
  })

  it('does not call OpenAI when Codex is disconnected', async () => {
    const fetcher = vi.fn()
    const service = new CodexUsageService({ getAuth: vi.fn(async () => undefined) }, store(undefined), fetcher)

    await expect(service.load()).resolves.toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('accepts plans with no active rate-limit windows', () => {
    expect(parseCodexUsagePayload({
      plan_type: 'pro',
      rate_limit: null,
      credits: { has_credits: false, unlimited: false, balance: null },
    }, 42)).toEqual({
      fetchedAt: 42,
      planType: 'pro',
      limitReached: false,
      primary: null,
      secondary: null,
      credits: { hasCredits: false, unlimited: false, balance: null },
    })
  })

  it('rejects malformed payloads rather than forwarding arbitrary fields', () => {
    expect(() => parseCodexUsagePayload({
      rate_limit: { primary_window: null, secondary_window: null },
      access_token: 'secret',
    })).toThrow('no displayable usage data')
    expect(() => parseCodexUsagePayload({
      rate_limit: { primary_window: { used_percent: -1 } },
    })).toThrow('invalid rate-limit window')
  })
})
