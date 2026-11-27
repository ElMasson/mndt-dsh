/**
 * Running a mission for real.
 *
 * The runtime is DSH: a programmatic root agent carries the run, and the mounted
 * workflow engine executes one `agent(prompt)` step with that agent as parent.
 * Two things are read from the engine rather than assumed: the text the child
 * produced, and the failure contracts that a settled run does not report by
 * itself. A run that produced nothing is an error here, not an empty brief.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the agents service and the session/workflow event maps.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workflow'
import { mkdir } from 'node:fs/promises'
import { dateLine, instanceTimeZone } from './core/index.ts'
import type { Mission, MissionResult } from './core/index.ts'
import type { TurnEngine, TurnInput, TurnOutput } from './turns.ts'
import { RESERVED_OUTPUT_TOKENS, RESERVED_TOOL_RESULT_TOKENS, ROUTE_UNREACHABLE_CODES, RouteUnreachable, TurnBudgetReached } from './turns.ts'
import { eurOf, priceOf, Refusal } from './core/index.ts'
import type { PriceGrid } from './core/index.ts'
import { clearActor, exclusive, publishActor } from './machine-tools.ts'
import { ALWAYS_SERVERS, channelPolicy, NO_TOOLS_POLICY, noCardsPolicy, scopeToolPolicy } from './tool-policy.ts'
import { ToolsReadiness } from './tools-ready.ts'
import type { ToolsRegistryLike } from './tools-ready.ts'
import type { PolicyHostLike, ToolPolicy } from './tool-policy.ts'
import { clearOperatorWarning, warnOperator, warnOperatorOnce } from './operator-log.ts'
import { withoutThought } from './thought-text.ts'
import { NO_MODEL_ROLES } from './model-roles.ts'
import type { ModelRolesRead } from './model-roles.ts'

/** What the runner needs from the host. */
export interface DshRunnerOptions {
  /** The price grid: a mission's cost is reported when its model's price is known. */
  readonly prices?: PriceGrid
  /** Extra framing per mission kind, prepended to the caller's instruction. */
  readonly frame?: (mission: Mission) => string
  /**
   * The allow-list of the mission's agent. A team instance passes one (people
   * other than the owner start missions there); omitted, the mission keeps the
   * engine's whole composition, as on a solo workstation.
   */
  readonly tools?: ToolPolicy
  /** Whether the servers have registered their tools; shared with the turns (one memory of a server's unavailability). */
  readonly readiness?: ToolsReadiness
  /**
   * Whether a server is configured for this space. A required server (the
   * approvals, the facts) that is not configured is neither waited for nor
   * required: a solo workstation mounts none. Omitted, every server is.
   */
  readonly configured?: (server: string) => boolean
  /**
   * Whether the space mounts the facts server (its descriptor
   * connectors/workbench_facts.json exists). A briefing requires the facts only
   * then; otherwise it runs without them, told so. Omitted: mounted.
   *
   * Unlike the approvals' rule (required whatever is on disk, off a solo
   * workstation), the descriptor's disappearance lifts the facts' requirement:
   * so each passage to « no facts » is said once in the operator's log, and the
   * mission records it (toolsUnavailable) for the screen.
   */
  readonly factsConfigured?: () => boolean
  /**
   * The space's models by role (model-roles.ts): a briefing takes the
   * « briefing » role's route, any other mission the « mission » role's. A role
   * that says « agent », or no policy: the workstation's default model.
   */
  readonly modelRoles?: () => Promise<ModelRolesRead>
  /** The instance's IANA time zone, for the date line the mission's prompt opens with (default: the process's). */
  readonly timeZone?: string
  /** The clock (tests). */
  readonly now?: () => Date
}

/**
 * @param ctx - the host context.
 * @returns the servers' readiness read from its tool registry, its warnings in the operator's log.
 */
export function toolsReadinessOf(ctx: Context): ToolsReadiness {
  return new ToolsReadiness(
    () => ctx.get('tools') as ToolsRegistryLike | undefined,
    listener => ctx.on('tools/change' as never, listener as never),
    (message) => { warnOperator(ctx, message) },
  )
}

