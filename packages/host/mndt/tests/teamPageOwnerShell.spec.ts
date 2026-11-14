import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import { gapSignature, proxyFetch, proxyKeyFile } from './support/proxySigned.ts'

const owner = 'duke@datanalysis.re'
const viewer = 'smarion@datanalysis.re'
const cleanup: (() => void)[] = []
afterEach(() => { for (const stop of cleanup.splice(0)) stop() })
const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms) })

describe('the API serves the team page', () => {
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'team-'))
    mkdirSync(join(dir, 'team-assets'))
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>mndt · Équipe</title>')
    writeFileSync(join(dir, 'team-assets', 'app-1a2b.js'), 'console.log(1)')
    writeFileSync(join(dir, '.secret'), 'x')
    // A file outside the built folder, and links that lead to it.
    const outside = mkdtempSync(join(tmpdir(), 'state-'))
    writeFileSync(join(outside, 'grants.json'), '{"grants":[]}')
    symlinkSync(join(outside, 'grants.json'), join(dir, 'team-assets', 'grants.js'))
    symlinkSync(outside, join(dir, 'state'))
    process.env.DSH_MNDT_TEAM_DIR = dir
  })
  const api = () => createMndtApi({
    service: new WorkbenchService({ store: new MemoryStore() }),
    runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
    identity: {},
    grants: { grants: async () => ({ ok: true, grants: [] }) },
  })

  it('gives its index and its hashed files, with their types, and needs no identity', async () => {
    const index = await api()({ method: 'GET', path: '/team/index.html' })
    expect(index.status).toBe(200)
    expect(index.file?.contentType).toBe('text/html; charset=utf-8')
    expect(String(index.file?.data)).toContain('mndt · Équipe')
    const script = await api()({ method: 'GET', path: '/team/team-assets/app-1a2b.js' })
    expect(script.file?.contentType).toBe('text/javascript; charset=utf-8')
  })

  it('gives nothing outside the page folder, nothing hidden, nothing of an unknown type', async () => {
    for (const path of [
      '/team/../../grants.json', '/team/%2e%2e/%2e%2e/state.json', '/team/..%2f..%2fstate.json', '/team/%2fetc%2fpasswd.json',
      '/team/.secret', '/team/team-assets/../.secret', '/team/x.exe',
      // Symbolic links out of the built folder are not followed.
      '/team/team-assets/grants.js', '/team/state/grants.json',
    ]) {
      const answer = await api()({ method: 'GET', path })
      expect(answer.status, path).toBe(404)
      expect(answer.file, path).toBeUndefined()
    }
  })
})

describe('the gateway: the team page for everyone, the shell for the owner alone', () => {
  /** @returns an upstream that records each request's path and headers. */
  async function recorder(): Promise<{ url: string; seen: { path: string; headers: IncomingHttpHeaders }[] }> {
    const seen: { path: string; headers: IncomingHttpHeaders }[] = []
    const server = createServer((req, res) => { seen.push({ path: req.url ?? '', headers: req.headers }); res.writeHead(200); res.end('ok') })
    server.on('upgrade', (req, socket) => { seen.push({ path: req.url ?? '', headers: req.headers }); socket.destroy() })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    cleanup.push(() => { server.closeAllConnections(); server.close() })
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
  }
  async function gateway(api: string, shell: string): Promise<string> {
    const port = 20000 + Math.floor(Math.random() * 20000)
    const child: ChildProcess = spawn(process.execPath, [join(import.meta.dirname, '..', 'deploy', 'gateway', 'server.mjs')], {
      env: { ...process.env, PORT: String(port), API: api, WORKBENCH: shell, TOKEN_FILE: '/nonexistent', PROXY_SIGNATURE_KEY_FILE: proxyKeyFile(), OWNER: owner },
      stdio: 'ignore',
    })
    cleanup.push(() => { child.kill() })
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) return `http://127.0.0.1:${port}`
      await sleep(50)
    }
    throw new Error('the gateway did not start')
  }
  const upgrade = (base: string, path: string, email: string) => new Promise<string>((resolve) => {
    const socket = connect(Number(new URL(base).port), '127.0.0.1')
    socket.on('error', () => { resolve('error') })
    socket.once('connect', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nhost: x\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nx-forwarded-email: ${email}\r\ngap-signature: ${gapSignature('GET', path, { 'x-forwarded-email': email })}\r\n\r\n`)
    })
    socket.once('data', (chunk) => { resolve(String(chunk).split('\r\n')[0] ?? ''); socket.destroy() })
    socket.once('close', () => { resolve('closed') })
  })

  it('serves the team page at / and its files under /team-assets/, to a member as to the owner', async () => {
    const api = await recorder()
    const shell = await recorder()
    const base = await gateway(api.url, shell.url)
    api.seen.length = 0
    for (const who of [viewer, owner]) {
      expect((await proxyFetch(base, '/', { headers: { 'x-forwarded-email': who } })).status).toBe(200)
      expect((await proxyFetch(base, '/team-assets/app-1a2b.js', { headers: { 'x-forwarded-email': who } })).status).toBe(200)
    }
    expect(api.seen.map(request => request.path)).toEqual(['/team/index.html', '/team/team-assets/app-1a2b.js', '/team/index.html', '/team/team-assets/app-1a2b.js'])
    expect(shell.seen).toHaveLength(0)
  })

  it('serves the page only behind the sign-on proxy: unsigned, it is refused before reaching the API', async () => {
    const api = await recorder()
    const shell = await recorder()
    const base = await gateway(api.url, shell.url)
    api.seen.length = 0
    expect((await fetch(`${base}/`)).status).toBe(401)
    expect((await fetch(`${base}/team-assets/app-1a2b.js`)).status).toBe(401)
    expect(api.seen).toHaveLength(0)
  })

  it('gives a member nothing of the shell: 404 on /dsh/, on /api/…, on the WebSocket, and never the launch token', async () => {
    const api = await recorder()
    const shell = await recorder()
    const base = await gateway(api.url, shell.url)
    shell.seen.length = 0
    for (const path of ['/dsh/', '/dsh/index.html', '/api/session', '/assets/app.js']) {
      const answer = await proxyFetch(base, path, { headers: { 'x-forwarded-email': viewer } })
      expect(answer.status, path).toBe(404)
      expect(await answer.text(), path).toBe('not found')
    }
    expect(await upgrade(base, '/api/remote.mux', viewer)).toBe('HTTP/1.1 404 Not Found')
    // A launch-token URL is the team page for a member: no token is ever exchanged for them.
    expect((await proxyFetch(base, '/?token=x', { headers: { 'x-forwarded-email': viewer } })).status).toBe(200)
    expect(shell.seen).toHaveLength(0)
  })

  it('gives the owner the DSH shell under /dsh/, the prefix removed, and its WebSocket', async () => {
    const api = await recorder()
    const shell = await recorder()
    const base = await gateway(api.url, shell.url)
    shell.seen.length = 0
    const bare = await proxyFetch(base, '/dsh', { headers: { 'x-forwarded-email': owner } })
    expect(bare.status).toBe(302)
    expect(bare.headers.get('location')).toBe('/dsh/')
    await proxyFetch(base, '/dsh/assets/index-9f.js', { headers: { 'x-forwarded-email': owner } })
    await proxyFetch(base, '/api/session', { headers: { 'x-forwarded-email': owner } })
    await upgrade(base, '/api/remote.mux', owner)
    expect(shell.seen.map(request => request.path)).toEqual(['/assets/index-9f.js', '/api/session', '/api/remote.mux'])
  })
})
