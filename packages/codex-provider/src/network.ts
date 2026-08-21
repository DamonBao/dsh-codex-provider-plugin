/** Host-side proxy discovery and OpenAI-scoped network routing. */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  Dispatcher,
  EnvHttpProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from 'undici'
import type { CodexNetworkIssue, CodexNetworkRoute, CodexProxyMode } from './types.ts'

interface ActiveCodexNetworkState {
  route: CodexNetworkRoute
  issue?: CodexNetworkIssue
}

interface ProxySettings {
  httpProxy: string
  httpsProxy: string
  noProxy: string
}

interface ProxyDiscovery {
  settings?: ProxySettings
  issue?: CodexNetworkIssue
}

interface SystemProxyReader {
  (platform: NodeJS.Platform): ProxyDiscovery | undefined
}

const OPENAI_HOST_SUFFIXES = ['openai.com', 'chatgpt.com'] as const
const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '[::1]'] as const

function envValue(env: NodeJS.ProcessEnv, lowercase: string): string | undefined {
  const value = env[lowercase] ?? env[lowercase.toUpperCase()]
  return value === undefined || value.trim().length === 0 ? undefined : value.trim()
}

function normalizeProxyUrl(raw: string): string | undefined {
  const candidate = raw.includes('://') ? raw : `http://${raw}`
  try {
    const url = new URL(candidate)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname.length === 0) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

function mergeNoProxy(...values: Array<string | undefined>): string {
  const entries = new Set<string>(LOOPBACK_NO_PROXY)
  for (const value of values) {
    if (value === undefined) continue
    for (const entry of value.split(/[,\s]+/)) {
      const normalized = entry.trim()
      if (normalized === '*') return '*'
      if (normalized.length > 0 && normalized !== '<local>') entries.add(normalized)
    }
  }
  return [...entries].join(',')
}

/** Resolve standard proxy variables without exposing their values. */
export function proxyFromEnvironment(env: NodeJS.ProcessEnv): ProxyDiscovery | undefined {
  const httpRaw = envValue(env, 'http_proxy')
  const httpsRaw = envValue(env, 'https_proxy')
  const allRaw = envValue(env, 'all_proxy')
  if (httpRaw === undefined && httpsRaw === undefined && allRaw === undefined) return undefined

  const effectiveHttp = httpRaw ?? allRaw
  const effectiveHttps = httpsRaw ?? allRaw ?? httpRaw
  if (effectiveHttps === undefined) return undefined
  const httpsProxy = normalizeProxyUrl(effectiveHttps)
  if (httpsProxy === undefined) return { issue: 'unsupported-proxy' }
  const httpProxy = (effectiveHttp === undefined ? undefined : normalizeProxyUrl(effectiveHttp)) ?? httpsProxy
  return {
    settings: {
      httpProxy,
      httpsProxy,
      noProxy: mergeNoProxy(envValue(env, 'no_proxy')),
    },
  }
}

function dictionaryValue(output: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${key}\\s*:\\s*(.*?)\\s*$`, 'm').exec(output)
  const value = match?.[1]
  return value === undefined || value.length === 0 ? undefined : value
}

function enabled(output: string, key: string): boolean {
  return dictionaryValue(output, key) === '1'
}

function proxyUrl(host: string | undefined, port: string | undefined): string | undefined {
  if (host === undefined || port === undefined || !/^\d+$/.test(port)) return undefined
  const hostname = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return normalizeProxyUrl(`http://${hostname}:${port}`)
}

/** Parse `scutil --proxy` output from macOS. */
export function proxyFromMacOSScutil(output: string): ProxyDiscovery | undefined {
  const httpsProxy = enabled(output, 'HTTPSEnable')
    ? proxyUrl(dictionaryValue(output, 'HTTPSProxy'), dictionaryValue(output, 'HTTPSPort'))
    : undefined
  const httpProxy = enabled(output, 'HTTPEnable')
    ? proxyUrl(dictionaryValue(output, 'HTTPProxy'), dictionaryValue(output, 'HTTPPort'))
    : undefined
  const selectedHttps = httpsProxy ?? httpProxy
  if (selectedHttps !== undefined) {
    const exceptions = [...output.matchAll(/^\s*\d+\s*:\s*(.*?)\s*$/gm)].map(match => match[1])
    return {
      settings: {
        httpProxy: httpProxy ?? selectedHttps,
        httpsProxy: selectedHttps,
        noProxy: mergeNoProxy(...exceptions),
      },
    }
  }
  if (enabled(output, 'ProxyAutoConfigEnable') || enabled(output, 'SOCKSEnable')) {
    return { issue: 'unsupported-proxy' }
  }
  return undefined
}

interface WindowsProxySnapshot {
  ProxyEnable?: number | boolean
  ProxyServer?: string
  ProxyOverride?: string
}

function splitWindowsProxyServer(value: string): Record<string, string> {
  if (!value.includes('=')) return { http: value, https: value }
  return Object.fromEntries(value.split(';').flatMap((entry) => {
    const separator = entry.indexOf('=')
    if (separator <= 0) return []
    return [[entry.slice(0, separator).trim().toLowerCase(), entry.slice(separator + 1).trim()]]
  }))
}

/** Parse WinINET's current-user proxy snapshot. */
export function proxyFromWindowsInternetSettings(value: unknown): ProxyDiscovery | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const snapshot = value as WindowsProxySnapshot
  if (snapshot.ProxyEnable !== 1 && snapshot.ProxyEnable !== true) return undefined
  if (typeof snapshot.ProxyServer !== 'string' || snapshot.ProxyServer.trim().length === 0) return undefined
  const entries = splitWindowsProxyServer(snapshot.ProxyServer)
  const httpsRaw = entries.https ?? entries.http
  if (httpsRaw === undefined) return entries.socks === undefined ? undefined : { issue: 'unsupported-proxy' }
  const httpsProxy = normalizeProxyUrl(httpsRaw)
  const httpProxy = entries.http === undefined ? undefined : normalizeProxyUrl(entries.http)
  if (httpsProxy === undefined) return { issue: 'unsupported-proxy' }
  return {
    settings: {
      httpProxy: httpProxy ?? httpsProxy,
      httpsProxy,
      noProxy: mergeNoProxy(
        typeof snapshot.ProxyOverride === 'string' ? snapshot.ProxyOverride.replaceAll(';', ',') : undefined,
      ),
    },
  }
}

