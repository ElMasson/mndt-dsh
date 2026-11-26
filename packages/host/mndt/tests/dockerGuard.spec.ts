/**
 * The Docker guard of a team space (eighth jump, C1): the machine service's only
 * way to Docker. A fake Docker on a Unix socket records every request that
 * reaches it; the guard must relay what one space's computers need, and answer
 * 403 to everything else without reaching Docker.
 */
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import type { Server } from 'node:http'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const GUARD = join(import.meta.dirname, '..', 'deploy', 'sandbox', 'docker-guard.py')
const SPACE = 'datanalysis'
const USERS = '/data/mndt/datanalysis/live/users'
const children: ChildProcess[] = []
const servers: Server[] = []
afterEach(() => {
  for (const child of children.splice(0)) child.kill()
  for (const server of servers.splice(0)) server.close()
})

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => { resolve(port) })
    })
  })
}

/** @returns a guard in front of a fake Docker, the requests that reached Docker, and a caller. */
async function guarded(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'))
  const socket = join(dir, 'docker.sock')
  const reached: string[] = []
  // Containers Docker knows, by name: their space label.
  const labels: Record<string, string | undefined> = {
    'mndt-datanalysis-pc-smarion-1234567890': SPACE, 'mndt-other-pc-x-1234567890': 'other', 'mndt-datanalysis-workbench-1': undefined,
    'mndt-datanalysis-egress': undefined,
  }
  // Networks Docker knows, by name: their space label. « mndt-datanalysis-pcnet-pcnet-x »
  // shares the space's prefix but belongs to a space named « datanalysis-pcnet ».
  const networks: Record<string, string | undefined> = {
    'mndt-datanalysis-pcnet-smarion-1234567890': SPACE, 'mndt-datanalysis-pcnet-pcnet-x': 'datanalysis-pcnet', 'mndt-datanalysis-pcnet-unlabelled': undefined,
  }
  const docker = createHttpServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString() })
    request.on('end', () => {
      const path = (request.url ?? '').replace(/^\/v[0-9.]+/, '').split('?')[0] ?? ''
      const inspected = /^\/containers\/([^/]+)\/json$/.exec(path)
      if (request.method === 'GET' && inspected !== null) {
        const name = decodeURIComponent(inspected[1] ?? '')
        if (!(name in labels)) { response.writeHead(404); response.end('{}'); return }
        // The guard's own reads are not counted as relayed requests.
        if (request.headers['user-agent'] !== undefined) reached.push(`${request.method ?? ''} ${path}`)
        const value = labels[name]
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ Config: { Labels: value === undefined ? {} : { 'mndt.tenant': value } } }))
        return
      }
      const network = /^\/networks\/([^/]+)$/.exec(path)
      if (request.method === 'GET' && network !== null) {
        const name = decodeURIComponent(network[1] ?? '')
        if (!(name in networks)) { response.writeHead(404); response.end('{}'); return }
        if (request.headers['user-agent'] !== undefined) reached.push(`${request.method ?? ''} ${path}`)
        const value = networks[name]
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ Labels: value === undefined ? {} : { 'mndt.tenant': value } }))
        return
      }
      reached.push(`${request.method ?? ''} ${path}`)
      if (/\/exec$/.test(path)) { response.writeHead(201, { 'content-type': 'application/json' }); response.end(JSON.stringify({ Id: 'ab'.repeat(32) })); return }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, body: body.length }))
    })
  })
  await new Promise<void>((resolve) => { docker.listen(socket, resolve) })
  servers.push(docker)
  const port = await freePort()
  const child = spawn('python3', [GUARD], {
    env: {
      ...process.env, MNDT_GUARD_SPACE: SPACE, MNDT_GUARD_USERS_ROOT: USERS, MNDT_GUARD_SOCKET: socket,
      MNDT_GUARD_HOST: '127.0.0.1', MNDT_GUARD_PORT: String(port), ...env,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  children.push(child)
  let log = ''
  child.stderr?.on('data', (chunk: Buffer) => { log += chunk.toString() })
  const call = async (method: string, path: string, body?: unknown) => {
    const answer = await fetch(`http://127.0.0.1:${port}/v1.52${path}`, {
      method, headers: { 'content-type': 'application/json', 'user-agent': 'Docker-Client/29.1.3' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return answer.status
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if (await call('GET', '/_ping') === 200) break } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  reached.length = 0
  /** @param raw - bytes written as they are, on one connection. @returns what the guard answered, whole. */
  const rawly = async (raw: string): Promise<string> => new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1', () => { socket.write(raw) })
    let data = ''
    socket.on('data', (chunk: Buffer) => { data += chunk.toString() })
    socket.on('close', () => { resolve(data) })
    socket.on('error', () => { resolve(data) })
    setTimeout(() => { socket.destroy(); resolve(data) }, 3000)
  })
  return { call, rawly, reached, log: () => log, port }
}

/** A computer's creation as the machine service asks it (docker run of machines-sidecar.py). */
const computer = () => ({
  Image: 'mndt-pc:local', User: '1000:1000', Env: ['HOME=/home/user'],
  Labels: { 'mndt.member': 'smarion@datanalysis.re', 'mndt.tenant': SPACE },
  HostConfig: {
    Runtime: 'runsc', NetworkMode: 'mndt-datanalysis-pcnet-smarion-1234567890', ReadonlyRootfs: true, CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges'], Mounts: [{ Type: 'bind', Source: `${USERS}/smarion-1234567890`, Target: '/home/user' }],
    Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=1g', '/dev/shm': 'rw,nosuid,nodev,noexec,size=256m' },
    Memory: 1073741824, MemorySwap: 1073741824, NanoCpus: 1000000000, PidsLimit: 256, MemorySwappiness: -1, Privileged: false,
  },
  NetworkingConfig: { EndpointsConfig: { 'mndt-datanalysis-pcnet-smarion-1234567890': {} } },
})
const CREATE = '/containers/create?name=mndt-datanalysis-pc-smarion-1234567890'

describe('the Docker guard relays what a space\'s computers need', { timeout: 30_000 }, () => {
  it('a computer\'s creation, start, exec (its start, once created) and removal; its networks; the filtered list', async () => {
    const g = await guarded()
    const own = 'mndt-datanalysis-pc-smarion-1234567890'
    const net = 'mndt-datanalysis-pcnet-smarion-1234567890'
    expect(await g.call('POST', CREATE, computer())).toBe(200)
    expect(await g.call('POST', `/containers/${own}/start`)).toBe(200)
    expect(await g.call('POST', `/containers/${own}/exec`, { User: '1000:1000', Cmd: ['id'] })).toBe(201)
    expect(await g.call('POST', `/exec/${'ab'.repeat(32)}/start`, { Detach: false })).toBe(200)
    expect(await g.call('GET', `/exec/${'ab'.repeat(32)}/json`)).toBe(200)
    expect(await g.call('DELETE', `/containers/${own}?force=1`)).toBe(200)
    expect(await g.call('POST', '/networks/create', { Name: net, Internal: true, Labels: { 'mndt.tenant': SPACE } })).toBe(200)
    expect(await g.call('POST', `/networks/${net}/connect`, { Container: 'mndt-datanalysis-egress' })).toBe(200)
    expect(await g.call('GET', '/containers/mndt-datanalysis-egress/json')).toBe(200)
    expect(await g.call('DELETE', `/networks/${net}`)).toBe(200)
    expect(await g.call('GET', `/containers/json?filters=${encodeURIComponent(JSON.stringify({ label: { 'mndt.tenant=datanalysis': true } }))}`)).toBe(200)
    expect(g.reached).toEqual([
      'POST /containers/create', `POST /containers/${own}/start`, `POST /containers/${own}/exec`, `POST /exec/${'ab'.repeat(32)}/start`,
      `GET /exec/${'ab'.repeat(32)}/json`, `DELETE /containers/${own}`, 'POST /networks/create', `POST /networks/${net}/connect`,
      'GET /containers/mndt-datanalysis-egress/json', `DELETE /networks/${net}`, 'GET /containers/json',
    ])
  })
})

describe('the Docker guard refuses everything else, without reaching Docker', { timeout: 30_000 }, () => {
  const refusedCreations: [string, (spec: ReturnType<typeof computer>) => unknown][] = [
    ['a bind of / (Binds)', spec => ({ ...spec, HostConfig: { ...spec.HostConfig, Binds: ['/:/h'] } })],
    ['a mount of / (Mounts)', spec => ({ ...spec, HostConfig: { ...spec.HostConfig, Mounts: [{ Type: 'bind', Source: '/', Target: '/home/user' }] } })],
    ['a mount escaping the members\' folders', spec => ({ ...spec, HostConfig: { ...spec.HostConfig, Mounts: [{ Type: 'bind', Source: `${USERS}/../../../etc`, Target: '/home/user' }] } })],
    ['a second mount', spec => ({ ...spec, HostConfig: { ...spec.HostConfig, Mounts: [...spec.HostConfig.Mounts, { Type: 'bind', Source: `${USERS}/other`, Target: '/mnt' }] } })],
    ['Privileged', spec => ({ ...spec, HostConfig: { ...spec.HostConfig, Privileged: true } })],
    ['a capability added', spec => ({ ...spec, HostConfig: { ...spec.HostConfig, CapAdd: ['SYS_ADMIN'] } })],
    ['the host\'s network', spec => ({ ...spec, HostConfig: { ...spec.HostConfig, NetworkMode: 'host' } })],
    ['another network (edge)', spec => ({ ...spec, NetworkingConfig: { EndpointsConfig: { traefik: {} } } })],
    ['the host\'s PID namespace', spec => ({ ...spec, HostConfig: { ...spec.HostConfig, PidMode: 'host' } })],
    ['a device', spec => ({ ...spec, HostConfig: { ...spec.HostConfig, Devices: [{ PathOnHost: '/dev/kvm', PathInContainer: '/dev/kvm' }] } })],
    ['another image', spec => ({ ...spec, Image: 'alpine:3.20' })],
    ['runc', spec => ({ ...spec, HostConfig: { ...spec.HostConfig, Runtime: 'runc' } })],
    ['another space\'s label', spec => ({ ...spec, Labels: { 'mndt.tenant': 'other' } })],
    ['a writable root', spec => ({ ...spec, HostConfig: { ...spec.HostConfig, ReadonlyRootfs: false } })],
    ['its own command', spec => ({ ...spec, Cmd: ['sh', '-c', 'id'] })],
    ['root as its user', spec => ({ ...spec, User: '0:0' })],
    ['a published port', spec => ({ ...spec, HostConfig: { ...spec.HostConfig, PortBindings: { '22/tcp': [{ HostPort: '2222' }] } } })],
    ['a user namespace of the host', spec => ({ ...spec, HostConfig: { ...spec.HostConfig, UsernsMode: 'host' } })],
  ]
  it.each(refusedCreations)('a creation with %s', async (_label, change) => {
    const g = await guarded()
    expect(await g.call('POST', CREATE, change(computer()))).toBe(403)
    expect(g.reached).toEqual([])
  })

  it('a computer on a network of another space that shares its prefix, or on an unlabelled one: its label, read from Docker, decides', async () => {
    const g = await guarded()
    const spec = computer()
    for (const net of ['mndt-datanalysis-pcnet-pcnet-x', 'mndt-datanalysis-pcnet-unlabelled', 'mndt-datanalysis-pcnet-unknown']) {
      expect(await g.call('POST', CREATE, { ...spec, HostConfig: { ...spec.HostConfig, NetworkMode: net }, NetworkingConfig: { EndpointsConfig: { [net]: {} } } }), net).toBe(403)
    }
    expect(g.reached).toEqual([])
  })

  it('a computer named outside the space\'s prefix; runc unless a rehearsal says so', async () => {
    const g = await guarded()
    expect(await g.call('POST', '/containers/create?name=mndt-other-pc-x', computer())).toBe(403)
    const rehearsal = await guarded({ MNDT_GUARD_ALLOW_RUNC: '1' })
    const runc = computer()
    expect(await rehearsal.call('POST', CREATE, { ...runc, HostConfig: { ...runc.HostConfig, Runtime: 'runc' } })).toBe(200)
  })

  it('acting on a container that is not of the space: the workbench, another space\'s computer', async () => {
    const g = await guarded()
    expect(await g.call('DELETE', '/containers/mndt-datanalysis-workbench-1?force=1')).toBe(403)
    expect(await g.call('POST', '/containers/mndt-datanalysis-workbench-1/stop')).toBe(403)
    expect(await g.call('POST', '/containers/mndt-other-pc-x-1234567890/exec', { Cmd: ['id'] })).toBe(403)
    expect(await g.call('GET', '/containers/mndt-other-pc-x-1234567890/json')).toBe(403)
    expect(await g.call('POST', '/containers/mndt-datanalysis-pc-smarion-1234567890/exec', { Cmd: ['id'], Privileged: true })).toBe(403)
    expect(await g.call('POST', '/containers/mndt-datanalysis-pc-smarion-1234567890/exec', { Cmd: ['id'], User: 'root' })).toBe(403)
    expect(await g.call('POST', `/exec/${'cd'.repeat(32)}/start`, {})).toBe(403)
    expect(g.reached).toEqual([])
  })

  it('a network that is not the space\'s, or another container on a computer\'s network', async () => {
    const g = await guarded()
    expect(await g.call('POST', '/networks/traefik/connect', { Container: 'mndt-datanalysis-egress' })).toBe(403)
    expect(await g.call('POST', '/networks/mndt-datanalysis-pcnet-x/connect', { Container: 'mndt-datanalysis-workbench-1' })).toBe(403)
    expect(await g.call('POST', '/networks/create', { Name: 'mndt-datanalysis-pcnet-x', Internal: false, Labels: { 'mndt.tenant': SPACE } })).toBe(403)
    expect(await g.call('POST', '/networks/create', { Name: 'open', Internal: true, Labels: { 'mndt.tenant': SPACE } })).toBe(403)
    expect(await g.call('DELETE', '/networks/mndt-datanalysis_machines')).toBe(403)
    expect(g.reached).toEqual([])
  })

  it('images, volumes, the system, swarm, an unfiltered list, a container\'s update or archive', async () => {
    const g = await guarded()
    for (const [method, path] of [['POST', '/images/create?fromImage=alpine'], ['POST', '/build'], ['GET', '/volumes'], ['POST', '/volumes/create'],
      ['GET', '/info'], ['GET', '/events'], ['POST', '/swarm/init'], ['GET', '/containers/json'], ['POST', '/containers/prune'],
      ['POST', '/containers/mndt-datanalysis-pc-smarion-1234567890/update'], ['PUT', '/containers/mndt-datanalysis-pc-smarion-1234567890/archive?path=/'],
      ['GET', '/containers/mndt-datanalysis-pc-smarion-1234567890/archive?path=/home'], ['POST', '/plugins/pull']] as const) {
      expect(await g.call(method, path), `${method} ${path}`).toBe(403)
    }
    expect(g.reached).toEqual([])
    expect(g.log()).toContain('docker-guard: refused POST /v1.52/images/create')
  })

  it('K1: an upgraded connection is relayed raw only for an exec\'s start; a pipeline after it never reaches Docker', async () => {
    const g = await guarded()
    const create = JSON.stringify(computer())
    // _ping with Upgrade, then a creation pipelined on the same connection.
    const pinged = await g.rawly('GET /v1.52/_ping HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n'
      + `POST /v1.52/containers/create?name=escape HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nContent-Length: ${create.length}\r\n\r\n${create}`)
    expect(pinged.startsWith('HTTP/1.1 403')).toBe(true)
    // An inspection with Upgrade, then a removal of the workbench pipelined.
    const inspected = await g.rawly('GET /v1.52/containers/mndt-datanalysis-pc-smarion-1234567890/json HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n'
      + 'DELETE /v1.52/containers/mndt-datanalysis-workbench-1?force=1 HTTP/1.1\r\nHost: docker\r\n\r\n')
    expect(inspected.startsWith('HTTP/1.1 403')).toBe(true)
    // Even an authorised request followed by a pipelined one: the second is never read.
    const twice = await g.rawly('GET /v1.52/_ping HTTP/1.1\r\nHost: docker\r\n\r\nDELETE /v1.52/containers/mndt-datanalysis-workbench-1?force=1 HTTP/1.1\r\nHost: docker\r\n\r\n')
    expect(twice.startsWith('HTTP/1.1 200')).toBe(true)
    expect(g.reached).toEqual(['GET /_ping'])
    // Any Transfer-Encoding is refused.
    const chunked = await g.rawly('POST /v1.52/containers/create?name=mndt-datanalysis-pc-x HTTP/1.1\r\nHost: docker\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n')
    expect(chunked.startsWith('HTTP/1.1 403')).toBe(true)
    expect(g.reached).toEqual(['GET /_ping'])
  })

  it('a log driver, a cgroup namespace, masked paths, a mount propagation, an address or a link of its own', async () => {
    const changes: ((spec: ReturnType<typeof computer>) => unknown)[] = [
      spec => ({ ...spec, HostConfig: { ...spec.HostConfig, LogConfig: { Type: 'gelf', Config: { 'gelf-address': 'udp://1.2.3.4:12201' } } } }),
      spec => ({ ...spec, HostConfig: { ...spec.HostConfig, LogConfig: { Type: 'syslog', Config: {} } } }),
      spec => ({ ...spec, HostConfig: { ...spec.HostConfig, CgroupnsMode: 'host' } }),
      spec => ({ ...spec, HostConfig: { ...spec.HostConfig, MaskedPaths: [] } }),
      spec => ({ ...spec, HostConfig: { ...spec.HostConfig, ReadonlyPaths: ['/proc/sys'] } }),
      spec => ({ ...spec, HostConfig: { ...spec.HostConfig, Mounts: [{ ...spec.HostConfig.Mounts[0], BindOptions: { Propagation: 'rshared' } }] } }),
      spec => ({ ...spec, NetworkingConfig: { EndpointsConfig: { 'mndt-datanalysis-pcnet-smarion-1234567890': { IPAMConfig: { IPv4Address: '172.30.0.9' } } } } }),
      spec => ({ ...spec, NetworkingConfig: { EndpointsConfig: { 'mndt-datanalysis-pcnet-smarion-1234567890': { Links: ['mndt-datanalysis-workbench-1:wb'] } } } }),
    ]
    const g = await guarded()
    for (const change of changes) expect(await g.call('POST', CREATE, change(computer())), JSON.stringify(change(computer())).slice(0, 80)).toBe(403)
    // An empty list of masked paths is a value (no masking): refused above; absent, Docker's defaults, accepted.
    const defaults = computer()
    expect(await g.call('POST', CREATE, { ...defaults, HostConfig: { ...defaults.HostConfig, LogConfig: { Type: '', Config: {} }, CgroupnsMode: 'private' } })).toBe(200)
    expect(g.reached).toEqual(['POST /containers/create'])
  })

  it('an exec whose user is not exactly the member\'s; a network of another space despite its prefix; a list filter not exactly the expected one', async () => {
    const g = await guarded()
    const own = 'mndt-datanalysis-pc-smarion-1234567890'
    for (const user of [undefined, '', 'root', '0', '1000:0', '01000', '1000:1000:1000']) {
      expect(await g.call('POST', `/containers/${own}/exec`, { Cmd: ['id'], ...(user === undefined ? {} : { User: user }) }), String(user)).toBe(403)
    }
    expect(await g.call('POST', '/networks/mndt-datanalysis-pcnet-pcnet-x/connect', { Container: 'mndt-datanalysis-egress' })).toBe(403)
    expect(await g.call('DELETE', '/networks/mndt-datanalysis-pcnet-unlabelled')).toBe(403)
    expect(await g.call('GET', '/networks/mndt-datanalysis-pcnet-pcnet-x')).toBe(403)
    const list = (filters: unknown) => `/containers/json?filters=${encodeURIComponent(JSON.stringify(filters))}`
    for (const filters of [
      { label: { 'mndt.tenant=datanalysis': true }, name: { x: true } },
      { label: { 'mndt.tenant=datanalysis': true, 'mndt.tenant=other': true } },
      { label: { 'mndt.tenant=datanalysis': false } },
      { label: { 'mndt.tenant=datanalysi': true } },
      { label: { 'mndt.tenant': true } },
    ]) expect(await g.call('GET', list(filters)), JSON.stringify(filters)).toBe(403)
    expect(await g.call('GET', list({ label: { 'mndt.member': true, 'mndt.tenant=datanalysis': true } }))).toBe(200)
    expect(g.reached).toEqual(['GET /containers/json'])
  })

  it('refuses to start without its space or the host path of the members\' folders', () => {
    for (const env of [{ MNDT_GUARD_SPACE: '' }, { MNDT_GUARD_USERS_ROOT: 'relative' }]) {
      const started = spawnSync('python3', [GUARD], { env: { ...process.env, MNDT_GUARD_SPACE: SPACE, MNDT_GUARD_USERS_ROOT: USERS, MNDT_GUARD_PORT: '0', ...env }, encoding: 'utf8', timeout: 10_000 })
      expect(started.status).toBe(2)
    }
  })
})
