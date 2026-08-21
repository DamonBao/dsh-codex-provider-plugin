/** IPv6 loopback compatibility for pi-ai's IPv4-only Codex OAuth callback. */

import { readFileSync } from 'node:fs'
import { createServer, request as requestHttp } from 'node:http'
import type { Server, ServerResponse } from 'node:http'

/** Fixed callback port registered by the OpenAI Codex OAuth client. */
export const CODEX_CALLBACK_PORT = 1455

/** Temporary listener owned by one browser-login attempt. */
export interface CodexCallbackBridge {
  close(): Promise<void>
}

/** Factory injected into the authentication lifecycle. */
export type CodexCallbackBridgeFactory = () => Promise<CodexCallbackBridge | undefined>

function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function ipv6Unavailable(error: unknown): boolean {
  const code = nodeErrorCode(error)
  return code === 'EAFNOSUPPORT' || code === 'EADDRNOTAVAIL' || code === 'EPROTONOSUPPORT'
}

/** Mirror pi-ai's provider-env lookup so the bridge sees the same callback host. */
function providerEnvValue(name: string): string | undefined {
  const direct = process.env[name]
  if (direct !== undefined && direct !== '') return direct
  if (typeof process === 'undefined' || !process.versions?.bun || Object.keys(process.env).length > 0) {
    return direct
  }
  try {
    const data = readFileSync('/proc/self/environ', 'utf8')
    for (const entry of data.split('\0')) {
      const separator = entry.indexOf('=')
      if (separator > 0 && entry.slice(0, separator) === name) {
        return entry.slice(separator + 1)
      }
    }
  } catch {
    // Fall back to whatever process.env exposed.
  }
  return direct
}

function callbackPath(requestUrl: string | undefined): string | undefined {
  try {
    const url = new URL(requestUrl ?? '/', 'http://localhost')
    return url.pathname === '/auth/callback' ? `${url.pathname}${url.search}` : undefined
  } catch {
    return undefined
  }
}

function relayToIpv4(path: string, port: number, response: ServerResponse): void {
  const upstream = requestHttp({
    host: '127.0.0.1',
    method: 'GET',
    path,
    port,
  }, (upstreamResponse) => {
    const headers = {
      ...upstreamResponse.headers['cache-control'] === undefined
        ? {}
        : { 'Cache-Control': upstreamResponse.headers['cache-control'] },
      ...upstreamResponse.headers['content-type'] === undefined
        ? {}
        : { 'Content-Type': upstreamResponse.headers['content-type'] },
    }
    response.writeHead(upstreamResponse.statusCode ?? 502, headers)
    upstreamResponse.pipe(response)
  })
  upstream.setTimeout(3_000, () => {
    upstream.destroy(new Error('Codex IPv4 callback relay timed out'))
  })
  upstream.once('error', () => {
    if (response.destroyed) return
    if (response.headersSent) {
      response.destroy()
      return
    }
    response.writeHead(502, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    })
    response.end('The Codex callback listener was not ready. Return to dsh and retry sign-in.')
  })
  upstream.end()
}

function listen(server: Server, host: string, port: number, ipv6Only = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ host, ipv6Only, port })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => { error === undefined ? resolve() : reject(error) })
  })
}

async function assertIpv4CallbackPortAvailable(port: number): Promise<void> {
  const probe = createServer()
  try {
    await listen(probe, '127.0.0.1', port)
    await close(probe)
  } catch (error) {
    throw new Error(`Codex browser callback cannot listen on 127.0.0.1:${port}`, { cause: error })
  }
}

/**
 * Bridge `[::1]` callbacks to pi-ai's `127.0.0.1` listener for one login.
 *
 * @param port OAuth callback port; injectable for isolated tests.
 * @param configuredHost Explicit pi-ai callback host, when present.
 * @param ipv6Bridge Whether to open the IPv6 compatibility listener after the IPv4 port check.
 * @returns A closeable bridge, or undefined when IPv6 is disabled/unavailable or pi-ai owns a custom host.
 */
export async function startCodexIpv6CallbackBridge(
  port = CODEX_CALLBACK_PORT,
  configuredHost = providerEnvValue('PI_OAUTH_CALLBACK_HOST'),
  ipv6Bridge = true,
): Promise<CodexCallbackBridge | undefined> {
  if (configuredHost !== undefined && configuredHost !== '' && configuredHost !== '127.0.0.1') {
    return undefined
  }

  await assertIpv4CallbackPortAvailable(port)
  if (!ipv6Bridge) return undefined

  const server = createServer((request, response) => {
    const path = callbackPath(request.url)
    if (request.method !== 'GET' || path === undefined) {
      response.writeHead(404, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
      })
      response.end('Callback route not found.')
      return
    }
    // Relay server-side instead of issuing a browser redirect. A second browser
    // request can be intercepted by proxy/PAC or localhost security policy even
    // though the first request already reached this Host successfully.
    relayToIpv4(path, port, response)
  })

  try {
    await listen(server, '::1', port, true)
  } catch (error) {
    if (ipv6Unavailable(error)) return undefined
    throw new Error(`Codex IPv6 callback bridge could not listen on [::1]:${port}`, { cause: error })
  }

  let closed = false
  return {
    close: async () => {
      if (closed) return
      closed = true
      await close(server)
    },
  }
}
