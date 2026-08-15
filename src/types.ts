/** Client-safe OpenAI Codex authentication state. */

/** Login method the UI may start. */
export type CodexLoginMethod = 'browser' | 'device'

/** Automatic proxy policy persisted through the Harness settings service. */
export type CodexProxyMode = 'auto' | 'environment' | 'off'

/** How Host HTTP requests currently reach OpenAI. TUN is transparent to Node. */
export type CodexNetworkRoute =
  | 'direct-or-tun'
  | 'environment-proxy'
  | 'host-dispatcher'
  | 'system-proxy'

/** Secret-free warning emitted when a detected proxy cannot be activated safely. */
export type CodexNetworkIssue =
  | 'proxy-initialization-failed'
  | 'system-proxy-detection-failed'
  | 'unsupported-proxy'

/** Browser-safe network routing snapshot; proxy addresses and credentials are never included. */
export interface CodexNetworkState {
  route: CodexNetworkRoute
  issue?: CodexNetworkIssue
  /** Mode that configured the currently running dispatcher. */
  activeProxyMode: CodexProxyMode
  /** Persisted mode that will be used after the next Host restart. */
  configuredProxyMode: CodexProxyMode
  restartRequired: boolean
}

/** Stable, secret-free diagnosis for an unsuccessful Codex login. */
export type CodexAuthFailureReason =
  | 'account-access'
  | 'browser-callback'
  | 'browser-callback-port'
  | 'browser-callback-timeout'
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
