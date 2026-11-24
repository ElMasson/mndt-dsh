/**
 * An in-memory channel face that plays the Host's part of the lot 1 contract, for developing the
 * screen and for tests before the routes are served. It is a test double, never the product: the
 * page reads the Host through `httpChat.ts`.
 *
 * It answers a post at once with its turns queued; `tick()` moves every open turn one step
 * (queued, running, then done with the agent's answer, or refused past the monthly ceiling with a
 * system message), as the Host would between two reads.
 */
import { ChatRefusal } from './chat.ts'
import type { ChannelCreate, ChatAgent, ChatCard, ChatChanges, ChatChannel, ChatFace, ChatMessage, ChatSkill, ChatTurn, MountedConnector, OfferedModel, OpenEscalation } from './chat.ts'

/**
 * A promise of what `work` returns, or of the error it throws: the double answers like the Host,
 * asynchronously, without any I/O of its own.
 * @param work - the double's step.
 * @returns its outcome.
 */
function settle<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work())
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
}

/**
 * The Host's derivation of an identifier from a title, played by the double.
 * @param title - the title.
 * @returns the identifier, or `canal` when nothing usable is left.
 */
function deriveName(title: string): string {
  const name = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 32)
    .replace(/-+$/gu, '')
  return name.length >= 2 ? name : 'canal'
}

/** What the double starts from. */
export interface MockSeed {
  readonly you: string
  readonly agents: readonly ChatAgent[]
  readonly channels: readonly ChatChannel[]
  readonly messages?: readonly ChatMessage[]
  readonly cards?: readonly ChatCard[]
  /** The models offered to agents; absent, `models()` answers 404 as an older core does. */
  readonly models?: readonly OfferedModel[]
  /** The connectors mounted on the workbench; a channel may only hold an enabled one. */
  /** The open escalations; absent, `escalations()` answers 404 as an older core does. */
  readonly escalations?: readonly OpenEscalation[]
  /** This month's spend of councils closed without naming their members, for the space. */
  readonly unattributedEur?: number
  /** The space's skills; absent, `skills()` answers 404 as an older core does. */
  readonly skills?: readonly ChatSkill[]
  readonly mounted?: readonly MountedConnector[]
}

/** The double, with its clock step. */
export interface MockChat extends ChatFace {
  /** Move every open turn one step. */
  tick(): void
}

/**
 * Build the double.
 * @param seed - its agents, channels and first messages.
 * @param clock - the instant to stamp (tests pass a fixed one).
 * @returns the face.
 */
