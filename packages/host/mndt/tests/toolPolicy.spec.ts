import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DshMissionRunner, DshTurnRunner } from '../src/runner.ts'
import { soloWorkstation } from '../src/gateway.ts'
import {
  ALLOWED_TOOLS, ALWAYS_SERVERS, TEAM_MISSION_POLICY, channelPolicy, hideOutsidePolicy, isServerName, mcpServerOf,
  scopeToolPolicy, toolRefusal,
} from '../src/tool-policy.ts'
import type { LineageAgentLike, ScopedToolsLike } from '../src/tool-policy.ts'
import type { Mission } from '../src/core/index.ts'
import type { TurnInput } from '../src/turns.ts'

/** The engine's default composition, as a turn's agent would inherit it, plus MCP servers. */
const ENGINE_DEFAULTS = [
  'bash', 'terminal', 'read_file', 'write_file', 'edit_file', 'list_directory', 'grep', 'glob',
  'web_fetch', 'web_search', 'subagent', 'send_message', 'interrupt_agent', 'workflow', 'run_code',
  'working_directory', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
]
const MCP = ['mcp__qonto__list_transactions', 'mcp__approvals__request_approval', 'mcp__dolibarr__get_invoices', 'mcp__office365__list_mail']

type Guard = (execution: { readonly name: string }) => string | undefined
type FakeTools = ScopedToolsLike & { allow: readonly string[] | undefined; deny: readonly string[] | undefined; guards: Guard[] }

/** @param names - the tools the agent sees. @returns a face recording the restriction and the guards. */
function fakeTools(names: readonly string[]): FakeTools {
  const face = {
    guards: [] as Guard[],
    allow: undefined as readonly string[] | undefined,
    deny: undefined as readonly string[] | undefined,
    schemas: () => names.map(name => ({ name })),
    restrict(filter: { readonly allow?: readonly string[]; readonly deny?: readonly string[] }) {
      face.allow = filter.allow
      face.deny = filter.deny
      return () => undefined
    },
    guard(guard: Guard) {
      face.guards.push(guard)
      return () => undefined
    },
  }
  return face
}

describe('the allow-list of the agents of the team', () => {
  it('names no tool outside MCP, and only the approvals server for everyone', () => {
    expect(ALLOWED_TOOLS).toEqual([])
    expect(ALWAYS_SERVERS).toEqual(['approvals'])
  })

  it('refuses every tool of the engine\'s default composition to a channel turn', () => {
    const policy = channelPolicy(['qonto'])
    for (const name of ENGINE_DEFAULTS) expect(toolRefusal(name, policy), name).toBeDefined()
  })

  it('opens the channel\'s servers and the approvals, and nothing of another server', () => {
    const policy = channelPolicy(['qonto'])
    expect(toolRefusal('mcp__qonto__list_transactions', policy)).toBeUndefined()
    expect(toolRefusal('mcp__approvals__request_approval', policy)).toBeUndefined()
    expect(toolRefusal('mcp__dolibarr__get_invoices', policy)).toMatch(/dolibarr is not allowed/)
    // A name that only looks like MCP is not one.
    expect(toolRefusal('mcp__qonto', policy)).toBeDefined()
    expect(toolRefusal('mcp_qonto__x', policy)).toBeDefined()
    expect(toolRefusal('MCP__qonto__x', policy)).toBeDefined()
  })

  it('gives a team mission MCP tools only', () => {
    expect(toolRefusal('mcp__dolibarr__get_invoices', TEAM_MISSION_POLICY)).toBeUndefined()
    for (const name of ENGINE_DEFAULTS) expect(toolRefusal(name, TEAM_MISSION_POLICY), name).toBeDefined()
  })

  it('reads a server only from a well-formed name, and never allows a badly named one', () => {
    expect(mcpServerOf('mcp__approvals__request_approval')).toBe('approvals')
    expect(mcpServerOf('mcp__workbench_facts__read')).toBe('workbench_facts')
    expect(isServerName('approvals__x')).toBe(false)
    expect(isServerName('approvals_')).toBe(false)
    // mcp__approvals___x splits at the first `__`: server approvals, tool _x.
    expect(mcpServerOf('mcp__approvals___x')).toBe('approvals')
    expect(channelPolicy(['approvals__x', 'qonto_']).servers).toEqual(new Set(['approvals']))
  })

  it('hides from one agent all but the allowed tools', () => {
    const face = fakeTools([...ENGINE_DEFAULTS, ...MCP])
    const visible = hideOutsidePolicy(face, channelPolicy(['qonto']), undefined)
    expect(visible).toEqual(['mcp__qonto__list_transactions', 'mcp__approvals__request_approval'])
    expect(face.allow).toEqual(visible)
    expect(face.deny).toBeUndefined()
  })
})

