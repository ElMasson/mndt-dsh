/**
 * The tool policy against the real engine: an agent composed by a preset, and
 * the child it delegates to (the workflow's `agent()` is such a child: it is
 * the agent that calls the model). The child's own requests and executions are
 * what the assertions read, not a fake tools face.
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountLocalActivations, startPreparedActivation } from '../../../subagent/subagent/tests/local-activation.ts'
import { channelPolicy, scopeToolPolicy, toolRefusal } from '../src/tool-policy.ts'
import type { PolicyHostLike, ScopedToolsLike } from '../src/tool-policy.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const TOOLS = ['bash', 'mcp__qonto__list_transactions', 'mcp__dolibarr__get_invoices', 'mcp__approvals__request_approval']
const ran = (): string[] => ((globalThis as { __mndtPolicyRan?: string[] }).__mndtPolicyRan ??= [])
const contexts: Context[] = []

beforeEach(() => { ran().length = 0 })
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

/**
 * @param scope - what to do to the host and the parent before the child starts.
 * @returns the host, its mock model, and the parent composed by the preset.
 */
async function host(scope: (ctx: Context, parentCtx: Context | undefined) => void, when: 'before' | 'setup') {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = `${pathToFileURL(FIXTURES).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await mountAgentLoopTestDependencies(ctx)
  await mountLocalActivations(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, { default: 'team' })
  await ctx.agentPresets.register({ id: 'team', plugins: [{ name: pathToFileURL(join(FIXTURES, 'policy-preset-tools.js')).href, config: { tools: TOOLS } }] })
  // The child calls the shell, another channel's server, its own server, then answers.
  const adapter = new MockAdapter([
    toolCallResponse('c1', 'bash', {}),
    toolCallResponse('c2', 'mcp__dolibarr__get_invoices', {}),
    toolCallResponse('c3', 'mcp__qonto__list_transactions', {}),
    textResponse('child done'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  if (when === 'before') scope(ctx, undefined)
  const handle = await ctx.agents.create({
    sessionId: SessionId('trn_1'),
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async (agentCtx: Context) => {
      await ctx.agentPresets.mount(agentCtx, 'team')
      if (when === 'setup') scope(ctx, agentCtx)
    },
  })
  return { ctx, adapter, parent: handle.agent }
}

/** @param parent - the delegating agent. @returns the child's run, as the workflow engine starts it. */
async function child(parent: Agent) {
  const run = await startPreparedActivation({
    label: 'mndt-turn child', prompt: [{ type: 'text', text: 'bonjour' }], parent, signal: new AbortController().signal,
  }, {})
  await run.result
  return run
}

/** @param adapter - the mock model. @returns the tools offered on each request, and every tool result the model read. */
function seenBy(adapter: MockAdapter) {
  const offered = adapter.requests.map(request => (request.tools ?? []).map(tool => tool.name).sort())
  const results = JSON.stringify(adapter.requests.at(-1)?.messages ?? [])
  return { offered, results }
}

describe('the tool policy reaches the agent that calls the model', () => {
  it('scoped to the run\'s session lineage: the child sees and runs only what the channel allows', async () => {
    const { adapter, parent } = await host((ctx) => { scopeToolPolicy(ctx as unknown as PolicyHostLike, 'trn_1', channelPolicy(['qonto'])) }, 'before')
    const run = await child(parent)
    const { offered, results } = seenBy(adapter)
    for (const tools of offered) expect(tools).toEqual(['mcp__approvals__request_approval', 'mcp__qonto__list_transactions'])
    expect(ran()).toEqual(['mcp__qonto__list_transactions'])
    expect(results).toContain('the tool bash is not open to the agents of the team')
    expect(results).toContain('the MCP server dolibarr is not allowed in this channel')
    await run.dispose()
  })

  it('the differential: a restriction and a guard set on the parent alone never reach the child', async () => {
    const policy = channelPolicy(['qonto'])
    const { adapter, parent } = await host((_ctx, parentCtx) => {
      // The first version of #63: restrict and guard on the turn's own agent.
      const tools = (parentCtx as unknown as { tools: ScopedToolsLike }).tools
      tools.restrict({ allow: tools.schemas().map(tool => tool.name).filter(name => toolRefusal(name, policy) === undefined) })
      tools.guard(execution => toolRefusal(execution.name, policy))
    }, 'setup')
    const run = await child(parent)
    const { offered } = seenBy(adapter)
    expect(offered[0]).toEqual([...TOOLS].sort())
    expect(ran()).toEqual(['bash', 'mcp__dolibarr__get_invoices', 'mcp__qonto__list_transactions'])
    await run.dispose()
  })
})
