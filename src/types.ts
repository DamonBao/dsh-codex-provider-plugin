/** Client-safe OpenAI Codex authentication state. */

/** Login method the UI may start. */
export type CodexLoginMethod = 'browser' | 'device'

/** Stable, secret-free diagnosis for an unsuccessful Codex login. */
export type CodexAuthFailureReason =
  | 'account-access'
  | 'browser-callback'
  | 'device-code-disabled'
  | 'network'
  | 'token-exchange'
  | 'unsupported-region'
  | 'unknown'

/** Non-secret authentication state returned to trusted UI clients. */
export type CodexAuthState =
  | { phase: 'disconnected' }
  | { phase: 'starting'; method: CodexLoginMethod }
  | { phase: 'awaiting-browser'; authorizationUrl: string }
  | { phase: 'awaiting-device'; verificationUri: string; userCode: string }
  | { phase: 'connected'; expiresAt: number }
  | { phase: 'reauth-required' }
  | { phase: 'failed'; method: CodexLoginMethod; reason: CodexAuthFailureReason }

/** One OpenAI-enforced Codex rate-limit window. Epoch timestamps use milliseconds. */
export interface CodexUsageWindow {
  usedPercent: number
  resetAt: number | null
  limitWindowSeconds: number | null
}

/** Optional purchased-credit balance returned by the Codex usage service. */
export interface CodexUsageCredits {
  hasCredits: boolean
  unlimited: boolean
  balance: number | null
}

/** Browser-safe Codex usage snapshot; OAuth tokens and account ids never cross RPC. */
export interface CodexUsageSnapshot {
  fetchedAt: number
  planType: string | null
  limitReached: boolean
  primary: CodexUsageWindow | null
  secondary: CodexUsageWindow | null
  credits: CodexUsageCredits | null
}
