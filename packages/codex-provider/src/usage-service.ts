/** Host-only Codex usage lookup over the account-scoped ChatGPT endpoint. */

import type { AuthResult, CredentialStore } from '@earendil-works/pi-ai'
import { CODEX_PROVIDER } from './credential-store.ts'
import type { CodexUsageCredits, CodexUsageSnapshot, CodexUsageWindow } from './types.ts'

/** OpenAI's account usage endpoint used by Codex clients. */
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const USAGE_TIMEOUT_MS = 15_000

/** Narrow pi-ai surface needed to refresh and resolve one Codex bearer token. */
export interface CodexUsageModels {
  getAuth(providerId: string): Promise<AuthResult | undefined>
}

/** Injectable fetch surface for deterministic tests. */
export type CodexUsageFetch = (input: string, init: RequestInit) => Promise<Response>

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function nullablePositive(value: unknown): number | null {
  const parsed = finiteNumber(value)
  return parsed !== undefined && parsed > 0 ? parsed : null
}

function parseWindow(value: unknown): CodexUsageWindow | null {
  if (value === undefined || value === null) return null
  const input = record(value)
  const usedPercent = finiteNumber(input?.used_percent)
  if (input === undefined || usedPercent === undefined || usedPercent < 0) {
    throw new Error('Codex usage response contains an invalid rate-limit window')
  }
  const resetAtSeconds = nullablePositive(input.reset_at)
  return {
    usedPercent: Math.min(100, usedPercent),
    resetAt: resetAtSeconds === null ? null : Math.trunc(resetAtSeconds * 1000),
    limitWindowSeconds: nullablePositive(input.limit_window_seconds),
  }
}

function parseCredits(value: unknown): CodexUsageCredits | null {
  if (value === undefined || value === null) return null
  const input = record(value)
  if (input === undefined
    || typeof input.has_credits !== 'boolean'
    || typeof input.unlimited !== 'boolean') {
    throw new Error('Codex usage response contains invalid credit metadata')
  }
  const balance = finiteNumber(input.balance)
  return {
    hasCredits: input.has_credits,
    unlimited: input.unlimited,
    balance: balance !== undefined && balance >= 0 ? balance : null,
  }
}

/** Validate and redact one untrusted OpenAI usage response. */
export function parseCodexUsagePayload(value: unknown, fetchedAt = Date.now()): CodexUsageSnapshot {
  const input = record(value)
  if (input === undefined) throw new Error('Codex usage response must be an object')
  const rateLimit = input.rate_limit === undefined || input.rate_limit === null
    ? undefined
    : record(input.rate_limit)
  if (input.rate_limit !== undefined && input.rate_limit !== null && rateLimit === undefined) {
    throw new Error('Codex usage response contains invalid rate-limit data')
  }
  const primary = parseWindow(rateLimit?.primary_window)
  const secondary = parseWindow(rateLimit?.secondary_window)
  const planType = typeof input.plan_type === 'string' && input.plan_type.trim().length > 0
    ? input.plan_type.trim()
    : null
  const credits = parseCredits(input.credits)
  if (primary === null && secondary === null && planType === null && credits === null) {
    throw new Error('Codex usage response contains no displayable usage data')
  }
  const explicitLimit = typeof rateLimit?.limit_reached === 'boolean' ? rateLimit.limit_reached : undefined
  return {
    fetchedAt,
    planType,
    limitReached: explicitLimit ?? (primary?.usedPercent === 100 || secondary?.usedPercent === 100),
    primary,
    secondary,
    credits,
  }
}

function accountIdOf(credential: Awaited<ReturnType<CredentialStore['read']>>): string | undefined {
  if (credential?.type !== 'oauth') return undefined
  return typeof credential.accountId === 'string' && credential.accountId.length > 0
    ? credential.accountId
    : undefined
}

/** Fetch usage with a fresh pi-ai bearer while keeping all secrets on the Host. */
export class CodexUsageService {
  constructor(
    private readonly models: CodexUsageModels,
    private readonly credentials: CredentialStore,
    private readonly fetcher: CodexUsageFetch = fetch,
  ) {}

  /** Return null when disconnected; otherwise return a validated usage snapshot. */
  async load(): Promise<CodexUsageSnapshot | null> {
    const auth = await this.models.getAuth(CODEX_PROVIDER)
    const access = auth?.auth.apiKey
    if (access === undefined || access.length === 0) return null

    const accountId = accountIdOf(await this.credentials.read(CODEX_PROVIDER))
    const headers = new Headers({
      accept: 'application/json',
      authorization: `Bearer ${access}`,
    })
    if (accountId !== undefined) headers.set('chatgpt-account-id', accountId)

    const response = await this.fetcher(CODEX_USAGE_URL, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
    })
    if (!response.ok) {
      const authHint = response.status === 401 || response.status === 403 ? ' (sign-in required)' : ''
      throw new Error(`Codex usage request failed with HTTP ${response.status}${authHint}`)
    }
    return parseCodexUsagePayload(await response.json())
  }
}
