import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { connect } from 'node:net'
import type { Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const gatewayScript = join(import.meta.dirname, '..', 'deploy', 'gateway', 'server.mjs')
const cleanup: (() => void)[] = []
afterEach(() => { for (const stop of cleanup.splice(0)) stop() })
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

type Upgrade = 'accept' | 'reset' | 'refuse'

/**
 * A workbench stand-in: HTTP answers, and WebSocket upgrades it accepts,
 * resets or refuses; `/cut` sends its headers then resets the connection.
 */
async function workbench(upgrade: Upgrade): Promise<string> {
  const server: Server = createServer((req, res) => {
    if (req.url === '/cut') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('half an answer')
      setTimeout(() => { req.socket.resetAndDestroy() }, 20)
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('workbench ok')
  })
  server.on('upgrade', (_req, socket: Socket) => {
    socket.on('error', () => undefined)
    if (upgrade === 'refuse') {
      socket.end('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n')
      return
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n')
    if (upgrade === 'reset') setTimeout(() => { socket.resetAndDestroy() }, 30)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  cleanup.push(() => { server.closeAllConnections(); server.close() })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** @returns the gateway's port and process, once it listens. */
async function gateway(target: string): Promise<{ port: number; child: ChildProcess }> {
  const port = 20000 + Math.floor(Math.random() * 20000)
  const child = spawn(process.execPath, [gatewayScript], {
    env: { ...process.env, PORT: String(port), API: target, WORKBENCH: target, TOKEN_FILE: '/nonexistent' },
    stdio: 'ignore',
  })
  cleanup.push(() => { child.kill() })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) return { port, child }
    await sleep(50)
  }
  throw new Error('the gateway did not start')
}

/** @returns the first answer line of a WebSocket upgrade through the gateway, and its socket. */
async function openSocket(port: number): Promise<{ socket: Socket; status: string }> {
  const socket = connect(port, '127.0.0.1')
  socket.on('error', () => undefined)
  await new Promise<void>((resolve) => { socket.once('connect', () => { resolve() }) })
  socket.write('GET /shell HTTP/1.1\r\nhost: equipe.datanalysis.re\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n')
  const status = await new Promise<string>((resolve) => {
    socket.once('data', (chunk) => { resolve(String(chunk).split('\r\n')[0] ?? '') })
    socket.once('close', () => { resolve('closed') })
  })
  return { socket, status }
}

/** The gateway is alive and still serves a request. */
async function stillServes(port: number, child: ChildProcess): Promise<void> {
  await sleep(150)
  expect(child.exitCode).toBeNull()
  const answer = await fetch(`http://127.0.0.1:${port}/`)
  expect(await answer.text()).toBe('workbench ok')
}

describe('the gateway survives connections that end abruptly', { timeout: 30_000 }, () => {
  it('a browser resetting an open WebSocket', async () => {
    const { port, child } = await gateway(await workbench('accept'))
    const { socket, status } = await openSocket(port)
    expect(status).toBe('HTTP/1.1 101 Switching Protocols')
    socket.resetAndDestroy()
    await stillServes(port, child)
  })

  it('the workbench resetting an open WebSocket', async () => {
    const { port, child } = await gateway(await workbench('reset'))
    const { status } = await openSocket(port)
    expect(status).toBe('HTTP/1.1 101 Switching Protocols')
    await stillServes(port, child)
  })

  it('the workbench refusing the upgrade: the browser hears it, the gateway lives', async () => {
    const { port, child } = await gateway(await workbench('refuse'))
    const { status } = await openSocket(port)
    expect(status).toBe('HTTP/1.1 404 Not Found')
    await stillServes(port, child)
  })

  it('the workbench cutting an answer after its headers', async () => {
    const { port, child } = await gateway(await workbench('accept'))
    await fetch(`http://127.0.0.1:${port}/cut`).then(r => r.text()).catch(() => 'cut')
    await stillServes(port, child)
  })

  it('a browser leaving in the middle of its request', async () => {
    const { port, child } = await gateway(await workbench('accept'))
    const socket = connect(port, '127.0.0.1')
    socket.on('error', () => undefined)
    await new Promise<void>((resolve) => { socket.once('connect', () => { resolve() }) })
    socket.write('POST / HTTP/1.1\r\nhost: x\r\ncontent-length: 100000\r\n\r\npartial body')
    await sleep(50)
    socket.resetAndDestroy()
    await stillServes(port, child)
  })
})
