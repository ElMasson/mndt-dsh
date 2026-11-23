/**
 * Agent turns: a mention asks an agent to answer in its channel.
 *
 * A turn checks the agent's monthly ceiling before any call to the model, then
 * runs the agent with its own model, in its channel's folder, with the MCP
 * servers its channel allows, on a prompt built from that channel only. It
 * answers in the thread of the message that mentioned it. A turn whose message
 * was deleted, or whose agent left the channel, stops: before it starts, while
 * it runs (its engine is aborted), and before its answer is written.
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  Agent,
  Channel,
  Message,
  Mission,
  ParallelSynthesis,
  Turn,
  TurnStep,
  WorkbenchService,
  WorkerPart,
} from './core/index.ts'
import {
  ceilingRefusal,
  eurOf,
  parseVerdict,
  priceOf,
  revisionPrompt,
  spentThisMonth,
  synthesisPrompt,
  turnPrompt,
  turnServers,
  verifierPrompt,
} from './core/index.ts'
import type { ModelPrice, PriceGrid } from './core/index.ts'

/**
 * The output tokens reserved for one model message when a turn has a cost
 * bound: a step starts, and a running step goes on to its next message, only
 * if this much still fits under the bound.
 */
export const RESERVED_OUTPUT_TOKENS = 8192

/**
 * The most a tool result may add to the next message's input, in estimated
 * tokens: the base bundle's spill-policy keeps a result inline up to
 * maxInlineTokens and spills the rest behind a reference
 * (packages/bundle/base/cordis.patch.yml; tests/turnBudgetReserve.spec.ts
 * fails if it moves). An estimate, not a count: the bound holds to it.
 */
export const RESERVED_TOOL_RESULT_TOKENS = 12_500

/** @param text - a prompt. @returns a generous estimate of its input tokens. */
export function estimatedTokens(text: string): number {
  return Math.ceil(text.length / 3)
}

/** What a step of a turn may use: everything, nothing, or its connectors without the cards. */
type StepTools = 'all' | 'none' | 'no-cards'

/** What a worker of « en parallèle puis synthèse » is told of its role. */
const WORKER_FRAME = 'Dans ce tour, tu rassembles ce qui répond à la demande, pour une synthèse faite ensuite par un autre agent. '
  + 'Tu ne demandes aucune action et aucune carte : une action se demande ensuite en mentionnant un agent seul.'

/** A step stopped by its cost bound, with what it had already used. */
export class TurnBudgetReached extends Error {
  readonly tokens: NonNullable<Mission['tokens']>
  constructor(tokens: NonNullable<Mission['tokens']>) {
    super('le coût du tour a atteint sa borne pendant l’appel')
    this.name = 'TurnBudgetReached'
    this.tokens = tokens
  }
}

/** Everything one turn gives the engine. */
export interface TurnInput {
  readonly turnId: string
  readonly agent: Agent
  readonly channel: Channel
  /** The mentioning person, for the connectors that act on their behalf (O365). */
  readonly actor: string
  readonly prompt: string
  /** The channel's folder: the agent's working directory. */
  readonly cwd: string
  /** The MCP servers the turn may use: the agent's that the channel allows. */
  readonly servers: readonly string[]
  /**
   * « none »: a step that only reads what it is given (a verifier, a synthesis):
   * no server, no tool. « no-cards »: its connectors, without the approvals
   * (a worker of « en parallèle puis synthèse »).
   */
  readonly tools?: 'none' | 'no-cards'
  /**
   * The most this step may cost, in euros, priced at `price`: the engine stops
   * before a model message that would not fit (RESERVED_OUTPUT_TOKENS) and
   * throws TurnBudgetReached.
   */
  readonly budget?: { readonly eur: number; readonly price: ModelPrice }
  /**
   * The turn a step belongs to: a card asked during a step is filed in that
   * turn's thread (x-mndt-run), not outside any channel.
   */
  readonly runId?: string
  /** Aborted when the turn must stop. */
  readonly signal: AbortSignal
}

/** What a turn produced. */
export interface TurnOutput {
  readonly text: string
  readonly sessionId?: string
  readonly tokens?: NonNullable<Mission['tokens']>
}

/** Runs one agent turn. */
export interface TurnEngine {
  run(input: TurnInput): Promise<TurnOutput>
}

/** What the scheduler needs. */
export interface TurnSchedulerOptions {
  readonly service: WorkbenchService
  readonly engine: TurnEngine
  readonly prices: PriceGrid
  /** Where each channel's folder lives: `<dataDir>/channels/<id>/files`. */
  readonly dataDir: string
}