export function createMockChat(
  seed: MockSeed,
  clock: () => number = Date.now,
): MockChat {
  let seq = 0
  const now = (): string => new Date(clock() + seq++).toISOString()
  const agents = new Map(
    seed.agents.map(a => [a.id, { ...a, eurThisMonth: a.eurThisMonth ?? 0 }]),
  )
  const channels = new Map(seed.channels.map(c => [c.id, c]))
  const skills = new Map((seed.skills ?? []).map(k => [k.slug, k]))
  const messages = new Map((seed.messages ?? []).map(m => [m.id, m]))
  const nextId = (prefix: string): string =>
    `${prefix}_${(seq += 1).toString(36)}`

  const inChannel = (channelId: string): ChatMessage[] =>
    [...messages.values()]
      .filter(m => m.channelId === channelId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const channelOf = (channelId: string): ChatChannel => {
    const c = channels.get(channelId)
    if (!c || !c.members.includes(seed.you))
      throw new Error('channel_not_found')
    return c
  }

  const face: MockChat = {
    channels() {
      return settle(() => {
        return [...channels.values()]
          .filter(c => c.members.includes(seed.you))
          .sort((a, b) =>
            a.kind === b.kind
              ? a.createdAt.localeCompare(b.createdAt)
              : a.kind === 'solo'
                ? -1
                : 1,
          )
      })
    },
    createChannel(input: ChannelCreate) {
      return settle(() => {
        const base = input.name ?? deriveName(input.title)
        if (!/^[a-z0-9][a-z0-9-]{1,31}$/u.test(base)) throw new Error('name_invalid')
        const taken = (name: string): boolean => [...channels.values()].some(c => c.name === name)
        if (input.name !== undefined && taken(base)) throw new Error('name_taken')
        let name = base
        for (let n = 2; input.name === undefined && taken(name); n += 1) name = `${base}-${n}`
        const c: ChatChannel = {
          id: nextId('chn'),
          name,
          title: input.title,
          kind: 'team',
          members: [...new Set([seed.you, ...(input.members ?? [])])],
          agents: [...(input.agents ?? [])],
          connectors: [...(input.connectors ?? [])],
          createdBy: seed.you,
          createdAt: now(),
        }
        channels.set(c.id, c)
        return c
      })
    },
    messages(channelId) {
      return settle(() => {
        channelOf(channelId)
        const page = inChannel(channelId)
        return { messages: page, cursor: now() }
      })
    },
    changes(channelId, since): Promise<ChatChanges> {
      return settle(() => {
        channelOf(channelId)
        const changed = inChannel(channelId)
          .filter(m => m.updatedAt >= since)
          .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
        return { messages: changed, cursor: now() }
      })
    },
    post(channelId, text, replyTo) {
      return settle(() => {
        const c = channelOf(channelId)
        if (!text.trim()) throw new Error('text_empty')
        // The Host's part: which of this channel's agents the text mentions.
        const mentioned = c.agents.filter((id) => {
          const a = agents.get(id)
          return a && new RegExp(`(^|\\s)@${a.handle}(?![\\w-])`, 'u').test(text)
        })
        const at = now()
        const m: ChatMessage = {
          id: nextId('msg'),
          channelId,
          author: { kind: 'human', email: seed.you },
          text,
          mentions: mentioned,
          ...(replyTo ? { replyTo } : {}),
          turns: mentioned.map(agentId => ({
            id: nextId('trn'),
            agentId,
            status: 'queued' as const,
          })),
          createdAt: at,
          updatedAt: at,
        }
        messages.set(m.id, m)
        return m
      })
    },
    remove(channelId, messageId) {
      return settle(() => {
        channelOf(channelId)
        const m = messages.get(messageId)
        if (!m) throw new Error('message_not_found')
        if (m.author.kind !== 'human' || m.author.email !== seed.you)
          throw new Error('not_the_author')
        const at = now()
        const removed: ChatMessage = {
          ...m,
          text: '',
          deletedAt: at,
          updatedAt: at,
          ...(m.turns
            ? {
              turns: m.turns.map(t =>
                t.status === 'queued' || t.status === 'running'
                  ? { ...t, status: 'cancelled' as const }
                  : t,
              ),
            }
            : {}),
        }
        messages.set(m.id, removed)
        return removed
      })
    },
    unattributedEur() {
      return settle(() => seed.unattributedEur)
    },
    agents() {
      return settle(() => {
        return [...agents.values()]
      })
    },
    cards() {
      return settle(() => [...(seed.cards ?? [])])
    },
    addAgents(channelId, agentIds) {
      return settle(() => {
        const c = channelOf(channelId)
        for (const id of agentIds)
          if (!agents.has(id)) throw new Error('agent_not_found')
        const next = { ...c, agents: [...new Set([...c.agents, ...agentIds])] }
        channels.set(c.id, next)
        return next
      })
    },
    removeAgents(channelId, agentIds) {
      return settle(() => {
        const c = channelOf(channelId)
        const next = { ...c, agents: c.agents.filter(id => !agentIds.includes(id)) }
        channels.set(c.id, next)
        return next
      })
    },
    setContext(channelId, change) {
      return settle(() => {
        const c = channelOf(channelId)
        const held = c.context as { readonly version?: number } | undefined
        const version = typeof held?.version === 'number' ? held.version : 0
        // As the core is asked to: a change since the version read is refused, the text bounded.
        if (change.version !== version) throw new ChatRefusal('the context changed meanwhile', 409, 'context-changed')
        const text = change.text.trim()
        if (text.length > 4000) throw new ChatRefusal('a channel context is 4000 characters at most', 400, 'context-too-long')
        const { context: _old, ...rest } = c
        const next = text === '' ? rest : { ...rest, context: { text, version: version + 1, updatedBy: seed.you, updatedAt: now() } }
        channels.set(c.id, next)
        return next
      })
    },
    setCoordination(channelId, change) {
      return settle(() => {
        const c = channelOf(channelId)
        if (change.mode === 'solo') {
          const { coordination: _gone, ...rest } = c
          channels.set(c.id, rest)
          return rest
        }
        if (change.mode === 'parallel-synthesis') {
          // As the core (#85): 2 to 4 distinct workers, a synthesiser not among them, at most 5 EUR a turn.
          const ids = [...change.workers, change.synthesizer]
          if (change.workers.length < 2 || change.workers.length > 4 || new Set(change.workers).size !== change.workers.length) {
            throw new ChatRefusal('a parallel turn has 2 to 4 distinct workers', 400)
          }
          if (ids.some(agentId => agents.get(agentId) === undefined || !c.agents.includes(agentId))) {
            throw new ChatRefusal('the workers and the synthesizer must all be active agents of this channel', 400)
          }
          if (change.workers.includes(change.synthesizer)) throw new ChatRefusal('the synthesizer is not one of the workers', 400)
          const max = change.maxEurPerTurn ?? 1
          if (max <= 0 || max > 5) throw new ChatRefusal('a parallel turn costs 5 € at most (maxEurPerTurn)', 400)
          const parallel = { ...c, coordination: { mode: 'parallel-synthesis', workerIds: [...change.workers], synthesizerId: change.synthesizer, maxEurPerTurn: max } }
          channels.set(c.id, parallel)
          return parallel
        }
        if (change.mode === 'council') {
          // As the core is asked to: 2 to 4 distinct members of the channel, a synthesiser outside them.
          if (change.members.length < 2) throw new ChatRefusal('a council has 2 to 4 members', 400, 'too-few-members')
          if (change.members.length > 4 || new Set(change.members).size !== change.members.length) {
            throw new ChatRefusal('a council has 2 to 4 members', 400, 'too-many-members')
          }
          const ids = [...change.members, ...(change.synthesizer === undefined ? [] : [change.synthesizer])]
          if (ids.some(agentId => agents.get(agentId) === undefined || !c.agents.includes(agentId))) {
            throw new ChatRefusal('the members must be active agents of this channel', 400, 'not-member')
          }
          if (change.decision === 'synthesis' && (change.synthesizer === undefined || change.members.includes(change.synthesizer))) {
            throw new ChatRefusal('the synthesizer is not one of the members', 400, 'synthesizer-is-member')
          }
          const max = change.maxEurPerTurn ?? 1
          if (max <= 0 || max > 5) throw new ChatRefusal('a council turn costs 5 € at most', 400, 'budget-out-of-range')
          const council = {
            ...c,
            coordination: {
              mode: 'council', memberIds: [...change.members], decision: change.decision, maxEurPerTurn: max,
              ...(change.decision === 'synthesis' && change.synthesizer !== undefined ? { synthesizerId: change.synthesizer } : {}),
            },
          }
          channels.set(c.id, council)
          return council
        }
        // As the core (#84): two agents of the channel, on two different models.
        const author = agents.get(change.author)
        const verifier = agents.get(change.verifier)
        if (author === undefined || verifier === undefined || !c.agents.includes(author.id) || !c.agents.includes(verifier.id)) {
          throw new ChatRefusal('author and verifier must be agents of the channel', 400)
        }
        if (author.provider === verifier.provider && author.model === verifier.model) {
          throw new ChatRefusal('the verifier must run on another model than the author', 400)
        }
        const next = { ...c, coordination: { mode: 'author-verifier', authorId: author.id, verifierId: verifier.id } }
        channels.set(c.id, next)
        return next
      })
    },
    setConnectors(channelId, servers) {
      return settle(() => {
        const c = channelOf(channelId)
        const on = new Set((seed.mounted ?? []).filter(m => m.enabled).map(m => m.server))
        const missing = servers.filter(server => !on.has(server))
        // As the API: a connector that is not mounted is refused, with its name.
        if (missing.length > 0) throw new ChatRefusal(`connector not mounted: ${missing.join(', ')}`, 400)
        const next = { ...c, connectors: [...new Set(servers)].sort() }
        channels.set(c.id, next)
        return next
      })
    },
    models() {
      return settle(() => {
        if (seed.models === undefined) throw new ChatRefusal('no route', 404)
        return [...seed.models]
      })
    },
    escalations() {
      return settle(() => {
        if (seed.escalations === undefined) throw new ChatRefusal('no route', 404)
        return [...seed.escalations]
      })
    },
    mounted() {
      return settle(() => [...(seed.mounted ?? [])])
    },
    createAgent(input) {
      return settle(() => {
        // As the core: a slug of 2 to 32 characters, unique, a name and a model.
        if (!/^[a-z0-9][a-z0-9-]{1,31}$/u.test(input.handle)) throw new ChatRefusal(`a handle is a slug of 2 to 32 characters: ${input.handle}`, 400)
        if ([...agents.values()].some(a => a.handle === input.handle)) throw new ChatRefusal(`the handle @${input.handle} is taken`, 409)
        if (input.name.trim() === '') throw new ChatRefusal('an agent needs a name', 400)
        const agent: ChatAgent & { eurThisMonth: number } = {
          id: `agt_${agents.size + 1}_${input.handle}`, handle: input.handle, name: input.name, provider: input.provider, model: input.model,
          ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
          connectors: [...(input.connectors ?? [])], eurPerMonth: input.eurPerMonth ?? 5, eurThisMonth: 0,
          createdBy: seed.you, createdAt: now(),
        }
        agents.set(agent.id, agent)
        return agent
      })
    },
    skills() {
      return settle(() => {
        if (seed.skills === undefined) throw new ChatRefusal('no route', 404)
        return [...skills.values()]
      })
    },
    createSkill(markdown) {
      return settle(() => {
        const read = readSkill(markdown)
        const slug = read.name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')
        if (skills.has(slug)) throw new ChatRefusal(`the skill ${slug} exists`, 409, 'skill-exists')
        const skill = {
          slug, name: read.name, description: read.description, body: read.body, version: 1, updatedBy: seed.you, updatedAt: now(),
        }
        skills.set(slug, skill)
        return { skill, ignoredFields: read.ignored }
      })
    },
    updateSkill(slug, change) {
      return settle(() => {
        const held = skills.get(slug)
        if (held === undefined) throw new ChatRefusal(`no skill ${slug}`, 404)
        if (held.version !== change.version) throw new ChatRefusal('the skill changed meanwhile', 409, 'skill-changed')
        const read = readSkill(change.markdown)
        const skill = {
          ...held, name: read.name, description: read.description, body: read.body,
          version: held.version + 1, updatedBy: seed.you, updatedAt: now(),
        }
        skills.set(slug, skill)
        return { skill, ignoredFields: read.ignored }
      })
    },
    deleteSkill(slug) {
      return settle(() => {
        skills.delete(slug)
        for (const [agentId, agent] of agents) {
          if (agent.skills?.includes(slug) === true) agents.set(agentId, { ...agent, skills: agent.skills.filter(s => s !== slug) })
        }
      })
    },
    updateAgent(agentId, patch) {
      return settle(() => {
        const agent = agents.get(agentId)
        if (agent === undefined) throw new ChatRefusal(`no agent ${agentId}`, 404)
        // As the core: three skills at most, each one of the space's.
        if (patch.skills !== undefined && (patch.skills.length > 3 || patch.skills.some(slug => !skills.has(slug)))) {
          throw new ChatRefusal('an agent reads three skills of the space at most', 400, 'too-many-skills')
        }
        const next = {
          ...agent, ...patch,
          ...(patch.connectors === undefined ? {} : { connectors: [...patch.connectors] }),
          ...(patch.skills === undefined ? {} : { skills: [...patch.skills] }),
        }
        agents.set(agentId, next)
        return next
      })
    },
    tick() {
      for (const m of [...messages.values()]) {
        if (
          !m.turns?.some(t => t.status === 'queued' || t.status === 'running')
        )
          continue
        const turns: ChatTurn[] = m.turns.map((t) => {
          const a = agents.get(t.agentId)
          if (t.status === 'queued') {
            if (a && a.eurThisMonth >= a.eurPerMonth) {
              const at = now()
              messages.set(`msg_sys_${t.id}`, {
                id: `msg_sys_${t.id}`,
                channelId: m.channelId,
                author: { kind: 'system' },
                text: `Plafond mensuel atteint pour @${a.handle} : ${a.eurPerMonth.toFixed(2).replace('.', ',')} € sur ${a.eurPerMonth.toFixed(2).replace('.', ',')} €`,
                mentions: [],
                createdAt: at,
                updatedAt: at,
              })
              return {
                ...t,
                status: 'refused' as const,
                reason: 'Plafond mensuel atteint',
              }
            }
            return {
              ...t,
              status: 'running' as const,
              sessionId: `ses_${t.id}`,
              startedAt: now(),
            }
          }
          if (t.status === 'running') {
            const at = now()
            const answer: ChatMessage = {
              id: `msg_ans_${t.id}`,
              channelId: m.channelId,
              author: { kind: 'agent', agentId: t.agentId },
              text: `Réponse de @${a?.handle ?? t.agentId} [S1].`,
              mentions: [],
              replyTo: m.id,
              createdAt: at,
              updatedAt: at,
            }
            messages.set(answer.id, answer)
            if (a)
              agents.set(a.id, {
                ...a,
                eurThisMonth: a.eurThisMonth + 0.01,
              })
            return {
              ...t,
              status: 'done' as const,
              tokens: { input: 1200, output: 300 },
              eur: 0.01,
              finishedAt: at,
            }
          }
          return t
        })
        messages.set(m.id, { ...m, turns, updatedAt: now() })
      }
    },
  }
  return face
}

/**
 * A pasted SKILL.md, read as the core is asked to (the double's version): the front matter's name
 * and description, the body, and the other front matter fields, which have no effect here.
 * @param markdown - the file. @returns what it says.
 */
function readSkill(markdown: string): { name: string; description: string; body: string; ignored: string[] } {
  const text = markdown.replace(/\r\n/gu, '\n').trim()
  const head = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u.exec(text)
  if (head === null) throw new ChatRefusal('a SKILL.md opens with a front matter (name, description)', 400, 'missing-fields')
  const fields = new Map<string, string>()
  for (const line of (head[1] ?? '').split('\n')) {
    const at = line.indexOf(':')
    if (at > 0 && !line.startsWith(' ')) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
  }
  const name = fields.get('name') ?? ''
  const description = fields.get('description') ?? ''
  if (name === '' || description === '') throw new ChatRefusal('a SKILL.md needs a name and a description', 400, 'missing-fields')
  return { name, description, body: (head[2] ?? '').trim(), ignored: [...fields.keys()].filter(k => k !== 'name' && k !== 'description') }
}