interface GnomeProxySnapshot {
  mode?: string
  httpHost?: string
  httpPort?: number | undefined
  httpsHost?: string
  httpsPort?: number | undefined
  ignoreHosts?: string[]
}

/** Resolve a GNOME manual proxy snapshot read through GSettings. */
export function proxyFromGnomeSettings(snapshot: GnomeProxySnapshot): ProxyDiscovery | undefined {
  if (snapshot.mode === 'auto') return { issue: 'unsupported-proxy' }
  if (snapshot.mode !== 'manual') return undefined
  const httpProxy = proxyUrl(snapshot.httpHost, snapshot.httpPort?.toString())
  const httpsProxy = proxyUrl(snapshot.httpsHost, snapshot.httpsPort?.toString()) ?? httpProxy
  if (httpsProxy === undefined) return { issue: 'unsupported-proxy' }
  return {
    settings: {
      httpProxy: httpProxy ?? httpsProxy,
      httpsProxy,
      noProxy: mergeNoProxy(...(snapshot.ignoreHosts ?? [])),
    },
  }
}

function kdeProxyUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const value = raw.trim().replace(/\s+(\d+)$/, ':$1')
  return normalizeProxyUrl(value)
}

/** Parse KDE's per-user `kioslaverc` proxy section. */
export function proxyFromKdeKioslaverc(output: string): ProxyDiscovery | undefined {
  const sections = new Map<string, Map<string, string>>()
  let current: Map<string, string> | undefined
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    const section = /^\[(.+)]$/.exec(line)?.[1]
    if (section !== undefined) {
      current = new Map()
      sections.set(section, current)
      continue
    }
    const separator = line.indexOf('=')
    if (current === undefined || separator <= 0 || line.startsWith('#')) continue
    current.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
  }
  const proxy = sections.get('Proxy Settings')
  const type = proxy?.get('ProxyType')
  if (proxy === undefined || type === undefined || type === '0') return undefined
  if (type !== '1') return { issue: 'unsupported-proxy' }
  const httpProxy = kdeProxyUrl(proxy.get('httpProxy'))
  const httpsProxy = kdeProxyUrl(proxy.get('httpsProxy')) ?? httpProxy
  if (httpsProxy === undefined) return { issue: 'unsupported-proxy' }
  return {
    settings: {
      httpProxy: httpProxy ?? httpsProxy,
      httpsProxy,
      noProxy: mergeNoProxy(proxy.get('NoProxyFor')?.replaceAll(';', ',')),
    },
  }
}

