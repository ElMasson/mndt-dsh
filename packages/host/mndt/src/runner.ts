/**
 * Running a mission for real.
 *
 * The runtime is DSH: a programmatic root agent carries the run, and the mounted
 * workflow engine executes one `agent(prompt)` step with that agent as parent.
 * Two things are read from the engine rather than assumed: the text the child
 * produced, and the failure contracts that a settled run does not report by
 * itself. A run that produced nothing is an error here, not an empty brief.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the agents service and the session/workflow event maps.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workflow'
import { mkdir } from 'node:fs/promises'
import type { Mission, MissionResult } from './core/index.ts'
import type { TurnEngine, TurnInput, TurnOutput } from './turns.ts'
import { clearActor, exclusive, publishActor } from './machine-tools.ts'

/** What the runner needs from the host. */
export interface DshRunnerOptions {
  /** Extra framing per mission kind, prepended to the caller's instruction. */
  readonly frame?: (mission: Mission) => string
}

/** Default framing: the product's voice and its evidence discipline. */
export function defaultFrame(mission: Mission): string {
  const goals: Record<string, string> = {
    briefing: 'Prépare le briefing quotidien : agenda, courriers sans réponse, comptes à risque, échéances, réunions du jour.',
    'meeting-prep': 'Prépare une note de préparation de réunion : participants, historique, sujets ouverts, questions à poser.',
    'account-review': 'Produis une revue de compte : santé, jalons, factures, risques, prochaines actions.',
    'invoice-chase': 'Identifie les factures échues et rédige les relances, sans jamais les envoyer.',
    'signal-watch': 'Synthétise les signaux utiles et ce qu’ils impliquent pour Duke Analytics.',
    'weekly-synthesis': 'Produis la synthèse hebdomadaire : avancées, blocages, décisions.',
    custom: 'Exécute la demande.',
  }
  return [
    'Tu travailles pour Duke Analytics. Tu réponds en français, en markdown, de façon dense et factuelle.',
    'Chaque affirmation doit pouvoir être rattachée à une source que tu cites à la fin, sous "Sources".',
    'Tu n’envoies jamais de courriel, ne publies rien et ne dépenses rien : tu prépares, un humain décide.',
    goals[mission.kind] ?? goals.custom,
    '',
    `Demande : ${mission.prompt}`,
  ].join('\n')
}

/** The engine face the runner uses, structurally. */
interface WorkflowEngineLike {
  start(input: { script: string; meta: { name: string; description: string }; parent: unknown }): {
    readonly id: string
    readonly result: Promise<unknown>
  }
}

/** The runner. */
export class DshMissionRunner {
  readonly #ctx: Context
  readonly #options: DshRunnerOptions

  /** @param ctx - the host context. @param options - optional framing. */
  constructor(ctx: Context, options: DshRunnerOptions = {}) {
    this.#ctx = ctx
    this.#options = options
  }