/**
 * @param mission - a mission.
 * @returns the servers it cannot run without: the approvals, and the facts for a briefing.
 */
export function missionRequiredServers(mission: Pick<Mission, 'kind'>, factsConfigured = true): string[] {
  // The facts are required only where the space mounts them: an instance with
  // no facts server (none of the guide's jumps mounts one) runs its briefings
  // without them, told so, instead of failing every one of them.
  return [...ALWAYS_SERVERS, ...(mission.kind === 'briefing' && factsConfigured ? ['workbench_facts'] : [])]
}

/** The note a briefing's prompt carries when the space mounts no facts server. */
export const NO_FACTS_NOTE = 'Outils indisponibles pour cette mission : workbench_facts (non monté sur cet espace). Ne prétends pas les avoir consultés.'

/** The operator-log key of the « briefing without facts » warning. */
const NO_FACTS_WARNING = 'briefing-without-facts'

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
    /** Awaits the script and its children's quiescence; idempotent. */
    dispose?(): Promise<void>
  }
}

/**
 * End a run: each release runs on its own, and the run's tool policy is lifted
 * only once every release succeeded. A child or an agent that could not be
 * released keeps its guard (a run that cannot end cleanly fails closed); the
 * first failure is rethrown.
 * @param ctx - the host context, for the log.
 * @param releases - what to release, in order.
 * @param unscope - lifts the run's policy.
 */
