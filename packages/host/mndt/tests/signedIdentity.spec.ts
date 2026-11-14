import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import { startMndtApi } from '../src/api.ts'
import { identityOf } from '../src/identity.ts'
import { gapSignature, proxyFetch, proxyKeyFile } from './support/proxySigned.ts'

const deploy = join(import.meta.dirname, '..', 'deploy')
const owner = 'duke@datanalysis.re'
const SECRET = 'a3f1c0de9b7e4d2a8c6b5f0e1d2c3b4a'
const cleanup: (() => void)[] = []
afterEach(() => { for (const stop of cleanup.splice(0)) stop() })
const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms) })

describe('the identity header is believed only from the gateway', () => {
  it('needs the gateway secret, the right one, and refuses everything without a configured secret', () => {
    const options = { proxyUserHeader: 'x-forwarded-email', gatewaySecret: SECRET }
    expect(identityOf({ headers: { 'x-forwarded-email': owner } }, options)).toBeUndefined()
    expect(identityOf({ headers: { 'x-forwarded-email': owner, 'x-mndt-gateway': 'forged' } }, options)).toBeUndefined()
    expect(identityOf({ headers: { 'x-forwarded-email': owner, 'x-mndt-gateway': SECRET } }, options)).toBe(owner)
    // A deployment without a secret never believes the header: closed, not open.
    expect(identityOf({ headers: { 'x-forwarded-email': owner, 'x-mndt-gateway': SECRET } }, { proxyUserHeader: 'x-forwarded-email' })).toBeUndefined()
  })

  it('closes the provisioned-token path on a team workbench: tokens live in /state, which an agent reads', () => {
    const tokens = { 'tok-owner': { user: owner } }
    expect(identityOf({ authorization: 'Bearer tok-owner' }, { tokens })).toBe(owner)
    expect(identityOf({ authorization: 'Bearer tok-owner' }, { tokens, proxyUserHeader: 'x-forwarded-email', gatewaySecret: SECRET })).toBeUndefined()
  })

  it('refuses a request from inside the network that declares the owner without the secret', async () => {
    const server: Server = startMndtApi({
      service: new WorkbenchService({ store: new MemoryStore() }),
      runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
      identity: { proxyUserHeader: 'x-forwarded-email', gatewaySecret: SECRET },
      grants: { grants: async () => ({ ok: true, grants: [{ subject: owner, role: 'owner' }] }) },
      port: 0,
    })
    cleanup.push(() => { server.close() })
    await new Promise<void>((resolve) => { if (server.listening) resolve(); else server.once('listening', () => { resolve() }) })
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    // What an agent's command or a neighbour container could send: curl -H 'x-forwarded-email: <owner>'.
    expect((await fetch(`${url}/me`, { headers: { 'x-forwarded-email': owner } })).status).toBe(401)
    expect((await fetch(`${url}/channels`, { method: 'POST', headers: { 'x-forwarded-email': owner }, body: '{"title":"x"}' })).status).toBe(401)
    expect((await fetch(`${url}/me`, { headers: { 'x-forwarded-email': owner, 'x-mndt-gateway': SECRET } })).status).toBe(200)
  })
})