/** @param dataDir - the data root. @param channelId - the channel. @returns its folder. */
export function channelFolder(dataDir: string, channelId: string): string {
  return join(dataDir, 'channels', channelId, 'files')
}

/** One running turn, so a deletion or a removal can stop it. */
interface Running {
  readonly messageId: string
  readonly channelId: string
  readonly agentId: string
  /** The agent's handle as the turn started, for the cards it asks. */
  readonly agentHandle: string
  readonly controller: AbortController
}

/** Runs the turns of mentions, one at a time, in the order asked. */
export class TurnScheduler {
  readonly #options: TurnSchedulerOptions
  #queue: Promise<unknown> = Promise.resolve()
  readonly #pending = new Set<Promise<unknown>>()
  readonly #running = new Map<string, Running>()

  /** @param options - service, engine, prices and data folder. */
  constructor(options: TurnSchedulerOptions) {
    this.#options = options
  }

  /** @returns the turn running now, if any: its card requests belong to it. */
  current():
    | {
      readonly turnId: string
      readonly messageId: string
      readonly channelId: string
      /** The agent whose turn it is. */
      readonly agent: { readonly id: string; readonly handle: string }
    }
    | undefined {
    const [entry] = this.#running.entries()
    return entry === undefined
      ? undefined
      : {
        turnId: entry[0],
        messageId: entry[1].messageId,
        channelId: entry[1].channelId,
        agent: { id: entry[1].agentId, handle: entry[1].agentHandle },
      }
  }

  /**
   * Queue the turns a message asks for.
   * @param message - the message just posted.
   */
  launch(message: Message): void {
    for (const turn of message.turns ?? []) {
      const next = this.#queue.then(
        () => this.#run(message.id, turn),
        () => this.#run(message.id, turn),
      )
      this.#queue = next.catch(() => undefined)
      const tracked = next
        .catch(() => undefined)
        .finally(() => this.#pending.delete(tracked))
      this.#pending.add(tracked)
    }
  }

  /**
   * Stop the turns of a message (it was deleted), of an agent in a channel
   * (it left) or of an agent everywhere (it was retired): a running one is
   * aborted, a queued one will not start.
   * @param filter - the message, the channel and the agent, or the agent alone.
   */
  stop(
    filter:
      | { readonly messageId: string }
      | { readonly channelId: string; readonly agentId: string }
      | { readonly agentId: string },
  ): void {
    for (const running of this.#running.values()) {
      const matches =
        'messageId' in filter
          ? running.messageId === filter.messageId
          : 'channelId' in filter
            ? running.channelId === filter.channelId && running.agentId === filter.agentId
            : running.agentId === filter.agentId
      if (matches) running.controller.abort()
    }
  }