  /**
   * Run one mission.
   * @param mission - the mission.
   * @returns the title and markdown the child produced.
   */
  async run(mission: Mission): Promise<MissionResult> {
    // One queue with the agent turns: they publish the same actor record.
    return exclusive(() => this.#run(mission))
  }

  /**
   * Run one mission with the actor published for the machine tools.
   * @param mission - the mission.
   * @returns the title and markdown the child produced.
   */
  async #run(mission: Mission): Promise<MissionResult> {
    const engine = this.#ctx.get('workflowEngine') as WorkflowEngineLike | undefined
    if (engine === undefined) {
      throw new Error('mndt: this host does not mount the workflow engine, so a mission cannot run')
    }
    const model = this.#ctx.get('agentDefaultModel') as { currentSelection(): { provider: string; model: string } | undefined } | undefined
    const selection = model === undefined ? undefined : model.currentSelection()
    const created = await this.#ctx.agents.create({
      // A fresh session per mission keeps runs readable and disposable.
      sessionId: mission.id as never,
      ...(selection === undefined ? {} : { agentOptions: { provider: selection.provider, model: selection.model } }),
    })
    await publishActor(mission.createdBy, mission.id)
    const childSessionId = created.agent.session.header.id
    const failures: string[] = []
    // Usage arrives on `assistant/message` events, one per model step; the
    // settled run carries no counters of its own, so they are summed here.
    const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    const stopAgentEnd = this.#ctx.on('workflow/agent-end', (_info, agent) => {
      if (agent.outcome === 'failed') failures.push(`agent step ${agent.seq} ended failed`)
    })
    const rootId = childSessionId
    const stopTurnEnd = this.#ctx.on('session/event', (session, event) => {
      if (event.type === 'assistant/message') {
        type StepUsage = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
        const usage = (event as unknown as { data?: { usage?: StepUsage } }).data?.usage
        if (usage !== undefined) {
          usageTotals.input += usage.inputTokens ?? 0
          usageTotals.output += usage.outputTokens ?? 0
          usageTotals.cacheRead += usage.cacheReadTokens ?? 0
          usageTotals.cacheWrite += usage.cacheWriteTokens ?? 0
        }
      }
      if (event.type !== 'turn/end') return
      // The workflow engine runs an agent child under the root agent, so a
      // failure can be reported on either session; both are the same run.
      if (session.header.id !== rootId && session.header.parentSession !== rootId) return
      const reason = event.data.reason
      if (reason.kind !== 'completed') {
        failures.push(reason.kind === 'error' ? `the agent turn failed: ${reason.error.message}` : `the agent turn ended ${reason.kind}`)
      }
    })
    try {
      const prompt = (this.#options.frame ?? defaultFrame)(mission)
      const run = engine.start({
        script: `return await agent(${JSON.stringify(prompt)})`,
        meta: { name: 'mndt-mission', description: `mndt mission ${mission.kind}` },
        parent: created.agent,
      })
      const settled = await run.result
      if (failures.length > 0) throw new Error(failures.join('; '))
      const text = textOf(settled)
      if (text.trim() === '') {
        const shape = JSON.stringify(settled).slice(0, 300)
        throw new Error(`the agent returned no text (settled: ${shape})`)
      }
      const reported = usageTotals.input + usageTotals.output > 0
      const tokens = reported
        ? { input: usageTotals.input, output: usageTotals.output, cacheRead: usageTotals.cacheRead, cacheWrite: usageTotals.cacheWrite }
        : settledTokensOf(settled)
      return { title: titleOf(mission, text), markdown: text, sources: [], ...(tokens === undefined ? {} : { tokens }) }
    } finally {
      stopAgentEnd()
      stopTurnEnd()
      await clearActor()
      await created.dispose()
    }
  }
}

/** @param name - a tool name. @returns the MCP server it comes from, if it is an MCP tool. */
export function mcpServerOf(name: string): string | undefined {
  if (!name.startsWith('mcp__')) return undefined
  const end = name.indexOf('__', 'mcp__'.length)
  return end < 0 ? undefined : name.slice('mcp__'.length, end)
}

/** The servers every turn may reach: asking for a card is never an action. */
export const ALWAYS_SERVERS: readonly string[] = ['approvals']

/** The scoped tools face the turn setup uses, structurally. */
interface ScopedToolsLike {
  schemas(): readonly { readonly name: string }[]
  restrict(filter: { readonly deny: readonly string[] }): () => void
  guard(guard: (execution: { readonly name: string }) => string | undefined): () => void
}

/**
 * Run one agent turn on DSH: the agent's own model, its channel's folder as
 * the working directory, and only the MCP servers its channel allows. The
 * servers outside are hidden (restrict) and refused at execution (guard), so a
 * server mounted after the turn started is refused too.
 */
export class DshTurnRunner implements TurnEngine {
  readonly #ctx: Context

  /** @param ctx - the host context. */
  constructor(ctx: Context) {
    this.#ctx = ctx
  }

