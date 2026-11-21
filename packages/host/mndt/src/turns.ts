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
import type { PriceGrid } from './core/index.ts'

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
  /** « none »: a step that only reads what it is given (a verifier): no server, no tool. */
  readonly tools?: 'none'
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
    }
    | undefined {
    const [entry] = this.#running.entries()
    return entry === undefined
      ? undefined
      : {
        turnId: entry[0],
        messageId: entry[1].messageId,
        channelId: entry[1].channelId,
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
   * time), then the synthesis. A worker that cannot run (gone, at its ceiling,
   * past the turn's cost bound, failed) is recorded and named as missing; the
   * synthesis step has no tool and receives the parts as data between a mark
   * drawn after they were written. Without a synthesis (no part, or the
   * synthesizer at a bound), the parts go out as they are, and the text says so.
   */
  async #parallel(input: {
    readonly coordination: ParallelSynthesis
    readonly synthesizer: Agent
    readonly channel: Channel
    readonly message: Message
    readonly history: readonly Message[]
    readonly agents: readonly Agent[]
    readonly call: (who: Agent, suffix: string, text: string, reading?: boolean) => Promise<{ output: TurnOutput; eur: number | undefined }>
  }): Promise<{ output: TurnOutput; steps: TurnStep[]; note?: string }> {
    const { coordination, synthesizer, channel, message, history, agents, call } = input
    const { service, prices } = this.#options
    const steps: TurnStep[] = []
    const parts: WorkerPart[] = []
    const missing: string[] = []
    let spent = 0
    for (const [index, workerId] of coordination.workerIds.entries()) {
      const worker = agents.find(candidate =>
        candidate.id === workerId && candidate.retiredAt === undefined && channel.agents.includes(candidate.id))
      const name = worker === undefined ? workerId : `@${worker.handle}`
      const why = worker === undefined
        ? 'n’est plus un agent actif de ce canal'
        : spent >= coordination.maxEurPerTurn
          ? `le coût du tour a atteint sa borne (${coordination.maxEurPerTurn} €)`
          : ceilingRefusal(worker, prices, spentThisMonth((await service.snapshot()).messages ?? [], worker.id, new Date().toISOString()))
      if (worker === undefined || why !== undefined) {
        steps.push({ role: 'worker', agentId: workerId, verdict: 'skipped', notes: [why ?? 'indisponible'] })
        missing.push(`${name} (${why ?? 'indisponible'})`)
        continue
      }
      let answered: { output: TurnOutput; eur: number | undefined }
      try {
        answered = await call(worker, `w${index + 1}`, turnPrompt(worker, channel, history, message, agents))
      } catch (error) {
        if (error instanceof Error && error.message === 'turn stopped') throw error
        const reason = error instanceof Error ? error.message : String(error)
        steps.push({ role: 'worker', agentId: worker.id, verdict: 'skipped', notes: [reason] })
        missing.push(`${name} (${reason})`)
        continue
      }
      spent += answered.eur ?? 0
      steps.push({
        role: 'worker', agentId: worker.id,
        ...(answered.output.tokens === undefined ? {} : { tokens: answered.output.tokens }),
        ...(answered.eur === undefined ? {} : { eur: answered.eur }),
      })
      if (answered.output.text.trim() === '') missing.push(`${name} (aucun texte)`)
      else parts.push({ handle: worker.handle, text: answered.output.text })
    }
    const asIs = (): string => parts.map(part => `Part de @${part.handle} :\n${part.text}`).join('\n\n')
    if (parts.length === 0) {
      return { output: { text: `Aucune part n’a abouti : ${missing.join(' ; ')}.` }, steps }
    }
    const synthesisRefusal = spent >= coordination.maxEurPerTurn
      ? `le coût du tour a atteint sa borne (${coordination.maxEurPerTurn} €)`
      : ceilingRefusal(synthesizer, prices,
        spentThisMonth((await service.snapshot()).messages ?? [], synthesizer.id, new Date().toISOString()))
    if (synthesisRefusal !== undefined) {
      steps.push({ role: 'synthesis', agentId: synthesizer.id, verdict: 'skipped', notes: [synthesisRefusal] })
      return { output: { text: asIs() }, steps, note: `Non synthétisé : ${synthesisRefusal}.` }
    }
    const mark = randomUUID().slice(0, 8)
    const synthesis = await call(synthesizer, 's', synthesisPrompt(synthesizer, channel, message, parts, missing, mark), true)
    steps.push({
      role: 'synthesis', agentId: synthesizer.id,
      ...(synthesis.output.tokens === undefined ? {} : { tokens: synthesis.output.tokens }),
      ...(synthesis.eur === undefined ? {} : { eur: synthesis.eur }),
    })
    if (synthesis.output.text.trim() === '') return { output: { text: asIs() }, steps, note: 'Non synthétisé : la synthèse n’a produit aucun texte.' }
    return { output: synthesis.output, steps }
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
    const cancel = async (reason: string): Promise<void> => {
      await service.updateTurn(messageId, turn.id, {
        status: 'cancelled',
        reason,
        finishedAt: new Date().toISOString(),
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
        reading = false,
      ): Promise<{ output: TurnOutput; eur: number | undefined }> => {
        if (controller.signal.aborted) throw new Error('turn stopped')
        const output = await engine.run({
          turnId: suffix === '' ? turn.id : `${turn.id}-${suffix}`,
          runId: turn.id,
          agent: who,
          channel,
          actor,
          prompt: text,
          cwd: channelFolder(dataDir, channel.id),
          servers: reading ? [] : turnServers(who, channel),
          ...(reading ? { tools: 'none' as const } : {}),
          signal: controller.signal,
        })
        const price = priceOf(prices, who)
        return { output, eur: output.tokens === undefined || price === undefined ? undefined : eurOf(output.tokens, price) }
      }
      // « En parallèle puis synthèse »: a turn of the channel's synthesizer has each
      // worker answer on its own (its own connectors, its own ceiling), then the
      // synthesizer assembles their parts with NO tool. Bounded: 2 to 4 workers,
      // workers + 1 calls, and the channel's cost bound for the whole turn.
      const parallelMode = channel.coordination?.mode === 'parallel-synthesis' && channel.coordination.synthesizerId === agent.id
        ? channel.coordination
        : undefined
      const parallel = parallelMode === undefined ? undefined : await this.#parallel({
        coordination: parallelMode, synthesizer: agent, channel, message, history, agents, call,
      })
      const first = parallel === undefined ? await call(agent, '', prompt) : { output: parallel.output, eur: undefined }
      if (first.output.text.trim() === '')
        throw new Error('l’agent n’a produit aucun texte')
      // « Auteur puis vérificateur »: a turn of the channel's author is checked by
      // its verifier (another model), and corrected once if needed. A host script:
      // at most three calls, each step priced for its own agent and bounded by
      // its own ceiling. A check that cannot happen says why; the draft goes out.
      let output = first.output
      let steps: TurnStep[] | undefined = parallel?.steps
      const coordination = channel.coordination
      if (coordination?.mode === 'author-verifier' && coordination.authorId === agent.id) {
        steps = [{ role: 'author', agentId: agent.id, ...(first.output.tokens === undefined ? {} : { tokens: first.output.tokens }), ...(first.eur === undefined ? {} : { eur: first.eur }) }]
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
          const checked = await call(verifier, 'v', verifierPrompt(verifier, agent, channel, message, first.output.text, mark), true)
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
            steps.push({
              role: 'revision', agentId: agent.id,
              ...(revised.output.tokens === undefined ? {} : { tokens: revised.output.tokens }),
              ...(revised.eur === undefined ? {} : { eur: revised.eur }),
            })
            if (revised.output.text.trim() !== '') output = revised.output
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