  /**
   * A « en parallèle puis synthèse » turn: each worker in order (one engine at a
   * time), then the synthesis. Workers keep their connectors but not the cards
   * (« no-cards »): this mode gathers; an action is asked afterwards of one
   * agent. Before every call, its largest estimated cost is reserved against
   * the turn's bound, and the call itself is stopped at that bound, so a turn
   * costs at most maxEurPerTurn. A worker that cannot run is a skipped step,
   * named to the synthesis as a missing part. The synthesis reads the parts
   * as data, with no tool. Without a synthesis, the published text says so and
   * the parts stay in the steps, for the screen to present under each agent.
   * @param input - the turn, and the steps array it records into (kept by the
   * caller, so a stopped or failed turn still counts what it spent).
   */
  async #parallel(input: {
    readonly coordination: ParallelSynthesis
    readonly synthesizer: Agent
    readonly channel: Channel
    readonly message: Message
    readonly history: readonly Message[]
    readonly agents: readonly Agent[]
    readonly steps: TurnStep[]
    readonly signal: AbortSignal
    readonly call: (
      who: Agent, suffix: string, text: string, tools?: StepTools, budgetEur?: number,
    ) => Promise<{ output: TurnOutput; eur: number | undefined }>
  }): Promise<{ output: TurnOutput; note?: string }> {
    const { coordination, synthesizer, channel, message, history, agents, steps, signal, call } = input
    const { service, prices } = this.#options
    const bound = coordination.maxEurPerTurn
    const parts: WorkerPart[] = []
    const missing: string[] = []
    const spent = (): number => steps.reduce((total, step) => total + (step.eur ?? 0), 0)
    /** @returns why a call of `who` with `prompt` would not fit under the bound, or undefined. */
    const overBound = (who: Agent, prompt: string): string | undefined => {
      const price = priceOf(prices, who)
      const reserved = price === undefined ? 0 : eurOf({ input: estimatedTokens(prompt), output: RESERVED_OUTPUT_TOKENS }, price)
      return spent() + reserved > bound ? `le coût du tour atteindrait sa borne (${bound} €)` : undefined
    }
    const stopped = (error: unknown): boolean => signal.aborted || (error instanceof Error && error.message === 'turn stopped')
    for (const [index, workerId] of coordination.workerIds.entries()) {
      const worker = agents.find(candidate =>
        candidate.id === workerId && candidate.retiredAt === undefined && channel.agents.includes(candidate.id))
      const name = worker === undefined ? workerId : `@${worker.handle}`
      const prompt = worker === undefined ? '' : `${turnPrompt(worker, channel, history, message, agents)}\n\n${WORKER_FRAME}`
      const why = worker === undefined
        ? 'n’est plus un agent actif de ce canal'
        : ceilingRefusal(worker, prices, spentThisMonth((await service.snapshot()).messages ?? [], worker.id, new Date().toISOString()))
          ?? overBound(worker, prompt)
      if (worker === undefined || why !== undefined) {
        steps.push({ role: 'worker', agentId: workerId, verdict: 'skipped', notes: [why ?? 'indisponible'] })
        missing.push(`${name} (${why ?? 'indisponible'})`)
        continue
      }
      try {
        const answered = await call(worker, `w${index + 1}`, prompt, 'no-cards', bound - spent())
        const text = answered.output.text.trim()
        steps.push({
          role: 'worker', agentId: worker.id,
          ...(answered.output.tokens === undefined ? {} : { tokens: answered.output.tokens }),
          ...(answered.eur === undefined ? {} : { eur: answered.eur }),
          ...(text === '' ? { verdict: 'skipped' as const, notes: ['aucun texte'] } : { text: answered.output.text }),
        })
        if (text === '') missing.push(`${name} (aucun texte)`)
        else parts.push({ handle: worker.handle, text: answered.output.text })
      } catch (error) {
        // A stop is not the worker's failure: the step says the turn was stopped.
        if (stopped(error)) {
          steps.push({ role: 'worker', agentId: worker.id, verdict: 'skipped', notes: ['tour arrêté'] })
          throw error
        }
        const reason = error instanceof TurnBudgetReached
          ? error.message
          : error instanceof Error ? error.message : String(error)
        const price = priceOf(prices, worker)
        steps.push({
          role: 'worker', agentId: worker.id, verdict: 'skipped', notes: [reason],
          // A call stopped at the bound still cost what it used.
          ...(error instanceof TurnBudgetReached
            ? { tokens: error.tokens, ...(price === undefined ? {} : { eur: eurOf(error.tokens, price) }) }
            : {}),
        })
        missing.push(`${name} (${reason})`)
      }
    }
    if (parts.length === 0) return { output: { text: `Aucune part n’a abouti : ${missing.join(' ; ')}.` } }
    const asIs = (reason: string): { output: TurnOutput; note: string } => ({
      output: { text: `Non synthétisé : ${reason}.` },
      note: `Les parts de ${parts.map(part => `@${part.handle}`).join(', ')} sont dans le détail du tour.`,
    })
    const mark = randomUUID().slice(0, 8)
    const prompt = synthesisPrompt(synthesizer, channel, message, parts, missing, mark)
    const refusal = ceilingRefusal(synthesizer, prices,
      spentThisMonth((await service.snapshot()).messages ?? [], synthesizer.id, new Date().toISOString()))
      ?? overBound(synthesizer, prompt)
    if (refusal !== undefined) {
      steps.push({ role: 'synthesis', agentId: synthesizer.id, verdict: 'skipped', notes: [refusal] })
      return asIs(refusal)
    }
    try {
      const synthesis = await call(synthesizer, 's', prompt, 'none', bound - spent())
      steps.push({
        role: 'synthesis', agentId: synthesizer.id,
        ...(synthesis.output.tokens === undefined ? {} : { tokens: synthesis.output.tokens }),
        ...(synthesis.eur === undefined ? {} : { eur: synthesis.eur }),
      })
      if (synthesis.output.text.trim() === '') return asIs('la synthèse n’a produit aucun texte')
      return { output: synthesis.output }
    } catch (error) {
      if (stopped(error)) {
        steps.push({ role: 'synthesis', agentId: synthesizer.id, verdict: 'skipped', notes: ['tour arrêté'] })
        throw error
      }
      if (!(error instanceof TurnBudgetReached)) throw error
      const price = priceOf(prices, synthesizer)
      steps.push({
        role: 'synthesis', agentId: synthesizer.id, verdict: 'skipped', notes: [error.message],
        tokens: error.tokens, ...(price === undefined ? {} : { eur: eurOf(error.tokens, price) }),
      })
      return asIs(error.message)
    }
  }

  /** @returns once every queued turn has settled (for tests and shutdown). */
  async settled(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all([...this.#pending])
  }

  /**
   * Why a turn may no longer go on: its message deleted, its agent gone.
   * @param messageId - the mentioning message.
   * @param agentId - the agent.
   * @returns the reason, or undefined while it may go on.
   */
  async #stale(
    messageId: string,
    agentId: string,
  ): Promise<{ message?: Message; channel?: Channel; reason?: string }> {
    const { service } = this.#options
    const message = await service.message(messageId)
    if (message === undefined || message.deletedAt !== undefined)
      return { reason: 'Message supprimé par son auteur.' }
    const channel = await service.channel(message.channelId)
    if (channel === undefined || !channel.agents.includes(agentId)) {
      return { message, reason: 'L’agent a quitté le canal.' }
    }
    return { message, channel }
  }

  /**
   * Run one turn to its end, whatever happens: it always settles with a status.
   * @param messageId - the mentioning message.
   * @param turn - the queued turn.
   */
  async #run(messageId: string, turn: Turn): Promise<void> {
    const { service, engine, prices, dataDir } = this.#options
    // The steps of a coordinated turn as they are done: a turn stopped or failed
    // midway still records them, and what they cost counts on each agent's ceiling.
    let live: TurnStep[] | undefined
    const spentSoFar = (): Partial<Pick<Turn, 'steps' | 'eur' | 'tokens'>> => {
      if (live === undefined || live.length === 0) return {}
      const eur = sumEur(live)
      const tokens = sumTokens(live)
      return { steps: [...live], ...(eur === undefined ? {} : { eur }), ...(tokens === undefined ? {} : { tokens }) }
    }
    const cancel = async (reason: string): Promise<void> => {
      await service.updateTurn(messageId, turn.id, {
        status: 'cancelled',
        reason,
        finishedAt: new Date().toISOString(),
        ...spentSoFar(),
      })
    }
    const before = await this.#stale(messageId, turn.agentId)
    if (
      before.reason !== undefined ||
      before.message === undefined ||
      before.channel === undefined
    ) {
      await cancel(before.reason ?? 'Tour impossible.')
      return
    }
    const { message, channel } = before
    const agent = await service.agent(turn.agentId)
    if (agent === undefined || agent.retiredAt !== undefined) {
      await cancel('Cet agent a été retiré.')
      return
    }
    const now = new Date().toISOString()
    const everything = (await service.snapshot()).messages ?? []
    const refusal = ceilingRefusal(
      agent,
      prices,
      spentThisMonth(everything, agent.id, now),
    )
    if (refusal !== undefined) {
      await service.updateTurn(messageId, turn.id, {
        status: 'refused',
        reason: refusal,
        finishedAt: now,
      })
      await service.reply(channel.id, messageId, { kind: 'system' }, refusal)
      return
    }
    const controller = new AbortController()
    this.#running.set(turn.id, {
      messageId,
      channelId: channel.id,
      agentId: agent.id,
      agentHandle: agent.handle,
      controller,
    })
    await service.updateTurn(messageId, turn.id, {
      status: 'running',
      startedAt: now,
    })
    try {
      const history = await service.messages(channel.id)
      const agents = await service.listAgents(true)
      const prompt = turnPrompt(agent, channel, history, message, agents)
      const actor = message.author.kind === 'human' ? message.author.email : ''
      /**
       * One call of the engine for one agent, priced with that agent's model. A
       * reading step (the verifier) runs with no server and no tool. Every step
       * files its cards in the thread of this turn. The turn stops between steps.
       */
      const call = async (
        who: Agent,
        suffix: string,
        text: string,
        tools: StepTools = 'all',
        budgetEur?: number,
      ): Promise<{ output: TurnOutput; eur: number | undefined }> => {
        if (controller.signal.aborted) throw new Error('turn stopped')
        const price = priceOf(prices, who)
        const output = await engine.run({
          turnId: suffix === '' ? turn.id : `${turn.id}-${suffix}`,
          runId: turn.id,
          agent: who,
          channel,
          actor,
          prompt: text,
          cwd: channelFolder(dataDir, channel.id),
          servers: tools === 'none' ? [] : turnServers(who, channel),
          ...(tools === 'all' ? {} : { tools }),
          ...(budgetEur === undefined || price === undefined ? {} : { budget: { eur: budgetEur, price } }),
          signal: controller.signal,
        })
        return { output, eur: output.tokens === undefined || price === undefined ? undefined : eurOf(output.tokens, price) }
      }
      // « En parallèle puis synthèse »: a turn of the channel's synthesizer has each
      // worker answer on its own (its own connectors, its own ceiling), then the
      // synthesizer assembles their parts with NO tool. Bounded: 2 to 4 workers,
      // workers + 1 calls, and the channel's cost bound for the whole turn.
      const parallelMode = channel.coordination?.mode === 'parallel-synthesis' && channel.coordination.synthesizerId === agent.id
        ? channel.coordination
        : undefined
      const parallelSteps: TurnStep[] = []
      if (parallelMode !== undefined) live = parallelSteps
      const parallel = parallelMode === undefined ? undefined : await this.#parallel({
        coordination: parallelMode, synthesizer: agent, channel, message, history, agents,
        steps: parallelSteps, signal: controller.signal, call,
      })
      const first = parallel === undefined ? await call(agent, '', prompt) : { output: parallel.output, eur: undefined }
      if (first.output.text.trim() === '')
        throw new Error('l’agent n’a produit aucun texte')
      // « Auteur puis vérificateur »: a turn of the channel's author is checked by
      // its verifier (another model), and corrected once if needed. A host script:
      // at most three calls, each step priced for its own agent and bounded by
      // its own ceiling. A check that cannot happen says why; the draft goes out.
      let output = first.output
      let steps: TurnStep[] | undefined = parallel === undefined ? undefined : parallelSteps
      const coordination = channel.coordination
      if (coordination?.mode === 'author-verifier' && coordination.authorId === agent.id) {
        steps = [{ role: 'author', agentId: agent.id, ...(first.output.tokens === undefined ? {} : { tokens: first.output.tokens }), ...(first.eur === undefined ? {} : { eur: first.eur }) }]
        live = steps
        const verifier = agents.find(candidate =>
          candidate.id === coordination.verifierId && candidate.retiredAt === undefined && channel.agents.includes(candidate.id))
        const spent = verifier === undefined
          ? undefined
          : ceilingRefusal(verifier, prices,
            spentThisMonth((await service.snapshot()).messages ?? [], verifier.id, new Date().toISOString()))
        if (verifier === undefined) {
          steps.push({ role: 'verifier', agentId: coordination.verifierId, verdict: 'skipped', notes: ['le vérificateur n’est plus un agent actif de ce canal'] })
        } else if (spent !== undefined) {
          steps.push({ role: 'verifier', agentId: verifier.id, verdict: 'skipped', notes: [spent] })
        } else {
          const mark = randomUUID().slice(0, 8)
          const checked = await call(verifier, 'v', verifierPrompt(verifier, agent, channel, message, first.output.text, mark), 'none')
          const verdict = parseVerdict(checked.output.text)
          steps.push({
            role: 'verifier', agentId: verifier.id, verdict: verdict.kind,
            ...(verdict.kind === 'issues' ? { notes: verdict.issues } : {}),
            ...(checked.output.tokens === undefined ? {} : { tokens: checked.output.tokens }),
            ...(checked.eur === undefined ? {} : { eur: checked.eur }),
          })
          // The author's own ceiling, again, before it pays for a correction.
          const authorRefusal = verdict.kind === 'issues'
            ? ceilingRefusal(agent, prices,
              spentThisMonth((await service.snapshot()).messages ?? [], agent.id, new Date().toISOString()) + (first.eur ?? 0))
            : undefined
          if (verdict.kind === 'issues' && authorRefusal !== undefined) {
            steps.push({ role: 'revision', agentId: agent.id, verdict: 'skipped', notes: [authorRefusal] })
          } else if (verdict.kind === 'issues') {
            // A second mark, drawn after the verdict: the verifier read the first one
            // and could have written it into its remarks.
            const revisionMark = randomUUID().slice(0, 8)
            const revised = await call(agent, 'r', revisionPrompt(prompt, first.output.text, verifier, verdict.issues, revisionMark))
            // Said positively: the published text is the revision, or the draft kept.
            // An empty correction keeps the draft; one identical to the draft
            // changes nothing: neither is « corrigé ».
            const revisedText = revised.output.text.trim()
            const unchanged = revisedText === first.output.text.trim()
            const replaced = revisedText !== '' && !unchanged
            steps.push({
              role: 'revision', agentId: agent.id, replaced,
              ...(replaced ? {} : { notes: [revisedText === '' ? 'correction vide, brouillon publié' : 'correction identique au brouillon'] }),
              ...(revised.output.tokens === undefined ? {} : { tokens: revised.output.tokens }),
              ...(revised.eur === undefined ? {} : { eur: revised.eur }),
            })
            if (replaced) output = revised.output
          }
        }
      }
      const after = await this.#stale(messageId, turn.agentId)
      if (controller.signal.aborted || after.reason !== undefined) {
        await cancel(after.reason ?? 'Tour arrêté.')
        return
      }
      const eur = steps === undefined ? first.eur : sumEur(steps)
      const tokens = steps === undefined ? output.tokens : sumTokens(steps)
      // A check that did not happen, or could not be read, is said in the text itself.
      const unchecked = steps?.find(step => step.role === 'verifier' && (step.verdict === 'skipped' || step.verdict === 'unreadable'))
      // Remarks found but not corrected (the author's ceiling): said in the text too.
      const uncorrected = steps?.find(step => step.role === 'revision' && step.verdict === 'skipped')
      const remarks = steps?.find(step => step.role === 'verifier' && step.verdict === 'issues')?.notes ?? []
      const published = parallel?.note !== undefined
        ? `${output.text}\n\n${parallel.note}`
        : unchecked !== undefined
          ? `${output.text}\n\nNon vérifié : ${unchecked.verdict === 'unreadable' ? 'la vérification n’a pas donné de verdict lisible' : (unchecked.notes?.[0] ?? 'la vérification n’a pas eu lieu')}.`
          : uncorrected !== undefined
            ? `${output.text}\n\nVérifié, remarques non corrigées (plafond atteint) : ${remarks.join(' ; ')}.`
            : output.text
      await service.reply(
        channel.id,
        messageId,
        { kind: 'agent', agentId: agent.id },
        published,
      )
      await service.updateTurn(messageId, turn.id, {
        status: 'done',
        finishedAt: new Date().toISOString(),
        ...(output.sessionId === undefined
          ? {}
          : { sessionId: output.sessionId }),
        ...(tokens === undefined ? {} : { tokens }),
        ...(eur === undefined ? {} : { eur }),
        ...(steps === undefined ? {} : { steps }),
      })
    } catch (error) {
      const after = await this.#stale(messageId, turn.agentId)
      if (controller.signal.aborted || after.reason !== undefined) {
        await cancel(after.reason ?? 'Tour arrêté.')
        return
      }
      await service.updateTurn(messageId, turn.id, {
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        finishedAt: new Date().toISOString(),
        ...spentSoFar(),
      })
    } finally {
      this.#running.delete(turn.id)
    }
  }
}

