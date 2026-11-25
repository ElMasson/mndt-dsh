import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DshMissionRunner, DshTurnRunner, NO_FACTS_NOTE } from '../src/runner.ts'
import { REQUIRED_TOOLS, ToolsReadiness } from '../src/tools-ready.ts'
import { clearOperatorWarning } from '../src/operator-log.ts'
import { soloWorkstation } from '../src/gateway.ts'
import {
  ALLOWED_TOOLS, ALWAYS_SERVERS, TEAM_MISSION_POLICY, channelPolicy, hideOutsidePolicy, isServerName, mcpServerOf,
  noCardsPolicy, scopeToolPolicy, toolRefusal,
} from '../src/tool-policy.ts'
import type { LineageAgentLike, ScopedToolsLike } from '../src/tool-policy.ts'
import type { Mission } from '../src/core/index.ts'
import { TurnBudgetReached } from '../src/turns.ts'
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
  /** How the fake host's run ends and which child provider its workflow engine uses. */
  interface FakeOptions {
    readonly createdAs?: string
    readonly provider?: { readonly name?: string; readonly start?: () => void; readonly unregistered?: true } | 'unreadable'
    readonly agentDisposeThrows?: boolean
    /** Model messages the run reports, by their input tokens (each writes `output`). */
    readonly messages?: readonly { readonly input: number; readonly output: number; readonly toolCalls?: number }[]
    /** The output cap the host's llm reports for the model (defaultMaxTokens). */
    readonly outputCap?: number
    /** The workstation's default model, the one a mission runs on. */
    readonly defaultModel?: { readonly provider: string; readonly model: string }
  }

  function fakeCtx(options: FakeOptions = {}) {
    const { host, announce, refused, guards } = fakeHost()
    type Announced = ReturnType<typeof agentOf>
    interface Seen {
      root?: Announced
      child?: Announced
      childBash?: string | undefined
      guardsAtCreate?: number
      guardsAtRunDispose?: number
      runDisposedBeforeAgent?: boolean
      /** How many messages had been reported when the agent was disposed. */
      messagesAtAgentDispose?: number
      /** The script the run was started with. */
      script?: string
    }
    const seen: Seen = {}
    let runDisposed = false
    let agentDisposed = false
    let reported = 0
    type SessionListener = (session: unknown, event: unknown) => void
    const sessionListeners = new Set<SessionListener>()
    const provider = options.provider ?? {}
    const engine = {
      ...(provider === 'unreadable' ? {} : { config: { provider: provider.name ?? 'spawn' } }),
      start: (spec?: { script?: string }) => {
        if (spec?.script !== undefined) seen.script = spec.script
        // The workflow child: the agent that actually calls the model.
        const child = agentOf('child_1', seen.root!.session.header.id)
        announce(child)
        seen.child = child
        seen.childBash = refused('bash', child)
        for (const [index, message] of (options.messages ?? []).entries()) {
          if (agentDisposed) break
          reported = index + 1
          for (const listener of sessionListeners) {
            listener(seen.root!.session, { type: 'assistant/message', data: { usage: { inputTokens: message.input, outputTokens: message.output }, message: { content: Array.from({ length: message.toolCalls ?? 0 }, () => ({ type: 'tool-call' })) } } })
          }
        }
        return {
          id: 'run-1',
          result: Promise.resolve('Réponse.'),
          dispose: async () => { runDisposed = true; seen.guardsAtRunDispose = guards.size },
        }
      },
    }
    const subagents = {
      getProvider: (name: string) => (provider !== 'unreadable' && provider.unregistered !== true && name === (provider.name ?? 'spawn')
        ? (provider.start === undefined ? {} : { start: provider.start })
        : undefined),
    }
    const ctx = {
      on: (event: string, listener: never) => {
        if (event !== 'session/event') return host.on(event as 'agent/created', listener)
        sessionListeners.add(listener)
        return () => { sessionListeners.delete(listener) }
      },
      logger: { warn: () => undefined },
      // As in production: this plugin does not inject `tools`, so reading it throws.
      get tools(): never { throw new Error('cannot get property "tools" without inject') },
      get: (name: string) => ({
        tools: host.tools, workflowEngine: engine, subagents,
        ...(options.outputCap === undefined ? {} : { llm: { resolveModelInfo: async () => ({ defaultMaxTokens: options.outputCap }) } }),
        ...(options.defaultModel === undefined ? {} : { agentDefaultModel: { currentSelection: () => options.defaultModel } }),
      } as Record<string, unknown>)[name],
      agents: {
        get: host.agents.get,
        create: async (create: { sessionId: string }) => {
          seen.guardsAtCreate = guards.size
          const root = agentOf(options.createdAs ?? create.sessionId)
          announce(root)
          seen.root = root
          return {
            agent: root,
            dispose: async () => {
              if (!agentDisposed) seen.messagesAtAgentDispose = reported
              agentDisposed = true
              seen.runDisposedBeforeAgent = runDisposed
              if (options.agentDisposeThrows === true) throw new Error('dispose failed')
            },
          }
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

  /** @param names - the tools registered now. @returns a readiness over them, with a short bound. */
  const readinessOver = (names: string[], warned: string[] = []) =>
    new ToolsReadiness(() => ({ schemas: () => names.map(name => ({ name })) }), () => () => undefined, (m) => { warned.push(m) }, 30)
  /** The approvals' six card tools, registered. */
  const APPROVALS = REQUIRED_TOOLS.approvals!.map(tool => `mcp__approvals__${tool}`)

  it('the approvals not registered at the bound: the turn does not start, and says why', async () => {
    const { ctx, seen } = fakeCtx()
    await expect(new DshTurnRunner(ctx, readinessOver(['mcp__qonto__list'])).run(turn()))
      .rejects.toThrow('outils indisponibles : approvals (démarrage en cours ou connecteur en panne)')
    expect(seen.root).toBeUndefined()
  })

  it('a channel connector not registered: the turn runs with the tools ready, told so, and records it', async () => {
    const { ctx, seen } = fakeCtx()
    const output = await new DshTurnRunner(ctx, readinessOver(APPROVALS)).run(turn())
    expect(output.text).toBe('Réponse.')
    expect(output.toolsUnavailable).toEqual(['qonto'])
    expect(seen.script).toContain('Outils indisponibles pour ce tour : qonto (démarrage en cours ou connecteur en panne). Ne prétends pas les avoir consultés.')
  })

  it('the approvals with one card tool still missing count as not ready: a partial list would freeze a partial allow-list', async () => {
    const { ctx, seen } = fakeCtx()
    await expect(new DshTurnRunner(ctx, readinessOver([...APPROVALS.slice(1), 'mcp__qonto__list'])).run(turn()))
      .rejects.toThrow('outils indisponibles : approvals')
    expect(seen.root).toBeUndefined()
  })

  it('a mission reports its cost when its model\'s price is known, and none when it is not', async () => {
    const custom = { id: 'msn_c', kind: 'custom', prompt: 'Fais le point', createdBy: 'stephane@datanalysis.re' } as unknown as Mission
    const defaultModel = { provider: 'scaleway-genapi', model: 'deepseek-v4.1-flash' }
    const priced = fakeCtx({ defaultModel, messages: [{ input: 1_000_000, output: 500_000 }] })
    const prices = { 'scaleway-genapi/deepseek-v4.1-flash': { input: 0.2, output: 0.8 } }
    const options = { tools: TEAM_MISSION_POLICY, readiness: readinessOver(APPROVALS) }
    const result = await new DshMissionRunner(priced.ctx, { ...options, prices }).run(custom)
    expect(result.eur).toBeCloseTo(0.6, 6)
    const unpriced = fakeCtx({ defaultModel, messages: [{ input: 1_000_000, output: 500_000 }] })
    expect((await new DshMissionRunner(unpriced.ctx, { ...options, prices: {} }).run(custom)).eur).toBeUndefined()
  })

  it('a mission waits too: without the approvals it does not start; a briefing needs the facts as well', async () => {
    const briefing = { id: 'msn_1', kind: 'briefing', prompt: 'Brief', createdBy: 'stephane@datanalysis.re' } as unknown as Mission
    const custom = { ...briefing, id: 'msn_2', kind: 'custom' } as unknown as Mission
    const none = fakeCtx()
    await expect(new DshMissionRunner(none.ctx, { tools: TEAM_MISSION_POLICY, readiness: readinessOver(['mcp__workbench_facts__get_facts']) }).run(briefing))
      .rejects.toThrow('outils indisponibles : approvals (démarrage en cours ou connecteur en panne) ; la mission n’a pas été lancée')
    expect(none.seen.root).toBeUndefined()
    const noFacts = fakeCtx()
    await expect(new DshMissionRunner(noFacts.ctx, { tools: TEAM_MISSION_POLICY, readiness: readinessOver(APPROVALS) }).run(briefing))
      .rejects.toThrow('outils indisponibles : workbench_facts')
    expect(noFacts.seen.root).toBeUndefined()
    const other = fakeCtx()
    await new DshMissionRunner(other.ctx, { tools: TEAM_MISSION_POLICY, readiness: readinessOver(APPROVALS) }).run(custom)
    expect(other.seen.root).toBeDefined()
  })

  it('a space that does not configure the approvals (a solo workstation) neither waits for nor requires them', async () => {
    const briefing = { id: 'msn_1', kind: 'briefing', prompt: 'Brief', createdBy: 'stephane@datanalysis.re' } as unknown as Mission
    const slow = () => new ToolsReadiness(() => ({ schemas: () => [] }), () => () => undefined, () => undefined, 60_000)
    const started = Date.now()
    const solo = fakeCtx()
    await new DshMissionRunner(solo.ctx, { readiness: slow(), configured: () => false }).run(briefing)
    expect(solo.seen.root).toBeDefined()
    const turnCtx = fakeCtx()
    const output = await new DshTurnRunner(turnCtx.ctx, slow(), server => server === 'qonto').run({ ...turn(), servers: [] })
    expect(output.toolsUnavailable).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(2000)
    // Configured: required again.
    const team = fakeCtx()
    await expect(new DshMissionRunner(team.ctx, { readiness: readinessOver([]), configured: () => true }).run(briefing)).rejects.toThrow('outils indisponibles : approvals')
  })

  it('behind the proxy the approvals stay required even with no descriptor; only a declared solo workstation lifts them', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { requiredServersRule } = await import('../src/gateway.ts')
    const empty = mkdtempSync(join(tmpdir(), 'mndt-nodesc-'))
    const none = () => new ToolsReadiness(() => ({ schemas: () => [] }), () => () => undefined, () => undefined, 30)
    // A proxy (a tenant), no connectors/approvals.json: the turn fails, said.
    const tenant = fakeCtx()
    await expect(new DshTurnRunner(tenant.ctx, none(), requiredServersRule('x-forwarded-email', empty, { DSH_MNDT_SOLO_WORKSTATION: '1' })).run(turn()))
      .rejects.toThrow('outils indisponibles : approvals')
    expect(tenant.seen.root).toBeUndefined()
    // Not declared solo, no proxy either: still required.
    const undeclared = fakeCtx()
    await expect(new DshTurnRunner(undeclared.ctx, none(), requiredServersRule(undefined, empty, {})).run(turn()))
      .rejects.toThrow('outils indisponibles : approvals')
    // A declared solo workstation without the descriptor: the turn runs.
    const solo = fakeCtx()
    const output = await new DshTurnRunner(solo.ctx, none(), requiredServersRule(undefined, empty, { DSH_MNDT_SOLO_WORKSTATION: '1' })).run({ ...turn(), servers: [] })
    expect(output.text).toBe('Réponse.')
  })

  it('a mission\'s prompt opens with the date line, in the zone given, as every turn\'s', async () => {
    const briefing = { id: 'msn_1', kind: 'briefing', prompt: 'Brief', createdBy: 'stephane@datanalysis.re' } as unknown as Mission
    const { ctx, seen } = fakeCtx()
    const now = new Date('2026-11-24T21:30:00Z')
    await new DshMissionRunner(ctx, { tools: TEAM_MISSION_POLICY, readiness: readinessOver(APPROVALS.concat('mcp__workbench_facts__get_facts')), timeZone: 'Indian/Reunion', now: () => now }).run(briefing)
    const sent = JSON.parse((seen.script ?? '').replace(/^return await agent\(/, '').replace(/\)$/, '')) as string
    expect(sent.startsWith('Nous sommes le mercredi 25 novembre 2026, 01:30 (heure de La Réunion).\n\n')).toBe(true)
    expect(sent).toContain('Brief')
  })

  /** @returns a team's mission runner over this readiness, the facts server mounted or not. */
  const teamMissions = (ctx: Context, readiness: ToolsReadiness, facts: boolean) =>
    new DshMissionRunner(ctx, { tools: TEAM_MISSION_POLICY, readiness, factsConfigured: () => facts })

  it('a briefing on a space that mounts no facts server runs without them, and its prompt says so', async () => {
    const briefing = { id: 'msn_1', kind: 'briefing', prompt: 'Brief', createdBy: 'stephane@datanalysis.re' } as unknown as Mission
    const { ctx, seen } = fakeCtx()
    const runner = teamMissions(ctx, readinessOver(APPROVALS), false)
    await runner.run(briefing)
    expect(seen.root).toBeDefined()
    const sent = JSON.parse((seen.script ?? '').replace(/^return await agent\(/, '').replace(/\)$/, '')) as string
    expect(sent).toContain(NO_FACTS_NOTE)
  })

  it('a briefing on a space that mounts the facts, whose tools are absent: it fails, said; a custom mission never carries the note', async () => {
    const briefing = { id: 'msn_1', kind: 'briefing', prompt: 'Brief', createdBy: 'stephane@datanalysis.re' } as unknown as Mission
    const mounted = fakeCtx()
    const runner = teamMissions(mounted.ctx, readinessOver(APPROVALS), true)
    await expect(runner.run(briefing)).rejects.toThrow('outils indisponibles : workbench_facts')
    expect(mounted.seen.root).toBeUndefined()
    const custom = fakeCtx()
    const plain = teamMissions(custom.ctx, readinessOver(APPROVALS), false)
    await plain.run({ ...briefing, kind: 'custom' } as unknown as Mission)
    expect(custom.seen.script ?? '').not.toContain('workbench_facts (non monté')
  })

  it('the operator hears of « no facts » once per passage, and the briefing records it for the screen', async () => {
    clearOperatorWarning('briefing-without-facts')
    const briefing = { id: 'msn_1', kind: 'briefing', prompt: 'Brief', createdBy: 'stephane@datanalysis.re' } as unknown as Mission
    const warned: string[] = []
    const run = async (facts: boolean) => {
      const { ctx } = fakeCtx()
      ;(ctx as unknown as { logger: { warn: (m: string) => void } }).logger = { warn: (m: string) => { warned.push(m) } }
      const readiness = readinessOver(facts ? [...APPROVALS, 'mcp__workbench_facts__get_facts'] : APPROVALS)
      return teamMissions(ctx, readiness, facts).run(briefing)
    }
    const first = await run(false)
    await run(false)
    expect(warned.filter(m => m.includes('briefing sans workbench_facts : descripteur absent'))).toHaveLength(1)
    expect(first.toolsUnavailable).toEqual(['workbench_facts'])
    // The facts come back: nothing said, nothing recorded; then gone again: said again, once.
    const back = await run(true)
    expect(back.toolsUnavailable).toBeUndefined()
    await run(false)
    await run(false)
    expect(warned.filter(m => m.includes('briefing sans workbench_facts : descripteur absent'))).toHaveLength(2)
  })

  it('without the approvals a briefing never runs, facts mounted or not', async () => {
    const briefing = { id: 'msn_1', kind: 'briefing', prompt: 'Brief', createdBy: 'stephane@datanalysis.re' } as unknown as Mission
    for (const factsConfigured of [true, false]) {
      const { ctx, seen } = fakeCtx()
      const readiness = readinessOver(['mcp__workbench_facts__get_facts'])
      const runner = teamMissions(ctx, readiness, factsConfigured)
      await expect(runner.run(briefing)).rejects.toThrow('outils indisponibles : approvals')
      expect(seen.root).toBeUndefined()
    }
  })

  it('a turn stopped while it waits leaves at once, and does not start', async () => {
    const { ctx, seen } = fakeCtx()
    const controller = new AbortController()
    const slow = new ToolsReadiness(() => ({ schemas: () => [] }), () => () => undefined, () => undefined, 60_000)
    const started = Date.now()
    const running = new DshTurnRunner(ctx, slow).run({ ...turn(), signal: controller.signal })
    setTimeout(() => { controller.abort() }, 20)
    await expect(running).rejects.toThrow('turn stopped')
    expect(Date.now() - started).toBeLessThan(2000)
    expect(seen.root).toBeUndefined()
  })

  it('a reading step (no server) waits for nothing', async () => {
    const { ctx } = fakeCtx()
    const started = Date.now()
    // A readiness that would wait a full minute: any wait at all would show, under any load.
    const slow = new ToolsReadiness(() => ({ schemas: () => [] }), () => () => undefined, () => undefined, 60_000)
    await new DshTurnRunner(ctx, slow).run({ ...turn(), tools: 'none' })
    expect(Date.now() - started).toBeLessThan(2000)
  })

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

  it('a worker of « en parallèle puis synthèse »: its connectors, not the approvals', async () => {
    const { ctx, seen } = fakeCtx()
    await new DshTurnRunner(ctx).run({ ...turn(), tools: 'no-cards' })
    expect(seen.root?.ctx.tools.allow).toEqual(['mcp__qonto__list_transactions'])
    expect(seen.child?.ctx.tools.allow).toEqual(['mcp__qonto__list_transactions'])
    expect(noCardsPolicy(['qonto', 'approvals']).servers).toEqual(new Set(['qonto']))
  })

  it('a step with a cost bound stops before a message that would not fit, and says what it used', async () => {
    // 1 €/M in, 1 €/M out. Each message reads 100 000 tokens and writes 1000; a
    // next message reserves that input, that output, 12 500 per tool called,
    // and the model's output cap (8192 unless the host says less).
    const price = { input: 1, output: 1 }
    const call = { input: 100_000, output: 1000, toolCalls: 1 }
    const messages = [call, call, { input: 100_000, output: 1000 }]
    const bounded = fakeCtx({ messages })
    const error = await new DshTurnRunner(bounded.ctx).run({ ...turn(), budget: { eur: 0.25, price } }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(TurnBudgetReached)
    // After two messages (0.202 €), a third (≥ 0.1217 €) would pass 0.25 €.
    expect(bounded.seen.messagesAtAgentDispose).toBe(2)
    expect((error as TurnBudgetReached).tokens).toMatchObject({ input: 200_000, output: 2000 })

    // Each tool called adds a result to the next message's input.
    const one = fakeCtx({ messages })
    await new DshTurnRunner(one.ctx).run({ ...turn(), budget: { eur: 0.23, price } }).catch(() => undefined)
    expect(one.seen.messagesAtAgentDispose).toBe(2)
    const two = fakeCtx({ messages: [{ ...call, toolCalls: 2 }, ...messages.slice(1)] })
    await new DshTurnRunner(two.ctx).run({ ...turn(), budget: { eur: 0.23, price } }).catch(() => undefined)
    expect(two.seen.messagesAtAgentDispose).toBe(1)

    // A model whose output cap is below the reserve lets the step go further.
    const uncapped = fakeCtx({ messages })
    await new DshTurnRunner(uncapped.ctx).run({ ...turn(), budget: { eur: 0.22, price } }).catch(() => undefined)
    expect(uncapped.seen.messagesAtAgentDispose).toBe(1)
    const capped = fakeCtx({ messages, outputCap: 1000 })
    await new DshTurnRunner(capped.ctx).run({ ...turn(), budget: { eur: 0.22, price } }).catch(() => undefined)
    expect(capped.seen.messagesAtAgentDispose).toBe(2)

    // A message that calls no tool ends the turn: its answer is kept, even with no room left.
    const answer = fakeCtx({ messages: [{ input: 100_000, output: 1000 }] })
    expect((await new DshTurnRunner(answer.ctx).run({ ...turn(), budget: { eur: 0.15, price } })).tokens)
      .toMatchObject({ input: 100_000, output: 1000 })

    const roomy = fakeCtx({ messages })
    const output = await new DshTurnRunner(roomy.ctx).run({ ...turn(), budget: { eur: 5, price } })
    expect(output.tokens).toMatchObject({ input: 300_000, output: 3000 })
  })

  it('fails closed when the agent is not created under the session its policy is keyed by', async () => {
    const { ctx, guards } = fakeCtx({ createdAs: 'another_session' })
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

  it('lifts the policy last, after the workflow and the agent, and keeps it when one of them cannot be released', async () => {
    const ordered = fakeCtx()
    await new DshTurnRunner(ordered.ctx).run(turn())
    expect(ordered.seen.guardsAtRunDispose).toBe(1)
    expect(ordered.seen.runDisposedBeforeAgent).toBe(true)
    expect(ordered.guards.size).toBe(0)

    const failing = fakeCtx({ agentDisposeThrows: true })
    await expect(new DshTurnRunner(failing.ctx).run(turn())).rejects.toThrow(/dispose failed/)
    // An agent that could not be released keeps its guard: the run fails closed.
    expect(failing.guards.size).toBe(1)
  })

  it('refuses to start when the workflow\'s children would run out of process, or its provider cannot be read', async () => {
    const cases: NonNullable<FakeOptions['provider']>[] = [{ name: 'claude-code', start: () => undefined }, 'unreadable', { name: 'spawn', unregistered: true }]
    for (const provider of cases) {
      const { ctx, guards, seen } = fakeCtx({ provider })
      await expect(new DshTurnRunner(ctx).run(turn())).rejects.toThrow(/not an in-process one/)
      expect(seen.root).toBeUndefined()
      expect(guards.size).toBe(0)
    }
  })

  it('the whole composition only on a host declared solo, never behind the sign-on proxy', () => {
    expect(soloWorkstation(undefined, {})).toBe(false)
    expect(soloWorkstation(undefined, { DSH_MNDT_SOLO_WORKSTATION: 'true' })).toBe(false)
    expect(soloWorkstation(undefined, { DSH_MNDT_SOLO_WORKSTATION: '1' })).toBe(true)
    expect(soloWorkstation('x-forwarded-email', { DSH_MNDT_SOLO_WORKSTATION: '1' })).toBe(false)
  })
})