/** A host context that records its guards and lets a test announce agents. */
function fakeHost(): {
  host: { agents: { get: (id: never) => LineageAgentLike | undefined }; tools: { guard: (guard: (execution: { name: string; agent?: LineageAgentLike }) => string | undefined) => () => void }; on: (event: 'agent/created', listener: (payload: { agent: LineageAgentLike }) => void) => () => void }
  guards: Set<(execution: { name: string; agent?: LineageAgentLike }) => string | undefined>
  announce: (agent: LineageAgentLike) => void
  refused: (name: string, agent?: LineageAgentLike) => string | undefined
} {
  const guards = new Set<(execution: { name: string; agent?: LineageAgentLike }) => string | undefined>()
  const listeners = new Set<(payload: { agent: LineageAgentLike }) => void>()
  return {
    host: {
      agents: { get: (id: never) => live.get(id) },
      tools: { guard: (guard) => { guards.add(guard); return () => { guards.delete(guard) } } },
      // Only agent/created is announced; the runner's other listeners hear nothing.
      on: (event, listener) => {
        if (event !== 'agent/created') return () => undefined
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    guards,
    announce: (agent) => { for (const listener of listeners) listener({ agent }) },
    refused: (name, agent) => [...guards]
      .map(guard => guard({ name, ...(agent === undefined ? {} : { agent }) }))
      .find(reason => reason !== undefined),
  }
}

/** The live agents, as the engine's registry holds them. */
const live = new Map<string, LineageAgentLike>()

/** @returns a live agent of the given session, with its own recorded tools face. */
const agentOf = (id: string, parentSession?: string): LineageAgentLike & { ctx: { tools: FakeTools } } => {
  const agent = {
    session: { header: { id, ...(parentSession === undefined ? {} : { parentSession }) } },
    ctx: { tools: fakeTools([...ENGINE_DEFAULTS, ...MCP]) },
  }
  live.set(id, agent)
  return agent
}

describe('the policy follows the session lineage of a run, not the agent it is set on', () => {
  it('refuses and hides for the root, its child and the child\'s child; never for another session', () => {
    const { host, announce, refused, guards } = fakeHost()
    const stop = scopeToolPolicy(host, 'trn_1', channelPolicy(['qonto']))
    const root = agentOf('trn_1')
    const child = agentOf('child_1', 'trn_1')
    const grandchild = agentOf('child_2', 'child_1')
    for (const agent of [root, child, grandchild]) {
      announce(agent)
      expect(agent.ctx.tools.allow, agent.session.header.id).toEqual(['mcp__qonto__list_transactions', 'mcp__approvals__request_approval'])
      expect(refused('bash', agent), agent.session.header.id).toBeDefined()
      expect(refused('mcp__dolibarr__get_invoices', agent)).toBeDefined()
      expect(refused('mcp__qonto__list_transactions', agent)).toBeUndefined()
    }
    // A child refused before it was announced is refused all the same.
    expect(refused('bash', agentOf('child_3', 'trn_1'))).toBeDefined()
    // Another person's run, and a call with no agent: untouched.
    const other = agentOf('trn_2')
    announce(other)
    expect(other.ctx.tools.allow).toBeUndefined()
    expect(refused('bash', other)).toBeUndefined()
    expect(refused('bash')).toBeUndefined()
    stop()
    expect(guards.size).toBe(0)
    expect(refused('bash', root)).toBeUndefined()
  })

  it('refuses a grandchild whose parent was never announced nor ran a tool', () => {
    const { host, refused } = fakeHost()
    scopeToolPolicy(host, 'trn_race', channelPolicy(['qonto']))
    agentOf('trn_race')
    agentOf('race_child', 'trn_race')
    const grandchild = agentOf('race_grandchild', 'race_child')
    expect(refused('bash', grandchild)).toBeDefined()
    expect(refused('mcp__qonto__list_transactions', grandchild)).toBeUndefined()
  })

  it('bounds two runs at once each to its own servers, and leaves nothing behind either', () => {
    const { host, refused, guards } = fakeHost()
    const stopQonto = scopeToolPolicy(host, 'trn_q', channelPolicy(['qonto']))
    const stopDolibarr = scopeToolPolicy(host, 'trn_d', channelPolicy(['dolibarr']))
    const q = agentOf('child_q', 'trn_q')
    const d = agentOf('child_d', 'trn_d')
    agentOf('trn_q')
    agentOf('trn_d')
    expect(refused('mcp__qonto__list_transactions', q)).toBeUndefined()
    expect(refused('mcp__dolibarr__get_invoices', q)).toMatch(/dolibarr is not allowed/)
    expect(refused('mcp__dolibarr__get_invoices', d)).toBeUndefined()
    expect(refused('mcp__qonto__list_transactions', d)).toMatch(/qonto is not allowed/)
    stopQonto()
    // The other run keeps its bound; the finished one leaves no guard.
    expect(refused('mcp__qonto__list_transactions', d)).toMatch(/qonto is not allowed/)
    expect(refused('mcp__dolibarr__get_invoices', q)).toBeUndefined()
    stopDolibarr()
    expect(guards.size).toBe(0)
    // A later run with the same session id starts from its own policy alone.
    const stopNext = scopeToolPolicy(host, 'trn_q', channelPolicy(['dolibarr']))
    expect(refused('mcp__dolibarr__get_invoices', q)).toBeUndefined()
    expect(refused('mcp__qonto__list_transactions', q)).toMatch(/qonto is not allowed/)
    stopNext()
  })
})

describe('the runners scope it before the agent exists, and lift it after', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mndt-tool-policy-'))
    process.env.MNDT_MISSION_ACTOR_FILE = join(dir, 'actor.json')
  })
  afterEach(async () => {
    delete process.env.MNDT_MISSION_ACTOR_FILE
    await rm(dir, { recursive: true, force: true })
  })

  /**
   * @param createdAs - the session id the fake engine gives the agent (its requested id when omitted).
   * @returns a host whose run creates an agent and a workflow child, and records what each saw.
   */
  function fakeCtx(createdAs?: string) {
    const { host, announce, refused, guards } = fakeHost()
    type Announced = ReturnType<typeof agentOf>
    type Seen = { root?: Announced; child?: Announced; childBash?: string | undefined; guardsAtCreate?: number }
    const seen: Seen = {}
    const ctx = {
      on: host.on,
      // As in production: this plugin does not inject `tools`, so reading it throws.
      get tools(): never { throw new Error('cannot get property "tools" without inject') },
      get: (name: string) => (name === 'tools' ? host.tools : name === 'workflowEngine'
        ? {
          start: () => {
            // The workflow child: the agent that actually calls the model.
            const child = agentOf('child_1', seen.root!.session.header.id)
            announce(child)
            seen.child = child
            seen.childBash = refused('bash', child)
            return { id: 'run-1', result: Promise.resolve('Réponse.') }
          },
        }
        : undefined),
      agents: {
        get: host.agents.get,
        create: async (options: { sessionId: string }) => {
          seen.guardsAtCreate = guards.size
          const root = agentOf(createdAs ?? options.sessionId)
          announce(root)
          seen.root = root
          return { agent: root, dispose: async () => undefined }
        },
      },
    }
    // `on` also serves the runner's own session/event listener.
    return { ctx: ctx as unknown as Context, seen, guards }
  }

  const turn = (): TurnInput => ({
    turnId: 'trn_1', actor: 'smarion@datanalysis.re', prompt: 'Bonjour', cwd: join(dir, 'files'),
    servers: ['qonto'], signal: new AbortController().signal,
    agent: { handle: 'assistant', provider: 'p', model: 'm' },
    channel: { id: 'ch_1', name: 'compta' },
  } as unknown as TurnInput)

  it('a channel turn: the root and the workflow child get its servers and the approvals, nothing else', async () => {
    const { ctx, seen, guards } = fakeCtx()
    const output = await new DshTurnRunner(ctx).run(turn())
    expect(output.text).toBe('Réponse.')
    expect(seen.guardsAtCreate).toBe(1)
    expect(seen.root?.ctx.tools.allow).toEqual(['mcp__qonto__list_transactions', 'mcp__approvals__request_approval'])
    expect(seen.child?.ctx.tools.allow).toEqual(['mcp__qonto__list_transactions', 'mcp__approvals__request_approval'])
    expect(seen.childBash).toBeDefined()
    expect(guards.size).toBe(0)
  })

  it('fails closed when the agent is not created under the session its policy is keyed by', async () => {
    const { ctx, guards } = fakeCtx('another_session')
    await expect(new DshTurnRunner(ctx).run(turn())).rejects.toThrow(/tool policy would not apply/)
    expect(guards.size).toBe(0)
  })

  it('a team mission: MCP tools only, child included; a declared solo mission keeps the whole composition', async () => {
    const mission = { id: 'msn_1', kind: 'briefing', prompt: 'Brief', createdBy: 'stephane@datanalysis.re' } as unknown as Mission
    const team = fakeCtx()
    await new DshMissionRunner(team.ctx, { tools: TEAM_MISSION_POLICY }).run(mission)
    expect(team.seen.child?.ctx.tools.allow).toEqual(MCP)
    expect(team.seen.childBash).toBeDefined()

    const solo = fakeCtx()
    await new DshMissionRunner(solo.ctx).run(mission)
    expect(solo.seen.guardsAtCreate).toBe(0)
    expect(solo.seen.child?.ctx.tools.allow).toBeUndefined()
  })

  it('the whole composition only on a host declared solo, never behind the sign-on proxy', () => {
    expect(soloWorkstation(undefined, {})).toBe(false)
    expect(soloWorkstation(undefined, { DSH_MNDT_SOLO_WORKSTATION: 'true' })).toBe(false)
    expect(soloWorkstation(undefined, { DSH_MNDT_SOLO_WORKSTATION: '1' })).toBe(true)
    expect(soloWorkstation('x-forwarded-email', { DSH_MNDT_SOLO_WORKSTATION: '1' })).toBe(false)
  })
})
