/** pi-ai credential storage backed by the Harness credential-reference seam. */

import type {
  Credential,
  CredentialInfo as PiCredentialInfo,
  CredentialStore,
  OAuthCredential,
} from '@earendil-works/pi-ai'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'

/** Provider id owned by this plugin. */
export const CODEX_PROVIDER = 'openai-codex'

function assertProvider(providerId: string): void {
  if (providerId !== CODEX_PROVIDER) {
    throw new Error(`@jcy2387/dsh-codex-provider does not own provider ${JSON.stringify(providerId)}`)
  }
}

function parseOAuthCredential(serialized: string, ref: CredentialRef): OAuthCredential {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized) as unknown
  } catch (error) {
    throw new Error(`Codex credential ${ref} is not valid JSON`, { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Codex credential ${ref} must contain an OAuth object`)
  }
  const value = parsed as Record<string, unknown>
  if (value.type !== 'oauth'
    || typeof value.access !== 'string'
    || value.access.length === 0
    || typeof value.refresh !== 'string'
    || value.refresh.length === 0
    || typeof value.expires !== 'number'
    || !Number.isFinite(value.expires)
    || value.expires <= 0) {
    throw new Error(`Codex credential ${ref} is not a valid OAuth credential`)
  }
  return { ...value, type: 'oauth', access: value.access, refresh: value.refresh, expires: value.expires }
}

/** Adapt one Harness credential reference to pi-ai's provider-keyed store. */
export class CodexCredentialStore implements CredentialStore {
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly credentials: CredentialProvider,
    private readonly ref: CredentialRef,
  ) {}

  /** Read and validate the stored OAuth credential. */
  async read(providerId: string): Promise<Credential | undefined> {
    assertProvider(providerId)
    const resolved = await this.credentials.resolve(this.ref)
    return resolved === undefined ? undefined : parseOAuthCredential(resolved.value, this.ref)
  }

  /** List non-secret credential metadata for pi-ai status checks. */
  async list(): Promise<readonly PiCredentialInfo[]> {
    const info = await this.credentials.describe(this.ref)
    return info.configured ? [{ providerId: CODEX_PROVIDER, type: 'oauth' }] : []
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  /** Serialize a pi-ai refresh or login write through the Harness provider. */
  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    assertProvider(providerId)
    return this.serialized(async () => {
      const current = await this.read(providerId)
      const next = await fn(current)
      if (next === undefined) return current
      if (next.type !== 'oauth') throw new Error('Codex credential store accepts OAuth credentials only')
      await this.credentials.set(this.ref, JSON.stringify(next))
      return next
    })
  }

  /** Remove the stored Codex OAuth credential after earlier writes settle. */
  delete(providerId: string): Promise<void> {
    assertProvider(providerId)
    return this.serialized(() => this.credentials.unset(this.ref))
  }
}
