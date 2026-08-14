import { describe, expect, it, vi } from 'vitest'
import { createCodexAuthRpcClient, parseCodexAuthState } from '../src/rpc-contract.ts'
import { handleCodexAuthRpc } from '../src/rpc.ts'

describe('Codex authentication RPC', () => {
  it('validates Host requests and redacts internal failures', async () => {
    const service = {
      status: vi.fn(async () => ({ phase: 'disconnected' as const })),
      login: vi.fn(() => ({ phase: 'starting' as const, method: 'browser' as const })),
      cancel: vi.fn(async () => ({ phase: 'disconnected' as const })),
      logout: vi.fn(async () => { throw new Error('secret provider response') }),
    }

    await expect(handleCodexAuthRpc(service, 'status', {})).resolves.toEqual({
      ok: true, value: { phase: 'disconnected' },
    })
    await expect(handleCodexAuthRpc(service, 'login', { method: 'browser' })).resolves.toEqual({
      ok: true, value: { phase: 'starting', method: 'browser' },
    })
    await expect(handleCodexAuthRpc(service, 'login', { method: 'bad' })).resolves.toMatchObject({
      ok: false, error: { code: 'bad-request' },
    })
    const failed = await handleCodexAuthRpc(service, 'logout', {})
    expect(failed).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(JSON.stringify(failed)).not.toContain('secret')
  })

  it('validates untrusted Host replies before updating browser state', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: { phase: 'connected', expiresAt: 42 } }))
    const client = createCodexAuthRpcClient({ call })

    await expect(client.status()).resolves.toEqual({
      ok: true, value: { phase: 'connected', expiresAt: 42 },
    })
    expect(parseCodexAuthState({ phase: 'connected', expiresAt: 'secret' })).toBeUndefined()
    expect(parseCodexAuthState({ phase: 'awaiting-device', verificationUri: 'https://x', userCode: 'ABCD' }))
      .toEqual({ phase: 'awaiting-device', verificationUri: 'https://x', userCode: 'ABCD' })
    expect(parseCodexAuthState({ phase: 'failed', method: 'browser', reason: 'browser-callback' }))
      .toEqual({ phase: 'failed', method: 'browser', reason: 'browser-callback' })
    expect(parseCodexAuthState({ phase: 'failed', method: 'browser', reason: 'unsupported-region' }))
      .toEqual({ phase: 'failed', method: 'browser', reason: 'unsupported-region' })
    expect(parseCodexAuthState({ phase: 'failed', method: 'browser', reason: 'secret-response-text' }))
      .toBeUndefined()
  })
})
