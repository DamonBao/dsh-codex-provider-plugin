import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('installable bundle', () => {
  it('declares one self-owned row and a browser face', () => {
    const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      name: string
      dsh?: { bundle?: { patch?: string }; client?: { platform?: string } }
    }
    const patch = readFileSync(resolve('cordis.patch.yml'), 'utf8')

    expect(manifest.name).toBe('@jcy2387/dsh-codex-provider-plugin')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(patch).toContain("name: '@jcy2387/dsh-codex-provider-plugin'")
    expect(patch).not.toContain('@deepseek-ai/dsh-api-remotes')
  })
})
