/**
 * « Mon ordinateur » for the agents (PR 2): the machine connector acts on the
 * computer of the person the running turn acts for, through the API, which
 * checks that the published actor is that very person and alone asks the
 * sidecar; every computer taken, the tool is refused with the host's sentence
 * and the turn notes it (toolRefusals, reasonKind busy); the turn carries its
 * actor.
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import type { PriceGrid } from '../src/core/index.ts'
import { createMndtApi, startMndtApi } from '../src/api.ts'
import { fileGrants } from '../src/grants.ts'
import { clearActor, noteToolRefusal, publishActor, takeToolRefusals } from '../src/machine-tools.ts'
import { TurnScheduler } from '../src/turns.ts'
import type { TurnEngine, TurnInput, TurnOutput } from '../src/turns.ts'

const MACHINE_MCP = join(import.meta.dirname, '..', 'deploy', 'machine-mcp.mjs')
const owner = 'duke@datanalysis.re'
const member = 'smarion@datanalysis.re'
const servers: Server[] = []
const children: ChildProcess[] = []

beforeEach(() => {
  process.env.MNDT_MISSION_ACTOR_FILE = join(mkdtempSync(join(tmpdir(), 'actor-')), 'mission-actor.json')
})
afterEach(async () => {
  await clearActor()
  for (const child of children.splice(0)) child.kill()
  for (const server of servers.splice(0)) server.close()
})

/**
 * @param answer - what the fake answers to one request: status and body.
 * @returns its address, and every request it received (headers and body).
 */
async function fake(answer: (body: Record<string, unknown>) => { status: number; body: unknown }) {
  const received: { path: string; headers: Record<string, unknown>; body: Record<string, unknown> }[] = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => { raw += String(chunk) })
    request.on('end', () => {
      const body = raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>
      received.push({ path: request.url ?? '', headers: request.headers, body })
      const { status, body: reply } = answer(body)
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(reply))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, received }
}

/** @param sidecar - the fake sidecar's address. @returns an API whose machine service is that fake. */
function api(sidecar: string) {
  const people = [owner, member]
  const handler = createMndtApi({
    service: new WorkbenchService({ store: new MemoryStore() }),
    runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
    identity: { tokens: Object.fromEntries(people.map(user => [user, { user }])) },
    grants: { grants: async () => ({ ok: true, grants: [{ subject: owner, role: 'owner' }, { subject: member, role: 'operator' as const }] }) },
    machines: { baseUrl: sidecar, token: 'tok' },
  })
  return async (who: string, body: unknown) => {
    const answer = await handler({ method: 'POST', path: '/me/machine/act', authorization: `Bearer ${who}`, body: JSON.stringify(body) })
    return { status: answer.status, body: answer.body as Record<string, unknown> }
  }
}

describe('POST /me/machine/act: a turn acts on its actor\'s computer, never another\'s', () => {
  it('no turn running: refused, the sidecar never asked', async () => {
    const sidecar = await fake(() => ({ status: 200, body: { ok: true } }))
    const answer = await api(sidecar.base)(member, { kind: 'terminal', command: 'ls' })
    expect(answer).toMatchObject({ status: 403, body: { code: 'machine-not-yours' } })
    expect(sidecar.received).toHaveLength(0)
  })

  it('a turn acting for another person: refused; for the caller: the caller\'s computer, its result and nothing of where it runs', async () => {
    const sidecar = await fake(() => ({ status: 200, body: { ok: true, exitCode: 0, stdout: 'hi', host: '10.0.0.9', token: 'agent-token', echo: 1 } }))
    const act = api(sidecar.base)
    await publishActor(member, 'turn-1')
    expect((await act(owner, { kind: 'terminal', command: 'ls' })).body).toMatchObject({ code: 'machine-not-yours' })
    const answer = await act(member, { kind: 'terminal', command: 'ls', identity: owner, timeoutSeconds: 30 })
    // The route's list of fields: never the computer's host, token or other words.
    expect(answer).toEqual({ status: 200, body: { exitCode: 0, stdout: 'hi' } })
    expect(sidecar.received).toHaveLength(1)
    // The published actor, never an identity a body names.
    expect(sidecar.received[0]).toMatchObject({ path: '/pcs/act', headers: { 'x-machine-token': 'tok' }, body: { identity: member, kind: 'terminal', command: 'ls', timeoutSeconds: 30 } })
  })

  it('every computer taken: 409 « les 4 ordinateurs sont occupés », noted once on the running turn', async () => {
    const sidecar = await fake(() => ({ status: 409, body: { busy: true, capacity: { used: 4, max: 4 } } }))
    const act = api(sidecar.base)
    await publishActor(member, 'turn-2')
    const answer = await act(member, { kind: 'browser', op: 'goto', url: 'https://example.org' })
    expect(answer).toMatchObject({ status: 409, body: { code: 'machines-busy', error: 'les 4 ordinateurs sont occupés' } })
    await act(member, { kind: 'browser', op: 'text' })
    expect(takeToolRefusals('turn-2')).toEqual([{ server: 'machine', reasonKind: 'busy' }])
    expect(takeToolRefusals('turn-2')).toEqual([])
  })

  it('an unknown kind is refused; a failure on the computer serves the host\'s sentence, never its words', async () => {
    const sidecar = await fake(() => ({ status: 502, body: { error: 'the browser answered: TimeoutError at /internal/x' } }))
    const act = api(sidecar.base)
    await publishActor(member, 'turn-3')
    expect((await act(member, { kind: 'shell', command: 'ls' })).status).toBe(400)
    const failed = await act(member, { kind: 'browser', op: 'text' })
    expect(failed).toEqual({ status: 502, body: { error: 'the machine service refused the request', code: 'machine-refused' } })
  })
})

