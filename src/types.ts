/** Client-safe OpenAI Codex authentication state. */

/** Login method the UI may start. */
export type CodexLoginMethod = 'browser' | 'device'

/** Non-secret authentication state returned to trusted UI clients. */
export type CodexAuthState =
  | { phase: 'disconnected' }
  | { phase: 'starting'; method: CodexLoginMethod }
  | { phase: 'awaiting-browser'; authorizationUrl: string }
  | { phase: 'awaiting-device'; verificationUri: string; userCode: string }
  | { phase: 'connected'; expiresAt: number }
  | { phase: 'failed'; reason: 'login-failed' }