function gsettingsString(raw: string): string {
  const value = raw.trim()
  return value.length >= 2 && value.startsWith("'") && value.endsWith("'")
    ? value.slice(1, -1)
    : value
}

function gsettingsNumber(raw: string): number | undefined {
  const value = Number(raw.trim())
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function readGnomeSystemProxy(): ProxyDiscovery | undefined {
  try {
    const read = (schema: string, key: string): string => execFileSync('gsettings', ['get', schema, key], {
      encoding: 'utf8',
      timeout: 750,
      maxBuffer: 64 * 1024,
    }).trim()
    const mode = gsettingsString(read('org.gnome.system.proxy', 'mode'))
    if (mode === 'none') return undefined
    if (mode === 'auto') return { issue: 'unsupported-proxy' }
    if (mode !== 'manual') return undefined
    const ignoreOutput = read('org.gnome.system.proxy', 'ignore-hosts')
    const ignoreHosts = [...ignoreOutput.matchAll(/'([^']+)'/g)]
      .flatMap(match => match[1] === undefined ? [] : [match[1]])
    return proxyFromGnomeSettings({
      mode,
      httpHost: gsettingsString(read('org.gnome.system.proxy.http', 'host')),
      httpPort: gsettingsNumber(read('org.gnome.system.proxy.http', 'port')),
      httpsHost: gsettingsString(read('org.gnome.system.proxy.https', 'host')),
      httpsPort: gsettingsNumber(read('org.gnome.system.proxy.https', 'port')),
      ignoreHosts,
    })
  } catch {
    return undefined
  }
}

function readKdeSystemProxy(): ProxyDiscovery | undefined {
  try {
    const configRoot = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
    return proxyFromKdeKioslaverc(readFileSync(join(configRoot, 'kioslaverc'), 'utf8'))
  } catch {
    return undefined
  }
}

function readSystemProxy(platform: NodeJS.Platform): ProxyDiscovery | undefined {
  if (platform === 'linux') return readGnomeSystemProxy() ?? readKdeSystemProxy()
  if (platform !== 'darwin' && platform !== 'win32') return undefined
  try {
    if (platform === 'darwin') {
      const output = execFileSync('/usr/sbin/scutil', ['--proxy'], {
        encoding: 'utf8',
        timeout: 1_500,
        maxBuffer: 256 * 1024,
      })
      return proxyFromMacOSScutil(output)
    }
    const script = [
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new();',
      "$p = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';",
      '[pscustomobject]@{ ProxyEnable = $p.ProxyEnable; ProxyServer = $p.ProxyServer; ProxyOverride = $p.ProxyOverride }',
      '| ConvertTo-Json -Compress',
    ].join(' ')
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 1_500,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    })
    return proxyFromWindowsInternetSettings(JSON.parse(output))
  } catch {
    return { issue: 'system-proxy-detection-failed' }
  }
}

