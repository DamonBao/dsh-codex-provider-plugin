import { describe, expect, it } from 'vitest'
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici'
import {
  CodexNetworkManager,
  proxyFromEnvironment,
  proxyFromGnomeSettings,
  proxyFromKdeKioslaverc,
  proxyFromMacOSScutil,
  proxyFromWindowsInternetSettings,
} from '../src/network.ts'

describe('Codex network routing', () => {
  it('resolves standard proxy variables and keeps loopback off the proxy', () => {
    const result = proxyFromEnvironment({
      HTTPS_PROXY: '127.0.0.1:7890',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: 'internal.example',
    })

    expect(result?.settings).toMatchObject({
      httpProxy: 'http://127.0.0.1:7890/',
      httpsProxy: 'http://127.0.0.1:7890/',
    })
    expect(result?.settings?.noProxy).toContain('localhost')
    expect(result?.settings?.noProxy).toContain('127.0.0.1')
    expect(result?.settings?.noProxy).toContain('internal.example')
    expect(proxyFromEnvironment({ HTTPS_PROXY: 'http://proxy.test:8080', NO_PROXY: '*' })?.settings?.noProxy)
      .toBe('*')
  })

  it('rejects SOCKS environment proxies without leaking their URL', () => {
    const result = proxyFromEnvironment({ ALL_PROXY: 'socks5://user:secret@127.0.0.1:7891' })
    expect(result).toEqual({ issue: 'unsupported-proxy' })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('reads enabled macOS HTTPS proxy settings and exceptions', () => {
    const result = proxyFromMacOSScutil(`
<dictionary> {
  ExceptionsList : <array> {
    0 : localhost
    1 : *.local
  }
  HTTPEnable : 0
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 0
}
`)
    expect(result?.settings).toMatchObject({ httpsProxy: 'http://127.0.0.1:7890/' })
    expect(result?.settings?.noProxy).toContain('*.local')
  })

  it('reads WinINET per-protocol settings and flags unsupported SOCKS-only mode', () => {
    expect(proxyFromWindowsInternetSettings({
      ProxyEnable: 1,
      ProxyServer: 'http=127.0.0.1:8080;https=127.0.0.1:8443',
      ProxyOverride: '<local>;*.example.test',
    })?.settings).toMatchObject({
      httpProxy: 'http://127.0.0.1:8080/',
      httpsProxy: 'http://127.0.0.1:8443/',
    })
    expect(proxyFromWindowsInternetSettings({
      ProxyEnable: 1,
      ProxyServer: 'socks=127.0.0.1:1080',
    })).toEqual({ issue: 'unsupported-proxy' })
  })

  it('reads GNOME and KDE Linux desktop proxy settings', () => {
    expect(proxyFromGnomeSettings({
      mode: 'manual',
      httpHost: '127.0.0.1',
      httpPort: 7890,
      httpsHost: '127.0.0.1',
      httpsPort: 7891,
      ignoreHosts: ['localhost', '*.local'],
    })?.settings).toMatchObject({
      httpProxy: 'http://127.0.0.1:7890/',
      httpsProxy: 'http://127.0.0.1:7891/',
    })
    expect(proxyFromGnomeSettings({ mode: 'auto' })).toEqual({ issue: 'unsupported-proxy' })

    expect(proxyFromKdeKioslaverc(`
[Proxy Settings]
ProxyType=1
httpProxy=http://127.0.0.1 8080
httpsProxy=http://127.0.0.1 8443
NoProxyFor=localhost;*.local
`)?.settings).toMatchObject({
      httpProxy: 'http://127.0.0.1:8080/',
      httpsProxy: 'http://127.0.0.1:8443/',
    })
    expect(proxyFromKdeKioslaverc('[Proxy Settings]\nProxyType=2\n'))
      .toEqual({ issue: 'unsupported-proxy' })
  })

  it('installs and restores an OpenAI-scoped dispatcher for an environment proxy', async () => {
    const before = getGlobalDispatcher()
    const manager = new CodexNetworkManager('environment', {
      HTTPS_PROXY: 'http://127.0.0.1:7890',
    })
    try {
      expect(manager.status()).toEqual({ route: 'environment-proxy' })
      expect(manager.usesProxy()).toBe(true)
      expect(getGlobalDispatcher()).not.toBe(before)
    } finally {
      await manager.dispose()
    }
    expect(getGlobalDispatcher()).toBe(before)
  })

  it('honors NO_PROXY=* without replacing the system route', async () => {
    const before = getGlobalDispatcher()
    const manager = new CodexNetworkManager('environment', {
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: '*',
    })
    try {
      expect(manager.status()).toEqual({ route: 'direct-or-tun' })
      expect(getGlobalDispatcher()).toBe(before)
    } finally {
      await manager.dispose()
    }
  })

  it('preserves a dispatcher already configured by the Host', async () => {
    const before = getGlobalDispatcher()
    const custom = new MockAgent()
    setGlobalDispatcher(custom)
    const manager = new CodexNetworkManager('environment', {
      HTTPS_PROXY: 'http://127.0.0.1:7890',
    })
    try {
      expect(manager.status()).toEqual({ route: 'host-dispatcher' })
      expect(getGlobalDispatcher()).toBe(custom)
    } finally {
      await manager.dispose()
      setGlobalDispatcher(before)
      await custom.close()
    }
  })

  it('describes an unconfigured route as direct-or-TUN', async () => {
    const manager = new CodexNetworkManager('auto', {}, 'linux', () => undefined)
    try {
      expect(manager.status()).toEqual({ route: 'direct-or-tun' })
      expect(manager.usesProxy()).toBe(false)
    } finally {
      await manager.dispose()
    }
  })
})
