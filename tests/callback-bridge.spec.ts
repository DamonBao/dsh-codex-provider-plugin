import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { startCodexIpv6CallbackBridge } from '../src/callback-bridge.ts'

function listenIpv4(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port }, () => {
      resolve((server.address() as AddressInfo).port)
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => { server.close(() => { resolve() }) })
}

describe('Codex IPv6 callback bridge', () => {
  it('redirects an IPv6 localhost callback to pi-ai on IPv4 loopback', async ({ skip }) => {
    const probe = createServer()
    const port = await listenIpv4(probe)
    await closeServer(probe)
    const bridge = await startCodexIpv6CallbackBridge(port, undefined)
    if (bridge === undefined) {
      skip()
      return
    }

    const target = createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(request.url)
    })
    let targetListening = false
    try {
      await listenIpv4(target, port)
      targetListening = true
      const response = await fetch(`http://[::1]:${port}/auth/callback?code=test-code&state=test-state`)
      expect(response.url).toBe(`http://127.0.0.1:${port}/auth/callback?code=test-code&state=test-state`)
      await expect(response.text()).resolves.toBe('/auth/callback?code=test-code&state=test-state')

      const missing = await fetch(`http://[::1]:${port}/other`, { redirect: 'manual' })
      expect(missing.status).toBe(404)
    } finally {
      await bridge.close()
      if (targetListening) await closeServer(target)
    }
  })

  it('rejects an occupied IPv4 callback port before starting pi-ai', async () => {
    const occupied = createServer()
    const port = await listenIpv4(occupied)
    try {
      await expect(startCodexIpv6CallbackBridge(port, undefined)).rejects.toThrow(
        `Codex browser callback cannot listen on 127.0.0.1:${port}`,
      )
    } finally {
      await closeServer(occupied)
    }
  })

  it('leaves an explicitly configured pi-ai callback host alone', async () => {
    await expect(startCodexIpv6CallbackBridge(0, '::')).resolves.toBeUndefined()
  })
})