  /**
   * @param input - the turn.
   * @returns its text, session and tokens.
   */
  async run(input: TurnInput): Promise<TurnOutput> {
    return exclusive(() => this.#run(input))
  }

  /** @param input - the turn. @returns its output, with the actor published for its tools. */
  async #run(input: TurnInput): Promise<TurnOutput> {
    const engine = this.#ctx.get('workflowEngine') as WorkflowEngineLike | undefined
    if (engine === undefined) throw new Error('mndt: this host does not mount the workflow engine, so an agent cannot answer')
    await mkdir(input.cwd, { recursive: true })
    const allowed = new Set([...input.servers, ...ALWAYS_SERVERS])
    const created = await this.#ctx.agents.create({
      sessionId: input.turnId as never,
      meta: { cwd: input.cwd },
      // The agent's own model, never the workstation default.
      agentOptions: { provider: input.agent.provider, model: input.agent.model },
      setup: (agentCtx: unknown) => {
        const tools = (agentCtx as { tools: ScopedToolsLike }).tools
        const outside = tools.schemas().map(tool => tool.name)
          .filter((name) => { const server = mcpServerOf(name); return server !== undefined && !allowed.has(server) })
        if (outside.length > 0) tools.restrict({ deny: outside })
        tools.guard((execution) => {
          const server = mcpServerOf(execution.name)
          return server === undefined || allowed.has(server) ? undefined : `the MCP server ${server} is not allowed in this channel`
        })
      },
    })
    await publishActor(input.actor, input.turnId)
    const sessionId = created.agent.session.header.id
    const failures: string[] = []
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    const stopEvents = this.#ctx.on('session/event', (session, event) => {
      if (session.header.id !== sessionId && session.header.parentSession !== sessionId) return
      if (event.type === 'assistant/message') {
        type StepUsage = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
        const step = (event as unknown as { data?: { usage?: StepUsage } }).data?.usage
        if (step !== undefined) {
          usage.input += step.inputTokens ?? 0
          usage.output += step.outputTokens ?? 0
          usage.cacheRead += step.cacheReadTokens ?? 0
          usage.cacheWrite += step.cacheWriteTokens ?? 0
        }
      }
      if (event.type === 'turn/end' && event.data.reason.kind !== 'completed') {
        const reason = event.data.reason
        failures.push(reason.kind === 'error' ? `the agent turn failed: ${reason.error.message}` : `the agent turn ended ${reason.kind}`)
      }
    })
    // A deleted message or an agent leaving the channel stops the turn at once.
    const abort = (): void => { void created.dispose() }
    input.signal.addEventListener('abort', abort, { once: true })
    try {
      const run = engine.start({
        script: `return await agent(${JSON.stringify(input.prompt)})`,
        meta: { name: 'mndt-turn', description: `@${input.agent.handle} in #${input.channel.name}` },
        parent: created.agent,
      })
      const settled = await run.result
      if (input.signal.aborted) throw new Error('turn stopped')
      if (failures.length > 0) throw new Error(failures.join('; '))
      const text = textOf(settled)
      if (text.trim() === '') throw new Error(`the agent returned no text (settled: ${JSON.stringify(settled).slice(0, 300)})`)
      const tokens = usage.input + usage.output > 0 ? usage : settledTokensOf(settled)
      return { text, sessionId, ...(tokens === undefined ? {} : { tokens }) }
    } finally {
      input.signal.removeEventListener('abort', abort)
      stopEvents()
      await clearActor()
      await created.dispose()
    }
  }
}

/**
 * Find the text a settled run carries.
 * @param settled - whatever the engine resolved.
 * @returns the text, or an empty string when there is none.
 */
export function textOf(settled: unknown): string {
  if (typeof settled === 'string') return settled
  const record = settled as Record<string, unknown> | null
  if (record === null || typeof record !== 'object') return ''
  const candidates: unknown[] = [record.value, record.result, record.text, record.content, record.output]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
    const nested = candidate as Record<string, unknown> | null
    if (nested !== null && typeof nested === 'object') {
      for (const key of ['value', 'result', 'text', 'output'] as const) {
        const value = nested[key]
        if (typeof value === 'string' && value.trim() !== '') return value
      }
      const parts = nested.content
      if (Array.isArray(parts)) {
        const joined = parts
          .map(part => (typeof part === 'string' ? part : (part as { text?: unknown }).text))
          .filter((part): part is string => typeof part === 'string')
          .join('')
        if (joined.trim() !== '') return joined
      }
    }
  }
  return ''
}

/** @param settled - the settled run. @returns the token usage, when reported. */
function settledTokensOf(settled: unknown): { input: number; output: number } | undefined {
  const usage = (settled as { usage?: { inputTokens?: unknown; outputTokens?: unknown } } | null)?.usage
  if (usage === undefined || typeof usage.inputTokens !== 'number' || typeof usage.outputTokens !== 'number') return undefined
  return { input: usage.inputTokens, output: usage.outputTokens }
}

/**
 * Take the first heading as the brief title.
 * @param mission - the mission, for a fallback title.
 * @param text - the produced markdown.
 * @returns a title a person can scan.
 */
export function titleOf(mission: Mission, text: string): string {
  const heading = /^#{1,3}\s+(.+)$/m.exec(text)?.[1]?.trim()
  if (heading !== undefined && heading !== '') return heading.slice(0, 120)
  return `${mission.kind} ${new Date().toISOString().slice(0, 10)}`
}

/** @returns a fresh session identifier for a mission run. */
export function sessionIdFor(): string {
  return randomUUID()
}
