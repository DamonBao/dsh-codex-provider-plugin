import { describe, expect, it, vi } from 'vitest'
import { createModels } from '@earendil-works/pi-ai'
import type { AuthInteraction, Credential, CredentialStore } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { classifyCodexLoginFailure, CodexAuthService, codexAuthModels } from '../src/auth-service.ts'
import type { CodexAuthModels } from '../src/auth-service.ts'

const OAUTH: Credential = {
  type: 'oauth',
  access: 'access-token',
  refresh: 'refresh-token',
  expires: Date.now() + 60_000,
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

function models(
  state: MutableStore,
  login: (interaction: AuthInteraction) => Promise<Credential>,
): CodexAuthModels {
  return {
    login: async (_provider, _type, interaction) => {
      const credential = await login(interaction)
      state.current = credential
      return credential
    },
    logout: async () => { state.current = undefined },
  }
}

describe('CodexAuthService', () => {
  it('publishes browser authorization and completes in background', async () => {
    const credentials = store()
    const closeBridge = vi.fn(async () => {})
    let finish!: () => void
    const completion = new Promise<void>(resolve => { finish = resolve })
    const auth = new CodexAuthService(models(credentials, async (interaction) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.example/start' })
      await completion
      return OAUTH
    }), credentials, async () => ({ close: closeBridge }))

    expect(auth.login('browser')).toEqual({ phase: 'starting', method: 'browser' })
    await vi.waitFor(async () => {
      await expect(auth.status()).resolves.toEqual({
        phase: 'awaiting-browser', authorizationUrl: 'https://auth.example/start',
      })
    })
    finish()
    await vi.waitFor(async () => {
      await expect(auth.status()).resolves.toEqual({ phase: 'connected', expiresAt: OAUTH.expires })
      expect(closeBridge).toHaveBeenCalledOnce()
    })
  })

  it('cancels active work and removes stored credentials on logout', async () => {
    const credentials = store()
    credentials.current = OAUTH
    const startBridge = vi.fn(async () => ({ close: async () => {} }))
    const auth = new CodexAuthService(models(credentials, async interaction => {
      await interaction.prompt({ type: 'manual_code', message: 'wait' })
      return OAUTH
    }), credentials, startBridge)

    auth.login('device')
    await expect(auth.logout()).resolves.toEqual({ phase: 'disconnected' })
    expect(credentials.current).toBeUndefined()
    expect(startBridge).not.toHaveBeenCalled()
  })

  it.each([
    ['OpenAI Codex device code login is not enabled for this server', 'device-code-disabled'],
    ['OpenAI Codex token exchange failed (403): unsupported_country_region_territory', 'unsupported-region'],
    ['Failed to extract accountId from token', 'account-access'],
    ['OpenAI Codex token exchange failed (403): forbidden', 'account-access'],
    ['Missing authorization code', 'browser-callback'],
    ['OpenAI Codex token exchange failed (400): invalid_grant', 'token-exchange'],
    ['TypeError: fetch failed', 'network'],
    ['unexpected provider failure containing secret-response-text', 'unknown'],
  ] as const)('classifies %s without returning the provider message', (message, reason) => {
    expect(classifyCodexLoginFailure(new Error(message))).toBe(reason)
  })

  it('publishes only a secret-free failure reason and login method', async () => {
    const credentials = store()
    const reportFailure = vi.fn()
    const auth = new CodexAuthService(models(credentials, async () => {
      throw new Error('Failed to extract accountId from token: secret-response-text')
    }), credentials, undefined, reportFailure)

    expect(auth.login('browser')).toEqual({ phase: 'starting', method: 'browser' })
    await vi.waitFor(async () => {
      const status = await auth.status()
      expect(status).toEqual({ phase: 'failed', method: 'browser', reason: 'account-access' })
      expect(JSON.stringify(status)).not.toContain('secret-response-text')
      expect(reportFailure).toHaveBeenCalledWith(expect.any(Error), 'browser')
    })
  })

  it('fails immediately when browser callback preparation rejects', async () => {
    const credentials = store()
    const login = vi.fn(async () => OAUTH)
    const auth = new CodexAuthService(
      models(credentials, login),
      credentials,
      async () => { throw new Error('Codex browser callback cannot listen on 127.0.0.1:1455') },
    )

    auth.login('browser')
    await vi.waitFor(async () => {
      await expect(auth.status()).resolves.toEqual({
        phase: 'failed', method: 'browser', reason: 'browser-callback',
      })
    })
    expect(login).not.toHaveBeenCalled()
  })

  it('drives the real pi-ai device-code branch without opening a browser callback', async () => {
    const credentials = store()
    const fetchMock = vi.fn(async () => new Response('', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    const piModels = createModels({ credentials })
    piModels.setProvider(openaiCodexProvider())
    const startBridge = vi.fn(async () => ({ close: async () => {} }))
    const auth = new CodexAuthService(codexAuthModels(piModels), credentials, startBridge)

    try {
      auth.login('device')
      await vi.waitFor(async () => {
        await expect(auth.status()).resolves.toEqual({
          phase: 'failed', method: 'device', reason: 'device-code-disabled',
        })
      })
      expect(fetchMock).toHaveBeenCalledWith(
        'https://auth.openai.com/api/accounts/deviceauth/usercode',
        expect.objectContaining({ method: 'POST' }),
      )
      expect(startBridge).not.toHaveBeenCalled()
    } finally {
      await auth.cancel()
      vi.unstubAllGlobals()
    }
  })
})
