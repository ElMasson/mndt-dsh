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
  Council,
  CouncilCost,
  CouncilSlot,
  ParallelSynthesis,
  Turn,
  TurnCouncil,
  TurnHelp,
  TurnStep,
  WorkbenchService,
  WorkerPart,
} from './core/index.ts'
import {
  ceilingRefusal,
  councilCritiquePrompt,
  councilFramingPrompt,
  councilPositionPrompt,
  councilSynthesisPrompt,
  eurOf,
  lastJsonLine,
  NONE_OF_THESE,
  parseFraming,
  helpPeerPrompt,
  helpReadingPrompt,
  parseHelpReading,
  parseVerdict,
  reasonKind,
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

  /**
   * The help an agent asked its peers during its turn (ask_peers), run by the
   * host once the agent ended: each peer answers alone, with NO tool, from its
   * own framing, the channel's context and the request (never the discussion
   * nor the other advice); the asker then reads the advices without their
   * authors, with its usual tools, and closes on a verdict. A second round, on
   * a fact still disputed, at most. Everything counts for the asker, under the
   * help's own cost bound, reserved before each call. A person who answers in
   * the thread meanwhile ends it there.
   * @param input - the turn, its asker, and the recorded help.
   * @returns the text to publish and what the help cost.
   */
  async #help(input: {
    readonly messageId: string
    readonly turnId: string
    readonly asker: Agent
    readonly channel: Channel
    readonly prompt: string
    readonly first: string
    readonly agents: readonly Agent[]
    readonly asked: TurnHelp
    readonly signal: AbortSignal
    readonly call: (
      who: Agent, suffix: string, text: string, tools?: StepTools, budgetEur?: number,
    ) => Promise<{ output: TurnOutput; eur: number | undefined }>
  }): Promise<{ text?: string; eur: number }> {
    const { messageId, turnId, asker, channel, prompt, first, agents, asked, signal, call } = input
    const { service, prices } = this.#options
    let help: TurnHelp = { ...asked, state: 'advising' }
    let other = 0
    const save = async (): Promise<void> => { await service.updateTurn(messageId, turnId, { help }) }
    const spent = (): number => help.advices.reduce((total, advice) => total + (advice.eur ?? 0), 0) + other
    const overCap = (who: Agent, text: string): string | undefined => {
      const price = priceOf(prices, who)
      const reserved = price === undefined ? 0 : eurOf({ input: estimatedTokens(text), output: RESERVED_OUTPUT_TOKENS }, price)
      return spent() + reserved > help.capEur ? `le coût de l’entraide atteindrait sa borne (${help.capEur} €)` : undefined
    }
    // Every call of the help is the asker's: its own ceiling, with what the help already spent.
    const askerCeiling = async (): Promise<string | undefined> =>
      ceilingRefusal(asker, prices, spentThisMonth((await service.snapshot()).messages ?? [], asker.id, new Date().toISOString()) + spent())
    const closedBy = async (): Promise<{ by: string; at: string } | undefined> => {
      const reply = ((await service.snapshot()).messages ?? []).find(candidate =>
        candidate.channelId === channel.id && candidate.replyTo === messageId && candidate.author.kind === 'human'
        && candidate.deletedAt === undefined && candidate.createdAt >= help.askedAt)
      return reply?.author.kind === 'human' ? { by: reply.author.email, at: reply.createdAt } : undefined
    }
    const stopped = (error: unknown): boolean => signal.aborted || (error instanceof Error && error.message === 'turn stopped')
    // The slots, in an order drawn here: A is not « the first one named ».
    const named = randomUUID().charCodeAt(0) % 2 === 0 ? [...help.peerIds] : [...help.peerIds].reverse()
    const slots = named.map((peerId, index) => ({ slot: (index === 0 ? 'A' : 'B') as 'A' | 'B', peerId }))
    // A person answered in the thread: the help ends there, and the asker
    // publishes nothing (no reading after it, no text beside the person's).
    const close = async (by: { by: string; at: string }): Promise<{ text?: string; eur: number }> => {
      const { escalation: _none, ...rest } = help
      help = { ...rest, state: 'done', closedBy: by, eur: spent() }
      await save()
      return { eur: spent() }
    }
    /** @param result - what the help would publish. @returns it, unless a person answered meanwhile. */
    const unlessClosed = async (result: { text: string; eur: number }): Promise<{ text?: string; eur: number }> => {
      const by = await closedBy()
      return by === undefined ? result : close(by)
    }
    /** One round of advices. @returns a person who closed the help meanwhile, if any. */
    const round = async (index: 1 | 2, disputed?: string): Promise<{ by: string; at: string } | undefined> => {
      await save()
      for (const { slot, peerId } of slots) {
        const by = await closedBy()
        if (by !== undefined) return by
        const peer = agents.find(candidate =>
          candidate.id === peerId && candidate.retiredAt === undefined && channel.agents.includes(candidate.id))
        if (peer === undefined) {
          help = { ...help, skipped: [...help.skipped, { slot, agentId: peerId, reason: 'n’est plus un agent actif de ce canal' }] }
          continue
        }
        const text = helpPeerPrompt(peer, channel, help.request, disputed)
        const why = await askerCeiling() ?? overCap(peer, text)
        if (why !== undefined) {
          help = { ...help, skipped: [...help.skipped, { slot, agentId: peer.id, reason: why }] }
          continue
        }
        try {
          const answered = await call(peer, `h${index}${slot.toLowerCase()}`, text, 'none', help.capEur - spent())
          const said = answered.output.text.trim()
          if (said === '') {
            other += answered.eur ?? 0
            help = { ...help, skipped: [...help.skipped, { slot, agentId: peer.id, reason: 'aucun texte' }] }
          } else {
            help = {
              ...help,
              advices: [...help.advices, {
                slot, round: index, text: said, agentId: peer.id, model: `${peer.provider}/${peer.model}`,
                ...(answered.eur === undefined ? {} : { eur: answered.eur }),
                ...(answered.output.tokens === undefined ? {} : { tokens: answered.output.tokens }),
              }],
            }
          }
        } catch (error) {
          if (stopped(error)) {
            help = { ...help, state: 'done', skipped: [...help.skipped, { slot, agentId: peer.id, reason: 'tour arrêté' }], eur: spent() }
            await save()
            throw error
          }
          const price = priceOf(prices, peer)
          if (error instanceof TurnBudgetReached && price !== undefined) other += eurOf(error.tokens, price)
          const reason = error instanceof Error ? error.message : String(error)
          help = { ...help, skipped: [...help.skipped, { slot, agentId: peer.id, reason }] }
        }
        await save()
      }
      return undefined
    }
    const escalate = async (question: string, body: string, disputed?: string): Promise<{ text?: string; eur: number }> => {
      const by = await closedBy()
      if (by !== undefined) return close(by)
      // By kind: a raw reason (« Plafond mensuel atteint pour @x : … € ») would name a peer while the question waits.
      const reasons = help.skipped.map(skip => reasonKind(skip.reason))
      const summary = [
        `Blocage : ${help.request.blocker}.`,
        `Avis reçus : ${help.advices.length}.`,
        ...(reasons.length === 0 ? [] : [`Sans avis : ${reasons.join(' ; ')}.`]),
        ...(disputed === undefined ? [] : [`Désaccord restant : ${disputed}.`]),
      ].join(' ')
      help = { ...help, state: 'done', escalation: { question, summary, at: new Date().toISOString() }, eur: spent() }
      await save()
      return { text: `${body}\n\nQuestion à l’équipe : ${question}`, eur: spent() }
    }
    const firstClose = await round(1)
    if (firstClose !== undefined) return close(firstClose)
    if (help.advices.length === 0) return escalate(help.request.blocker, `${first}\n\nAucun avis n’a abouti.`)
    /** The asker's reading of the advices so far. */
    type Reading = ReturnType<typeof parseHelpReading> | { refused: string } | { closed: { by: string; at: string } }
    const read = async (index: 1 | 2): Promise<Reading> => {
      const by = await closedBy()
      if (by !== undefined) return { closed: by }
      help = { ...help, state: 'reading' }
      await save()
      const text = helpReadingPrompt(prompt, help.request, help.advices,
        index === 1 && help.request.need === 'fact' && help.advices.length === 2)
      const why = await askerCeiling() ?? overCap(asker, text)
      if (why !== undefined) return { refused: why }
      try {
        const read = await call(asker, `hr${index}`, text, 'all', help.capEur - spent())
        other += read.eur ?? 0
        return parseHelpReading(read.output.text)
      } catch (error) {
        if (stopped(error)) throw error
        const price = priceOf(prices, asker)
        if (error instanceof TurnBudgetReached && price !== undefined) other += eurOf(error.tokens, price)
        return { refused: error instanceof Error ? error.message : String(error) }
      }
    }
    let parsed = await read(1)
    if ('closed' in parsed) return close(parsed.closed)
    if ('refused' in parsed) return escalate(help.request.blocker, `${first}\n\nLecture des avis impossible : ${parsed.refused}.`)
    if (parsed.disputed !== undefined && help.request.need === 'fact' && help.advices.length === 2) {
      const disputed = parsed.disputed
      const secondClose = await round(2, disputed)
      if (secondClose !== undefined) return close(secondClose)
      const again = await read(2)
      if ('closed' in again) return close(again.closed)
      if ('refused' in again) return escalate(help.request.blocker, parsed.body, disputed)
      parsed = again
    }
    let reading = parsed.reading
    // « card » is checked, never taken on trust: a card of this asker, in this
    // thread, since the help was asked.
    if (reading.verdict === 'card') {
      const filed = (await service.snapshot()).approvals.some(card =>
        card.messageId === messageId && card.requestedByAgent?.id === asker.id && card.requestedAt >= help.askedAt)
      if (!filed) reading = { ...reading, verdict: 'escalate', why: `${reading.why} (aucune carte posée)`.trim() }
    }
    help = { ...help, reading }
    if (reading.verdict === 'escalate') return escalate(parsed.question ?? help.request.blocker, parsed.body, parsed.disputed)
    const done = await unlessClosed({ text: parsed.body, eur: spent() })
    if (done.text === undefined) return done
    help = { ...help, state: 'done', eur: spent() }
    await save()
    return done
  }

  /**
   * A « conseil » turn (its chair's): the chair frames a question and options
   * (the host adds « aucune de ces options »); each member takes a position
   * ALONE; each critiques the others without their names and gives a final
   * choice; then a vote on the options' indexes, or a synthesizer (not a
   * member) decides. No member has a tool. A tie, a lost quorum (fewer than
   * two positions counted), « none of these » or a synthesis that cannot
   * decide escalates to the people. Each call counts for the agent who made
   * it, under the turn's cost bound, reserved before each call.
   * @param input - the turn, its coordination and the chair.
   * @returns the text to publish and what the council cost.
   */
  async #council(input: {
    readonly messageId: string
    readonly turnId: string
    readonly coordination: Council
    readonly chair: Agent
    readonly channel: Channel
    readonly message: Message
    readonly agents: readonly Agent[]
    readonly signal: AbortSignal
    readonly call: (
      who: Agent, suffix: string, text: string, tools?: StepTools, budgetEur?: number,
    ) => Promise<{ output: TurnOutput; eur: number | undefined }>
  }): Promise<{ text: string; eur: number }> {
    const { messageId, turnId, coordination, chair, channel, message, agents, signal, call } = input
    const { service, prices } = this.#options
    let council: TurnCouncil = {
      state: 'deliberating', question: '', options: [], positions: [], critiques: [], dissent: [],
      capEur: coordination.maxEurPerTurn, skipped: [], startedAt: new Date().toISOString(),
    }
    const save = async (): Promise<void> => { await service.updateTurn(messageId, turnId, { council }) }
    const spent = (): number => [
      ...(council.framing === undefined ? [] : [council.framing]), ...council.positions, ...council.critiques,
      ...(council.decision?.kind === 'synthesis' ? [council.decision] : []), ...council.skipped,
    ].reduce((total, entry) => total + (entry.eur ?? 0), 0)
    const stopped = (error: unknown): boolean => signal.aborted || (error instanceof Error && error.message === 'turn stopped')
    /** One call with no tool, bounded. @returns its text and cost, or why it could not be made. */
    /** What a call that could not give its part consumed, for its agent: recorded on its skipped entry. */
    type Refused = { refused: string; eur?: number }
    const run = async (who: Agent, suffix: string, text: string): Promise<{ text: string; cost: CouncilCost } | Refused> => {
      const price = priceOf(prices, who)
      const reserved = price === undefined ? 0 : eurOf({ input: estimatedTokens(text), output: RESERVED_OUTPUT_TOKENS }, price)
      if (spent() + reserved > council.capEur) return { refused: `le coût du tour atteindrait sa borne (${council.capEur} €)` }
      const monthly = spentThisMonth((await service.snapshot()).messages ?? [], who.id, new Date().toISOString())
      const ceiling = ceilingRefusal(who, prices, monthly)
      if (ceiling !== undefined) return { refused: ceiling }
      try {
        const answered = await call(who, suffix, text, 'none', council.capEur - spent())
        return {
          text: answered.output.text.trim(),
          cost: {
            agentId: who.id, model: `${who.provider}/${who.model}`,
            ...(answered.eur === undefined ? {} : { eur: answered.eur }),
            ...(answered.output.tokens === undefined ? {} : { tokens: answered.output.tokens }),
          },
        }
      } catch (error) {
        if (stopped(error)) throw error
        const reason = error instanceof Error ? error.message : String(error)
        return error instanceof TurnBudgetReached && price !== undefined
          ? { refused: reason, eur: eurOf(error.tokens, price) }
          : { refused: reason }
      }
    }
    /** @param who - the agent. @param refused - why its call gave no part. @param slot - its slot, if any. */
    const skip = (who: Agent, refused: Refused, slot?: CouncilSlot): void => {
      council = {
        ...council,
        skipped: [...council.skipped, {
          ...(slot === undefined ? {} : { slot }), agentId: who.id, reason: refused.refused,
          ...(refused.eur === undefined ? {} : { eur: refused.eur }),
        }],
      }
    }
    const escalate = async (question: string, why: string, body: string): Promise<{ text: string; eur: number }> => {
      const summary = [
        `Question : ${council.question === '' ? question : council.question}.`,
        `Pourquoi : ${why}.`,
        `Positions comptées : ${council.positions.filter(p => p.choice !== undefined).length}.`,
        ...(council.decision?.kind === 'vote' ? [`Décompte : ${Object.entries(council.decision.tally).map(([k, n]) => `option ${k} : ${n}`).join(', ')}.`] : []),
        ...(council.critiques.length === 0 ? [] : [`Critiques : ${council.critiques.map(c => `${c.slot} : ${c.text.replace(/\s+/g, ' ').slice(0, 200)}`).join(' / ')}.`]),
      ].join(' ')
      council = { ...council, state: 'done', escalation: { question, summary, at: new Date().toISOString() }, eur: spent() }
      await save()
      return { text: `${body}\n\nQuestion à l’équipe : ${question}`, eur: spent() }
    }
    // 1. The chair frames the question; the host adds « none of these ».
    await save()
    const framed = await run(chair, 'cf', councilFramingPrompt(chair, channel, message))
    if ('refused' in framed) {
      skip(chair, framed)
      return escalate(withoutMentions(message.text), `cadrage impossible (${reasonKind(framed.refused)})`, 'Le conseil n’a pas pu être cadré.')
    }
    const frame = parseFraming(framed.text)
    council = { ...council, framing: { text: framed.text, ...framed.cost } }
    if (frame === undefined) return escalate(withoutMentions(message.text), 'cadrage illisible', 'Le conseil n’a pas pu être cadré.')
    council = { ...council, question: frame.question, options: [...frame.options, NONE_OF_THESE] }
    await save()
    // 2. The members, in slots drawn here: A is not necessarily the chair.
    const active = coordination.memberIds.flatMap((memberId) => {
      const member = agents.find(a => a.id === memberId && a.retiredAt === undefined && channel.agents.includes(a.id))
      if (member === undefined) council = { ...council, skipped: [...council.skipped, { agentId: memberId, reason: 'n’est plus un agent actif de ce canal' }] }
      return member === undefined ? [] : [member]
    })
    const order = active.map(member => ({ member, key: randomUUID() }))
      .sort((a, b) => a.key.localeCompare(b.key)).map(entry => entry.member)
    const slots = order.map((member, index) => ({ slot: (['A', 'B', 'C', 'D'] as const)[index] as CouncilSlot, member }))
    const valid = (choice: unknown): number | undefined =>
      typeof choice === 'number' && Number.isInteger(choice) && choice >= 1 && choice <= council.options.length ? choice : undefined
    for (const { slot, member } of slots) {
      const positioned = await run(member, `cp${slot.toLowerCase()}`, councilPositionPrompt(member, channel, council.question, council.options))
      if ('refused' in positioned) {
        skip(member, positioned, slot)
      } else {
        const parsed = lastJsonLine(positioned.text)
        const choice = valid(parsed?.value.choice)
        council = {
          ...council,
          positions: [...council.positions, {
            slot, text: parsed?.body || positioned.text, ...(choice === undefined ? {} : { choice }), ...positioned.cost,
          }],
          ...(choice === undefined ? { skipped: [...council.skipped, { slot, agentId: member.id, reason: 'choix illisible' }] } : {}),
        }
      }
      await save()
    }
    const counted = council.positions.filter(position => position.choice !== undefined)
    if (counted.length < 2) return escalate(council.question, 'quorum manqué (moins de deux positions comptées)', 'Le conseil n’a pas réuni assez de positions.')
    // 3. Each counted member critiques the others, without their names, and chooses again.
    council = { ...council, state: 'critiquing' }
    await save()
    for (const own of counted) {
      const member = slots.find(entry => entry.slot === own.slot)?.member
      if (member === undefined) continue
      const others = counted.filter(other => other.slot !== own.slot).map(other => ({ slot: other.slot, text: other.text }))
      const critiqued = await run(member, `cc${own.slot.toLowerCase()}`, councilCritiquePrompt(member, channel, council.question, council.options, own, others))
      if ('refused' in critiqued) {
        skip(member, critiqued, own.slot)
      } else {
        const parsed = lastJsonLine(critiqued.text)
        const about = Array.isArray(parsed?.value.about)
          ? (parsed.value.about as unknown[]).filter((s): s is CouncilSlot => others.some(o => o.slot === s))
          : []
        const choice = valid(parsed?.value.choice)
        council = {
          ...council,
          critiques: [...council.critiques, {
            slot: own.slot, about: about.length === 0 ? others.map(o => o.slot) : about, text: parsed?.body || critiqued.text,
            ...(choice === undefined ? {} : { choice }), ...critiqued.cost,
          }],
        }
      }
      await save()
    }
    // 4. The decision. A member's final choice is its critique's, else its position's.
    council = { ...council, state: 'deciding' }
    await save()
    const finalOf = (slot: CouncilSlot): number | undefined =>
      council.critiques.find(c => c.slot === slot)?.choice ?? council.positions.find(p => p.slot === slot)?.choice
    const none = council.options.length
    if (coordination.decision === 'vote') {
      const tally: Record<string, number> = {}
      for (const position of counted) {
        const choice = finalOf(position.slot)
        if (choice !== undefined) tally[String(choice)] = (tally[String(choice)] ?? 0) + 1
      }
      const top = Math.max(...Object.values(tally))
      const votes = Object.values(tally).reduce((sum, n) => sum + n, 0)
      const leaders = Object.entries(tally).filter(([, n]) => n === top).map(([k]) => Number(k))
      // An absolute majority, more than half of the votes counted: a 2-1-1 out of 4 does not decide.
      if (leaders.length !== 1 || top * 2 <= votes) {
        council = { ...council, decision: { kind: 'vote', tally } }
        return escalate(council.question, leaders.length !== 1 ? 'égalité' : 'pas de majorité', 'Le conseil est partagé.')
      }
      const chosen = leaders[0] as number
      council = { ...council, decision: { kind: 'vote', tally, chosen } }
      if (chosen === none) return escalate(council.question, `vote majoritaire sur « ${NONE_OF_THESE} »`, 'Aucune option ne convient au conseil.')
      const dissent = counted.filter(p => finalOf(p.slot) !== chosen).map(p => ({ slot: p.slot }))
      council = { ...council, dissent, state: 'done', eur: spent() }
      await save()
      const count = Object.entries(tally).map(([k, n]) => `option ${k} : ${n}`).join(', ')
      return {
        text: `Décision du conseil (vote) : option ${chosen}, « ${council.options[chosen - 1] ?? ''} ». Décompte : ${count}. ${dissent.length === 0 ? 'Unanime.' : `Ne suivent pas : ${dissent.map(d => d.slot).join(', ')}.`}`,
        eur: spent(),
      }
    }
    const synthesizer = agents.find(a => a.id === coordination.synthesizerId && a.retiredAt === undefined && channel.agents.includes(a.id))
    if (synthesizer === undefined) return escalate(council.question, 'le synthétiseur n’est plus un agent actif de ce canal', 'Le conseil n’a pas pu trancher.')
    const decided = await run(synthesizer, 'cs', councilSynthesisPrompt(synthesizer, channel, council.question, council.options,
      council.positions.map(p => ({ slot: p.slot, text: p.text })), council.critiques.map(c => ({ slot: c.slot, text: c.text }))))
    if ('refused' in decided) {
      skip(synthesizer, decided)
      return escalate(council.question, `synthèse impossible (${reasonKind(decided.refused)})`, 'Le conseil n’a pas pu trancher.')
    }
    const parsed = lastJsonLine(decided.text)
    const chosen = valid(parsed?.value.chosen)
    const body = parsed?.body || decided.text
    council = { ...council, decision: { kind: 'synthesis', text: body, ...(chosen === undefined ? {} : { chosen }), ...decided.cost } }
    if (chosen === undefined) return escalate(council.question, 'la synthèse ne tranche pas', body)
    if (chosen === none) return escalate(council.question, `synthèse sur « ${NONE_OF_THESE} »`, body)
    // The dissent the synthesizer names, kept to the slots that exist.
    const dissent = Array.isArray(parsed?.value.dissent)
      ? (parsed.value.dissent as unknown[]).flatMap((entry) => {
        const item = entry as { slot?: unknown; why?: unknown }
        return counted.some(p => p.slot === item.slot)
          ? [{ slot: item.slot as CouncilSlot, ...(typeof item.why === 'string' && item.why.trim() !== '' ? { why: item.why.trim() } : {}) }]
          : []
      })
      : []
    council = { ...council, dissent, state: 'done', eur: spent() }
    await save()
    return { text: body, eur: spent() }
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
      const councilMode = channel.coordination?.mode === 'council' && channel.coordination.memberIds[0] === agent.id
        ? channel.coordination
        : undefined
      const councilled = councilMode === undefined ? undefined : await this.#council({
        messageId, turnId: turn.id, coordination: councilMode, chair: agent, channel, message, agents,
        signal: controller.signal, call,
      })
      const parallel = parallelMode === undefined ? undefined : await this.#parallel({
        coordination: parallelMode, synthesizer: agent, channel, message, history, agents,
        steps: parallelSteps, signal: controller.signal, call,
      })
      const first = councilled !== undefined
        ? { output: { text: councilled.text }, eur: councilled.eur }
        : parallel === undefined ? await call(agent, '', prompt) : { output: parallel.output, eur: undefined }
      if (first.output.text.trim() === '')
        throw new Error('l’agent n’a produit aucun texte')
      // « Auteur puis vérificateur »: a turn of the channel's author is checked by
      // its verifier (another model), and corrected once if needed. A host script:
      // at most three calls, each step priced for its own agent and bounded by
      // its own ceiling. A check that cannot happen says why; the draft goes out.
      let output = first.output
      let helpEur: number | undefined
      let helpClosed = false
      // A help the agent asked its peers during this call (ask_peers): run now, by the host.
      const asked = parallel === undefined && councilled === undefined
        ? (await service.message(messageId))?.turns?.find(t => t.id === turn.id)?.help
        : undefined
      if (asked?.state === 'asked') {
        const helped = await this.#help({
          messageId, turnId: turn.id, asker: agent, channel, prompt, first: first.output.text.trim(), agents, asked,
          signal: controller.signal, call,
        })
        helpEur = helped.eur
        if (helped.text === undefined) helpClosed = true
        else output = { ...first.output, text: helped.text }
      }
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
      const eur = steps === undefined
        ? (helpEur === undefined ? first.eur : (first.eur ?? 0) + helpEur)
        : sumEur(steps)
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
      // A help a person closed by answering publishes nothing beside them.
      const answer = helpClosed
        ? undefined
        : await service.reply(
          channel.id,
          messageId,
          { kind: 'agent', agentId: agent.id },
          published,
        )
      // An escalated question names the message that publishes it: a person answers it there.
      const settledTurn = (await service.message(messageId))?.turns?.find(t => t.id === turn.id)
      const escalated = settledTurn?.help
      if (answer !== undefined && escalated?.escalation !== undefined) {
        const escalation = { ...escalated.escalation, messageId: answer.id }
        await service.updateTurn(messageId, turn.id, { help: { ...escalated, escalation } })
      }
      const convened = settledTurn?.council
      if (answer !== undefined && convened?.escalation !== undefined) {
        const escalation = { ...convened.escalation, messageId: answer.id }
        await service.updateTurn(messageId, turn.id, { council: { ...convened, escalation } })
      }
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

/**
 * @param text - a person's message.
 * @returns it without its @mentions: a question put back to the people names no agent.
 */
function withoutMentions(text: string): string {
  return text.replace(/(^|\s)@[a-z0-9-]+/g, '$1').replace(/\s{2,}/g, ' ').trim()
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
