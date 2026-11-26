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
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'

const SIDECAR = join(import.meta.dirname, '..', 'deploy', 'sandbox', 'machines-sidecar.py')
const children: ChildProcess[] = []
afterEach(() => { for (const child of children.splice(0)) child.kill() })

/** A fake docker: logs each call (one line, args joined by « | »), keeps running computers by their label. */
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" | tr ' ' '|' >> "$FAKE_DIR/calls"
running="$FAKE_DIR/running"; touch "$running"
case "$1" in
  ps) cut -f1 "$running"; exit 0 ;;
  network) [ "$2" = inspect ] && exit 1; exit 0 ;;
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
async function sidecar(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pc-'))
  writeFileSync(join(dir, 'docker'), FAKE_DOCKER)
  chmodSync(join(dir, 'docker'), 0o755)
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
  const calls = (): string[][] => readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').filter(line => line !== '').map(line => line.split('|'))
  return { call, calls, dir, base: `http://127.0.0.1:${port}` }
}

describe('a member\'s computer, started by the sidecar', { timeout: 30_000 }, () => {
  it('runs under gVisor by default, on its own internal network with the egress proxy, with its own files and nothing of the space', async () => {
    const s = await sidecar()
    const started = await s.call('POST', '/pcs/start', { identity: 'smarion@datanalysis.re' })
    expect(started.status).toBe(200)
    expect(started.body).toMatchObject({ state: 'running', capacity: { used: 1, max: 4 } })
    const calls = s.calls()
    expect(calls).toContainEqual(['network', 'create', '--internal', '--label', 'mndt.member=smarion@datanalysis.re', 'mndt-pc-net-smarion-datanalysis-re'])
    expect(calls).toContainEqual(['network', 'connect', 'mndt-pc-net-smarion-datanalysis-re', 'mndt-egress'])
    const run = calls.find(args => args[0] === 'run') ?? []
    const flag = (name: string) => run[run.indexOf(name) + 1]
    expect(flag('--runtime')).toBe('runsc')
    expect(flag('--network')).toBe('mndt-pc-net-smarion-datanalysis-re')
    expect(run).toContain('--read-only')
    expect(flag('--cap-drop')).toBe('ALL')
    expect(flag('--memory')).toBe('1g')
    expect(flag('--mount')).toBe('type=bind,src=/data/mndt/datanalysis/users/smarion-datanalysis-re,dst=/home/user')
    expect(run).toContain('HTTPS_PROXY=http://mndt-egress:3128')
    // Nothing of the space: no /state, no Docker socket, no model key.
    expect(run.join(' ')).not.toMatch(/\/state|docker\.sock|_KEY=|_TOKEN=(?!tok)/)
  })

  it('MNDT_MACHINE_RUNTIME=runc runs it without gVisor (a rehearsal without runsc)', async () => {
    const s = await sidecar({ MNDT_MACHINE_RUNTIME: 'runc' })
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
    expect(calls).toContainEqual(['rm', '-f', 'mndt-pc-smarion-datanalysis-re'])
    expect(calls).toContainEqual(['network', 'rm', 'mndt-pc-net-smarion-datanalysis-re'])
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
