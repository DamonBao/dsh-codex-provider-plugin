/** Host dispatcher for the plugin-owned Connection RPC channel. */

import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { CodexAuthService } from './auth-service.ts'
import type { CodexLoginMethod } from './types.ts'
export { CODEX_AUTH_RPC_CHANNEL } from './rpc-contract.ts'

/** Dispatch a decoded Host request without exposing token material. */
export async function handleCodexAuthRpc(
  service: Pick<CodexAuthService, 'status' | 'login' | 'cancel' | 'logout'>,
  endpoint: string,
  payload: unknown,
): Promise<RpcResult<unknown>> {
  if (endpoint === 'status' || endpoint === 'cancel' || endpoint === 'logout') {
    if (!isEmptyRecord(payload)) return badRequest(`${endpoint} expects an empty payload`)
    try {
      if (endpoint === 'status') return { ok: true, value: await service.status() }
      if (endpoint === 'cancel') return { ok: true, value: await service.cancel() }
      return { ok: true, value: await service.logout() }
    } catch {
      return internalError()
    }
  }
  if (endpoint === 'login') {
    if (!isRecord(payload) || !isLoginMethod(payload.method)
      || Object.keys(payload).some(key => key !== 'method')) {
      return badRequest('login expects { method: "browser" | "device" }')
    }
    try {
      return { ok: true, value: service.login(payload.method) }
    } catch {
      return internalError()
    }
  }
  return badRequest(`unknown Codex provider endpoint ${JSON.stringify(endpoint)}`)
}

function badRequest(message: string): RpcResult<never> {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

function internalError(): RpcResult<never> {
  return {
    ok: false,
    error: { code: 'internal', message: 'Codex authentication operation failed', details: {} },
  }
}

function isEmptyRecord(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLoginMethod(value: unknown): value is CodexLoginMethod {
  return value === 'browser' || value === 'device'
}
