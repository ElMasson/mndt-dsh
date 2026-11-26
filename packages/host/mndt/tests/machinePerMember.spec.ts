/**
 * « Mon ordinateur » (option B, 26/11), the sidecar's side: one computer per
 * member, started on demand under gVisor (runsc by default; a rehearsal without
 * gVisor sets runc and says the gVisor proof is still to be made), with its own
 * files and an internal network whose only way out is the egress proxy; four
 * at most, the fifth refused; stopped after its idle time.
 *
 * Docker is a fake on PATH that records every call and keeps the running
 * computers in a file: these tests prove the flags, never an isolation.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'

const SIDECAR = join(import.meta.dirname, '..', 'deploy', 'sandbox', 'machines-sidecar.py')
const children: ChildProcess[] = []

/** @param identity - an address. @returns its readable slug and 10 hex of its sha256: the computer's name, network and folder. */
function key(identity: string): string {
  const normalised = identity.trim().toLowerCase()
  return `${normalised.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/^-+|-+$/g, '')}-${createHash('sha256').update(normalised).digest('hex').slice(0, 10)}`
}
const SMARION = key('smarion@datanalysis.re')
afterEach(() => { for (const child of children.splice(0)) child.kill() })

/** A fake docker: logs each call (one line, args joined by « | »), keeps running computers by their label. */
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" | tr ' ' '|' >> "$FAKE_DIR/calls"
running="$FAKE_DIR/running"; touch "$running"
case "$1" in
  ps) cut -f1 "$running"; exit 0 ;;
  network) [ "$2" = inspect ] && exit 1; exit 0 ;;
  inspect) exit 1 ;;
  rm) name="$3"; grep -v "^.*	$name\\$" "$running" > "$running.new"; mv "$running.new" "$running"; exit 0 ;;
  run)
    member=""; name=""; prev=""
    for arg in "$@"; do
      [ "$prev" = "--label" ] && member="\${arg#mndt.member=}"
      [ "$prev" = "--name" ] && name="$arg"
      prev="$arg"
    done
    printf '%s\\t%s\\n' "$member" "$name" >> "$running"; exit 0 ;;
esac
exit 0
`

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => { resolve(port) })
    })
  })
}

/** @returns a running sidecar on a fake docker, and helpers. */
async function sidecar(env: Record<string, string> = {}, prepare?: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'pc-'))
  writeFileSync(join(dir, 'docker'), FAKE_DOCKER)
  chmodSync(join(dir, 'docker'), 0o755)
  prepare?.(dir)
  const port = await freePort()
  const child = spawn('python3', [SIDECAR], {
    env: {
      ...process.env, ...env, PATH: `${dir}:${process.env.PATH ?? ''}`, FAKE_DIR: dir, MACHINES_TOKEN: 'tok', MACHINES_HOST: '127.0.0.1', MACHINES_PORT: String(port),
      USERS_ROOT: join(dir, 'users'), USERS_ROOT_HOST: '/data/mndt/datanalysis/users',
    },
    stdio: 'ignore',
  })
  children.push(child)
  const call = async (method: string, path: string, body?: unknown) => {
    const answer = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'x-machine-token': 'tok', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: answer.status, body: await answer.json() as Record<string, unknown> }
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await call('GET', '/health')).status === 200) break } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const calls = (): string[][] => (existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8') : '').trim().split('\n').filter(line => line !== '').map(line => line.split('|'))
  return { call, calls, dir, base: `http://127.0.0.1:${port}` }
}

