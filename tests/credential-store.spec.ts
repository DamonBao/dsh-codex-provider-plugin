import { describe, expect, it, vi } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { CODEX_PROVIDER, CodexCredentialStore } from '../src/credential-store.ts'

const REF = credentialRef('OPENAI_CODEX_OAUTH')
const OAUTH = {
  type: 'oauth' as const,
  access: 'access-token',
  refresh: 'refresh-token',
  expires: Date.now() + 60_000,
}

function memory(seed?: string): { provider: CredentialProvider; value: () => string | undefined } {
  let value = seed
  const provider = {
    resolve: vi.fn(async () => value === undefined ? undefined : { value, source: 'memory' }),
    describe: vi.fn(async () => ({ configured: value !== undefined, source: 'memory', writable: true })),
    set: vi.fn(async (_ref, next: string): Promise<void> => { value = next }),
    unset: vi.fn(async (): Promise<void> => { value = undefined }),
  } as unknown as CredentialProvider
  return { provider, value: () => value }
}

describe('CodexCredentialStore', () => {
  it('reads, updates, lists, and deletes OAuth state without exposing it in metadata', async () => {
    const source = memory(JSON.stringify(OAUTH))
    const store = new CodexCredentialStore(source.provider, REF)

    await expect(store.read(CODEX_PROVIDER)).resolves.toEqual(OAUTH)
    await expect(store.list()).resolves.toEqual([{ providerId: CODEX_PROVIDER, type: 'oauth' }])
    await store.modify(CODEX_PROVIDER, async current => ({ ...current as typeof OAUTH, access: 'next' }))
    expect(JSON.parse(source.value() ?? '')).toMatchObject({ access: 'next' })
    await store.delete(CODEX_PROVIDER)
    await expect(store.read(CODEX_PROVIDER)).resolves.toBeUndefined()
  })

  it('rejects malformed state and foreign provider ids', async () => {
    const store = new CodexCredentialStore(memory('{').provider, REF)
    await expect(store.read(CODEX_PROVIDER)).rejects.toThrow(/OPENAI_CODEX_OAUTH/)
    await expect(store.read('openai')).rejects.toThrow(/does not own provider/)
  })
})
