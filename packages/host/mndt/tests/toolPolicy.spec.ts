import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DshMissionRunner, DshTurnRunner } from '../src/runner.ts'
import {
  ALLOWED_TOOLS, ALWAYS_SERVERS, TEAM_MISSION_POLICY, applyToolPolicy, channelPolicy, toolRefusal,
} from '../src/tool-policy.ts'
import type { ScopedToolsLike } from '../src/tool-policy.ts'
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

/** @returns why the recorded guards refuse a call, if any does. */
const refusedBy = (face: FakeTools, name: string): string | undefined =>
  face.guards.map(guard => guard({ name })).find(reason => reason !== undefined)

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

  it('hides all but the allowed tools and refuses the rest at execution, a tool mounted later included', () => {
    const face = fakeTools([...ENGINE_DEFAULTS, ...MCP])
    const visible = applyToolPolicy(face, channelPolicy(['qonto']))
    expect(visible).toEqual(['mcp__qonto__list_transactions', 'mcp__approvals__request_approval'])
    expect(face.allow).toEqual(visible)
    expect(face.deny).toBeUndefined()
    for (const name of ENGINE_DEFAULTS) expect(refusedBy(face, name), name).toBeDefined()
    expect(refusedBy(face, 'mcp__dolibarr__get_invoices')).toBeDefined()
    // Mounted after the turn started: refused unless the policy names it.
    expect(refusedBy(face, 'shell_exec')).toBeDefined()
    expect(refusedBy(face, 'mcp__qonto__get_statement')).toBeUndefined()
    expect(refusedBy(face, 'mcp__approvals__request_approval')).toBeUndefined()
  })
})

describe('the runners apply it on the agent they create', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mndt-tool-policy-'))
    process.env.MNDT_MISSION_ACTOR_FILE = join(dir, 'actor.json')
  })
  afterEach(async () => {
    delete process.env.MNDT_MISSION_ACTOR_FILE
    await rm(dir, { recursive: true, force: true })
  })

  /** @returns a host context whose agents receive the recorded tools face. */
  function fakeCtx(face: FakeTools): { ctx: Context; setups: number[] } {
    const setups: number[] = []
    const ctx = {
      get: (name: string) => (name === 'workflowEngine'
        ? { start: () => ({ id: 'run-1', result: Promise.resolve('Réponse.') }) }
        : undefined),
      on: () => () => undefined,
      agents: {
        create: async (options: { setup?: (agentCtx: unknown) => void }) => {
          if (options.setup !== undefined) {
            setups.push(1)
            options.setup({ tools: face })
          }
          return { agent: { session: { header: { id: 'session-1' } } }, dispose: async () => undefined }
        },
      },
    }
    return { ctx: ctx as unknown as Context, setups }
  }

  it('a channel turn: its servers and the approvals, nothing else', async () => {
    const face = fakeTools([...ENGINE_DEFAULTS, ...MCP])
    const { ctx } = fakeCtx(face)
    const input = {
      turnId: 'trn_1', actor: 'smarion@datanalysis.re', prompt: 'Bonjour', cwd: join(dir, 'files'),
      servers: ['qonto'], signal: new AbortController().signal,
      agent: { handle: 'assistant', provider: 'p', model: 'm' },
      channel: { id: 'ch_1', name: 'compta' },
    } as unknown as TurnInput
    const output = await new DshTurnRunner(ctx).run(input)
    expect(output.text).toBe('Réponse.')
    expect(face.allow).toEqual(['mcp__qonto__list_transactions', 'mcp__approvals__request_approval'])
    expect(refusedBy(face, 'bash')).toBeDefined()
  })

  it('a team mission: MCP tools only; a solo mission keeps the whole composition', async () => {
    const mission = { id: 'msn_1', kind: 'briefing', prompt: 'Brief', createdBy: 'stephane@datanalysis.re' } as unknown as Mission
    const team = fakeTools([...ENGINE_DEFAULTS, ...MCP])
    await new DshMissionRunner(fakeCtx(team).ctx, { tools: TEAM_MISSION_POLICY }).run(mission)
    expect(team.allow).toEqual(MCP)
    expect(refusedBy(team, 'bash')).toBeDefined()

    const solo = fakeTools([...ENGINE_DEFAULTS, ...MCP])
    const soloCtx = fakeCtx(solo)
    await new DshMissionRunner(soloCtx.ctx).run(mission)
    expect(soloCtx.setups).toEqual([])
    expect(solo.allow).toBeUndefined()
  })
})