describe('a member\'s computer, started by the sidecar', { timeout: 30_000 }, () => {
  it('runs under gVisor by default, on its own internal network with the egress proxy, with its own files and nothing of the space', async () => {
    const s = await sidecar()
    const started = await s.call('POST', '/pcs/start', { identity: 'smarion@datanalysis.re' })
    expect(started.status).toBe(200)
    expect(started.body).toMatchObject({ state: 'running', capacity: { used: 1, max: 4 } })
    const calls = s.calls()
    expect(calls).toContainEqual(['network', 'create', '--internal', '--label', 'mndt.member=smarion@datanalysis.re', `mndt-pc-net-${SMARION}`])
    expect(calls).toContainEqual(['network', 'connect', `mndt-pc-net-${SMARION}`, 'mndt-egress'])
    const run = calls.find(args => args[0] === 'run') ?? []
    const flag = (name: string) => run[run.indexOf(name) + 1]
    const flags = (name: string) => run.flatMap((arg, at) => (arg === name ? [run[at + 1]] : []))
    expect(flag('--name')).toBe(`mndt-pc-${SMARION}`)
    expect(flag('--runtime')).toBe('runsc')
    expect(flag('--network')).toBe(`mndt-pc-net-${SMARION}`)
    expect(run).toContain('--read-only')
    expect(flag('--cap-drop')).toBe('ALL')
    expect(flag('--security-opt')).toBe('no-new-privileges')
    expect(flag('--user')).toBe('1000:1000')
    expect(flag('--pids-limit')).toBe('256')
    expect(flag('--memory')).toBe('1g')
    expect(flag('--memory-swap')).toBe('1g')
    expect(flag('--cpus')).toBe('1')
    expect(flags('--tmpfs')).toEqual(['/tmp:rw,nosuid,nodev,noexec,size=1g', '/dev/shm:rw,nosuid,nodev,noexec,size=256m'])
    expect(flag('--mount')).toBe(`type=bind,src=/data/mndt/datanalysis/users/${SMARION},dst=/home/user`)
    expect(run).toContain('HTTPS_PROXY=http://mndt-egress:3128')
    // Nothing of the space: no /state, no Docker socket, no model key, never the machine service's token.
    expect(run.join(' ')).not.toMatch(/\/state|docker\.sock|_KEY=/)
    expect(run.some(arg => arg.endsWith('=tok'))).toBe(false)
    // Its agents' token is its own, drawn at its start: never the master token.
    const token = run.find(arg => arg.startsWith('AGENT_TOKEN='))?.slice('AGENT_TOKEN='.length) ?? ''
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    expect(token).not.toBe('tok')
    expect(run).toContain(`DESKTOP_TOKEN=${token}`)
  })

  it('two addresses folding to one slug get two computers, two networks, two folders', async () => {
    const s = await sidecar()
    const people = ['jean.dupont@datanalysis.re', 'jean-dupont@datanalysis.re', 'jean_dupont@datanalysis.re', 'jean+dupont@datanalysis.re']
    for (const who of people) expect((await s.call('POST', '/pcs/start', { identity: who })).status).toBe(200)
    const runs = s.calls().filter(args => args[0] === 'run')
    const names = new Set(runs.map(run => run[run.indexOf('--name') + 1]))
    const networks = new Set(runs.map(run => run[run.indexOf('--network') + 1]))
    const folders = new Set(runs.map(run => run[run.indexOf('--mount') + 1]))
    expect([names.size, networks.size, folders.size]).toEqual([4, 4, 4])
    expect([...names].every(name => name?.startsWith('mndt-pc-jean-dupont-datanalysis-re-'))).toBe(true)
    // Stopping one never removes another's computer.
    const before = s.calls().length
    await s.call('POST', '/pcs/stop', { identity: 'jean.dupont@datanalysis.re' })
    const removed = s.calls().slice(before).filter(args => args[0] === 'rm' && args[1] === '-f').map(args => args[2])
    expect(removed).toEqual([`mndt-pc-${key('jean.dupont@datanalysis.re')}`])
  })

  it('a desktop or browser session gets its own token, never the machine service\'s', async () => {
    const s = await sidecar()
    const started = await s.call('POST', '/desktops/start', { identity: 'smarion@datanalysis.re' })
    expect(started.status).toBe(200)
    expect(started.body.token).toMatch(/^[0-9a-f]{32}$/)
    const run = s.calls().find(args => args[0] === 'run') ?? []
    expect(run).toContain(`DESKTOP_TOKEN=${String(started.body.token)}`)
    expect(run.some(arg => arg.endsWith('=tok'))).toBe(false)
  })

  it('MNDT_MACHINE_RUNTIME=runc runs it without gVisor only when MNDT_MACHINE_ALLOW_RUNC=1 says so (a rehearsal without runsc)', async () => {
    const s = await sidecar({ MNDT_MACHINE_RUNTIME: 'runc', MNDT_MACHINE_ALLOW_RUNC: '1' })
    await s.call('POST', '/pcs/start', { identity: 'duke@datanalysis.re' })
    const run = s.calls().find(args => args[0] === 'run') ?? []
    expect(run[run.indexOf('--runtime') + 1]).toBe('runc')
  })

  it('four at most: the fifth member is refused, with no queue; a member already running is not counted twice', async () => {
    const s = await sidecar()
    for (const who of ['a', 'b', 'c', 'd']) expect((await s.call('POST', '/pcs/start', { identity: `${who}@datanalysis.re` })).status).toBe(200)
    expect((await s.call('POST', '/pcs/start', { identity: 'a@datanalysis.re' })).status).toBe(200)
    const fifth = await s.call('POST', '/pcs/start', { identity: 'e@datanalysis.re' })
    expect(fifth).toMatchObject({ status: 409, body: { busy: true, capacity: { used: 4, max: 4 } } })
    expect(s.calls().filter(args => args[0] === 'run')).toHaveLength(4)
    expect((await s.call('GET', '/pcs')).body).toMatchObject({ capacity: { used: 4, max: 4 } })
  })

  it('stops on demand: its container and its network go, its files stay', async () => {
    const s = await sidecar()
    await s.call('POST', '/pcs/start', { identity: 'smarion@datanalysis.re' })
    const stopped = await s.call('POST', '/pcs/stop', { identity: 'smarion@datanalysis.re' })
    expect(stopped.body).toMatchObject({ state: 'stopped', capacity: { used: 0 } })
    const calls = s.calls()
    expect(calls).toContainEqual(['rm', '-f', `mndt-pc-${SMARION}`])
    expect(calls).toContainEqual(['network', 'rm', `mndt-pc-net-${SMARION}`])
    expect(calls.some(args => args.join(' ').includes('users') && args[0] === 'rm')).toBe(false)
  })

  it('stops by itself once idle for its time; a touch keeps it running', async () => {
    // Wide margins: a loaded machine may delay a call by a second or more.
    const s = await sidecar({ MNDT_MACHINE_IDLE_SECONDS: '3', MNDT_MACHINE_REAP_SECONDS: '0.2' })
    await s.call('POST', '/pcs/start', { identity: 'smarion@datanalysis.re' })
    expect((await s.call('GET', '/pcs/state?identity=smarion@datanalysis.re')).body).toMatchObject({ state: 'running' })
    for (let i = 0; i < 8; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 500))
      await s.call('POST', '/pcs/touch', { identity: 'smarion@datanalysis.re' })
    }
    // Four seconds of touches: twice past the idle time, still running.
    expect((await s.call('GET', '/pcs/state?identity=smarion@datanalysis.re')).body).toMatchObject({ state: 'running' })
    await new Promise(resolve => setTimeout(resolve, 4500))
    expect((await s.call('GET', '/pcs/state?identity=smarion@datanalysis.re')).body).toMatchObject({ state: 'stopped' })
  })

  it('fails closed: refuses to start without its token, on every interface, or under runc unsaid', () => {
    const start = (env: Record<string, string>) => spawnSync('python3', [SIDECAR], { env: { ...process.env, MACHINES_TOKEN: 'tok', MACHINES_HOST: '127.0.0.1', MACHINES_PORT: '0', ...env }, encoding: 'utf8', timeout: 10_000 })
    expect(start({ MACHINES_TOKEN: '' })).toMatchObject({ status: 2, stderr: expect.stringContaining('MACHINES_TOKEN is empty') as unknown })
    expect(start({ MACHINES_HOST: '0.0.0.0' })).toMatchObject({ status: 2, stderr: expect.stringContaining('MACHINES_HOST must name') as unknown })
    expect(start({ MACHINES_HOST: '' })).toMatchObject({ status: 2 })
    // Every spelling of « every interface », and a name resolving to it.
    for (const host of ['0', '[::]', '::', '::ffff:0.0.0.0', 'no-such-host.invalid']) {
      expect(start({ MACHINES_HOST: host }), host).toMatchObject({ status: 2, stderr: expect.stringContaining('MACHINES_HOST must name') as unknown })
    }
    expect(start({ MNDT_MACHINE_RUNTIME: 'runc' })).toMatchObject({ status: 2, stderr: expect.stringContaining('MNDT_MACHINE_ALLOW_RUNC=1') as unknown })
  })

  it('a computer left running by a previous sidecar (its token lost) is stopped, never adopted; started again, it gets a new token', async () => {
    const survivor = 'jean@datanalysis.re'
    const left = (dir: string) => { writeFileSync(join(dir, 'running'), `${survivor}\tmndt-pc-${key(survivor)}\n`) }
    // The reaper stops it: unusable, it must not hold one of the four places.
    const reaped = await sidecar({ MNDT_MACHINE_REAP_SECONDS: '0.2' }, left)
    for (let i = 0; i < 40 && !reaped.calls().some(args => args[0] === 'rm' && args[2] === `mndt-pc-${key(survivor)}`); i += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(reaped.calls()).toContainEqual(['rm', '-f', `mndt-pc-${key(survivor)}`])
    expect((await reaped.call('GET', '/pcs')).body).toMatchObject({ capacity: { used: 0 } })
    // Asked to start before the reaper passes: stopped, then started with its own token.
    const started = await sidecar({ MNDT_MACHINE_REAP_SECONDS: '3600' }, left)
    expect((await started.call('POST', '/pcs/start', { identity: survivor })).status).toBe(200)
    const calls = started.calls()
    const removed = calls.findIndex(args => args[0] === 'rm' && args[2] === `mndt-pc-${key(survivor)}`)
    const run = calls.findIndex(args => args[0] === 'run')
    expect(removed).toBeGreaterThanOrEqual(0)
    expect(run).toBeGreaterThan(removed)
    expect(calls[run]?.some(arg => /^AGENT_TOKEN=[0-9a-f]{32}$/.test(arg))).toBe(true)
  })

  it('a token header that is not ASCII is refused, not a crash', async () => {
    const s = await sidecar()
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${s.base}/pcs`, { method: 'GET', headers: { 'x-machine-token': Buffer.from('tök', 'latin1').toString('latin1') } }, (answer) => {
        answer.resume()
        resolve(answer.statusCode ?? 0)
      })
      request.on('error', reject)
      request.end()
    })
    expect(status).toBe(403)
    expect((await s.call('GET', '/pcs')).status).toBe(200)
  })

  it('refuses a request without its token, or for an identity that is not an address', async () => {
    const s = await sidecar()
    expect((await s.call('POST', '/pcs/start', { identity: 'nobody' })).status).toBe(400)
    const anonymous = await fetch(`${s.base}/pcs/start`, { method: 'POST', body: JSON.stringify({ identity: 'duke@datanalysis.re' }) })
    expect(anonymous.status).toBe(403)
  })
})

describe('« Mon ordinateur » through the API', { timeout: 30_000 }, () => {
  const people = ['duke@datanalysis.re', 'smarion@datanalysis.re', 'a@datanalysis.re', 'b@datanalysis.re', 'c@datanalysis.re']
  async function bench() {
    const s = await sidecar()
    const api = createMndtApi({
      service: new WorkbenchService({ store: new MemoryStore() }),
      runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
      identity: { tokens: Object.fromEntries(people.map(user => [user, { user }])) },
      grants: { grants: async () => ({ ok: true, grants: [{ subject: people[0] ?? '', role: 'owner' }, ...people.slice(1).map(subject => ({ subject, role: 'viewer' as const }))] }) },
      machines: { baseUrl: s.base, token: 'tok' },
    })
    const call = async (method: string, path: string, who: string) => {
      const answer = await api({ method, path, authorization: `Bearer ${who}` })
      return { status: answer.status, body: answer.body as Record<string, unknown> }
    }
    return { ...s, api: call }
  }

  it('a member reads, starts and stops their own computer: its state and times, nothing of where it runs', async () => {
    const b = await bench()
    expect((await b.api('GET', '/me/machine', 'smarion@datanalysis.re')).body).toEqual({ state: 'stopped', capacity: { used: 0, max: 4 } })
    const started = await b.api('POST', '/me/machine/start', 'smarion@datanalysis.re')
    expect(started.status).toBe(200)
    const machine = started.body.machine as Record<string, unknown>
    expect(machine).toMatchObject({ state: 'running', capacity: { used: 1, max: 4 } })
    expect(Object.keys(machine).sort()).toEqual(['capacity', 'lastUsedAt', 'startedAt', 'state', 'stopsAt'])
    // It is the caller's computer, never another's.
    const run = b.calls().find(args => args[0] === 'run') ?? []
    expect(run).toContain('mndt.member=smarion@datanalysis.re')
    expect((await b.api('POST', '/me/machine/stop', 'smarion@datanalysis.re')).body.machine).toMatchObject({ state: 'stopped' })
  })

  it('the fifth: 409 machines-busy, « les 4 ordinateurs sont occupés », with no queue', async () => {
    const b = await bench()
    for (const who of people.slice(0, 4)) expect((await b.api('POST', '/me/machine/start', who)).status).toBe(200)
    const fifth = await b.api('POST', '/me/machine/start', people[4] ?? '')
    expect(fifth).toMatchObject({ status: 409, body: { code: 'machines-busy', error: 'les 4 ordinateurs sont occupés', capacity: { used: 4, max: 4 } } })
  })

  it('the members\' computers are listed for who may administer rights, their state only', async () => {
    const b = await bench()
    await b.api('POST', '/me/machine/start', 'smarion@datanalysis.re')
    const listed = await b.api('GET', '/machines/members', 'duke@datanalysis.re')
    expect(listed.status).toBe(200)
    expect(listed.body).toMatchObject({ machines: [{ member: 'smarion@datanalysis.re', state: 'running' }], capacity: { used: 1, max: 4 } })
    expect((await b.api('GET', '/machines/members', 'smarion@datanalysis.re')).status).toBe(403)
  })

  it('a sidecar that never answers: the request ends, with a fixed sentence', async () => {
    const hanging = createHttpServer(() => { /* never answers */ })
    await new Promise<void>((resolve) => { hanging.listen(0, '127.0.0.1', () => { resolve() }) })
    try {
      const api = createMndtApi({
        service: new WorkbenchService({ store: new MemoryStore() }),
        runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
        identity: { tokens: { owner: { user: 'duke@datanalysis.re' } } },
        grants: { grants: async () => ({ ok: true, grants: [{ subject: 'duke@datanalysis.re', role: 'owner' }] }) },
        machines: { baseUrl: `http://127.0.0.1:${(hanging.address() as { port: number }).port}`, token: 'tok', timeoutMs: 300 },
      })
      const answer = await api({ method: 'POST', path: '/me/machine/start', authorization: 'Bearer owner' })
      expect(answer).toEqual({ status: 502, body: { error: 'the machine service is unreachable' } })
    } finally {
      hanging.closeAllConnections()
      hanging.close()
    }
  })

  it('without a machine service, a clear refusal', async () => {
    const api = createMndtApi({
      service: new WorkbenchService({ store: new MemoryStore() }),
      runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
      identity: { tokens: { owner: { user: 'duke@datanalysis.re' } } },
      grants: { grants: async () => ({ ok: true, grants: [{ subject: 'duke@datanalysis.re', role: 'owner' }] }) },
    })
    const answer = await api({ method: 'GET', path: '/me/machine', authorization: 'Bearer owner' })
    expect(answer).toMatchObject({ status: 503, body: { code: 'no-machines' } })
  })
})
