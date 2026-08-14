/** IPv6 loopback compatibility for pi-ai's IPv4-only Codex OAuth callback. */

import { createServer } from 'node:http'
import type { Server } from 'node:http'

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

function callbackPath(requestUrl: string | undefined): string | undefined {
  try {
    const url = new URL(requestUrl ?? '/', 'http://localhost')
    return url.pathname === '/auth/callback' ? `${url.pathname}${url.search}` : undefined
  } catch {
    return undefined
  }
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
  configuredHost = process.env.PI_OAUTH_CALLBACK_HOST,
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
    response.writeHead(307, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      Location: `http://127.0.0.1:${port}${path}`,
    })
    response.end('Continuing OpenAI authentication on IPv4 loopback.')
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