function isOpenAIOrigin(origin: string | URL): boolean {
  try {
    const hostname = new URL(origin).hostname.toLowerCase()
    return OPENAI_HOST_SUFFIXES.some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`))
  } catch {
    return false
  }
}

/** Route only OpenAI/ChatGPT origins through the discovered proxy. */
class CodexProxyDispatcher extends Dispatcher {
  constructor(
    private readonly fallback: Dispatcher,
    private readonly proxy: Dispatcher,
  ) {
    super()
  }

  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const proxied = options.origin !== undefined && isOpenAIOrigin(options.origin)
    return (proxied ? this.proxy : this.fallback).dispatch(options, handler)
  }

  override close(): Promise<void>
  override close(callback: () => void): void
  override close(callback?: () => void): Promise<void> | void {
    const task = this.proxy.close()
    if (callback === undefined) return task
    void task.then(callback, callback)
  }

  override destroy(): Promise<void>
  override destroy(error: Error | null): Promise<void>
  override destroy(callback: () => void): void
  override destroy(error: Error | null, callback: () => void): void
  override destroy(
    errorOrCallback?: Error | null | (() => void),
    callback?: () => void,
  ): Promise<void> | void {
    const done = typeof errorOrCallback === 'function' ? errorOrCallback : callback
    const error = typeof errorOrCallback === 'function' ? null : errorOrCallback ?? null
    const task = this.proxy.destroy(error)
    if (done === undefined) return task
    void task.then(done, done)
  }
}

function isDefaultDispatcher(dispatcher: Dispatcher): boolean {
  return dispatcher.constructor.name === 'Agent'
}

/** Install and own one reversible, OpenAI-scoped global fetch dispatcher. */
export class CodexNetworkManager {
  private readonly previous: Dispatcher | undefined
  private readonly proxyAgent: EnvHttpProxyAgent | undefined
  private readonly scopedDispatcher: CodexProxyDispatcher | undefined
  private readonly current: ActiveCodexNetworkState

  constructor(
    mode: CodexProxyMode = 'auto',
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
    systemProxyReader: SystemProxyReader = readSystemProxy,
  ) {
    const existing = getGlobalDispatcher()
    const existingRoute = isDefaultDispatcher(existing) ? 'direct-or-tun' : 'host-dispatcher'
    if (mode === 'off') {
      this.current = { route: existingRoute }
      return
    }

    const environment = proxyFromEnvironment(env)
    const source = environment ?? (mode === 'auto' ? systemProxyReader(platform) : undefined)
    if (source?.settings === undefined) {
      this.current = {
        route: existingRoute,
        ...(source?.issue === undefined || existingRoute === 'host-dispatcher' ? {} : { issue: source.issue }),
      }
      return
    }
    if (source.settings.noProxy === '*' || existingRoute === 'host-dispatcher') {
      this.current = { route: existingRoute }
      return
    }

    try {
      this.previous = existing
      this.proxyAgent = new EnvHttpProxyAgent(source.settings)
      this.scopedDispatcher = new CodexProxyDispatcher(this.previous, this.proxyAgent)
      setGlobalDispatcher(this.scopedDispatcher)
      this.current = {
        route: environment === undefined ? 'system-proxy' : 'environment-proxy',
        ...(source.issue === undefined ? {} : { issue: source.issue }),
      }
    } catch {
      this.current = { route: 'direct-or-tun', issue: 'proxy-initialization-failed' }
    }
  }

  /** Secret-free route status for diagnostics and the Settings UI. */
  status(): ActiveCodexNetworkState {
    return this.current
  }

  /** Whether this manager installed an environment or system proxy route. */
  usesProxy(): boolean {
    return this.current.route === 'environment-proxy' || this.current.route === 'system-proxy'
  }

  /** Restore the dispatcher only when nobody replaced this manager after startup. */
  async dispose(): Promise<void> {
    if (this.scopedDispatcher !== undefined
      && this.previous !== undefined
      && getGlobalDispatcher() === this.scopedDispatcher) {
      setGlobalDispatcher(this.previous)
    }
    await this.proxyAgent?.close()
  }
}
