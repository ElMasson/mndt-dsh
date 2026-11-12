/**
 * The rules of a conversation, as plain functions.
 *
 * A mention is found structurally (an `@handle` of an agent of this channel),
 * never by reading what the sentence means: a message never decides anything.
 * A turn's price comes from the configured grid of its model; a model without a
 * price is refused rather than counted as free. A turn sees its own channel
 * only: the prompt is built from that channel's messages and nothing else.
 */
import type { Agent, Channel, Message, Mission } from './types.ts'

/** A handle or a channel name: lower case, digits and dashes. */
export const SLUG = /^[a-z0-9][a-z0-9-]{1,31}$/

/**
 * A slug from a title a person typed: accents dropped, lower case, every other
 * character a dash. Plain formatting, it reads no meaning.
 * @param title - the title.
 * @returns a slug of 2 to 32 characters (`canal` when nothing usable is left).
 */
export function slugOf(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '')
  return SLUG.test(slug) ? slug : 'canal'
}

/**
 * @param slug - the wanted slug.
 * @param taken - the names already used.
 * @returns the slug, or the slug with the first free `-n` suffix.
 */
export function freeSlug(slug: string, taken: ReadonlySet<string>): string {
  if (!taken.has(slug)) return slug
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`
    const candidate = `${slug.slice(0, 32 - suffix.length).replace(/-+$/, '')}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

/** How many of the channel's last messages a turn reads. */
export const HISTORY = 30

/** Euros per million tokens of one model. */
export interface ModelPrice {
  readonly input: number
  readonly output: number
  /** Cached input read back; the input price when absent. */
  readonly cacheRead?: number
  /** Input written to the cache; the input price when absent. */
  readonly cacheWrite?: number
}

/** The grid: `<provider>/<model>` to its price. */
/**
 * The grid, as the adapters lane keeps it in `deploy/llm/prices.json`: keys
 * `<route>/<model>` or `<route>/*` (every model of a route); `null` means the
 * price is still to be provided, and such a model is refused, never free.
 */
export type PriceGrid = Readonly<Record<string, ModelPrice | null>>

/** @param agent - the agent. @returns the grid key of its model. */
export function priceKey(agent: Pick<Agent, 'provider' | 'model'>): string {
  return `${agent.provider}/${agent.model}`
}

/**
 * The price of an agent's model: its exact key, else its route's `*`.
 * @param grid - the grid.
 * @param agent - the agent.
 * @returns the price, or undefined when it is absent or still to be provided.
 */
export function priceOf(grid: PriceGrid, agent: Pick<Agent, 'provider' | 'model'>): ModelPrice | undefined {
  const exact = grid[priceKey(agent)]
  if (exact !== undefined) return exact ?? undefined
  return grid[`${agent.provider}/*`] ?? undefined
}

/**
 * Read the grid file of the adapters lane (`{ models: { key: price | null } }`).
 * @param text - the file's text, or undefined when there is no file.
 * @returns the grid; no file is an empty grid, so every turn is refused.
 * @throws when the file is not a grid: a broken price list must not run turns.
 */
export function parsePrices(text: string | undefined): PriceGrid {
  if (text === undefined || text.trim() === '') return {}
  const parsed = JSON.parse(text) as { models?: unknown }
  const models = parsed.models
  if (typeof models !== 'object' || models === null || Array.isArray(models)) {
    throw new Error('the price grid needs { "models": { "<route>/<model>": { input, output } | null } } in euros per million tokens')
  }
  const grid: Record<string, ModelPrice | null> = {}
  for (const [key, value] of Object.entries(models as Record<string, unknown>)) {
    if (value === null) {
      grid[key] = null
      continue
    }
    const price = value as Partial<Record<keyof ModelPrice, unknown>>
    const numbers = [price.input, price.output, price.cacheRead ?? 0, price.cacheWrite ?? 0]
    if (numbers.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) {
      throw new Error(`the price of ${key} needs non-negative numbers for input and output, or null`)
    }
    grid[key] = price as ModelPrice
  }
  return grid
}

/**
 * @param tokens - what a turn used.
 * @param price - its model's price.
 * @returns the euros it cost.
 */
export function eurOf(
  tokens: NonNullable<Mission['tokens']>,
  price: ModelPrice,
): number {
  const perToken = (eurPerMillion: number): number => eurPerMillion / 1_000_000
  const eur =
    tokens.input * perToken(price.input) +
    tokens.output * perToken(price.output) +
    (tokens.cacheRead ?? 0) * perToken(price.cacheRead ?? price.input) +
    (tokens.cacheWrite ?? 0) * perToken(price.cacheWrite ?? price.input)
  return Math.round(eur * 1_000_000) / 1_000_000
}

/** @param at - an ISO instant. @returns the first instant of its calendar month (UTC). */
export function monthStart(at: string): string {
  return `${at.slice(0, 7)}-01T00:00:00.000Z`
}

/**
 * What an agent spent this month, from the turns already settled.
 * @param messages - the messages of every channel.
 * @param agentId - the agent.
 * @param now - the clock.
 * @returns the euros.
 */
export function spentThisMonth(
  messages: readonly Message[],
  agentId: string,
  now: string,
): number {
  const since = monthStart(now)
  let eur = 0
  for (const message of messages) {
    for (const turn of message.turns ?? []) {
      if (
        turn.agentId === agentId &&
        turn.eur !== undefined &&
        (turn.finishedAt ?? message.createdAt) >= since
      ) {
        eur += turn.eur
      }
    }
  }
  return Math.round(eur * 1_000_000) / 1_000_000
}

/**
 * Why a turn may not start, before any call to the model.
 * @param agent - the agent mentioned.
 * @param prices - the grid.
 * @param spent - what it spent this month.
 * @returns the reason in French for the thread, or undefined when it may run.
 */
export function ceilingRefusal(
  agent: Agent,
  prices: PriceGrid,
  spent: number,
): string | undefined {
  if (priceOf(prices, agent) === undefined) {
    return `Prix du modèle non configuré (${priceKey(agent)}) : @${agent.handle} ne peut pas répondre tant que son prix n'est pas renseigné.`
  }
  if (spent >= agent.eurPerMonth) {
    return `Plafond mensuel atteint pour @${agent.handle} : ${spent.toFixed(2)} € sur ${agent.eurPerMonth.toFixed(2)} €. Seul l'owner peut le relever.`
  }
  return undefined
}

/**
 * The agents a text mentions among the channel's agents.
 * @param text - the message.
 * @param agents - the channel's agents, not retired.
 * @returns their ids, once each, in the order mentioned.
 */
export function mentionsOf(text: string, agents: readonly Agent[]): string[] {
  const byHandle = new Map(agents.map(agent => [agent.handle, agent.id]))
  const found: string[] = []
  for (const match of text.matchAll(
    /(?<![\w@.])@([a-z0-9][a-z0-9-]{1,31})\b/g,
  )) {
    const id = byHandle.get(match[1] ?? '')
    if (id !== undefined && !found.includes(id)) found.push(id)
  }
  return found
}

/**
 * The MCP servers a turn may use: the agent's that its channel also allows.
 * @param agent - the agent.
 * @param channel - the channel.
 * @returns the servers, sorted.
 */
export function turnServers(agent: Agent, channel: Channel): string[] {
  return agent.connectors
    .filter(server => channel.connectors.includes(server))
    .sort()
}

/** @param author - a message author. @param agents - every agent. @returns the name shown. */
function speaker(message: Message, agents: readonly Agent[]): string {
  const author = message.author
  if (author.kind === 'human') return author.email
  if (author.kind === 'agent')
    return `@${agents.find(a => a.id === author.agentId)?.handle ?? 'agent'}`
  return 'système'
}

/**
 * The prompt of one turn: the agent's framing, this channel's last messages,
 * and the message that mentions it. Nothing from any other channel.
 * @param agent - the agent.
 * @param channel - the channel.
 * @param history - the messages of this channel, oldest first.
 * @param asked - the message that mentions the agent.
 * @param agents - every agent, to name the authors.
 * @returns the prompt.
 */
export function turnPrompt(
  agent: Agent,
  channel: Channel,
  history: readonly Message[],
  asked: Message,
  agents: readonly Agent[],
): string {
  const earlier = history
    .filter(
      m =>
        m.channelId === channel.id &&
        m.id !== asked.id &&
        m.deletedAt === undefined &&
        m.createdAt <= asked.createdAt,
    )
    .slice(-HISTORY)
    .map(m => `[${speaker(m, agents)}] ${m.text}`)
  return [
    `Tu es @${agent.handle} (${agent.name}), un agent du canal #${channel.name} de l'équipe DATANALYSIS.`,
    'Tu réponds en français, de façon dense et factuelle, à partir de ce canal et de ses documents (ton dossier de travail).',
    'Tu cites ce sur quoi tu t’appuies. Si l’information manque, tu le dis plutôt que d’inventer.',
    'Tu n’envoies rien, ne publies rien et ne dépenses rien : pour toute action, tu demandes une carte de validation, et un humain décide.',
    ...(agent.instructions === undefined || agent.instructions.trim() === ''
      ? []
      : ['', agent.instructions.trim()]),
    '',
    `Messages récents du canal #${channel.name} :`,
    ...(earlier.length === 0 ? ['(aucun)'] : earlier),
    '',
    `Message qui te mentionne, de ${speaker(asked, agents)} :`,
    asked.text,
  ].join('\n')
}