describe('the gateway vouches for its own requests only', () => {
  /** @returns an upstream that records the headers of each request, and its URL. */
  async function recorder(): Promise<{ url: string; seen: IncomingHttpHeaders[] }> {
    const seen: IncomingHttpHeaders[] = []
    const server = createServer((req, res) => { seen.push(req.headers); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    cleanup.push(() => { server.closeAllConnections(); server.close() })
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
  }

  /** @returns the gateway's port, once it listens. */
  async function gateway(api: string, workbench: string, secretFile: string): Promise<number> {
    const port = 20000 + Math.floor(Math.random() * 20000)
    const child: ChildProcess = spawn(process.execPath, [join(deploy, 'gateway', 'server.mjs')], {
      env: {
        ...process.env, PORT: String(port), API: api, WORKBENCH: workbench, TOKEN_FILE: '/nonexistent',
        GATEWAY_SECRET_FILE: secretFile, PROXY_SIGNATURE_KEY_FILE: proxyKeyFile(),
      },
      stdio: 'ignore',
    })
    cleanup.push(() => { child.kill() })
    process.once('exit', () => { child.kill() })
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await fetch(`http://127.0.0.1:${port}/mndt-api/health`).then(() => true, () => false)) return port
      await sleep(50)
    }
    throw new Error('the gateway did not start')
  }

  it('adds its secret to API calls, drops one a browser forged, and never sends it to the shell', async () => {
    const api = await recorder()
    const shell = await recorder()
    const secretFile = join(mkdtempSync(join(tmpdir(), 'secret-')), 'mndt-gateway')
    writeFileSync(secretFile, `${SECRET}\n`)
    const port = await gateway(api.url, shell.url, secretFile)
    api.seen.length = 0
    const base = `http://127.0.0.1:${port}`
    await proxyFetch(base, '/mndt-api/me', { headers: { 'x-forwarded-email': owner, 'x-mndt-gateway': 'forged-by-a-browser' } })
    expect(api.seen.at(-1)?.['x-mndt-gateway']).toBe(SECRET)
    await proxyFetch(base, '/some/page', { headers: { 'x-mndt-gateway': 'forged-by-a-browser' } })
    expect(shell.seen.at(-1)?.['x-mndt-gateway']).toBeUndefined()
  })

  it('never hands the workbench the proxy signature or the sign-on cookie, and the API no cookie at all', async () => {
    const api = await recorder()
    const shell = await recorder()
    const secretFile = join(mkdtempSync(join(tmpdir(), 'secret-')), 'mndt-gateway')
    writeFileSync(secretFile, `${SECRET}\n`)
    const base = `http://127.0.0.1:${await gateway(api.url, shell.url, secretFile)}`
    const cookie = '_mndt_datanalysis=sso-session; _mndt_datanalysis_1=sso-part; theme=dark'
    await proxyFetch(base, '/some/page', { headers: { cookie, 'x-forwarded-email': owner } })
    const toShell = shell.seen.at(-1)
    expect(toShell?.['gap-signature']).toBeUndefined()
    expect(toShell?.['gap-auth']).toBeUndefined()
    expect(toShell?.cookie).toBe('theme=dark')
    await proxyFetch(base, '/mndt-api/me', { headers: { cookie, 'x-forwarded-email': owner } })
    const toApi = api.seen.at(-1)
    expect(toApi?.cookie).toBeUndefined()
    expect(toApi?.['gap-signature']).toBeUndefined()
  })

  it('reads at most 1 MiB before checking a signature, 20 MiB only for a document deposit', async () => {
    const api = await recorder()
    const shell = await recorder()
    const secretFile = join(mkdtempSync(join(tmpdir(), 'secret-')), 'mndt-gateway')
    writeFileSync(secretFile, `${SECRET}\n`)
    const base = `http://127.0.0.1:${await gateway(api.url, shell.url, secretFile)}`
    const big = JSON.stringify({ text: 'x'.repeat(2 * 1024 * 1024) })
    expect((await proxyFetch(base, '/mndt-api/channels/chn_1/messages', { method: 'POST', body: big, headers: { 'x-forwarded-email': owner } })).status).toBe(413)
    expect((await proxyFetch(base, '/mndt-api/channels/chn_1/files', { method: 'POST', body: big, headers: { 'x-forwarded-email': owner } })).status).toBe(200)
  })

  it('serves nothing the sign-on proxy did not sign: no identity relayed, no secret added', async () => {
    const api = await recorder()
    const shell = await recorder()
    const secretFile = join(mkdtempSync(join(tmpdir(), 'secret-')), 'mndt-gateway')
    writeFileSync(secretFile, `${SECRET}\n`)
    const port = await gateway(api.url, shell.url, secretFile)
    const base = `http://127.0.0.1:${port}`
    api.seen.length = 0
    shell.seen.length = 0
    // What an agent's command would send from the tenant's network: the owner's header, no signature.
    expect((await fetch(`${base}/mndt-api/state`, { headers: { 'x-forwarded-email': owner } })).status).toBe(401)
    // Signed with another key.
    expect((await proxyFetch(base, '/mndt-api/state', { headers: { 'x-forwarded-email': owner }, key: 'not-the-proxy-key' })).status).toBe(401)
    // A signature for another person, the header changed afterwards.
    const signedFor = gapSignature('GET', '/mndt-api/state', { 'x-forwarded-email': 'viewer@datanalysis.re' })
    expect((await fetch(`${base}/mndt-api/state`, { headers: { 'x-forwarded-email': owner, 'gap-signature': signedFor } })).status).toBe(401)
    // A body changed after signing.
    const bodySigned = gapSignature('POST', '/mndt-api/channels', { 'content-type': 'application/json', 'content-length': '13', 'x-forwarded-email': owner }, Buffer.from('{"title":"a"}'))
    expect((await fetch(`${base}/mndt-api/channels`, {
      method: 'POST', body: '{"title":"b"}',
      headers: { 'content-type': 'application/json', 'content-length': '13', 'x-forwarded-email': owner, 'gap-signature': bodySigned },
    })).status).toBe(401)
    // The shell too: no page, no launch token.
    expect((await fetch(`${base}/`, { headers: { 'x-forwarded-email': owner } })).status).toBe(401)
    expect(api.seen).toHaveLength(0)
    expect(shell.seen).toHaveLength(0)
    // An unsigned WebSocket upgrade is answered 401 before anything is relayed.
    const status = await new Promise<string>((resolve) => {
      const socket = connect(port, '127.0.0.1')
      socket.on('error', () => { resolve('error') })
      socket.once('connect', () => {
        socket.write('GET /api/remote.mux HTTP/1.1\r\nhost: x\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n')
      })
      socket.once('data', (chunk) => { resolve(String(chunk).split('\r\n')[0] ?? ''); socket.destroy() })
    })
    expect(status).toBe('HTTP/1.1 401 Unauthorized')
    expect(shell.seen).toHaveLength(0)
  })
})