async function endRun(ctx: Context, releases: readonly (() => unknown)[], unscope: () => void): Promise<void> {
  const failures: unknown[] = []
  for (const release of releases) {
    try {
      await release()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length === 0) {
    unscope()
    return
  }
  // For the operator's log only: never served.
  const raw = failures.map(error => (error instanceof Error ? error.message : String(error))).join('; ')
  warnOperator(ctx, `mndt: a run did not end cleanly, its tool policy stays in force: ${raw}`)
  throw failures[0]
}

/**
 * The policy follows a run's children through the live agents of this process.
 * A child started by an external provider (another CLI, another process) would
 * not be one of them: its tool calls would escape the guard. A run under a
 * policy therefore requires the workflow engine's child provider to run in
 * process, and refuses to start otherwise, an unreadable setting included.
 * @param ctx - the host context.
 * @param engine - the workflow engine.
 */
function assertInProcessChildren(ctx: Context, engine: WorkflowEngineLike): void {
  const configured = (engine as { config?: { provider?: unknown } }).config?.provider
  const subagents = ctx.get('subagents') as { getProvider(name: string): { start?: unknown } | undefined } | undefined
  const provider = typeof configured === 'string' ? subagents?.getProvider(configured) : undefined
  if (provider === undefined || typeof provider.start === 'function') {
    throw new Error(`mndt: the workflow's child provider (${String(configured)}) is not an in-process one, so a run cannot be held to its tool policy`)
  }
}

/**
 * Create the agent of a run with its policy already scoped to its session
 * lineage (see tool-policy.ts), so no step of it, nor of any child, runs first.
 * @param ctx - the host context.
 * @param policy - the allow-list, or undefined for the engine's whole composition.
 * @param sessionId - the session the agent is created with.
 * @param create - creates the agent.
 * @returns the agent and the disposer of its policy, to call when the run ends.
 */
async function createUnderPolicy<T extends { agent: { session: { header: { id: string } } } }>(
  ctx: Context, policy: ToolPolicy | undefined, sessionId: string, create: () => Promise<T>,
): Promise<{ created: T; unscope: () => void }> {
  let unscope = (): void => undefined
  if (policy !== undefined) {
    // This plugin does not inject `tools` (its apply timing stays as it is):
    // the registry is read at run time, like the workflow engine. Without it,
    // a policy cannot be enforced, so the run does not start.
    const tools = ctx.get('tools') as PolicyHostLike['tools'] | undefined
    if (tools === undefined) throw new Error('mndt: this host does not mount the tools registry, so a run cannot be held to its tool policy')
    const host: PolicyHostLike = {
      agents: ctx.agents as unknown as PolicyHostLike['agents'],
      tools,
      on: (event, listener) => ctx.on(event as never, listener as never),
    }
    unscope = scopeToolPolicy(host, sessionId, policy)
  }
  try {
    const created = await create()
    // The lineage is keyed by this id: another one would leave the run unguarded.
    if (policy !== undefined && created.agent.session.header.id !== sessionId) {
      throw new Error(`mndt: the agent was created as ${created.agent.session.header.id}, not ${sessionId}: its tool policy would not apply`)
    }
    return { created, unscope }
  } catch (error) {
    unscope()
    throw error
  }
}

/** The runner. */
export class DshMissionRunner {
  readonly #ctx: Context
  readonly #options: DshRunnerOptions
  readonly #readiness: ToolsReadiness

  /** @param ctx - the host context. @param options - optional framing. */
  constructor(ctx: Context, options: DshRunnerOptions = {}) {
    this.#ctx = ctx
    this.#options = options
    this.#readiness = options.readiness ?? toolsReadinessOf(ctx)
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
    const roles = this.#options.modelRoles === undefined ? undefined : await this.#options.modelRoles()
    if (roles !== undefined && !roles.ok) throw new Refusal(`la politique des modèles de l’espace ne se lit pas : ${roles.reason}`)
    const policy = roles?.policy ?? NO_MODEL_ROLES
    const routeName = policy.roles[mission.kind === 'briefing' ? 'briefing' : 'mission']
    const route = routeName === undefined || routeName === 'agent' ? undefined : policy.routes[routeName]
    const selection = route ?? (model === undefined ? undefined : model.currentSelection())
    if (this.#options.tools !== undefined) assertInProcessChildren(this.#ctx, engine)
    // As a turn: the servers' tools before the agent (its policy copies the
    // visible names once). The first automation tick runs at start-up, while
    // the servers are still starting. Without its required servers, a mission
    // does not start, and says why.
    const configured = this.#options.configured ?? (() => true)
    const facts = this.#options.factsConfigured?.() ?? true
    if (mission.kind === 'briefing') {
      // Once per passage to « no facts », never at every briefing; said again after the facts came back.
      if (facts) clearOperatorWarning(NO_FACTS_WARNING)
      else warnOperatorOnce(this.#ctx, NO_FACTS_WARNING, 'mndt: briefing sans workbench_facts : descripteur absent (connectors/workbench_facts.json) ; les briefings partent sans les faits')
    }
    const { missing } = await this.#readiness.waitFor(missionRequiredServers(mission, facts).filter(configured))
    if (missing.length > 0) {
      throw new Refusal(`outils indisponibles : ${missing.join(', ')} (démarrage en cours ou connecteur en panne) ; la mission n’a pas été lancée`)
    }
    const { created, unscope } = await createUnderPolicy(this.#ctx, this.#options.tools, mission.id, () => this.#ctx.agents.create({
      // A fresh session per mission keeps runs readable and disposable.
      sessionId: mission.id as never,
      ...(selection === undefined ? {} : { agentOptions: { provider: selection.provider, model: selection.model } }),
    }))
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
    let run: ReturnType<WorkflowEngineLike['start']> | undefined
    try {
      // As every turn's: a briefing or an automation knows the day it runs. At the
      // end, so that the mission's frame keeps one prefix (the prefix cache).
      const dated = dateLine((this.#options.now ?? (() => new Date()))(), this.#options.timeZone ?? instanceTimeZone(undefined).timeZone)
      const framed = (this.#options.frame ?? defaultFrame)(mission)
      const prompt = `${mission.kind === 'briefing' && !facts ? `${framed}\n\n${NO_FACTS_NOTE}` : framed}\n\n${dated}`
      run = engine.start({
        script: `return await agent(${JSON.stringify(prompt)})`,
        meta: { name: 'mndt-mission', description: `mndt mission ${mission.kind}` },
        parent: created.agent,
      })
      const settled = await run.result
      if (failures.length > 0) throw new Error(failures.join('; '))
      const text = textOf(settled)
      if (text.trim() === '') {
        throw new Error(`the agent returned no text (settled: ${settledShape(settled)})`)
      }
      const reported = usageTotals.input + usageTotals.output > 0
      const tokens = reported
        ? { input: usageTotals.input, output: usageTotals.output, cacheRead: usageTotals.cacheRead, cacheWrite: usageTotals.cacheWrite }
        : settledTokensOf(settled)
      const price = selection === undefined || this.#options.prices === undefined ? undefined : priceOf(this.#options.prices, selection)
      return {
        title: titleOf(mission, text), markdown: text, sources: [], ...(tokens === undefined ? {} : { tokens }),
        ...(tokens === undefined || price === undefined ? {} : { eur: eurOf(tokens, price) }),
        ...(mission.kind === 'briefing' && !facts ? { toolsUnavailable: ['workbench_facts'] } : {}),
      }
    } finally {
      // The policy is lifted last, and only once the workflow's children and
      // the agent are gone (endRun).
      const ending = run
      await endRun(this.#ctx, [() => ending?.dispose?.(), stopAgentEnd, stopTurnEnd, clearActor, () => created.dispose()], unscope)
    }
  }
}

/**
 * Run one agent turn on DSH: the agent's own model, its channel's folder as
 * the working directory, and only what its channel's allow-list names (the
 * channel's MCP servers and the approvals, see tool-policy.ts): everything else
 * is hidden and refused at execution, including the engine's own tools.
 */
export class DshTurnRunner implements TurnEngine {
  readonly #ctx: Context
  /** Whether a turn's servers have registered their tools: kept across turns (a server's unavailability is remembered). */
  readonly #readiness: ToolsReadiness

  readonly #configured: (server: string) => boolean

  /**
   * The fingerprints of the last prompt of each agent in each channel
   * ({@link prefixPrints}), for the measure's common prefix: never a word of
   * the prompt, in memory only, the oldest dropped past {@link PREVIOUS_PROMPTS}.
   */
  readonly #previousPrints = new Map<string, readonly string[]>()

  /**
   * @param ctx - the host context.
   * @param readiness - the servers' readiness (shared with the missions; for tests, a fake).
   * @param configured - whether a server is configured for this space (see DshRunnerOptions.configured).
   */
  constructor(ctx: Context, readiness?: ToolsReadiness, configured: (server: string) => boolean = () => true) {
    this.#ctx = ctx
    this.#readiness = readiness ?? toolsReadinessOf(ctx)
    this.#configured = configured
  }

  /** @returns the servers every turn needs that this space configures: the approvals, unless none are mounted. */
  #always(): string[] {
    return ALWAYS_SERVERS.filter(server => this.#configured(server))
  }

  /**
   * Wait, outside the scheduler's queue, until a turn's servers are ready (or
   * the bound, or the turn's stop): a server slow to start delays its turn, not
   * every channel's.
   * @param servers - the servers the turn will use.
   * @param signal - the turn's stop.
   */
  async ready(servers: readonly string[], signal: AbortSignal): Promise<void> {
    await this.#readiness.waitFor([...new Set([...servers, ...this.#always()])], signal)
  }

  /**
   * @param input - the turn.
   * @returns the length of the prefix its prompt shares with the same agent's
   * previous prompt in that channel, or undefined on the first; this prompt
   * becomes the next one's previous.
   */
  #commonWithPrevious(input: Pick<TurnInput, 'channel' | 'agent' | 'prompt'>): number | undefined {
    const key = `${input.channel.id}\u0000${input.agent.id}`
    const previous = this.#previousPrints.get(key)
    const prints = prefixPrints(input.prompt)
    this.#previousPrints.delete(key)
    this.#previousPrints.set(key, prints)
    if (this.#previousPrints.size > PREVIOUS_PROMPTS) {
      const oldest = this.#previousPrints.keys().next().value
      if (oldest !== undefined) this.#previousPrints.delete(oldest)
    }
    return previous === undefined ? undefined : commonPrefixOfPrints(previous, prints)
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
    // The servers' tools first: the policy below copies the visible names once,
    // when the agent is created, so a server not yet registered would stay
    // hidden for the whole turn. The approvals are required: without them the
    // turn does not start. A channel's connector may be missing: the turn runs
    // without it, and is told so.
    const needed = input.tools === 'none' ? [] : input.tools === 'no-cards' ? [...input.servers] : [...new Set([...input.servers, ...this.#always()])]
    const { missing } = await this.#readiness.waitFor(needed, input.signal)
    if (input.signal.aborted) throw new Error('turn stopped')
    const required = missing.filter(server => input.tools !== 'no-cards' && ALWAYS_SERVERS.includes(server))
    if (required.length > 0) {
      throw new Refusal(`outils indisponibles : ${required.join(', ')} (démarrage en cours ou connecteur en panne) ; le tour n’a pas été lancé`)
    }
    const toolsUnavailable = missing.filter(server => !required.includes(server))
    const prompt = toolsUnavailable.length === 0 ? input.prompt
      : `${input.prompt}\n\nOutils indisponibles pour ce tour : ${toolsUnavailable.join(', ')} (démarrage en cours ou connecteur en panne). Ne prétends pas les avoir consultés.`
    // Deny by default: the channel's servers and the approvals, nothing else.
    // A reading step (an « auteur puis vérificateur » verifier) has no server, no tool.
    // A worker of « en parallèle puis synthèse » keeps its connectors, not the approvals.
    const policy = input.tools === 'none'
      ? NO_TOOLS_POLICY
      : input.tools === 'no-cards' ? noCardsPolicy(input.servers) : channelPolicy(input.servers)
    assertInProcessChildren(this.#ctx, engine)
    const { created, unscope } = await createUnderPolicy(this.#ctx, policy, input.turnId, () => this.#ctx.agents.create({
      sessionId: input.turnId as never,
      meta: { cwd: input.cwd },
      // The agent's own model, never the workstation default.
      agentOptions: { provider: input.agent.provider, model: input.agent.model },
    }))
    // The cards of a step are filed in the thread of the turn it belongs to.
    await publishActor(input.actor, input.runId ?? input.turnId)
    const sessionId = created.agent.session.header.id
    const failures: string[] = []
    // Set by the session listener below: an object, so the check after the run reads its value.
    const route = { unreachable: false }
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    // The model calls of the turn (one assistant message each), for the measure.
    let calls = 0
    // A step with a cost bound stops before a next message that would not fit.
    // The next message reads what the last one read, plus what it wrote, plus
    // one tool result per tool it called (each kept inline up to
    // RESERVED_TOOL_RESULT_TOKENS by spill-policy); it writes up to the model's
    // own output cap (the routes' maxTokens, sent as max_completion_tokens).
    let overBudget = false
    const outputCap = input.budget === undefined ? RESERVED_OUTPUT_TOKENS : await modelOutputCap(this.#ctx, input.agent)
    const stopEvents = this.#ctx.on('session/event', (session, event) => {
      if (session.header.id !== sessionId && session.header.parentSession !== sessionId) return
      if (event.type === 'assistant/message') {
        type StepUsage = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
        type StepData = { usage?: StepUsage; message?: { content?: readonly { type?: string }[] } }
        const data = (event as unknown as { data?: StepData }).data
        const step = data?.usage
        const toolCalls = (data?.message?.content ?? []).filter(block => block.type === 'tool-call').length
        calls += 1
        if (step !== undefined) {
          usage.input += step.inputTokens ?? 0
          usage.output += step.outputTokens ?? 0
          usage.cacheRead += step.cacheReadTokens ?? 0
          usage.cacheWrite += step.cacheWriteTokens ?? 0
          const budget = input.budget
          // A message that calls no tool ends the turn: no next message to fit,
          // so its answer is never turned into an over-budget stop.
          if (budget !== undefined && !overBudget && toolCalls > 0) {
            const nextInput = (step.inputTokens ?? 0) + (step.outputTokens ?? 0) + toolCalls * RESERVED_TOOL_RESULT_TOKENS
            const next = eurOf({ input: nextInput, output: outputCap }, budget.price)
            if (eurOf(usage, budget.price) + next > budget.eur) {
              overBudget = true
              void created.dispose()
            }
          }
        }
      }
      if (event.type === 'turn/end' && event.data.reason.kind !== 'completed') {
        const reason = event.data.reason
        failures.push(reason.kind === 'error' ? `the agent turn failed: ${reason.error.message}` : `the agent turn ended ${reason.kind}`)
        // Its route could not be reached, by the engine's own code (after its retries).
        if (reason.kind === 'error' && ROUTE_UNREACHABLE_CODES.includes(reason.error.code)) route.unreachable = true
      }
    })
    // A deleted message or an agent leaving the channel stops the turn at once.
    const abort = (): void => { void created.dispose() }
    input.signal.addEventListener('abort', abort, { once: true })
    let run: ReturnType<WorkflowEngineLike['start']> | undefined
    try {
      run = engine.start({
        script: `return await agent(${JSON.stringify(prompt)})`,
        meta: { name: 'mndt-turn', description: `@${input.agent.handle} in #${input.channel.name}` },
        parent: created.agent,
      })
      const settled = await run.result.catch((error: unknown) => {
        if (overBudget) throw new TurnBudgetReached({ ...usage })
        // The workflow fails with its agent: the route's code, seen above, decides.
        if (route.unreachable) throw new RouteUnreachable(error instanceof Error ? error.message : String(error))
        throw error
      })
      if (input.signal.aborted) throw new Error('turn stopped')
      if (overBudget) throw new TurnBudgetReached({ ...usage })
      if (failures.length > 0) throw route.unreachable ? new RouteUnreachable(failures.join('; ')) : new Error(failures.join('; '))
      const text = textOf(settled)
      if (text.trim() === '') throw new Error(`the agent returned no text (settled: ${settledShape(settled)})`)
      const tokens = usage.input + usage.output > 0 ? usage : settledTokensOf(settled)
      // The prompt's measure, never its content: its size, the fingerprints of its
      // head (one value from one turn to the next: the prefix cache can serve it),
      // and what the model counted (input, read from cache, output).
      warnOperator(this.#ctx, promptMeasure(input, tokens, { common: this.#commonWithPrevious(input), calls }))
      return {
        text, sessionId, ...(tokens === undefined ? {} : { tokens }), ...(toolsUnavailable.length === 0 ? {} : { toolsUnavailable }),
      }
    } finally {
      // The policy is lifted last, and only once the workflow's children and
      // the agent are gone (endRun).
      input.signal.removeEventListener('abort', abort)
      const ending = run
      await endRun(this.#ctx, [() => ending?.dispose?.(), stopEvents, clearActor, () => created.dispose()], unscope)
    }
  }
}

/**
 * @param input - a turn, with the server's key of the fingerprints (TurnInput.measureKey).
 * @param tokens - what the model counted, when it said.
 * @returns the operator's line that measures its prompt, without any of its text.
 * The heads' fingerprints are HMACs under a key the log never shows: two turns
 * with one head show one value (the prefix cache can serve it), but no reader of
 * the log can try a candidate (a channel's mark, with the rest of a head a
 * member mostly knows) against it. Without the key, no fingerprint at all.
 */
export function promptMeasure(
  input: Pick<TurnInput, 'turnId' | 'agent' | 'prompt' | 'measureKey'>,
  tokens: { readonly input: number; readonly output: number; readonly cacheRead?: number } | undefined,
  run: { readonly common?: number | undefined; readonly calls?: number | undefined } = {},
): string {
  const key = input.measureKey ?? ''
  const head = (length: number): string => (key === '' ? 'unkeyed' : createHmac('sha256', key).update(input.prompt.slice(0, length)).digest('hex').slice(0, 12))
  const counted = tokens === undefined ? 'tokens unknown' : `input ${tokens.input}, cacheRead ${tokens.cacheRead ?? 0}, output ${tokens.output}`
  // The characters this prompt shares, from its start, with the same agent's
  // previous prompt in the same channel, by whole blocks of PREFIX_BLOCK: the
  // direct measure of what a prefix cache can serve (« - » on the agent's
  // first turn there since the start).
  const common = `common ${run.common ?? '-'}`
  // The model calls of the turn: its tokens are their sum, each call sending
  // the whole context again (the tools' schemas, then each tool's result).
  const calls = `calls ${run.calls ?? '-'}`
  return `mndt: prompt of turn ${input.turnId} (@${input.agent.handle}): ${input.prompt.length} chars, head1k ${head(1000)}, head4k ${head(4000)}, ${common}; ${counted}; ${calls}`
}

/** The block of a prompt's prefix fingerprints, in characters: the measure's resolution. */
export const PREFIX_BLOCK = 256

/**
 * @param prompt - a prompt.
 * @returns a chain of fingerprints, one per whole block of {@link PREFIX_BLOCK}
 * characters, each covering the whole prefix up to its block's end: two prompts
 * share their first n blocks exactly when their first n fingerprints match.
 */
export function prefixPrints(prompt: string): string[] {
  const prints: string[] = []
  let chained = ''
  for (let end = PREFIX_BLOCK; end <= prompt.length; end += PREFIX_BLOCK) {
    chained = createHash('sha256').update(chained).update(prompt.slice(end - PREFIX_BLOCK, end)).digest('hex').slice(0, 16)
    prints.push(chained)
  }
  return prints
}

/** @param a - one prompt's prints. @param b - another's. @returns the characters of the whole blocks their prefixes share. */
export function commonPrefixOfPrints(a: readonly string[], b: readonly string[]): number {
  let blocks = 0
  while (blocks < a.length && blocks < b.length && a[blocks] === b[blocks]) blocks += 1
  return blocks * PREFIX_BLOCK
}

/** How many (channel, agent) previous prompts the runner keeps, for the measure only. */
const PREVIOUS_PROMPTS = 256

/**
 * Find the text a settled run carries, without the model's reasoning
 * ({@link withoutThought}): a mission's markdown and an agent's answer alike.
 * @param settled - whatever the engine resolved.
 * @returns the text, or an empty string when there is none.
 */
export function textOf(settled: unknown): string {
  return withoutThought(rawTextOf(settled))
}

/**
 * The form of a settled run, never a word of it: an empty answer is most often
 * one made of thought alone, which the log must not carry (C on #176).
 * @param settled - whatever the engine resolved.
 * @returns its type, its keys, its raw text's length and its tags counted.
 */
export function settledShape(settled: unknown): string {
  const raw = rawTextOf(settled)
  const keys = settled !== null && typeof settled === 'object' ? `{${Object.keys(settled).sort().join(',')}}` : ''
  const count = (tag: string): number => raw.split(tag).length - 1
  return `${settled === null ? 'null' : typeof settled}${keys}, text ${raw.length} chars, <think> ${count('<think>')}, </think> ${count('</think>')}`
}

/** @param settled - whatever the engine resolved. @returns its text as the model wrote it, reasoning included. */
function rawTextOf(settled: unknown): string {
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

/**
 * @param ctx - the host.
 * @param agent - the step's agent.
 * @returns the most one of its model messages may write: the model's
 * configured cap (the routes' maxTokens), RESERVED_OUTPUT_TOKENS when the host
 * cannot say. Never above RESERVED_OUTPUT_TOKENS, which the pre-call
 * reservation uses (tests/turnBudgetReserve.spec.ts holds the routes to it).
 */
async function modelOutputCap(ctx: Context, agent: { readonly provider: string; readonly model: string }): Promise<number> {
  type ModelInfoReader = { resolveModelInfo?: (provider: string, model: string) => Promise<{ defaultMaxTokens?: number }> }
  try {
    const llm = ctx.get('llm') as ModelInfoReader | undefined
    const cap = (await llm?.resolveModelInfo?.(agent.provider, agent.model))?.defaultMaxTokens
    return cap !== undefined && Number.isSafeInteger(cap) && cap > 0 ? Math.min(cap, RESERVED_OUTPUT_TOKENS) : RESERVED_OUTPUT_TOKENS
  } catch {
    return RESERVED_OUTPUT_TOKENS
  }
}
