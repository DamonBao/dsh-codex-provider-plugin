import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('installable bundle', () => {
  it('declares one self-owned row and a browser face', () => {
    const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      name: string
      exports?: Record<string, { default?: string }>
      files?: string[]
      scripts?: Record<string, string>
      dsh?: { bundle?: { patch?: string }; client?: { platform?: string } }
    }
    const patch = readFileSync(resolve('cordis.patch.yml'), 'utf8')

    expect(manifest.name).toBe('@jcy2387/dsh-codex-provider')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(manifest.exports?.['./client']?.default).toBe('./lib/client.cjs')
    expect(manifest.files).toContain('lib/client.cjs')
    expect(manifest.files).toContain('docs/images/openai-codex-settings.svg')
    expect(manifest.files).not.toContain('lib/client.js')
    expect(manifest.scripts?.prepare).toBe('pnpm run build')
    expect(manifest.scripts?.publint).toContain('--strict')
    expect(patch).toContain("name: '@jcy2387/dsh-codex-provider'")
    expect(patch).not.toContain('@deepseek-ai/dsh-api-remotes')
  })
})
