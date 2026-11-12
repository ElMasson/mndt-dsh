import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const gatewayScript = join(import.meta.dirname, '..', 'deploy', 'gateway', 'server.mjs')
const running: (ChildProcess | Server)[] = []

afterEach(() => {
  for (const item of running.splice(0)) {
    if ('kill' in item) item.kill()
    else item.close()
  }
})

/** @returns an API stand-in that records the headers of each call. */
async function api(): Promise<{ url: string; seen: IncomingHttpHeaders[] }> {
  const seen: IncomingHttpHeaders[] = []
  const server = createServer((req, res) => {
    seen.push(req.headers)
    res.writeHead(201, { 'content-type': 'application/json' })
    res.end('{"approval":{}}')
  })
  running.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

/** @param apiUrl - where the API listens. @returns the gateway base URL, once it listens. */
async function gateway(apiUrl: string): Promise<string> {
  const port = 20000 + Math.floor(Math.random() * 20000)
  const child = spawn(process.execPath, [gatewayScript], {
    env: { ...process.env, PORT: String(port), API: apiUrl, WORKBENCH: apiUrl, TOKEN_FILE: '/nonexistent' },
    stdio: 'ignore',
  })
  running.push(child)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const up = await fetch(`http://127.0.0.1:${port}/mndt-api/health`).then(() => true, () => false)
    if (up) return `http://127.0.0.1:${port}`
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('the gateway did not start')
}

describe('gateway', { timeout: 30_000 }, () => {
  it('never lets a browser name the agent run a card belongs to', async () => {
    const backend = await api()
    const base = await gateway(backend.url)
    backend.seen.length = 0
    const answer = await fetch(`${base}/mndt-api/approvals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mndt-run': 'trn_someone_else', 'x-forwarded-email': 'a@datanalysis.re' },
      body: '{"kind":"send-email","title":"t"}',
    })
    expect(answer.status).toBe(201)
    const [headers] = backend.seen
    expect(headers?.['x-mndt-run']).toBeUndefined()
    expect(headers?.['x-forwarded-email']).toBe('a@datanalysis.re') // the proven identity still goes through
  })
})
