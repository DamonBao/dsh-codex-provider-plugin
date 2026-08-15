/** Browser-safe dedicated Connection RPC contract owned by this plugin. */

import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {
  CodexAuthFailureReason,
  CodexAuthState,
  CodexLoginMethod,
  CodexUsageCredits,
  CodexUsageSnapshot,
  CodexUsageWindow,
} from './types.ts'

/** Logical channel registered by the Host half and called by the browser half. */
export const CODEX_AUTH_RPC_CHANNEL = '/dsh-codex-provider'

/** Browser-safe authentication RPC face. */
export interface CodexAuthRpcClient {
  status(signal?: AbortSignal): Promise<RpcResult<CodexAuthState>>
  usage(signal?: AbortSignal): Promise<RpcResult<CodexUsageSnapshot | null>>
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
  const callAuth = async (
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<RpcResult<CodexAuthState>> => {
    const result = await rpc.call(CODEX_AUTH_RPC_CHANNEL, endpoint, payload, signal)
    if (!result.ok) return result
    const state = parseCodexAuthState(result.value)
    return state === undefined ? invalidResponse(endpoint) : { ok: true, value: state }
  }
  const callUsage = async (signal?: AbortSignal): Promise<RpcResult<CodexUsageSnapshot | null>> => {
    const result = await rpc.call(CODEX_AUTH_RPC_CHANNEL, 'usage', {}, signal)
    if (!result.ok) return result
    if (result.value === null) return { ok: true, value: null }
    const usage = parseCodexUsageSnapshot(result.value)
    return usage === undefined ? invalidResponse('usage') : { ok: true, value: usage }
  }
  return {
    status: signal => callAuth('status', {}, signal),
    usage: callUsage,
    login: (method, signal) => callAuth('login', { method }, signal),
    cancel: signal => callAuth('cancel', {}, signal),
    logout: signal => callAuth('logout', {}, signal),
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
    case 'reauth-required': return { phase: 'reauth-required' }
    case 'failed':
      return isLoginMethod(value.method) && isFailureReason(value.reason)
        ? { phase: 'failed', method: value.method, reason: value.reason }
        : undefined
    default: return undefined
  }
}

/** Validate one secret-free usage snapshot returned by the Host. */
export function parseCodexUsageSnapshot(value: unknown): CodexUsageSnapshot | undefined {
  if (!isRecord(value)
    || !isFiniteNumber(value.fetchedAt)
    || (value.planType !== null && typeof value.planType !== 'string')
    || typeof value.limitReached !== 'boolean') return undefined
  const primary = parseUsageWindow(value.primary)
  const secondary = parseUsageWindow(value.secondary)
  const credits = parseUsageCredits(value.credits)
  if (primary === undefined || secondary === undefined || credits === undefined) return undefined
  if (primary === null && secondary === null && value.planType === null && credits === null) return undefined
  return {
    fetchedAt: value.fetchedAt,
    planType: value.planType,
    limitReached: value.limitReached,
    primary,
    secondary,
    credits,
  }
}

function parseUsageWindow(value: unknown): CodexUsageWindow | null | undefined {
  if (value === null) return null
  if (!isRecord(value)
    || !isFiniteNumber(value.usedPercent)
    || value.usedPercent < 0
    || value.usedPercent > 100
    || !isNullablePositiveNumber(value.resetAt)
    || !isNullablePositiveNumber(value.limitWindowSeconds)) return undefined
  return {
    usedPercent: value.usedPercent,
    resetAt: value.resetAt,
    limitWindowSeconds: value.limitWindowSeconds,
  }
}

function parseUsageCredits(value: unknown): CodexUsageCredits | null | undefined {
  if (value === null) return null
  if (!isRecord(value)
    || typeof value.hasCredits !== 'boolean'
    || typeof value.unlimited !== 'boolean'
    || (value.balance !== null && (!isFiniteNumber(value.balance) || value.balance < 0))) return undefined
  return {
    hasCredits: value.hasCredits,
    unlimited: value.unlimited,
    balance: value.balance,
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNullablePositiveNumber(value: unknown): value is number | null {
  return value === null || (isFiniteNumber(value) && value > 0)
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

function isFailureReason(value: unknown): value is CodexAuthFailureReason {
  return value === 'account-access'
    || value === 'browser-callback'
    || value === 'device-code-disabled'
    || value === 'network'
    || value === 'token-exchange'
    || value === 'unsupported-region'
    || value === 'unknown'
}

function isLoginMethod(value: unknown): value is CodexLoginMethod {
  return value === 'browser' || value === 'device'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