/** @param steps - a coordinated turn's steps. @returns their total cost, or undefined when none is priced. */
function sumEur(steps: readonly TurnStep[]): number | undefined {
  const priced = steps.filter(step => step.eur !== undefined)
  if (priced.length === 0) return undefined
  return Math.round(priced.reduce((total, step) => total + (step.eur ?? 0), 0) * 1_000_000) / 1_000_000
}

/** @param steps - a coordinated turn's steps. @returns their tokens added up, or undefined when none counted. */
function sumTokens(steps: readonly TurnStep[]): TurnStep['tokens'] {
  const counted = steps.map(step => step.tokens).filter((tokens): tokens is NonNullable<TurnStep['tokens']> => tokens !== undefined)
  if (counted.length === 0) return undefined
  return counted.reduce((total, tokens) => ({
    input: total.input + tokens.input,
    output: total.output + tokens.output,
    ...(total.cacheRead === undefined && tokens.cacheRead === undefined
      ? {}
      : { cacheRead: (total.cacheRead ?? 0) + (tokens.cacheRead ?? 0) }),
    ...(total.cacheWrite === undefined && tokens.cacheWrite === undefined
      ? {}
      : { cacheWrite: (total.cacheWrite ?? 0) + (tokens.cacheWrite ?? 0) }),
  }))
}