describe('create-tenant.sh', { timeout: 30_000 }, () => {
  it('writes the gateway secret once, owner-only and outside /state, and mounts it without writing it in the compose', () => {
    const root = mkdtempSync(join(tmpdir(), 'tenant-'))
    execFileSync('mkdir', ['-p', join(root, 'root')])
    writeFileSync(join(root, 'root', 'secret'), 'entra-secret')
    const create = () => execFileSync('bash', [join(deploy, 'create-tenant.sh'), 'datanalysis', 'equipe.datanalysis.re', '--owner', owner,
      '--client-id', 'app-1234', '--client-secret-file', '/root/secret', '--no-docker'], { env: { ...process.env, MNDT_ROOT: root } })
    create()
    const secretPath = join(root, 'etc/mndt/datanalysis/gateway_secret')
    const secret = readFileSync(secretPath, 'utf8').trim()
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    expect((statSync(secretPath).mode & 0o777).toString(8)).toBe('400')
    create()
    expect(readFileSync(secretPath, 'utf8').trim()).toBe(secret)
    const compose = readFileSync(join(root, 'opt/mndt/datanalysis/docker-compose.yml'), 'utf8')
    expect(compose).not.toContain(secret)
    expect(compose.match(/\/etc\/mndt\/datanalysis\/gateway_secret:\/run\/secrets\/mndt-gateway:ro/g)).toHaveLength(2)
    expect(compose).toContain('GATEWAY_SECRET_FILE: "/run/secrets/mndt-gateway"')
    expect(compose).toContain('DSH_MNDT_GATEWAY_SECRET_FILE: /run/secrets/mndt-gateway')
    // The proxy's signing key: one value, a file for the gateway and an env file for the proxy, never in the compose.
    const keyPath = join(root, 'etc/mndt/datanalysis/proxy_signature_key')
    const key = readFileSync(keyPath, 'utf8').trim()
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(join(root, 'etc/mndt/datanalysis/proxy_signature.env'), 'utf8')).toBe(`OAUTH2_PROXY_SIGNATURE_KEY=sha256:${key}\n`)
    for (const file of ['proxy_signature_key', 'proxy_signature.env']) {
      expect((statSync(join(root, 'etc/mndt/datanalysis', file)).mode & 0o777).toString(8)).toBe('400')
    }
    expect(compose).not.toContain(key)
    // Two networks: the proxy and the gateway alone on an internal one; the workbench never on it.
    type Service = { networks: unknown; env_file?: string[]; environment?: Record<string, string> }
    const rendered = load(compose) as { services: Record<string, Service>; networks: Record<string, { internal?: boolean }> }
    expect(rendered.networks.ingress?.internal).toBe(true)
    expect(rendered.services.proxy?.networks).toEqual(['ingress', 'edge'])
    expect(rendered.services.proxy?.env_file).toEqual(['/etc/mndt/datanalysis/proxy_signature.env'])
    expect(Object.keys(rendered.services.gateway?.networks as object).sort()).toEqual(['front', 'ingress'])
    expect(rendered.services.gateway?.environment?.LISTEN_ALIAS).toBe('gateway-ingress')
    expect(rendered.services.workbench?.networks).toEqual(['front'])
    expect(readFileSync(join(root, 'etc/mndt/datanalysis/oauth2.cfg'), 'utf8')).toContain('upstreams = ["http://gateway-ingress:8080/"]')
    create()
    expect(readFileSync(keyPath, 'utf8').trim()).toBe(key)
  })
})
