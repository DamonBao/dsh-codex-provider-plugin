/** Codex provider view that accepts a resolved request token. */

import type { ApiKeyAuth, Provider } from '@earendil-works/pi-ai'

/** Add an api-key method without changing the native OAuth login provider. */
export function codexDispatchProvider(base: Provider): Provider {
  const requestToken: ApiKeyAuth = {
    name: 'OpenAI Codex OAuth',
    resolve: ({ credential }) => Promise.resolve(credential?.key === undefined
      ? undefined
      : { auth: { apiKey: credential.key }, source: 'OAuth' }),
  }
  return {
    ...base,
    auth: { ...base.auth, apiKey: requestToken },
  }
}
