import { describe, expect, it, vi } from 'vitest'
import type { AuthInteraction, Credential, CredentialStore } from '@earendil-works/pi-ai'
import { CodexAuthService } from '../src/auth-service.ts'
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
    let finish!: () => void
    const completion = new Promise<void>(resolve => { finish = resolve })
    const auth = new CodexAuthService(models(credentials, async (interaction) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.example/start' })
      await completion
      return OAUTH
    }), credentials)

    expect(auth.login('browser')).toEqual({ phase: 'starting', method: 'browser' })
    await vi.waitFor(async () => {
      await expect(auth.status()).resolves.toEqual({
        phase: 'awaiting-browser', authorizationUrl: 'https://auth.example/start',
      })
    })
    finish()
    await vi.waitFor(async () => {
      await expect(auth.status()).resolves.toEqual({ phase: 'connected', expiresAt: OAUTH.expires })
    })
  })

  it('cancels active work and removes stored credentials on logout', async () => {
    const credentials = store()
    credentials.current = OAUTH
    const auth = new CodexAuthService(models(credentials, async interaction => {
      await interaction.prompt({ type: 'manual_code', message: 'wait' })
      return OAUTH
    }), credentials)

    auth.login('device')
    await expect(auth.logout()).resolves.toEqual({ phase: 'disconnected' })
    expect(credentials.current).toBeUndefined()
  })
})
