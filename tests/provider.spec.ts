import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as CodexProvider from '../src/index.ts'

class MemoryCredentials extends CredentialProvider {
  override resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return Promise.resolve(undefined)
  }

  override describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: false, writable: true })
  }

  override set(_ref: CredentialRef, _value: string): Promise<void> {
    return Promise.resolve()
  }

  override unset(_ref: CredentialRef): Promise<void> {
    return Promise.resolve()
  }
}

describe('Codex provider plugin', () => {
  it('registers the native catalog and exposes exact context metadata', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemoryCredentials)
    const fiber = await ctx.plugin(CodexProvider, {})

    expect(ctx.llm.listProviders()).toEqual([{ id: 'openai-codex', name: 'OpenAI Codex' }])
    const models = await ctx.llm.listModels('openai-codex')
    expect(models.length).toBeGreaterThan(0)
    for (const model of models) {
      const info = await ctx.llm.resolveModelInfo('openai-codex', model.id)
      expect(info.context?.contextWindow).toBeGreaterThan(0)
      expect(Number.isSafeInteger(info.context?.contextWindow)).toBe(true)
    }

    await fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('validates timer bounds and incomplete model catalogs', () => {
    expect(CodexProvider.resolveConfig({}).credentialRef).toBe('OPENAI_CODEX_OAUTH')
    expect(() => CodexProvider.resolveConfig({ streamIdleTimeoutMs: 0 })).toThrow(/positive/)
    expect(() => CodexProvider.resolveConfig({ credentialRef: 'not-valid!' })).toThrow(/credential ref/)
    expect(() => CodexProvider.assertCodexCatalog({ getModels: () => [] } as never)).toThrow(/empty/)
    expect(() => CodexProvider.assertCodexCatalog({
      getModels: () => [{ id: 'bad-context', contextWindow: 0, maxTokens: 1 }],
    } as never)).toThrow(/contextWindow/)
    expect(() => CodexProvider.assertCodexCatalog({
      getModels: () => [{ id: 'bad-output', contextWindow: 1, maxTokens: 0 }],
    } as never)).toThrow(/maxTokens/)
  })
})
