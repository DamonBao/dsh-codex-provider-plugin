import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-runtime/client', () => ({
  createSnapshotStore: <T>(initial: T) => {
    let state = structuredClone(initial)
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      update: (mutate: (draft: T) => void) => {
        state = structuredClone(state)
        mutate(state)
        for (const listener of listeners) listener()
      },
    }
  },
}))

import { CodexAuthCardController } from '../src/client/controller.ts'
import type { CodexAuthRpcClient } from '../src/rpc-contract.ts'
import type { CodexAuthState, CodexNetworkState, CodexUsageSnapshot } from '../src/types.ts'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const NETWORK: CodexNetworkState = {
  route: 'direct-or-tun',
  activeProxyMode: 'auto',
  configuredProxyMode: 'auto',
  restartRequired: false,
}

function remote(overrides: Partial<CodexAuthRpcClient>): CodexAuthRpcClient {
  const disconnected: CodexAuthState = { phase: 'disconnected' }
  return {
    status: async () => ({ ok: true, value: disconnected }),
    network: async () => ({ ok: true, value: NETWORK }),
    setProxyMode: async mode => ({
      ok: true,
      value: { ...NETWORK, configuredProxyMode: mode, restartRequired: mode !== NETWORK.activeProxyMode },
    }),
    usage: async () => ({ ok: true, value: null }),
    login: async () => ({ ok: true, value: { phase: 'starting', method: 'browser' } }),
    cancel: async () => ({ ok: true, value: disconnected }),
    logout: async () => ({ ok: true, value: disconnected }),
    ...overrides,
  }
}

const USAGE: CodexUsageSnapshot = {
  fetchedAt: 42,
  planType: 'plus',
  limitReached: false,
  primary: null,
  secondary: { usedPercent: 24, resetAt: 1_700_000_000_000, limitWindowSeconds: 604_800 },
  credits: null,
}

describe('CodexAuthCardController', () => {
  it('publishes connected auth without waiting for a slow usage request', async () => {
    const usage = deferred<Awaited<ReturnType<CodexAuthRpcClient['usage']>>>()
    const controller = new CodexAuthCardController(remote({
      status: vi.fn(async () => ({ ok: true as const, value: { phase: 'connected' as const, expiresAt: 100 } })),
      usage: vi.fn(() => usage.promise),
    }))

    const loading = controller.load()
    await vi.waitFor(() => {
      expect(controller.store.getSnapshot()).toMatchObject({
        status: 'ready',
        auth: { phase: 'connected' },
        usageStatus: 'loading',
      })
    })

    usage.resolve({ ok: true, value: USAGE })
    await loading
    expect(controller.store.getSnapshot()).toMatchObject({ usageStatus: 'ready', usage: USAGE })
  })

  it('does not let a stale load resurrect auth after logout', async () => {
    const status = deferred<Awaited<ReturnType<CodexAuthRpcClient['status']>>>()
    const usage = deferred<Awaited<ReturnType<CodexAuthRpcClient['usage']>>>()
    const controller = new CodexAuthCardController(remote({
      status: vi.fn(() => status.promise),
      usage: vi.fn(() => usage.promise),
    }))

    const loading = controller.load()
    controller.logout()
    await vi.waitFor(() => {
      expect(controller.store.getSnapshot().auth).toEqual({ phase: 'disconnected' })
      expect(controller.store.getSnapshot().action).toBeNull()
    })

    status.resolve({ ok: true, value: { phase: 'connected', expiresAt: 100 } })
    usage.resolve({ ok: true, value: USAGE })
    await loading
    expect(controller.store.getSnapshot()).toMatchObject({
      auth: { phase: 'disconnected' },
      usage: null,
    })
  })

  it('surfaces a failed network-status RPC instead of staying in loading', async () => {
    const controller = new CodexAuthCardController(remote({
      network: vi.fn(async () => { throw new Error('connection reset') }),
    }))

    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({
      networkStatus: 'error',
      network: null,
    })
  })

  it('publishes the restart-required snapshot after saving proxy mode', async () => {
    const setProxyMode = vi.fn(async () => ({
      ok: true as const,
      value: { ...NETWORK, configuredProxyMode: 'off' as const, restartRequired: true },
    }))
    const controller = new CodexAuthCardController(remote({ setProxyMode }))
    await controller.load()

    controller.setProxyMode('off')
    await vi.waitFor(() => {
      expect(controller.store.getSnapshot()).toMatchObject({
        action: null,
        network: { activeProxyMode: 'auto', configuredProxyMode: 'off', restartRequired: true },
      })
    })
    expect(setProxyMode).toHaveBeenCalledWith('off')
  })

  it('clears usage and stays actionable when the Host reports reauth-required', async () => {
    const controller = new CodexAuthCardController(remote({
      status: vi.fn(async () => ({ ok: true as const, value: { phase: 'reauth-required' as const } })),
      usage: vi.fn(async () => ({ ok: true as const, value: USAGE })),
    }))

    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready',
      auth: { phase: 'reauth-required' },
      usage: null,
      action: null,
    })
  })
})
