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
import { join } from 'node:path'
import type {
  Agent,
  Channel,
  Message,
  Mission,
  Turn,
  WorkbenchService,
} from './core/index.ts'
import {
  ceilingRefusal,
  eurOf,
  priceOf,
  spentThisMonth,
  turnPrompt,
  turnServers,
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
   * Stop the turns of a message (it was deleted) or of an agent in a channel
   * (it left): a running one is aborted, a queued one will not start.
   * @param filter - the message, or the channel and the agent.
   */
  stop(
    filter:
      | { readonly messageId: string }
      | { readonly channelId: string; readonly agentId: string },
  ): void {
    for (const running of this.#running.values()) {
      const matches =
        'messageId' in filter
          ? running.messageId === filter.messageId
          : running.channelId === filter.channelId &&
            running.agentId === filter.agentId
      if (matches) running.controller.abort()
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
      const output = await engine.run({
        turnId: turn.id,
        agent,
        channel,
        actor: message.author.kind === 'human' ? message.author.email : '',
        prompt: turnPrompt(
          agent,
          channel,
          history,
          message,
          await service.listAgents(true),
        ),
        cwd: channelFolder(dataDir, channel.id),
        servers: turnServers(agent, channel),
        signal: controller.signal,
      })
      const after = await this.#stale(messageId, turn.agentId)
      if (controller.signal.aborted || after.reason !== undefined) {
        await cancel(after.reason ?? 'Tour arrêté.')
        return
      }
      const price = priceOf(prices, agent)
      const eur =
        output.tokens === undefined || price === undefined
          ? undefined
          : eurOf(output.tokens, price)
      if (output.text.trim() === '')
        throw new Error('l’agent n’a produit aucun texte')
      await service.reply(
        channel.id,
        messageId,
        { kind: 'agent', agentId: agent.id },
        output.text,
      )
      await service.updateTurn(messageId, turn.id, {
        status: 'done',
        finishedAt: new Date().toISOString(),
        ...(output.sessionId === undefined
          ? {}
          : { sessionId: output.sessionId }),
        ...(output.tokens === undefined ? {} : { tokens: output.tokens }),
        ...(eur === undefined ? {} : { eur }),
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
