/** Browser-safe dedicated Connection RPC contract owned by this plugin. */

import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { CodexAuthState, CodexLoginMethod } from './types.ts'

/** Logical channel registered by the Host half and called by the browser half. */
export const CODEX_AUTH_RPC_CHANNEL = '/dsh-codex-provider'

/** Browser-safe authentication RPC face. */
export interface CodexAuthRpcClient {
  status(signal?: AbortSignal): Promise<RpcResult<CodexAuthState>>
  login(method: CodexLoginMethod, signal?: AbortSignal): Promise<RpcResult<CodexAuthState>>
  cancel(signal?: AbortSignal): Promise<RpcResult<CodexAuthState>>
  logout(signal?: AbortSignal): Promise<RpcResult<CodexAuthState>>
}

/** Minimal Connection caller required by this package. */
export interface CodexAuthConnectionRpc {
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<RpcResult<unknown>>
}

/** Build the browser face over Connection's plugin-owned unary channel. */
export function createCodexAuthRpcClient(rpc: CodexAuthConnectionRpc): CodexAuthRpcClient {
  const call = async (
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<RpcResult<CodexAuthState>> => {
    const result = await rpc.call(CODEX_AUTH_RPC_CHANNEL, endpoint, payload, signal)
    if (!result.ok) return result
    const state = parseCodexAuthState(result.value)
    return state === undefined ? invalidResponse(endpoint) : { ok: true, value: state }
  }
  return {
    status: signal => call('status', {}, signal),
    login: (method, signal) => call('login', { method }, signal),
    cancel: signal => call('cancel', {}, signal),
    logout: signal => call('logout', {}, signal),
  }
}

/** Validate one untrusted Host reply before it reaches UI state. */
export function parseCodexAuthState(value: unknown): CodexAuthState | undefined {
  if (!isRecord(value) || typeof value.phase !== 'string') return undefined
  switch (value.phase) {
    case 'disconnected': return { phase: 'disconnected' }
    case 'starting':
      return value.method === 'browser' || value.method === 'device'
        ? { phase: 'starting', method: value.method }
        : undefined
    case 'awaiting-browser':
      return typeof value.authorizationUrl === 'string' && value.authorizationUrl.length > 0
        ? { phase: 'awaiting-browser', authorizationUrl: value.authorizationUrl }
        : undefined
    case 'awaiting-device':
      return typeof value.verificationUri === 'string' && value.verificationUri.length > 0
        && typeof value.userCode === 'string' && value.userCode.length > 0
        ? { phase: 'awaiting-device', verificationUri: value.verificationUri, userCode: value.userCode }
        : undefined
    case 'connected':
      return typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)
        ? { phase: 'connected', expiresAt: value.expiresAt }
        : undefined
    case 'failed':
      return value.reason === 'login-failed' ? { phase: 'failed', reason: 'login-failed' } : undefined
    default: return undefined
  }
}

function invalidResponse(endpoint: string): RpcResult<never> {
  return {
    ok: false,
    error: {
      code: 'internal',
      message: `Codex provider returned an invalid ${endpoint} response`,
      details: {},
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
