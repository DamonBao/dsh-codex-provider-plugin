import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
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

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private readonly doc: Record<string, unknown> = {}

  protected override load(): Promise<Record<string, unknown>> {
    return Promise.resolve(this.doc)
  }

  protected override persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = section
    return Promise.resolve()
  }
}

describe('Codex provider plugin', () => {
  it('registers the native catalog and exposes exact context metadata', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(MemorySettings)
    const fiber = await ctx.plugin(CodexProvider, {})

    expect(ctx.settings.describe()).toEqual([
      expect.objectContaining({
        ns: CodexProvider.CODEX_SETTINGS_NAMESPACE,
        value: { proxyMode: 'auto' },
        applies: 'restart',
      }),
    ])
    await ctx.settings.update(CodexProvider.CODEX_SETTINGS_NAMESPACE, { proxyMode: 'off' })
    expect(ctx.settings.get(CodexProvider.CODEX_SETTINGS_NAMESPACE)).toEqual({ proxyMode: 'off' })

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
    expect(CodexProvider.resolveConfig({})).toMatchObject({
      credentialRef: 'OPENAI_CODEX_OAUTH',
      ipv6CallbackBridge: true,
      proxyMode: 'auto',
    })
    expect(CodexProvider.resolveConfig({ ipv6CallbackBridge: false }).ipv6CallbackBridge).toBe(false)
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