const PRICES: PriceGrid = { 'route-a/*': { input: 1, output: 2 } }

describe('the turn carries its actor and the tools refused during it', () => {
  it('a mention by a member: actor is the member; a busy machine during the turn is noted on it', async () => {
    const service = new WorkbenchService({ store: new MemoryStore() })
    let calls = 0
    const engine: TurnEngine = {
      run: async (input: TurnInput): Promise<TurnOutput> => {
        // The first turn meets every computer taken; the second does not.
        calls += 1
        if (calls === 1) noteToolRefusal(input.runId ?? input.turnId, { server: 'machine', reasonKind: 'busy' })
        return { text: 'fait', tokens: { input: 1, output: 1 } }
      },
    }
    const turns = new TurnScheduler({ service, engine, prices: PRICES, dataDir: '/data/mndt' })
    const handler = createMndtApi({
      service, turns, runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
      identity: { tokens: { owner: { user: owner } } },
      grants: { grants: async () => ({ ok: true, grants: [{ subject: owner, role: 'owner' }] }) },
    })
    const call = async (method: string, path: string, body?: unknown) =>
      (await handler({ method, path, authorization: 'Bearer owner', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).body as Record<string, unknown>
    const agent = ((await call('POST', '/agents', { handle: 'alpha', name: 'alpha', provider: 'route-a', model: 'm', eurPerMonth: 5 })).agent as { id: string }).id
    const channel = ((await call('POST', '/channels', { name: 'calculs', agents: [agent], members: [] })).channel as { id: string }).id
    await call('POST', `/channels/${channel}/messages`, { text: '@alpha calcule la marge' })
    await turns.settled()
    await call('POST', `/channels/${channel}/messages`, { text: '@alpha bonjour' })
    await turns.settled()
    const all = await service.messages(channel)
    const turnsOf = all.flatMap(message => message.turns ?? [])
    expect(turnsOf).toHaveLength(2)
    expect(turnsOf[0]).toMatchObject({ status: 'done', actor: owner, toolRefusals: [{ server: 'machine', reasonKind: 'busy' }] })
    expect(turnsOf[1]).toMatchObject({ status: 'done', actor: owner })
    expect(turnsOf[1]?.toolRefusals).toBeUndefined()
  })
})

/** @param env - the connector's settings. @returns a sender and a reader of its replies. */
function connector(env: Record<string, string>) {
  const child = spawn(process.execPath, [MACHINE_MCP], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...env } })
  children.push(child)
  const replies = new Map<number, Record<string, unknown>>()
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const reply = JSON.parse(line) as { id: number } & Record<string, unknown>
      replies.set(reply.id, reply)
    } catch { /* not protocol */ }
  })
  return async (id: number, method: string, params: unknown = {}) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    for (let i = 0; i < 300; i += 1) {
      const reply = replies.get(id)
      if (reply !== undefined) return reply
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`no reply to ${id}`)
  }
}

