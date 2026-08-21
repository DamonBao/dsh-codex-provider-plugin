/** Browser projection of the Host-owned authentication RPC. */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { CodexAuthRpcClient } from '../rpc-contract.ts'
import type {
  CodexAuthState,
  CodexLoginMethod,
  CodexNetworkState,
  CodexProxyMode,
  CodexUsageSnapshot,
} from '../types.ts'

/** One UI action crossing the wire. */
export type CodexAuthAction = 'login' | 'cancel' | 'logout' | 'proxy-mode'

/** Snapshot rendered by the settings page. */
export interface CodexAuthCardState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  auth: CodexAuthState
  networkStatus: 'idle' | 'loading' | 'ready' | 'error'
  network: CodexNetworkState | null
  usageStatus: 'idle' | 'loading' | 'ready' | 'error'
  usage: CodexUsageSnapshot | null
  action: CodexAuthAction | null
  actionFailed: boolean
}

/** Registration-side business face for the Codex settings page. */
export interface CodexAuthCardFace {
  hooks: {
    codexAuth: SnapshotStore<CodexAuthCardState>
  }
  isLoopback: boolean
  load: () => void
  refresh: () => void
  setProxyMode: (mode: CodexProxyMode) => void
  login: (method: CodexLoginMethod) => void
  cancel: () => void
  logout: () => void
}

/** Join RPC replies and connection invalidations into one observable view. */
export class CodexAuthCardController {
  readonly store = createSnapshotStore<CodexAuthCardState>({
    status: 'idle',
    auth: { phase: 'disconnected' },
    networkStatus: 'idle',
    network: null,
    usageStatus: 'idle',
    usage: null,
    action: null,
    actionFailed: false,
  })

  private loadGeneration = 0

  constructor(private readonly remote: CodexAuthRpcClient) {}

  /** Read auth, network, and usage concurrently; the latest invocation wins. */
  async load(silent = false): Promise<void> {
    const generation = ++this.loadGeneration
    if (!silent) {
      this.store.update((state) => {
        state.status = 'loading'
        state.networkStatus = 'loading'
        state.usageStatus = 'loading'
        state.actionFailed = false
      })
    }
    // Start every call together, but publish auth as soon as it arrives so a
    // slow usage endpoint never prolongs the fast login-status polling loop.
    const authTask = this.remote.status().catch(() => undefined)
    const networkTask = this.remote.network().catch(() => undefined)
    const usageTask = this.remote.usage().catch(() => undefined)
    const authResult = await authTask
    if (generation !== this.loadGeneration) return
    this.store.update((state) => {
      if (authResult?.ok === true) {
        state.status = 'ready'
        state.auth = authResult.value
        state.action = null
        state.actionFailed = false
        if (authResult.value.phase === 'connected' && state.usage === null) state.usageStatus = 'loading'
      } else if (!silent) {
        state.status = 'error'
        state.actionFailed = false
      }
      if (state.auth.phase !== 'connected') state.usage = null
    })

    const networkResult = await networkTask
    if (generation !== this.loadGeneration) return
    this.store.update((state) => {
      if (networkResult?.ok === true) {
        state.networkStatus = 'ready'
        state.network = networkResult.value
      } else if (!silent) {
        state.networkStatus = 'error'
      }
    })

    const usageResult = await usageTask
    if (generation !== this.loadGeneration) return
    this.store.update((state) => {
      if (usageResult?.ok === true) {
        state.usageStatus = 'ready'
        state.usage = state.auth.phase === 'connected' ? usageResult.value : null
      } else {
        state.usageStatus = 'error'
      }
    })
  }

  private accept(auth: CodexAuthState): void {
    this.store.update((state) => {
      state.status = 'ready'
      state.auth = auth
      state.action = null
      state.actionFailed = false
      if (auth.phase !== 'connected') {
        state.usageStatus = 'idle'
        state.usage = null
      }
    })
  }

  setProxyMode(mode: CodexProxyMode): void {
    void this.runProxyMode(mode)
  }

  private async runProxyMode(mode: CodexProxyMode): Promise<void> {
    if (this.store.getSnapshot().action !== null) return
    ++this.loadGeneration
    this.store.update((state) => {
      state.action = 'proxy-mode'
      state.actionFailed = false
    })
    try {
      const result = await this.remote.setProxyMode(mode)
      if (!result.ok) throw new Error('Codex proxy-mode RPC failed')
      this.store.update((state) => {
        state.networkStatus = 'ready'
        state.network = result.value
        state.action = null
        state.actionFailed = false
      })
    } catch {
      this.store.update((state) => {
        state.action = null
        state.actionFailed = true
      })
    }
  }

  login(method: CodexLoginMethod): void {
    void this.run('login', async () => this.remote.login(method))
  }

  cancel(): void {
    void this.run('cancel', async () => this.remote.cancel())
  }

  logout(): void {
    void this.run('logout', async () => this.remote.logout())
  }

  private async run(
    action: CodexAuthAction,
    operation: () => ReturnType<CodexAuthRpcClient['status']>,
  ): Promise<void> {
    if (this.store.getSnapshot().action !== null) return
    ++this.loadGeneration
    this.store.update((state) => {
      state.action = action
      state.actionFailed = false
    })
    try {
      const result = await operation()
      if (!result.ok) throw new Error('Codex authentication RPC failed')
      this.accept(result.value)
    } catch {
      this.store.update((state) => {
        state.action = null
        state.actionFailed = true
      })
    }
  }

  /** Build the stable face registered into the Settings slot. */
  face(isLoopback: boolean): CodexAuthCardFace {
    return {
      hooks: { codexAuth: this.store },
      isLoopback,
      load: () => { void this.load() },
      refresh: () => { void this.load(true) },
      setProxyMode: mode => { this.setProxyMode(mode) },
      login: method => { this.login(method) },
      cancel: () => { this.cancel() },
      logout: () => { this.logout() },
    }
  }
}