describe('the machine connector, « ordinateur » mode', () => {
  it('lists the terminal only in this mode; acts as the published actor, through the API, with no machine token', async () => {
    const product = await fake((body) => {
      if (body.command === 'busy') return { status: 409, body: { error: 'les 4 ordinateurs sont occupés', code: 'machines-busy' } }
      if (body.command === 'boom') return { status: 500, body: { error: 'Error: ECONNRESET at internal' } }
      return { status: 200, body: { exitCode: 0, stdout: 'hi', stderr: '' } }
    })
    const actorFile = join(mkdtempSync(join(tmpdir(), 'mcp-actor-')), 'actor.json')
    writeFileSync(actorFile, JSON.stringify({ actor: member, missionId: 'turn-9' }))
    const pc = connector({ MACHINES_MODE: 'pc', MNDT_API: product.base, MNDT_ACTOR_FILE: actorFile, MACHINES_TOKEN: '' })
    const listed = (await pc(1, 'tools/list')).result as { tools: { name: string }[] }
    expect(listed.tools.map(tool => tool.name)).toContain('machine_terminal_run')
    const ran = await pc(2, 'tools/call', { name: 'machine_terminal_run', arguments: { command: 'echo hi' } })
    expect(ran.result).toEqual({ content: [{ type: 'text', text: 'exit 0\nstdout:\nhi' }] })
    expect(product.received[0]).toMatchObject({ path: '/me/machine/act', headers: { 'x-forwarded-email': member }, body: { kind: 'terminal', command: 'echo hi' } })
    expect(product.received[0]?.headers['x-machine-token']).toBeUndefined()
    const busy = await pc(3, 'tools/call', { name: 'machine_terminal_run', arguments: { command: 'busy' } })
    expect(busy.error).toMatchObject({ message: 'les 4 ordinateurs sont occupés' })
    const boom = await pc(4, 'tools/call', { name: 'machine_terminal_run', arguments: { command: 'boom' } })
    expect(boom.error).toMatchObject({ message: 'the call failed' })

    const classic = connector({ MNDT_API: product.base })
    const classicTools = (await classic(1, 'tools/list')).result as { tools: { name: string }[] }
    expect(classicTools.tools.map(tool => tool.name)).not.toContain('machine_terminal_run')
  })

  it('no person behind the turn: refused, the API never asked', async () => {
    const product = await fake(() => ({ status: 200, body: {} }))
    const actorFile = join(mkdtempSync(join(tmpdir(), 'mcp-actor-')), 'none.json')
    // The shell's identity is the owner's: never a fallback for a computer.
    const pc = connector({ MACHINES_MODE: 'pc', MNDT_API: product.base, MNDT_ACTOR_FILE: actorFile, MNDT_IDENTITY: owner, DSH_MNDT_IDENTITY: owner })
    const refused = await pc(1, 'tools/call', { name: 'machine_browser_read', arguments: {} })
    expect(refused.error).toMatchObject({ message: 'no person is behind this turn, so no computer can be used' })
    expect(product.received).toHaveLength(0)
  })
})

describe('the machine connector through the real API (identityOf, the gateway\'s secret)', () => {
  it('acts as the published actor with the gateway\'s secret; without it, the API refuses and the tool says nothing of why', async () => {
    const sidecar = await fake(() => ({ status: 200, body: { ok: true, exitCode: 0, stdout: 'bonjour', host: '10.0.0.9' } }))
    const dir = mkdtempSync(join(tmpdir(), 'machine-real-'))
    const secretFile = join(dir, 'gateway')
    writeFileSync(secretFile, 'gateway-secret-for-tests\n')
    writeFileSync(join(dir, 'grants.json'), JSON.stringify({ grants: [{ subject: owner, role: 'owner' }, { subject: member, role: 'operator' }] }))
    const server = startMndtApi({
      service: new WorkbenchService({ store: new MemoryStore() }),
      runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
      identity: { proxyUserHeader: 'x-forwarded-email', gatewaySecret: 'gateway-secret-for-tests' },
      grants: fileGrants(join(dir, 'grants.json')),
      machines: { baseUrl: sidecar.base, token: 'tok' },
      port: 0,
      host: '127.0.0.1',
    })
    servers.push(server)
    await new Promise<void>((resolve) => { if (server.listening) resolve(); else server.once('listening', () => { resolve() }) })
    const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    await publishActor(member, 'turn-real')
    const actorFile = process.env.MNDT_MISSION_ACTOR_FILE ?? ''
    const signed = connector({ MACHINES_MODE: 'pc', MNDT_API: api, MNDT_ACTOR_FILE: actorFile, MNDT_GATEWAY_SECRET_FILE: secretFile })
    const ran = await signed(1, 'tools/call', { name: 'machine_terminal_run', arguments: { command: 'echo bonjour' } })
    expect(ran.result).toEqual({ content: [{ type: 'text', text: 'exit 0\nstdout:\nbonjour' }] })
    expect(sidecar.received[0]?.body).toMatchObject({ identity: member, kind: 'terminal' })
    const unsigned = connector({ MACHINES_MODE: 'pc', MNDT_API: api, MNDT_ACTOR_FILE: actorFile, MNDT_GATEWAY_SECRET_FILE: '', MNDT_GATEWAY_SECRET: '' })
    const refused = await unsigned(2, 'tools/call', { name: 'machine_terminal_run', arguments: { command: 'echo bonjour' } })
    expect(refused.error).toMatchObject({ message: 'the call failed' })
    expect(sidecar.received).toHaveLength(1)
  })
})

describe('whose computer a run uses', () => {
  it('an owner\'s automation runs as that owner (its mission is theirs), so its tools act on the owner\'s computer', async () => {
    const sidecar = await fake(() => ({ status: 200, body: { ok: true, exitCode: 0, stdout: '' } }))
    const service = new WorkbenchService({ store: new MemoryStore() })
    const mission = await service.createMission({ kind: 'custom', prompt: 'x', createdBy: owner })
    // The runner publishes the mission's requester (runner.ts, publishActor(mission.createdBy, …)).
    await publishActor(mission.createdBy, mission.id)
    const act = api(sidecar.base)
    expect((await act(member, { kind: 'terminal', command: 'ls' })).body).toMatchObject({ code: 'machine-not-yours' })
    expect((await act(owner, { kind: 'terminal', command: 'ls' })).status).toBe(200)
    expect(sidecar.received[0]?.body).toMatchObject({ identity: owner })
  })
})
