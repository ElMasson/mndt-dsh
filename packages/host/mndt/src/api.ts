/**
 * The Duke Workbench HTTP API.
 *
 * One handler from a request to a response, so it is testable without a socket,
 * and one thin adapter that puts it on the network. Every route authenticates
 * first, then asks the grant table before it changes anything. A refusal is a
 * JSON body with its reason, never an empty success.
 */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { DEFAULT_EUR_PER_COUNCIL_TURN, DEFAULT_EUR_PER_PARALLEL_TURN, isMissionKind, ContextRefusal, CoordinationRefusal, HelpRefusal, servedMessage, SkillRefusal, UnreadableApproval } from './core/index.ts'
import type {
  ApprovalState,
  Brief,
  WorkbenchEvent,
  Mission,
  MissionStatus,
  Visibility,
} from './core/index.ts'
import type { WorkbenchService, MissionResult, WorkbenchState, Approval } from './core/index.ts'
import { normalise, readAutomations, runAutomation, writeAutomations } from './automations.ts'
import type { Automation } from './automations.ts'
import { isPlainAscii } from './core/address.ts'
import { operatorLine } from './operator-log.ts'
import { isRefusal, publicFailure } from './public-failure.ts'
import { identityOf } from './identity.ts'
import type { Headers, IdentityOptions } from './identity.ts'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { can, roleChangeRefusal, roleOf } from './policy.ts'
import { searchState } from './search.ts'
import { canReadApproval, canReadEvent, canReadMandate, canReadMission, cardOrigin, servedCard, servedEvent } from './visibility.ts'
import type { Reader } from './visibility.ts'
import type { GrantSource } from './policy.ts'
import { mandateState, missionRefusal } from './mandates.ts'
import type { PageState } from './types.ts'
import type { TurnScheduler } from './turns.ts'
import { spentThisMonth, unattributedCouncilEur } from './core/index.ts'
import type { Channel } from './core/index.ts'

/** One request as the handler sees it. */
export interface MndtApiRequest {
  readonly method: string
  readonly path: string
  readonly query?: Readonly<Record<string, string>>
  readonly authorization?: string
  readonly headers?: Headers
  readonly body?: string
}

/** One response. */
export interface MndtApiResponse {
  readonly status: number
  readonly body: unknown
  /** A file answered as it is (the team page), instead of the JSON body. */
  readonly file?: { readonly contentType: string; readonly data: Buffer }
}

/** Runs one mission for real. */
export interface MissionRunner {
  /**
   * @param mission - the mission to run.
   * @returns the brief material the run produced.
   */
  run(mission: Mission): Promise<MissionResult>
}

/** One mounted connector, as the product shows it. */
export interface ConnectorInfo {
  readonly module: string
  readonly server: string
  readonly enabled: boolean
}

/** What the API needs. */
/** One person's token counters, summed from the missions they ran. */
interface UsageTotals {
  user: string
  missions: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * One model an agent may be given: a priced route of the price grid. `kind`
 * gives the screen its three buttons (rapide, analyse, local), `eur` its price
 * per million tokens (null when to be provided: such a model is refused for a turn).
 */
export interface ModelChoice {
  readonly provider: string
  readonly model: string
  readonly label: string
  readonly kind: 'rapide' | 'analyse' | 'local' | 'other'
  readonly eur: { readonly input: number; readonly output: number } | null
}

export interface MndtApiOptions {
  /** Where the team authority lives, for the member screen. */
  /** Where an unexpected error's detail is told to the operator (the web log); stderr by default. */
  readonly warn?: (message: string) => void
  readonly authority?: {
    readonly baseUrl: string
    readonly token: string
    /** How long a role change waits for the authority (AUTHORITY_TIMEOUT_MS by default). */
    readonly timeoutMs?: number
  }
  /** Where the roles come from when there is no authority (« file » by default). */
  readonly rolesFrom?: 'file' | 'local'
  /** The briefing schedule file, editable from the page. */
  readonly schedulePath?: string
  /** The automation registry, editable from the page. */
  readonly automationsPath?: string
  /** The machine sidecar: one browser session per person. */
  readonly machines?: { readonly baseUrl: string; readonly token: string }
  readonly service: WorkbenchService
  readonly runner: MissionRunner
  readonly identity: IdentityOptions
  readonly grants: GrantSource
  /** Mounted connectors, when the host can enumerate them. */
  readonly connectors?: () => Promise<readonly ConnectorInfo[]>
  /** The models an agent may be given (the priced routes), for the agent form. */
  readonly models?: () => Promise<readonly ModelChoice[]>
  /** Agent turns of mentions; without it, a mention queues a turn nobody runs. */
  readonly turns?: TurnScheduler
  /** The organisation the top bar names: its name, its slug and, when declared, its environment (prod, preprod). */
  readonly org?: { readonly name: string; readonly slug: string; readonly env?: string }
}

/** Where the standalone team page was built (vite, ui-mndt standalone): index.html and team-assets/. */
// Resolved, so a configured path with a trailing slash names the same folder.
const teamDir = (): string => resolve(process.env.DSH_MNDT_TEAM_DIR ?? resolve(import.meta.dirname, '..', '..', '..', 'client', 'ui-mndt', 'lib', 'team'))
const TEAM_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json; charset=utf-8',
}

/**
 * One file of the team page: `/team` and `/team/` are its index; anything else is a plain
 * file under the page's folder (no listing, no path out of it, no hidden file).
 * @param path - the request path, `/team…`.
 * @returns the file, or 404.
 */
async function teamFile(path: string): Promise<MndtApiResponse> {
  const rest = path.replace(/^\/team\/?/, '') || 'index.html'
  let name: string
  try { name = decodeURIComponent(rest) } catch { return respond(404, { error: 'no such file of the team page' }) }
  const root = teamDir()
  const target = resolve(root, name)
  if (!target.startsWith(`${root}/`) || name.split('/').some(part => part === '' || part.startsWith('.'))) {
    return respond(404, { error: 'no such file of the team page' })
  }
  const type = TEAM_TYPES[extname(target)]
  if (type === undefined) return respond(404, { error: 'no such file of the team page' })
  try {
    // The file as it really is: a symbolic link leading out of the built folder serves nothing.
    const [realRoot, real] = await Promise.all([realpath(root), realpath(target)])
    if (!real.startsWith(`${realRoot}/`)) return respond(404, { error: 'no such file of the team page' })
    const data = await readFile(real)
    return { status: 200, body: undefined, file: { contentType: type, data } }
  } catch {
    return respond(404, { error: 'no such file of the team page' })
  }
}

/** The API handler. */
export type MndtApi = (request: MndtApiRequest) => Promise<MndtApiResponse>

/** @param status - HTTP status. @param body - JSON body. @returns the response. */
function respond(status: number, body: unknown): MndtApiResponse {
  return { status, body }
}

/** @param error - a thrown value. @returns its message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** @returns today, as a plain date the mandate rules can compare. */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** @param days - how far ahead. @returns that date, as a plain date. */
function daysAhead(days: number): string {
  const at = new Date()
  at.setUTCDate(at.getUTCDate() + days)
  return at.toISOString().slice(0, 10)
}

/** @param events - the journal. @returns it as CSV with a header line. */
function journalCsv(events: readonly WorkbenchEvent[]): string {
  const cell = (value: string | undefined): string => `"${(value ?? '').replaceAll('"', '""')}"`
  const lines = ['at,actor,action,subject,detail']
  for (const event of events) {
    lines.push([event.at, event.actor, event.action, event.subject, event.detail ?? ''].map(cell).join(','))
  }
  return `${lines.join('\n')}\n`
}

/**
 * Build the handler.
 * @param options - service, runner, identity and rights.
 * @returns the handler.
 */
/** How long a role change waits for the team authority, in milliseconds. */
export const AUTHORITY_TIMEOUT_MS = 10_000

export function createMndtApi(options: MndtApiOptions): MndtApi {
  const { service, runner, grants } = options

  /** @param capability - what the route needs. @returns the identity, or a refusal. */
  const authorise = async (
    identity: string,
    capability: 'workflows.write' | 'rights.write' | 'rights.read' | 'agents.write' | 'sharing.write',
  ): Promise<MndtApiResponse | undefined> => {
    const table = await grants.grants()
    if (!table.ok) return unreadableGrants(table.reason)
    const decision = can(table.grants, identity, capability)
    return decision.allowed ? undefined : respond(403, { error: decision.reason })
  }

  /**
   * Starting a mission on a team instance is the owner's alone (Missions is off
   * for members, shown « bientôt »); the rest of the team reads it as absent.
   * Automations start missions too, so creating, changing, enabling or running
   * one, and moving the briefing's hour, are closed the same way.
   * @param identity - the caller.
   * @returns the refusal, or undefined when they may start one.
   */
  const missionsClosed = async (identity: string): Promise<MndtApiResponse | undefined> => {
    if (!teamInstance) return undefined
    const table = await grants.grants()
    const owner = table.ok && table.grants.some(grant => grant.subject === identity && grant.role === 'owner')
    return owner ? undefined : respond(404, { error: 'not found' })
  }

  /** Role changes, one at a time: the table is read again inside the section. */
  let roleChanges: Promise<unknown> = Promise.resolve()
  const serialRoleChange = <T>(work: () => Promise<T>): Promise<T> => {
    const next = roleChanges.then(work, work)
    roleChanges = next.catch(() => undefined)
    return next
  }

  /** A team instance: people other than the owner reach this API through the sign-on proxy. */
  const teamInstance = options.identity.proxyUserHeader !== undefined && options.identity.proxyUserHeader !== ''

  /**
   * What one person may read, resolved once per request (see visibility.ts).
   * @param identity - the reader.
   * @returns their channels and whether they may decide.
   */
  const readerOf = async (identity: string): Promise<Reader> => readerIn(await service.snapshot(), await grants.grants(), identity)

  /**
   * The same reader, resolved from a given state: a decision checks it inside
   * its own write, on the state it changes (never on an earlier snapshot).
   * @param state - the state read.
   * @param table - the role table.
   * @param identity - the reader.
   * @returns their channels and whether they may decide.
   */
  const readerIn = (state: WorkbenchState, table: Awaited<ReturnType<typeof grants.grants>>, identity: string): Reader => {
    const all = state.channels ?? []
    const decides = (person: string): boolean => table.ok && can(table.grants, person, 'rights.write').allowed
    const decider = decides(identity)
    return {
      identity,
      // Read from the state as it is: reading never creates the person's lane.
      channels: new Set(all.filter(channel => channel.members.includes(identity)).map(channel => channel.id)),
      decider,
      // The channels whose cards nobody among their members may decide: they
      // rise to a decider (the cards alone, see visibility.ts).
      ...(decider
        ? { channelsWithoutDecider: new Set(all.filter(channel => !channel.members.some(decides)).map(channel => channel.id)) }
        : {}),
      // On a team instance, missions and briefs are read by role (visibility.ts).
      ...(teamInstance
        ? { missionRole: table.ok && table.grants.some(grant => grant.subject === identity && grant.role === 'owner') ? 'owner' as const : 'member' as const }
        : {}),
    }
  }

  /**
   * Start a queued mission and let the runner finish it.
   * @param mission - the mission just created.
   * @returns the finished mission, or a 502 carrying the failure.
   */
  const launch = async (mission: Mission): Promise<MndtApiResponse> => {
    const started = await service.startMission(mission.id, 'pending')
    try {
      const result = await runner.run(started)
      return respond(201, await service.completeMission(started.id, result))
    } catch (error) {
      // The runtime's words go to the operator's log (failMission); the caller
      // reads the host's sentence for the failure, as on the mission.
      await service.failMission(started.id, messageOf(error))
      const failed = await service.getMission(started.id)
      return respond(502, { error: failed?.error ?? 'Erreur pendant l’exécution.', mission: failed })
    }
  }
  /** @param channelId - a channel. @param identity - the caller. @returns it, when they are a member. */
  const memberChannel = async (channelId: string, identity: string): Promise<Channel | undefined> => {
    const channel = await service.channel(channelId)
    return channel !== undefined && channel.members.includes(identity) ? channel : undefined
  }

  /**
   * @param servers - MCP server names asked for.
   * @returns a 400 naming those not mounted, when the host can say which are.
   */
  /**
   * @param provider - an agent's route. @param model - its model.
   * @returns a 400 when the host lists its models (GET /models) and this one is not among them.
   */
  const unlistedModel = async (provider: string, model: string): Promise<MndtApiResponse | undefined> => {
    if (options.models === undefined) return undefined
    const listed = await options.models()
    if (listed.some(choice => choice.provider === provider.trim() && choice.model === model.trim())) return undefined
    return respond(400, { error: `model not offered: ${provider}/${model} (see GET /models)` })
  }

  const unmounted = async (servers: readonly string[]): Promise<MndtApiResponse | undefined> => {
    if (options.connectors === undefined || servers.length === 0) return undefined
    const mounted = new Set((await options.connectors()).filter(c => c.enabled).map(c => c.server))
    const missing = servers.filter(server => !mounted.has(server))
    return missing.length === 0 ? undefined : respond(400, { error: `connector not mounted: ${missing.join(', ')}` })
  }

  /**
   * The channels, messages and agents routes.
   * @param request - the request.
   * @param path - its normalised path.
   * @param identity - the proven caller.
   * @returns the response, or undefined for no such route.
   */
  const conversationRoute = async (request: MndtApiRequest, path: string, identity: string): Promise<MndtApiResponse | undefined> => {
    try {
      return await conversation(request, path, identity)
    } catch (error) {
      // A refusal of the host (a Refusal, core/refusal.ts, the typed refusals
      // included) is served with its words. Anything else (a plain Error from a
      // library, a TypeError, a JSON error, a system error carrying a path) is
      // an internal fault: the caller gets « internal error », the detail goes
      // to the operator's log (public-failure.ts).
      if (!isRefusal(error)) return respond(500, { error: failure(error, 'internal error', `internal error on ${request.method} ${path}`) })
      const reason = failure(error, 'internal error', `internal error on ${request.method} ${path}`)
      if (error instanceof CoordinationRefusal) return respond(400, { error: reason, code: error.code })
      if (error instanceof ContextRefusal) return respond(error.code === 'context-changed' ? 409 : 400, { error: reason, code: error.code })
      // One status per skill refusal, whichever route meets it (POST /agents, /agents/:id, /agents/:id/skills).
      if (error instanceof SkillRefusal) return respond(skillRefusalStatus(error.code), { error: reason, code: error.code })
      if (/^no (channel|message|agent|turn) /.test(reason)) return respond(404, { error: reason })
      if (/taken|exists|not available/.test(reason)) return respond(409, { error: reason })
      return respond(400, { error: reason, ...(typeof (error as { code?: unknown }).code === 'string' ? { code: (error as unknown as { code: string }).code } : {}) })
    }
  }

  /** The operator's log for an internal fault: the gateway's, or stderr on one clean line. */
  const warnInternal = options.warn ?? ((message: string): void => { process.stderr.write(`${operatorLine(message)}\n`) })
  /**
   * A role table that cannot be read: served as one sentence (« la table des
   * rôles est illisible », code grants-unreadable); its file, row or code go to
   * the operator's log, once per change of the reason.
   */
  let lastUnreadable: string | undefined
  const unreadableGrantsSentence = (reason: string): string => {
    if (reason !== lastUnreadable) {
      lastUnreadable = reason
      warnInternal(`mndt: the grant table cannot be read: ${reason}`)
    }
    return GRANTS_UNREADABLE
  }
  const unreadableGrants = (reason: string): MndtApiResponse =>
    respond(503, { code: 'grants-unreadable', error: unreadableGrantsSentence(reason) })
  /**
   * The machine service's answer (sessions, a desktop's or a browser's action):
   * on success the fields of the route's list only (no host, no token, no
   * error text); on a refusal, or a body carrying an error, the host's sentence
   * and a code, its body in the operator's log, never relayed.
   * @param answer - its HTTP answer.
   * @param body - its parsed body.
   * @param fields - the route's list of served fields.
   * @param agentHost - for an action: the agent's own host, never served as a page's address.
   * @returns what is served.
   */
  const machineAnswer = (
    answer: { readonly ok: boolean; readonly status: number },
    body: Record<string, unknown>,
    fields: MachineFields,
    agentHost?: string,
  ): MndtApiResponse => {
    // A body that says an error, even under a 2xx, is a refusal: its words are not served.
    if (answer.ok && typeof body.error !== 'string') return respond(answer.status, servedAction(machinePayload(body, fields), agentHost))
    warnInternal(`mndt: the machine service answered ${answer.status}: ${JSON.stringify(body).slice(0, 300)}`)
    return respond(answer.ok ? 502 : answer.status, { error: 'the machine service refused the request', code: 'machine-refused' })
  }
  /** @param what - the machine asked for. @returns its refusal, said by the host. */
  const machineRefused = (what: string): MndtApiResponse =>
    respond(502, { error: `the machine service could not start ${what}`, code: 'machine-start-failed' })
  /** What may be served of a failure (public-failure.ts): the host's refusal, or the caller's fixed sentence. */
  const failure = (error: unknown, fallback: string, where: string): string => publicFailure(error, fallback, warnInternal, where)

  const conversation = async (request: MndtApiRequest, path: string, identity: string): Promise<MndtApiResponse | undefined> => {
    const parts = path.split('/').slice(1)
    const input = request.method === 'POST' ? parseBody(request.body) : {}
    const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])

    if (parts[0] === 'agents') {
      if (request.method === 'GET' && parts.length === 1) {
        const now = new Date().toISOString()
        const messages = (await service.snapshot()).messages ?? []
        const agents = await service.listAgents()
        return respond(200, {
          agents: agents.map(agent => ({ ...agent, eurThisMonth: spentThisMonth(messages, agent.id, now, true) })),
          // Councils closed without naming their members: one sum for the space, never per agent.
          eurUnattributedThisMonth: unattributedCouncilEur(messages, now),
        })
      }
      if (request.method === 'POST' && parts.length === 3 && parts[2] === 'retire') {
        // Retiring an agent is creating's mirror: owners and admins only.
        const denied = await authorise(identity, 'rights.write')
        if (denied !== undefined) return denied
        const agent = await service.retireAgent(parts[1] ?? '', identity)
        // A retired agent stops answering, a turn already running included.
        options.turns?.stop({ agentId: agent.id })
        return respond(200, { agent })
      }
      if (request.method === 'POST' && parts.length === 3 && parts[2] === 'skills') {
        // One skill attached or detached, applied to the agent as it stands
        // (two at the same time both count): owners and admins, as the agent itself.
        const denied = await authorise(identity, 'rights.write')
        if (denied !== undefined) return denied
        const add = typeof input.add === 'string' ? input.add : undefined
        const remove = typeof input.remove === 'string' ? input.remove : undefined
        try {
          const agent = await service.changeAgentSkill(parts[1] ?? '', { ...(add === undefined ? {} : { add }), ...(remove === undefined ? {} : { remove }) }, identity)
          return respond(200, { agent })
        } catch (error) {
          if (error instanceof SkillRefusal) {
            return respond(skillRefusalStatus(error.code), { error: failure(error, 'refused', 'a skill change failed'), code: error.code })
          }
          const said = isRefusal(error) ? failure(error, 'no agent', 'a skill change failed') : undefined
          if (said?.startsWith('no agent ') === true) return respond(404, { error: said, code: 'unknown-agent' })
          throw error
        }
      }
      if (request.method === 'POST' && parts.length <= 2) {
        // Creating and changing an agent (its instructions, model, connectors,
        // ceiling): owners and admins only (rights.write), decided by Stephane on
        // 15/11. agents.write alone would let every operator do it.
        const denied = await authorise(identity, 'rights.write')
        if (denied !== undefined) return denied
        const connectors = input.connectors === undefined ? undefined : strings(input.connectors)
        const missing = await unmounted(connectors ?? [])
        if (missing !== undefined) return missing
        const eurPerMonth = typeof input.eurPerMonth === 'number' ? input.eurPerMonth : undefined
        const skills = input.skills === undefined ? undefined : strings(input.skills)
        const text = (key: string): string | undefined => (typeof input[key] === 'string' ? input[key] : undefined)
        if (parts.length === 1 || text('provider') !== undefined || text('model') !== undefined) {
          const current = parts.length === 2 ? await service.agent(parts[1] ?? '') : undefined
          const offered = await unlistedModel(text('provider') ?? current?.provider ?? '', text('model') ?? current?.model ?? '')
          if (offered !== undefined) return offered
        }
        if (parts.length === 1) {
          const table = await grants.grants()
          const creatorRole = table.ok ? roleOf(table.grants, identity) : undefined
          const agent = await service.createAgent({
            handle: text('handle') ?? '',
            name: text('name') ?? '',
            provider: text('provider') ?? '',
            model: text('model') ?? '',
            ...(text('instructions') === undefined ? {} : { instructions: text('instructions') as string }),
            ...(connectors === undefined ? {} : { connectors }),
            ...(eurPerMonth === undefined ? {} : { eurPerMonth }),
            ...(skills === undefined ? {} : { skills }),
          }, identity, creatorRole)
          return respond(201, { agent })
        }
        const table = await grants.grants()
        const role = table.ok ? roleOf(table.grants, identity) : undefined
        const patch = {
          ...(text('name') === undefined ? {} : { name: text('name') as string }),
          ...(text('provider') === undefined ? {} : { provider: text('provider') as string }),
          ...(text('model') === undefined ? {} : { model: text('model') as string }),
          ...(text('instructions') === undefined ? {} : { instructions: text('instructions') as string }),
          ...(connectors === undefined ? {} : { connectors }),
          ...(eurPerMonth === undefined ? {} : { eurPerMonth }),
          ...(skills === undefined ? {} : { skills }),
        }
        const agent = await service.updateAgent(parts[1] ?? '', patch, identity, role)
        return respond(200, { agent })
      }
      return undefined
    }

    // ---- channels
    if (request.method === 'GET' && parts.length === 1) {
      return respond(200, { channels: await service.channelsOf(identity) })
    }
    if (request.method === 'POST' && parts.length === 1) {
      const denied = await authorise(identity, 'workflows.write')
      if (denied !== undefined) return denied
      const connectors = strings(input.connectors)
      const missing = await unmounted(connectors)
      if (missing !== undefined) return missing
      const channel = await service.createChannel({
        ...(typeof input.name === 'string' && input.name !== '' ? { name: input.name } : {}),
        ...(typeof input.title === 'string' ? { title: input.title } : {}),
        members: strings(input.members),
        agents: strings(input.agents),
        connectors,
      }, identity)
      return respond(201, { channel })
    }
    const channelId = parts[1] ?? ''
    const channel = await memberChannel(channelId, identity)
    // Not a member: the channel does not exist for them (never an empty list).
    if (channel === undefined) return respond(404, { error: `no channel ${channelId}` })

    if (request.method === 'GET' && parts.length === 2) return respond(200, { channel })

    if (request.method === 'GET' && parts.length === 3 && parts[2] === 'messages') {
      const limit = Number(request.query?.limit ?? 200)
      const since = request.query?.since
      if (since !== undefined) {
        if (Number.isNaN(Date.parse(since))) return respond(400, { error: 'since is an ISO instant' })
        const changed = await service.changedSince(channel.id, since, Number.isFinite(limit) && limit > 0 ? limit : 200)
        return respond(200, { ...changed, messages: changed.messages.map(servedMessage) })
      }
      const after = request.query?.after
      // The cursor of the first poll: the channel's last change, whatever this page holds.
      return respond(200, {
        messages: (await service.messages(channel.id, after, Number.isFinite(limit) && limit > 0 ? limit : 200)).map(servedMessage),
        cursor: await service.lastChange(channel.id),
      })
    }

    if (request.method === 'POST' && parts.length === 3 && parts[2] === 'messages') {
      const text = typeof input.text === 'string' ? input.text : ''
      const replyTo = typeof input.replyTo === 'string' ? input.replyTo : undefined
      const message = await service.postMessage(channel.id, identity, text, replyTo)
      // A reply to an agent's escalated question, by a member who may write,
      // answers it and gives the asker the hand again.
      const writer = replyTo !== undefined && (await grants.grants()).ok
        ? await authorise(identity, 'workflows.write') === undefined
        : false
      const answered = writer ? await service.answerEscalation(message, identity) : undefined
      options.turns?.launch(answered ?? message)
      return respond(201, { message: servedMessage(answered ?? message) })
    }

    if (request.method === 'POST' && parts.length === 5 && parts[2] === 'messages' && parts[4] === 'delete') {
      const message = await service.deleteMessage(channel.id, parts[3] ?? '', identity)
      options.turns?.stop({ messageId: message.id })
      // A deleted message may carry a help still running: served like any other.
      return respond(200, { message: servedMessage(message) })
    }

    if (request.method === 'POST' && parts.length === 3 && parts[2] === 'context') {
      // What the channel's agents are told about it reaches every turn: owners
      // and admins only, as for its connectors and its coordination.
      const denied = await authorise(identity, 'rights.write')
      if (denied !== undefined) return denied
      const version = input.version
      if (typeof input.text !== 'string' || typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
        return respond(400, { error: 'a context needs text (a string, empty to erase) and version (the version read, 0 for none)', code: 'missing-fields' })
      }
      return respond(200, { channel: await service.setChannelContext(channel.id, input.text, version, identity) })
    }

    if (request.method === 'POST' && parts.length === 3 && parts[2] === 'coordination') {
      // How the channel's turns are coordinated decides what runs and what it costs:
      // owners and admins only.
      const denied = await authorise(identity, 'rights.write')
      if (denied !== undefined) return denied
      if (input.mode === 'solo') return respond(200, { channel: await service.setCoordination(channel.id, undefined, identity) })
      if (input.mode === 'council') {
        if (!Array.isArray(input.members)) {
          return respond(400, { error: 'a council needs members (2 to 4 agent ids), decision (vote or synthesis) and, for a synthesis, a synthesizer', code: 'missing-fields' })
        }
        const decision = input.decision === undefined ? 'vote' : input.decision
        const updated = await service.setCoordination(channel.id, {
          mode: 'council',
          memberIds: strings(input.members),
          decision: decision as 'vote' | 'synthesis',
          ...(typeof input.synthesizer === 'string' ? { synthesizerId: input.synthesizer } : {}),
          maxEurPerTurn: typeof input.maxEurPerTurn === 'number' ? input.maxEurPerTurn : DEFAULT_EUR_PER_COUNCIL_TURN,
        }, identity)
        return respond(200, { channel: updated })
      }
      if (input.mode === 'parallel-synthesis') {
        if (!Array.isArray(input.workers) || typeof input.synthesizer !== 'string') {
          return respond(400, { error: 'parallel-synthesis needs workers (2 to 4 agent ids) and a synthesizer (an agent id)', code: 'missing-fields' })
        }
        const updated = await service.setCoordination(channel.id, {
          mode: 'parallel-synthesis',
          workerIds: strings(input.workers),
          synthesizerId: input.synthesizer,
          maxEurPerTurn: typeof input.maxEurPerTurn === 'number' ? input.maxEurPerTurn : DEFAULT_EUR_PER_PARALLEL_TURN,
        }, identity)
        return respond(200, { channel: updated })
      }
      if (input.mode !== 'author-verifier' || typeof input.author !== 'string' || typeof input.verifier !== 'string') {
        return respond(400, {
          error: 'mode is solo, author-verifier (author, verifier) or parallel-synthesis (workers, synthesizer)',
          code: input.mode === 'author-verifier' ? 'missing-fields' : 'unknown-mode',
        })
      }
      const updated = await service.setCoordination(channel.id, { mode: 'author-verifier', authorId: input.author, verifierId: input.verifier }, identity)
      return respond(200, { channel: updated })
    }

    if (request.method === 'POST' && parts.length === 3 && ['members', 'agents', 'connectors'].includes(parts[2] ?? '')) {
      // A channel's connectors give its agents access to data (Qonto, Dolibarr,
      // Office 365): owners and admins only (rights.write), not every operator
      // (decision taken in autonomy on 21/11, to be confirmed by Stephane).
      const denied = await authorise(identity, parts[2] === 'connectors' ? 'rights.write' : 'workflows.write')
      if (denied !== undefined) return denied
      if (parts[2] === 'connectors') {
        // `{ add, remove }` (preferred: applied on the server's current list, in one
        // write, so two pages never undo each other) or `{ connectors }` (the whole
        // list). Only what is ADDED must be mounted: a connector already on the
        // channel and since unmounted never blocks a change.
        if (Array.isArray(input.add) || Array.isArray(input.remove)) {
          const add = strings(input.add)
          const missing = await unmounted(add.filter(server => !(channel.connectors ?? []).includes(server)))
          if (missing !== undefined) return missing
          const updated = await service.updateChannel(channel.id, { addConnectors: add, removeConnectors: strings(input.remove) }, identity)
          return respond(200, { channel: updated })
        }
        const connectors = strings(input.connectors)
        const missing = await unmounted(connectors.filter(server => !(channel.connectors ?? []).includes(server)))
        if (missing !== undefined) return missing
        return respond(200, { channel: await service.updateChannel(channel.id, { connectors }, identity) })
      }
      const add = strings(input.add)
      const remove = strings(input.remove)
      const updated = parts[2] === 'members'
        ? await service.updateChannel(channel.id, { addMembers: add, removeMembers: remove }, identity)
        : await service.updateChannel(channel.id, { addAgents: add, removeAgents: remove }, identity)
      // An agent that leaves stops answering here, a turn already running included.
      if (parts[2] === 'agents') for (const agentId of remove) options.turns?.stop({ channelId: channel.id, agentId })
      return respond(200, { channel: updated })
    }
    return undefined
  }

  return async function handle(request: MndtApiRequest): Promise<MndtApiResponse> {
    const path = request.path.replace(/\/+$/, '') || '/'

    if (request.method === 'GET' && path === '/health') return respond(200, { ok: true })

    // The standalone team page (ui-mndt lib/team): static files, no data, no identity
    // needed (the sign-on proxy already admitted the person; the page reads /me).
    // GET and HEAD alike: the gateway relays both for the page (HTTP leaves the body out of a HEAD answer).
    if ((request.method === 'GET' || request.method === 'HEAD') && (path === '/team' || path.startsWith('/team/'))) return await teamFile(path)

    const identity = identityOf(request, options.identity)
    if (identity === undefined) return respond(401, { error: 'a bearer token or an authenticated proxy is required' })

    // On a team instance a person the role table does not name is served nothing
    // but who they are (/me, /org: the page says so): proven by the sign-on, not
    // part of the team. A role taken off grants.json applies on the next request.
    if (teamInstance && path !== '/me' && path !== '/org') {
      const table = await grants.grants()
      if (!table.ok) return unreadableGrants(table.reason)
      if (roleOf(table.grants, identity) === undefined) return respond(403, { error: 'no role on this team: ask its owner' })
    }

    try {
      if (request.method === 'GET' && path === '/me') {
        // Who the person is for the screen: their e-mail, their role and the name the role file gives them.
        const table = await grants.grants()
        const role = table.ok ? roleOf(table.grants, identity) : undefined
        const name = (await grants.names?.())?.[identity]
        // `shell`: whether this person gets the DSH shell. On a team instance only
        // the gateway knows (its OWNER) and says so, on its secret, in x-mndt-shell;
        // a second owner of the role file does not get it. Solo: the person at the
        // workstation has it.
        const shell = !teamInstance || request.headers?.['x-mndt-shell'] === '1'
        // The rows of the role file set aside (#75): told to whoever may change the
        // roles (owners and admins, rights.write), and to the tenant's owner as the
        // gateway knows it (x-mndt-shell), even when their own row is the one set aside.
        // A role file that cannot be read refuses everyone (503): its reason is told
        // to the tenant's owner as the gateway knows it, who can fix it (#75 review).
        const grantsError = !table.ok && teamInstance && shell ? unreadableGrantsSentence(table.reason) : undefined
        const skipped = table.ok && table.skipped !== undefined && table.skipped.length > 0
          && (can(table.grants, identity, 'rights.write').allowed || (teamInstance && shell))
          ? table.skipped
          : undefined
        return respond(200, {
          you: identity, ...(name === undefined ? {} : { name }), ...(role === undefined ? {} : { role }), shell,
          ...(skipped === undefined ? {} : { grantsSkipped: skipped }),
          ...(grantsError === undefined ? {} : { grantsError }),
        })
      }

      if (request.method === 'GET' && path === '/org') {
        const org = options.org
        if (org === undefined) return respond(200, { name: '', slug: '' })
        return respond(200, { name: org.name, slug: org.slug, ...(org.env === undefined || org.env === '' ? {} : { env: org.env }) })
      }

      if (request.method === 'GET' && path === '/people') {
        // The team as the role file lists it, for the screen to show names: only to someone of the team.
        const table = await grants.grants()
        if (!table.ok) return unreadableGrants(table.reason)
        if (roleOf(table.grants, identity) === undefined) return respond(403, { error: `${identity} holds no role in this team` })
        const names = (await grants.names?.()) ?? {}
        const subjects = [...new Set(table.grants.map(grant => grant.subject))]
        return respond(200, {
          people: subjects.map(email => ({
            email,
            role: roleOf(table.grants, email),
            ...(names[email] === undefined ? {} : { name: names[email] }),
          })),
        })
      }

      if (request.method === 'GET' && path === '/search') {
        const snapshot = await service.snapshot()
        const table = await grants.grants()
        const canAdmin = table.ok && can(table.grants, identity, 'rights.write').allowed
        const reader = await readerOf(identity)
        const hits = searchState(snapshot, identity, canAdmin, request.query?.q ?? '',
          approval => canReadApproval(reader, approval), item => canReadMission(reader, item),
          approval => cardOrigin(reader, approval, snapshot))
        return respond(200, { hits })
      }

      if (request.method === 'GET' && path === '/metrics') {
        const snapshot = await service.snapshot()
        const now = Date.now()
        // On a team instance the counts are of what the reader may read: a count of
        // the owner's private missions or of cards they cannot see says too much.
        const reader = teamInstance ? await readerOf(identity) : undefined
        const missions = reader === undefined ? snapshot.missions : snapshot.missions.filter(mission => canReadMission(reader, mission))
        const briefs = reader === undefined ? snapshot.briefs : snapshot.briefs.filter(brief => canReadMission(reader, brief))
        const count = (status: MissionStatus): number => missions.filter(mission => mission.status === status).length
        const pending = snapshot.approvals.filter(approval => approval.state === 'pending' && (reader === undefined || canReadApproval(reader, approval)))
        const ages = pending
          .map(approval => (now - Date.parse(approval.requestedAt)) / 3_600_000)
          .filter(hours => Number.isFinite(hours))
        let automationsEnabled = 0
        if (options.automationsPath !== undefined && (reader === undefined || reader.missionRole === 'owner')) {
          const items = await readAutomations(options.automationsPath).catch(() => [])
          automationsEnabled = items.filter(item => item.enabled).length
        }
        const todayDate = today()
        // The mandates and the last event the reader may read, as /mandates and
        // /events filter them: a count or a timestamp of what they cannot see tells
        // the activity of private channels and of the owner's missions (#75 review).
        let mandatesSeen = snapshot.mandates
        if (reader !== undefined) {
          const table = await grants.grants()
          const canAdmin = table.ok && can(table.grants, identity, 'rights.write').allowed
          mandatesSeen = mandatesSeen.filter(mandate => canReadMandate(identity, canAdmin, mandate))
        }
        const activeMandates = mandatesSeen.filter(mandate => mandateState(mandate, todayDate) === 'active').length
        const lastEvent = reader === undefined
          ? snapshot.events.at(-1)
          : servedLast(reader, snapshot)
        return respond(200, {
          up: 1,
          uptimeSeconds: Math.round(process.uptime()),
          missions: { queued: count('queued'), running: count('running'), done: count('done'), failed: count('failed') },
          briefs: briefs.length,
          approvalsPending: pending.length,
          oldestApprovalHours: ages.length === 0 ? 0 : Math.round(Math.max(...ages)),
          activeMandates,
          automationsEnabled,
          lastEventAt: lastEvent?.at ?? null,
        })
      }
      if (request.method === 'GET' && path === '/state') {
        const snapshot = await service.snapshot()
        const table = await grants.grants()
        const decision = table.ok
          ? can(table.grants, identity, 'workflows.write')
          : { allowed: false, reason: unreadableGrantsSentence(table.reason) }
        const role = table.ok ? roleOf(table.grants, identity) : undefined
        const canAdmin = table.ok ? can(table.grants, identity, 'rights.write').allowed : false
        const canShare = table.ok ? can(table.grants, identity, 'sharing.write').allowed : false
        const reader = await readerOf(identity)
        const page: PageState = {
          you: identity,
          canWrite: decision.allowed,
          ...(role === undefined ? {} : { role }),
          canAdmin,
          rolesFrom: options.authority !== undefined ? 'authority' : (options.rolesFrom ?? 'file'),
          canShare,
          missions: snapshot.missions.filter(mission => canReadMission(reader, mission)).slice(0, 30),
          briefs: snapshot.briefs.filter(brief => canReadMission(reader, brief)).slice(0, 30),
          approvals: snapshot.approvals.filter(approval => approval.state === 'pending' && canReadApproval(reader, approval))
            .map(approval => servedCard(reader, approval, snapshot)),
          memories: snapshot.memories.filter(note => note.scope === 'team' || note.createdBy === identity).slice(0, 20),
          events: snapshot.events.filter(event => canReadEvent(reader, event, snapshot)).slice(-40)
            .map(event => servedEvent(reader, event, snapshot)),
          mandates: snapshot.mandates
            .filter(mandate => canReadMandate(identity, canAdmin, mandate))
            .map(mandate => ({ ...mandate, state: mandateState(mandate, new Date().toISOString().slice(0, 10)) })),
        }
        return respond(200, { page })
      }

      if (request.method === 'GET' && path === '/mandates') {
        const table = await grants.grants()
        const canAdmin = table.ok ? can(table.grants, identity, 'rights.write').allowed : false
        const mandates = (await service.mandates())
          .filter(mandate => canReadMandate(identity, canAdmin, mandate))
          .map(mandate => ({ ...mandate, state: mandateState(mandate, today()) }))
        return respond(200, { mandates })
      }

      if (request.method === 'POST' && path === '/mandates') {
        // Proposing a delegation is a governance act, not a daily action.
        const denied = await authorise(identity, 'rights.write')
        if (denied !== undefined) return denied
        const table = await grants.grants()
        if (!table.ok) return unreadableGrants(table.reason)
        const input = parseBody(request.body)
        const canAdmin = can(table.grants, identity, 'rights.write').allowed
        const delegant = typeof input.delegant === 'string' && canAdmin ? input.delegant.trim().toLowerCase() : identity
        const delegataire = typeof input.delegataire === 'string' ? input.delegataire.trim().toLowerCase() : ''
        if (!can(table.grants, delegant, 'workflows.write').allowed) {
          return respond(403, { error: `${delegant} cannot delegate: they do not hold workflows.write` })
        }
        if (!can(table.grants, delegataire, 'workflows.write').allowed) {
          return respond(400, { error: `${delegataire || 'that person'} cannot receive a mandate: they do not hold workflows.write` })
        }
        const purpose = typeof input.purpose === 'string' && input.purpose.trim() !== '' ? input.purpose : 'preparation de dossiers'
        const connectors = Array.isArray(input.connectors)
          ? input.connectors.filter((value): value is string => typeof value === 'string')
          : ['office365', 'attio']
        const kinds = Array.isArray(input.missionKinds)
          ? input.missionKinds.filter(value => isMissionKind(value))
          : (['briefing', 'custom'] as const)
        const dailyCap = typeof input.dailyCap === 'number' ? input.dailyCap : 3
        const expiresOn = typeof input.expiresOn === 'string' ? input.expiresOn : daysAhead(30)
        try {
          const mandate = await service.createMandate({
            delegant, delegataire, purpose, connectors, missionKinds: kinds, dailyCap, expiresOn,
          })
          return respond(201, mandate)
        } catch (error) {
          return respond(400, { error: failure(error, 'the mandate could not be created', 'a mandate failed') })
        }
      }

      if (request.method === 'POST' && path.startsWith('/mandates/') && path.endsWith('/sign')) {
        const id = path.slice('/mandates/'.length, -'/sign'.length)
        const denied = await authorise(identity, 'workflows.write')
        if (denied !== undefined) return denied
        const table = await grants.grants()
        if (!table.ok) return unreadableGrants(table.reason)
        try {
          const mandate = await service.signMandate(id, identity, roleOf(table.grants, identity))
          return respond(200, mandate)
        } catch (error) {
          return respond(403, { error: failure(error, 'the mandate could not be signed', 'a mandate signature failed') })
        }
      }

      if (request.method === 'POST' && path.startsWith('/mandates/') && path.endsWith('/retire')) {
        const id = path.slice('/mandates/'.length, -'/retire'.length)
        const denied = await authorise(identity, 'workflows.write')
        if (denied !== undefined) return denied
        const table = await grants.grants()
        if (!table.ok) return unreadableGrants(table.reason)
        try {
          const mandate = await service.retireMandate(id, identity, roleOf(table.grants, identity))
          return respond(200, mandate)
        } catch (error) {
          return respond(403, { error: failure(error, 'the mandate could not be retired', 'a mandate retirement failed') })
        }
      }

      if (request.method === 'GET' && path === '/journal') {
        const denied = await authorise(identity, 'rights.write')
        if (denied !== undefined) return denied
        const all = await service.events(500)
        // On a team instance the journal shows only lines whose subject the reader may read.
        const reader = teamInstance ? await readerOf(identity) : undefined
        const snapshot = reader === undefined ? undefined : await service.snapshot()
        const events = reader === undefined || snapshot === undefined
          ? all
          : all.filter(event => canReadEvent(reader, event, snapshot)).map(event => servedEvent(reader, event, snapshot))
        if (request.query?.format === 'csv') return respond(200, { format: 'csv', filename: 'journal.csv', text: journalCsv(events) })
        return respond(200, { format: 'json', entries: events })
      }

      if (request.method === 'GET' && path === '/missions') {
        const status = request.query?.status
        const missions = await service.listMissions(status === undefined ? {} : { status: status as MissionStatus })
        const reader = await readerOf(identity)
        return respond(200, { missions: missions.filter(mission => canReadMission(reader, mission)) })
      }

      if (request.method === 'POST' && path === '/missions') {
        const closed = await missionsClosed(identity)
        if (closed !== undefined) return closed
        const denied = await authorise(identity, 'workflows.write')
        if (denied !== undefined) return denied
        const input = parseBody(request.body)
        const kind = input.kind
        if (!isMissionKind(kind)) return respond(400, { error: `unknown mission kind: ${String(kind)}` })
        const prompt = typeof input.prompt === 'string' ? input.prompt : ''
        const mandateId = typeof input.mandateId === 'string' && input.mandateId !== '' ? input.mandateId : undefined
        if (mandateId !== undefined) {
          const mandate = await service.mandate(mandateId)
          if (mandate === undefined) return respond(404, { error: `no mandate ${mandateId}` })
          const usedToday = await service.missionsToday(mandateId, mandate.delegataire)
          const refusal = missionRefusal(mandate, { identity, kind, usedToday }, today())
          if (refusal !== undefined) {
            await service.recordRefusal(identity, kind, refusal, mandateId)
            return respond(403, { error: refusal })
          }
        }
        // Hybrid model: a mission a person starts is personal until they share
        // it. Automated missions are created by the service with 'team'.
        const visibility: Visibility = input.visibility === 'team' ? 'team' : 'private'
        const mission = await service.createMission({
          kind, prompt, createdBy: identity, visibility, ...(mandateId === undefined ? {} : { mandateId }),
        })
        return await launch(mission)
      }

      if (request.method === 'POST' && path.startsWith('/missions/') && path.endsWith('/cancel')) {
        const id = path.slice('/missions/'.length, -'/cancel'.length)
        const denied = await authorise(identity, 'workflows.write')
        if (denied !== undefined) return denied
        const target = await service.getMission(id)
        if (target === undefined || !canReadMission(await readerOf(identity), target)) return respond(404, { error: `no mission ${id}` })
        const table = await grants.grants()
        if (!table.ok) return unreadableGrants(table.reason)
        try {
          const mission = await service.cancelMission(id, identity, can(table.grants, identity, 'rights.write').allowed)
          return respond(200, mission)
        } catch (error) {
          return respond(409, { error: failure(error, 'the mission could not be cancelled', 'a mission cancellation failed') })
        }
      }

      if (request.method === 'POST' && path.startsWith('/missions/') && path.endsWith('/retry')) {
        const id = path.slice('/missions/'.length, -'/retry'.length)
        const closed = await missionsClosed(identity)
        if (closed !== undefined) return closed
        const denied = await authorise(identity, 'workflows.write')
        if (denied !== undefined) return denied
        const original = await service.getMission(id)
        if (original === undefined || !canReadMission(await readerOf(identity), original)) return respond(404, { error: `no mission ${id}` })
        if (original.status !== 'failed') {
          return respond(409, { error: `mission ${id} is ${original.status}; only a failed mission can be retried` })
        }
        const mandateId = original.mandateId
        if (mandateId !== undefined) {
          const mandate = await service.mandate(mandateId)
          if (mandate === undefined) return respond(404, { error: `no mandate ${mandateId}` })
          const usedToday = await service.missionsToday(mandateId, mandate.delegataire)
          const refusal = missionRefusal(mandate, { identity, kind: original.kind, usedToday }, today())
          if (refusal !== undefined) {
            await service.recordRefusal(identity, original.kind, refusal, mandateId)
            return respond(403, { error: refusal })
          }
        }
        const mission = await service.createMission({
          kind: original.kind,
          prompt: original.prompt,
          createdBy: identity,
          visibility: original.visibility,
          ...(mandateId === undefined ? {} : { mandateId }),
        })
        return await launch(mission)
      }
      if (request.method === 'GET' && path.startsWith('/missions/')) {
        const id = path.slice('/missions/'.length)
        const mission = await service.getMission(id)
        if (mission === undefined) return respond(404, { error: `no mission ${id}` })
        // Unreadable reads as absent, never as « private to someone ».
        if (!canReadMission(await readerOf(identity), mission)) return respond(404, { error: `no mission ${id}` })
        const brief = mission.briefId === undefined ? undefined : await service.getBrief(mission.briefId)
        return respond(200, { mission, brief })
      }

      if (request.method === 'GET' && path === '/briefs') {
        const briefs = await service.listBriefs()
        const reader = await readerOf(identity)
        return respond(200, { briefs: briefs.filter(brief => canReadMission(reader, brief)) })
      }

      if (request.method === 'GET' && path.startsWith('/briefs/')) {
        const id = path.slice('/briefs/'.length)
        const brief = await service.getBrief(id)
        if (brief === undefined) return respond(404, { error: `no brief ${id}` })
        if (!canReadMission(await readerOf(identity), brief)) return respond(404, { error: `no brief ${id}` })
        return respond(200, { brief })
      }

      if (request.method === 'POST' && /^\/briefs\/[^/]+\/approve$/.test(path)) {
        const denied = await authorise(identity, 'workflows.write')
        if (denied !== undefined) return denied
        const id = path.split('/')[2] ?? ''
        const stored = await service.getBrief(id)
        if (stored === undefined || !canReadMission(await readerOf(identity), stored)) return respond(404, { error: `no brief ${id}` })
        const brief = await service.approveBrief(id, identity)
        return respond(200, { brief })
      }

      if (request.method === 'GET' && path === '/approvals') {
        const state = (request.query?.state ?? 'pending') as ApprovalState | 'all'
        // A card is read where it was asked (visibility.ts). `canDecide` says, for
        // the reader, whether the card is theirs to decide; `mine=1` keeps exactly
        // those, pending: the « À traiter » queue.
        const reader = await readerOf(identity)
        const snapshot = await service.snapshot()
        const visible = (await service.listApprovals(state))
          .filter(approval => canReadApproval(reader, approval))
          .map(approval => servedCard(reader, { ...approval, canDecide: reader.decider && approval.state === 'pending' }, snapshot))
        const approvals = request.query?.mine === '1' ? visible.filter(approval => approval.canDecide) : visible
        return respond(200, { approvals })
      }

      if (request.method === 'POST' && path === '/help') {
        // ask_peers, during the asking agent's own turn: the running turn is the
        // one the approvals connector names (x-mndt-run), never what a body says.
        const denied = await authorise(identity, 'workflows.write')
        if (denied !== undefined) return denied
        const run = request.headers?.['x-mndt-run']
        const turn = options.turns?.current()
        if (turn === undefined || run === undefined || run !== turn.turnId) {
          return respond(400, { error: 'a help is asked during an agent turn', code: 'not-running' })
        }
        const input = parseBody(request.body)
        const said = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string).trim() : '')
        const list = (key: string): string[] => (Array.isArray(input[key]) ? (input[key] as unknown[]).filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(item => item !== '') : [])
        const need = input.need
        try {
          const help = await service.askPeers(turn.messageId, turn.turnId, turn.agent.id, {
            task: said('task'), tried: said('tried'), blocker: said('blocker'), options: list('options'),
            need: need === 'fact' || need === 'opinion' || need === 'check' || need === 'choice' ? need : ('' as never),
          }, list('peers'))
          return respond(201, { help: { state: help.state, peers: help.peerIds.length, capEur: help.capEur } })
        } catch (error) {
          if (error instanceof HelpRefusal) return respond(error.code === 'not-running' ? 400 : 409, { error: failure(error, 'refused', 'a help failed'), code: error.code })
          throw error
        }
      }

      // The space's library of skills: read by every member, written by owners and admins.
      if (path === '/skills' || path.startsWith('/skills/')) {
        const skillStatus = (error: unknown): MndtApiResponse | undefined => {
          if (!(error instanceof SkillRefusal)) return undefined
          return respond(skillRefusalStatus(error.code), { error: failure(error, 'refused', 'a skill failed'), code: error.code })
        }
        if (request.method === 'GET' && path === '/skills') return respond(200, { skills: await service.listSkills() })
        if (request.method !== 'POST') return respond(404, { error: `no route ${request.method} ${path}` })
        const denied = await authorise(identity, 'rights.write')
        if (denied !== undefined) return denied
        const input = parseBody(request.body)
        const parts = path.split('/')
        try {
          if (path === '/skills') {
            if (typeof input.markdown !== 'string') return respond(400, { error: 'a skill is the text of a SKILL.md (markdown)', code: 'missing-fields' })
            return respond(201, await service.createSkill(input.markdown, identity))
          }
          if (parts.length === 4 && parts[3] === 'delete') return respond(200, await service.deleteSkill(parts[2] ?? '', identity))
          if (parts.length === 3) {
            const version = input.version
            if (typeof input.markdown !== 'string' || typeof version !== 'number' || !Number.isInteger(version)) {
              return respond(400, { error: 'a change needs markdown and version (the version read)', code: 'missing-fields' })
            }
            return respond(200, await service.updateSkill(parts[2] ?? '', input.markdown, version, identity))
          }
          return respond(404, { error: `no route ${request.method} ${path}` })
        } catch (error) {
          const refused = skillStatus(error)
          if (refused !== undefined) return refused
          throw error
        }
      }

      if (request.method === 'GET' && path === '/escalations') {
        // A person sees the open questions of the channels they are a member of; nothing else.
        return respond(200, { escalations: await service.openEscalations(identity) })
      }

      if (request.method === 'POST' && path === '/approvals') {
        const denied = await authorise(identity, 'workflows.write')
        if (denied !== undefined) return denied
        const input = parseBody(request.body)
        const kind = input.kind
        if (kind !== 'send-email' && kind !== 'publish' && kind !== 'spend' && kind !== 'delete' && kind !== 'propose_agent' && kind !== 'propose_context') {
          return respond(400, { error: `unknown approval kind: ${String(kind)}` })
        }
        // A propose_agent card carries the agent to create: the fields of POST /agents,
        // checked now as POST /agents checks them (the connectors must be mounted).
        const raw = typeof input.proposal === 'object' && input.proposal !== null ? input.proposal as Record<string, unknown> : undefined
        const field = (key: string): string | undefined => (typeof raw?.[key] === 'string' ? raw[key] as string : undefined)
        const proposal = kind !== 'propose_agent' || raw === undefined
          ? undefined
          : {
            handle: field('handle') ?? '',
            name: field('name') ?? '',
            provider: field('provider') ?? '',
            model: field('model') ?? '',
            ...(field('instructions') === undefined ? {} : { instructions: field('instructions') as string }),
            ...(raw.connectors === undefined ? {} : { connectors: Array.isArray(raw.connectors) ? raw.connectors.filter((server): server is string => typeof server === 'string') : [] }),
            ...(typeof raw.eurPerMonth === 'number' ? { eurPerMonth: raw.eurPerMonth } : {}),
          }
        if (proposal?.connectors !== undefined) {
          const missing = await unmounted(proposal.connectors)
          if (missing !== undefined) return missing
        }
        if (proposal !== undefined) {
          const offered = await unlistedModel(proposal.provider, proposal.model)
          if (offered !== undefined) return offered
        }
        // A card asked during an agent turn belongs to that turn's thread: the
        // approvals connector names the run it acts for (x-mndt-run).
        const run = request.headers?.['x-mndt-run']
        const turn = options.turns?.current()
        const thread = turn !== undefined && run !== undefined && run === turn.turnId ? turn : undefined
        // A propose_context card carries the new text and the version it was
        // written from; its channel is the running turn's, never what a request says.
        const rawContext = typeof input.contextProposal === 'object' && input.contextProposal !== null ? input.contextProposal as Record<string, unknown> : undefined
        const contextProposal = kind !== 'propose_context' || rawContext === undefined
          || typeof rawContext.text !== 'string' || typeof rawContext.baseVersion !== 'number'
          || !Number.isInteger(rawContext.baseVersion) || rawContext.baseVersion < 0
          ? undefined
          : { text: rawContext.text, baseVersion: rawContext.baseVersion }
        if (kind === 'propose_context' && contextProposal === undefined) {
          return respond(400, { error: 'a propose_context card needs contextProposal { text, baseVersion }', code: 'missing-fields' })
        }
        if (kind === 'propose_context' && thread === undefined) {
          return respond(400, { error: 'a propose_context card is asked from a channel turn' })
        }
        // A channel's context is decided by one of its members only: a decider
        // from outside must not write the content of a channel they do not read
        // (decision of 25/11). In a channel with no decider among its members,
        // such a card would never be decided: it is refused before it is born.
        if (kind === 'propose_context' && thread !== undefined) {
          const table = await grants.grants()
          const channel = ((await service.snapshot()).channels ?? []).find(candidate => candidate.id === thread.channelId)
          const decided = channel !== undefined && table.ok && channel.members.some(member => can(table.grants, member, 'rights.write').allowed)
          if (!decided) {
            return respond(409, {
              error: 'le contexte de ce canal se décide par un owner ou un admin membre du canal ; ajoutez-en un au canal',
              code: 'no-context-decider',
            })
          }
        }
        const asked = service.requestApproval({
          kind,
          title: typeof input.title === 'string' && input.title.trim() !== ''
            ? input.title
            : proposal !== undefined ? `Créer l'agent ${proposal.name}` : kind === 'propose_context' ? 'Contexte du canal' : '',
          payload: typeof input.payload === 'object' && input.payload !== null ? input.payload : {},
          requestedBy: identity,
          ...(typeof input.missionId === 'string' ? { missionId: input.missionId } : {}),
          // The turn's agent, from the running turn itself: never what a request says.
          ...(thread === undefined ? {} : { channelId: thread.channelId, messageId: thread.messageId, requestedByAgent: thread.agent }),
          ...(proposal === undefined ? {} : { proposal }),
          ...(contextProposal === undefined ? {} : { contextProposal }),
        })
        // A card refused as asked (an invalid proposal, no title) is the caller's mistake.
        try {
          return respond(201, { approval: await asked })
        } catch (error) {
          return respond(400, { error: failure(error, 'the card could not be asked', 'a card failed'), ...(error instanceof ContextRefusal ? { code: error.code } : {}) })
        }
      }

      if (request.method === 'POST' && /^\/approvals\/[^/]+\/decide$/.test(path)) {
        const id = path.split('/')[2] ?? ''
        // A card is decided where it is read: a channel's card by a member of that
        // channel who may decide, or by any decider when no member of its channel
        // may (visibility.ts). Unreadable reads as absent, never as forbidden.
        const card = (await service.snapshot()).approvals.find(candidate => candidate.id === id)
        if (card === undefined || !canReadApproval(await readerOf(identity), card)) return respond(404, { error: `no approval ${id}` })
        const denied = await authorise(identity, 'rights.write')
        if (denied !== undefined) return denied
        const input = parseBody(request.body)
        const decision = input.decision
        if (decision !== 'approved' && decision !== 'rejected') {
          return respond(400, { error: 'decision must be approved or rejected' })
        }
        if (card.kind === 'propose_agent' && decision === 'approved') {
          // An agent wrote this proposal: it is approved only from a screen that shows
          // all of it (name, model, connectors, ceiling, instructions), which says so.
          // A screen guard, NOT a security barrier: any client can send the header.
          // What protects the decision is rights.write above and, at creation, the
          // owner alone above the default ceiling (approveAgentProposal).
          if (request.headers?.['x-mndt-shows-proposal'] !== '1') {
            return respond(409, { error: 'this card proposes an agent: approve it from a screen that shows the whole proposal (x-mndt-shows-proposal)' })
          }
          // The agent is created from the proposal recorded on the card, by whoever
          // approves it (an owner or an admin, rights.write above), with their role.
          const missing = await unmounted(card.proposal?.connectors ?? [])
          if (missing !== undefined) return missing
          const offered = await unlistedModel(card.proposal?.provider ?? '', card.proposal?.model ?? '')
          if (offered !== undefined) return offered
          const table = await grants.grants()
          const role = table.ok ? roleOf(table.grants, identity) : undefined
          // As above: the table read before the write, the state read again in it.
          const readable = (state: WorkbenchState, card: Approval): boolean => canReadApproval(readerIn(state, table, identity), card)
          try {
            return respond(200, await service.approveAgentProposal(id, identity, role, readable))
          } catch (error) {
            if (error instanceof UnreadableApproval) return respond(404, { error: `no approval ${id}` })
            return respond(400, { error: failure(error, 'the agent could not be created', 'an agent proposal failed') })
          }
        }
        if (card.kind === 'propose_context' && decision === 'approved') {
          // As for an agent: approved only from a screen that shows the whole text
          // (and the version it replaces). A screen guard, not a barrier.
          if (request.headers?.['x-mndt-shows-proposal'] !== '1') {
            return respond(409, { error: 'this card proposes a channel context: approve it from a screen that shows the whole proposal (x-mndt-shows-proposal)' })
          }
          try {
            return respond(200, await service.approveContextProposal(id, identity))
          } catch (error) {
            const said = failure(error, 'the context could not be changed', 'a context proposal failed')
            if (error instanceof ContextRefusal) return respond(error.code === 'context-changed' ? 409 : 400, { error: said, code: error.code })
            return respond(400, { error: said })
          }
        }
        // Read again inside the write that decides: a card whose channel gained a
        // decider meanwhile, or that the reader lost, is not decided from outside.
        // The role table is read just before the write (an HTTP call: read inside,
        // it would hold every write of the space); the write reads the state it
        // decides on again with it (the channel's members, the card's status).
        const table = await grants.grants()
        const readable = (state: WorkbenchState, approval: Approval): boolean => canReadApproval(readerIn(state, table, identity), approval)
        try {
          const approval = await service.decideApproval(id, identity, decision, typeof input.reason === 'string' ? input.reason : undefined, readable)
          return respond(200, { approval })
        } catch (error) {
          if (error instanceof UnreadableApproval) return respond(404, { error: `no approval ${id}` })
          throw error
        }
      }

      if (request.method === 'POST' && /^\/missions\/[^/]+\/visibility$/.test(path)) {
        const id = path.split('/')[2] ?? ''
        const mission = await service.getMission(id)
        if (mission === undefined || !canReadMission(await readerOf(identity), mission)) return respond(404, { error: `no mission ${id}` })
        if (mission.createdBy !== identity) {
          const denied = await authorise(identity, 'sharing.write')
          if (denied !== undefined) return denied
        }
        const input = parseBody(request.body)
        if (input.visibility !== 'team' && input.visibility !== 'private') {
          return respond(400, { error: 'visibility must be team or private' })
        }
        const updated = await service.setMissionVisibility(id, input.visibility)
        return respond(200, { mission: updated })
      }

      if (request.method === 'POST' && /^\/memory\/[^/]+\/scope$/.test(path)) {
        const id = path.split('/')[2] ?? ''
        const notes = await service.recall({ limit: 500 })
        const note = notes.find(candidate => candidate.id === id)
        // A note the caller may not read is absent to them: holding sharing.write
        // lets a person share what they read, never publish another's private note.
        if (note === undefined || (note.scope !== 'team' && note.createdBy !== identity)) return respond(404, { error: `no memory ${id}` })
        if (note.createdBy !== identity) {
          const denied = await authorise(identity, 'sharing.write')
          if (denied !== undefined) return denied
        }
        const input = parseBody(request.body)
        if (input.scope !== 'team' && input.scope !== 'user') {
          return respond(400, { error: 'scope must be team or user' })
        }
        const updated = await service.setMemoryScope(id, input.scope)
        return respond(200, { memory: updated })
      }

      if (request.method === 'GET' && path === '/memory') {
        const scope = request.query?.scope
        const notes = await service.recall(scope === undefined ? {} : { scope: scope as never })
        return respond(200, {
          memories: notes.filter(note => note.scope === 'team' || note.createdBy === identity),
        })
      }

      if (request.method === 'POST' && path === '/memory') {
        const denied = await authorise(identity, 'agents.write')
        if (denied !== undefined) return denied
        const input = parseBody(request.body)
        const kind = input.kind
        // A note a person writes is personal until they share it; naming the
        // team scope explicitly is the act of sharing.
        const scope = input.scope === 'team' || input.scope === 'mission' ? input.scope : 'user'
        if (kind !== 'fact' && kind !== 'decision' && kind !== 'preference') return respond(400, { error: 'kind must be fact, decision or preference' })
        const note = await service.remember({
          scope,
          kind,
          text: typeof input.text === 'string' ? input.text : '',
          createdBy: identity,
        })
        return respond(201, { memory: note })
      }

      if (request.method === 'GET' && path === '/machines') {
        const denied = await authorise(identity, 'rights.read')
        if (denied !== undefined) return denied
        const machines = options.machines
        if (machines === undefined) return respond(503, { error: 'this deployment has no machine service' })
        const answer = await fetch(`${machines.baseUrl.replace(/\/$/, '')}/sessions`, {
          headers: { 'x-machine-token': machines.token },
        }).catch(() => undefined)
        if (answer === undefined) return respond(502, { error: 'the machine service is unreachable' })
        const body = await answer.json().catch(() => ({})) as Record<string, unknown>
        return machineAnswer(answer, body, MACHINE_FIELDS.SESSIONS)
      }

      if (request.method === 'POST' && path === '/machines/desktop/start') {
        const denied = await authorise(identity, 'workflows.write')
        if (denied !== undefined) return denied
        const machines = options.machines
        if (machines === undefined) return respond(503, { error: 'this deployment has no machine service' })
        const answer = await fetch(`${machines.baseUrl.replace(/\/$/, '')}/desktops/start`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-machine-token': machines.token },
          body: JSON.stringify({ identity }),
        }).catch(() => undefined)
        if (answer === undefined) return respond(502, { error: 'the machine service is unreachable' })
        const body = await answer.json().catch(() => ({})) as Record<string, unknown>
        if (!answer.ok) return machineAnswer(answer, body, MACHINE_FIELDS.STARTED)
        return respond(200, { ok: true, started: true })
      }

      if (request.method === 'POST' && path === '/machines/desktop/act') {
        const denied = await authorise(identity, 'workflows.write')
        if (denied !== undefined) return denied
        const machines = options.machines
        if (machines === undefined) return respond(503, { error: 'this deployment has no machine service' })
        const input = parseBody(request.body)
        const started = await fetch(`${machines.baseUrl.replace(/\/$/, '')}/desktops/start`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-machine-token': machines.token },
          body: JSON.stringify({ identity }),
        }).then(async answer => ({ ok: answer.ok, body: await answer.json().catch(() => ({})) as Record<string, unknown> }))
          .catch(() => undefined)
        if (started === undefined) return respond(502, { error: 'the machine service is unreachable' })
        // The machine service's own answer is not relayed: a fixed sentence and a code.
        if (!started.ok) return machineRefused('the desktop')
        const host = typeof started.body.host === 'string' ? started.body.host : ''
        const token = typeof started.body.token === 'string' ? started.body.token : ''
        if (host === '') return respond(502, { error: 'the desktop agent did not provide a host' })
        const op = typeof input.op === 'string' ? input.op : ''
        if (op === '') return respond(400, { error: 'op is required' })
        let answer: Response
        try {
          answer = await fetch(`http://${host}:9224/`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-agent-token': token },
            body: JSON.stringify(input),
          })
        } catch (error) {
          return respond(502, { error: failure(error, 'the desktop agent is unreachable', 'the desktop agent is unreachable') })
        }
        const body = await answer.json().catch(() => ({})) as Record<string, unknown>
        return machineAnswer(answer, body, MACHINE_FIELDS.ACTED, host)
      }

      if (request.method === 'POST' && path === '/machines/desktop/stop') {
        const denied = await authorise(identity, 'workflows.write')
        if (denied !== undefined) return denied
        const machines = options.machines
        if (machines === undefined) return respond(503, { error: 'this deployment has no machine service' })
        const answer = await fetch(`${machines.baseUrl.replace(/\/$/, '')}/desktops/stop`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-machine-token': machines.token },
          body: JSON.stringify({ identity }),
        }).catch(() => undefined)
        if (answer === undefined) return respond(502, { error: 'the machine service is unreachable' })
        const body = await answer.json().catch(() => ({})) as Record<string, unknown>
        return machineAnswer(answer, body, MACHINE_FIELDS.STOPPED)
      }

      if (request.method === 'POST' && path === '/machines/browser/start') {
        const denied = await authorise(identity, 'workflows.write')
        if (denied !== undefined) return denied
        const machines = options.machines
        if (machines === undefined) return respond(503, { error: 'this deployment has no machine service' })
        const answer = await fetch(`${machines.baseUrl.replace(/\/$/, '')}/browsers/start`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-machine-token': machines.token },
          body: JSON.stringify({ identity }),
        }).catch(() => undefined)
        if (answer === undefined) return respond(502, { error: 'the machine service is unreachable' })
        const body = await answer.json().catch(() => ({})) as Record<string, unknown>
        if (!answer.ok) return machineAnswer(answer, body, MACHINE_FIELDS.STARTED)
        return respond(200, { ok: true, started: true })
      }

      if (request.method === 'POST' && path === '/machines/browser/act') {
        const denied = await authorise(identity, 'workflows.write')
        if (denied !== undefined) return denied
        const machines = options.machines
        if (machines === undefined) return respond(503, { error: 'this deployment has no machine service' })
        const input = parseBody(request.body)
        const started = await fetch(`${machines.baseUrl.replace(/\/$/, '')}/browsers/start`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-machine-token': machines.token },
          body: JSON.stringify({ identity }),
        }).then(async answer => ({ ok: answer.ok, body: await answer.json().catch(() => ({})) as Record<string, unknown> }))
          .catch(() => undefined)
        if (started === undefined) return respond(502, { error: 'the machine service is unreachable' })
        // The machine service's own answer is not relayed: a fixed sentence and a code.
        if (!started.ok) return machineRefused('the browser')
        const host = typeof started.body.host === 'string' ? started.body.host : ''
        const token = typeof started.body.token === 'string' ? started.body.token : ''
        if (host === '') return respond(502, { error: 'the browser agent did not provide a host' })
        const op = typeof input.op === 'string' ? input.op : ''
        if (op === '') return respond(400, { error: 'op is required' })
        let answer: Response
        try {
          answer = await fetch(`http://${host}:9223/`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-agent-token': token },
            body: JSON.stringify(input),
          })
        } catch (error) {
          return respond(502, { error: failure(error, 'the browser agent is unreachable', 'the browser agent is unreachable') })
        }
        const body = await answer.json().catch(() => ({})) as Record<string, unknown>
        return machineAnswer(answer, body, MACHINE_FIELDS.ACTED, host)
      }

      if (request.method === 'POST' && path === '/machines/browser/stop') {
        const denied = await authorise(identity, 'workflows.write')
        if (denied !== undefined) return denied
        const machines = options.machines
        if (machines === undefined) return respond(503, { error: 'this deployment has no machine service' })
        const answer = await fetch(`${machines.baseUrl.replace(/\/$/, '')}/browsers/stop`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-machine-token': machines.token },
          body: JSON.stringify({ identity }),
        }).catch(() => undefined)
        if (answer === undefined) return respond(502, { error: 'the machine service is unreachable' })
        const body = await answer.json().catch(() => ({})) as Record<string, unknown>
        return machineAnswer(answer, body, MACHINE_FIELDS.STOPPED)
      }

      if (request.method === 'POST' && path === '/machines/capture') {
        const denied = await authorise(identity, 'workflows.write')
        if (denied !== undefined) return denied
        const machines = options.machines
        if (machines === undefined) return respond(503, { error: 'this deployment has no machine service' })
        const input = parseBody(request.body)
        const url = typeof input.url === 'string' ? input.url.trim() : ''
        if (!/^https?:\/\/[^\s]+$/.test(url)) return respond(400, { error: 'url must start with http:// or https://' })
        let answer: Response
        try {
          answer = await fetch(`${machines.baseUrl.replace(/\/$/, '')}/capture`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-machine-token': machines.token },
            body: JSON.stringify({ identity, url }),
          })
        } catch (error) {
          return respond(502, { error: failure(error, 'the machine service is unreachable', 'the machine service is unreachable') })
        }
        const body = await answer.json().catch(() => ({})) as Record<string, unknown>
        if (!answer.ok) return machineAnswer(answer, body, MACHINE_FIELDS.CAPTURED)
        return respond(200, {
          ok: true,
          bytes: body.bytes,
          seconds: body.seconds,
          png: body.png,
        })
      }

      if (request.method === 'GET' && path === '/schedule') {
        const closedToTeam = await missionsClosed(identity)
        if (closedToTeam !== undefined) return closedToTeam
        let at: string | undefined = process.env.DSH_MNDT_BRIEFING_AT
        if (options.automationsPath !== undefined) {
          const items = await readAutomations(options.automationsPath).catch(() => [])
          const briefing = items.find(item => item.id === 'auto_briefing')
          if (briefing !== undefined) at = briefing.at
        }
        if (at === undefined && options.schedulePath !== undefined) {
          const raw = await readFile(options.schedulePath, 'utf8').catch(() => '')
          if (raw.trim() !== '') {
            const record = JSON.parse(raw) as { at?: unknown; lastFiredDate?: unknown }
            if (typeof record.at === 'string') at = record.at
          }
        }
        return respond(200, { at: at ?? null })
      }

      if (request.method === 'POST' && path === '/schedule') {
        const closedToTeam = await missionsClosed(identity)
        if (closedToTeam !== undefined) return closedToTeam
        const denied = await authorise(identity, 'rights.write')
        if (denied !== undefined) return denied
        const input = parseBody(request.body)
        const at = typeof input.at === 'string' ? input.at.trim() : ''
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) {
          return respond(400, { error: 'at must be a time like 06:30' })
        }
        if (options.schedulePath === undefined) {
          return respond(503, { error: 'this deployment has no writable schedule' })
        }
        await writeFile(options.schedulePath, JSON.stringify({ at }), 'utf8')
        if (options.automationsPath !== undefined) {
          const items = await readAutomations(options.automationsPath).catch(() => [])
          await writeAutomations(options.automationsPath, items.map(item => (item.id === 'auto_briefing' ? { ...item, at } : item)))
        }
        return respond(200, { at })
      }

      if (request.method === 'GET' && path === '/automations') {
        const closedToTeam = await missionsClosed(identity)
        if (closedToTeam !== undefined) return closedToTeam
        if (options.automationsPath === undefined) return respond(503, { error: 'this deployment has no writable automation registry' })
        const items = await readAutomations(options.automationsPath)
        const table = await grants.grants()
        const canAdmin = table.ok ? can(table.grants, identity, 'rights.write').allowed : false
        return respond(200, { items, canAdmin })
      }

      if (request.method === 'POST' && path === '/automations') {
        const closedToTeam = await missionsClosed(identity)
        if (closedToTeam !== undefined) return closedToTeam
        const denied = await authorise(identity, 'rights.write')
        if (denied !== undefined) return denied
        if (options.automationsPath === undefined) return respond(503, { error: 'this deployment has no writable automation registry' })
        const items = await readAutomations(options.automationsPath)
        const input = parseBody(request.body)
        const id = typeof input.id === 'string' ? input.id : undefined
        const existing = id === undefined ? undefined : items.find(item => item.id === id)
        const proposed = normalise({
          ...(existing ?? {}),
          ...input,
          ...(id === undefined ? {} : { id }),
          // On a team instance the owner who saves an automation takes it over,
          // a system one included: they have read its prompt.
          createdBy: teamInstance ? identity : existing?.createdBy ?? identity,
        })
        if (proposed === undefined) return respond(400, { error: 'a name, a prompt, a valid kind and a time like 07:30 are required' })
        // Who enabled it is the server's record, never the request's.
        const { enabledBy: _claimed, ...rest } = proposed
        const recorded: Automation = proposed.enabled ? { ...rest, enabledBy: identity } : rest
        const next = existing === undefined ? [...items, recorded] : items.map(item => (item.id === recorded.id ? recorded : item))
        await writeAutomations(options.automationsPath, next)
        return respond(existing === undefined ? 201 : 200, { automation: recorded })
      }

      if (request.method === 'POST' && /^\/automations\/[^/]+\/toggle$/.test(path)) {
        const closedToTeam = await missionsClosed(identity)
        if (closedToTeam !== undefined) return closedToTeam
        const denied = await authorise(identity, 'rights.write')
        if (denied !== undefined) return denied
        if (options.automationsPath === undefined) return respond(503, { error: 'this deployment has no writable automation registry' })
        const id = path.split('/')[2] ?? ''
        const input = parseBody(request.body)
        if (typeof input.enabled !== 'boolean') return respond(400, { error: 'enabled must be true or false' })
        const items = await readAutomations(options.automationsPath)
        if (!items.some(item => item.id === id)) return respond(404, { error: `no automation ${id}` })
        const next = items.map((item) => {
          if (item.id !== id) return item
          const { enabledBy: _previous, ...rest } = item
          return input.enabled === true ? { ...rest, enabled: true, enabledBy: identity } : { ...rest, enabled: false }
        })
        await writeAutomations(options.automationsPath, next)
        return respond(200, { automation: next.find(item => item.id === id) })
      }

      if (request.method === 'POST' && /^\/automations\/[^/]+\/run$/.test(path)) {
        const closedToTeam = await missionsClosed(identity)
        if (closedToTeam !== undefined) return closedToTeam
        const denied = await authorise(identity, 'rights.write')
        if (denied !== undefined) return denied
        if (options.automationsPath === undefined) return respond(503, { error: 'this deployment has no writable automation registry' })
        const id = path.split('/')[2] ?? ''
        const items = await readAutomations(options.automationsPath)
        const item = items.find(candidate => candidate.id === id)
        if (item === undefined) return respond(404, { error: `no automation ${id}` })
        const outcome = await runAutomation(service, runner, item, teamInstance ? identity : undefined)
        const failures = outcome.outcome === 'done' ? 0 : (item.failures ?? 0) + 1
        const patch: Partial<Automation> = {
          lastMissionId: outcome.missionId,
          lastOutcome: outcome.outcome,
          failures,
          ...(failures >= 3 ? { enabled: false } : {}),
        }
        const updated = items.map(candidate => (candidate.id === id ? { ...candidate, ...patch } : candidate))
        await writeAutomations(options.automationsPath, updated)
        const mission = await service.getMission(outcome.missionId)
        return respond(200, { mission, outcome: outcome.outcome })
      }

      if (request.method === 'GET' && path === '/usage') {
        const missions = await service.listMissions({})
        const rows = new Map<string, UsageTotals>()
        for (const mission of missions) {
          const user = mission.createdBy
          const row = rows.get(user) ?? { user, missions: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
          row.missions += 1
          row.input += mission.tokens?.input ?? 0
          row.output += mission.tokens?.output ?? 0
          row.cacheRead += mission.tokens?.cacheRead ?? 0
          row.cacheWrite += mission.tokens?.cacheWrite ?? 0
          rows.set(user, row)
        }
        const table = await grants.grants()
        const canAdmin = table.ok && can(table.grants, identity, 'rights.write').allowed
        const all = [...rows.values()].sort((a, b) => b.input + b.output - (a.input + a.output))
        const mine: UsageTotals = all.find(row => row.user === identity) ?? {
          user: identity, missions: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        }
        return respond(200, { mine, team: canAdmin ? all : [], canAdmin })
      }

      if (request.method === 'GET' && path === '/members') {
        const denied = await authorise(identity, 'rights.read')
        if (denied !== undefined) return denied
        const table = await grants.grants()
        if (!table.ok) return unreadableGrants(table.reason)
        const canAdmin = can(table.grants, identity, 'rights.write').allowed
        return respond(200, { members: table.grants, canAdmin })
      }

      if (request.method === 'POST' && (path === '/members/grant' || path === '/members/revoke')) {
        const denied = await authorise(identity, 'rights.write')
        if (denied !== undefined) return denied
        const authority = options.authority
        if (authority === undefined) {
          return respond(503, { code: 'no-authority', error: 'this deployment has no team authority to write to' })
        }
        const input = parseBody(request.body)
        // Printable ASCII only, as for a proven identity: toLowerCase() folds a few
        // Unicode characters onto ASCII ones (the Kelvin sign becomes k).
        if (typeof input.subject === 'string' && input.subject.trim() !== '' && !isPlainAscii(input.subject)) {
          return respond(400, { error: 'subject must be a plain ASCII e-mail' })
        }
        const subject = typeof input.subject === 'string' ? input.subject.trim().toLowerCase() : ''
        if (subject === '') return respond(400, { error: 'subject is required' })
        const body: Record<string, unknown> = { subject }
        let next: 'viewer' | 'operator' | 'admin' | 'owner' | undefined
        if (path === '/members/grant') {
          if (input.role !== 'viewer' && input.role !== 'operator' && input.role !== 'admin' && input.role !== 'owner') {
            return respond(400, { error: 'role must be viewer, operator, admin or owner' })
          }
          next = input.role
          body.role = input.role
        }
        // Reading the table, checking and forwarding are one section, one change
        // at a time for the team: two owners removing each other at once would
        // otherwise each read two owners and leave none.
        return serialRoleChange(async () => {
          // The authority is called with this deployment's token, not the caller's:
          // who may change whose role is decided here, on the current table.
          const table = await grants.grants()
          if (!table.ok) return unreadableGrants(table.reason)
          const before = roleOf(table.grants, subject)
          const refusal = roleChangeRefusal(table.grants, identity, subject, next)
          if (refusal !== undefined) {
            await service.recordRoleChange(identity, subject, { before, after: next, outcome: `refused: ${refusal.reason}` })
            return respond(refusal.status, { error: refusal.reason })
          }
          let answer: { status: number; body: unknown }
          try {
            // The authority names its write routes /governance/grant and
            // /governance/revoke; the product exposes them under /members.
            const target = path === '/members/grant' ? '/governance/grant' : '/governance/revoke'
            const url = `${authority.baseUrl.replace(/\/$/, '')}${target}`
            // Bounded: changes wait in one line, so an authority that does not
            // answer must not hold every role change behind it.
            const response = await fetch(url, {
              method: 'POST',
              headers: { authorization: `Bearer ${authority.token}`, 'content-type': 'application/json' },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(authority.timeoutMs ?? AUTHORITY_TIMEOUT_MS),
            })
            answer = { status: response.status, body: await response.json().catch(() => ({})) }
          } catch (error) {
            const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
            await service.recordRoleChange(identity, subject, {
              before, after: next, outcome: timedOut ? 'not applied: authority did not answer in time' : 'not applied: authority unreachable',
            })
            return timedOut
              ? respond(504, { error: `the authority did not answer within ${(authority.timeoutMs ?? AUTHORITY_TIMEOUT_MS) / 1000} s: the role is unchanged` })
              : respond(502, { error: failure(error, 'authority unreachable: the role is unchanged', 'the role authority is unreachable') })
          }
          await service.recordRoleChange(identity, subject, {
            before,
            after: next,
            outcome: answer.status === 200 ? 'applied' : `not applied: authority answered ${answer.status}`,
          })
          // The authority's own answer is not relayed: its status, with the host's words.
          if (answer.status === 200) return respond(200, { applied: true, subject, role: next })
          warnInternal(`mndt: the role authority answered ${answer.status}: ${JSON.stringify(answer.body).slice(0, 300)}`)
          return respond(answer.status, { error: 'the authority refused the change: the role is unchanged', code: 'authority-refused' })
        })
      }

      if (request.method === 'GET' && path === '/models') {
        // The models an agent may be given, for the agent form: the priced routes only.
        return respond(200, { models: options.models === undefined ? [] : await options.models() })
      }

      if (request.method === 'GET' && path === '/connectors') {
        const mounted = options.connectors === undefined ? [] : await options.connectors()
        return respond(200, { connectors: mounted })
      }

      if (path === '/agents' || path.startsWith('/agents/') || path === '/channels' || path.startsWith('/channels/')) {
        const answered = await conversationRoute(request, path, identity)
        if (answered !== undefined) return answered
      }

      if (request.method === 'GET' && path === '/events') {
        // The journal of what happened, each line only where its subject is readable.
        const reader = await readerOf(identity)
        const snapshot = await service.snapshot()
        const limit = Number(request.query?.limit ?? 100)
        const events = snapshot.events.filter(event => canReadEvent(reader, event, snapshot))
          .map(event => servedEvent(reader, event, snapshot))
        return respond(200, { events: events.slice(-(Number.isFinite(limit) && limit > 0 ? limit : 100)) })
      }

      return respond(404, { error: `no route ${request.method} ${path}` })
    } catch (error) {
      // A refusal of the host is the caller's: said, with its words. Anything
      // else is ours: « internal error », its detail in the operator's log.
      if (!isRefusal(error)) return respond(500, { error: failure(error, 'internal error', `internal error on ${request.method} ${request.path}`) })
      const reason = failure(error, 'internal error', `internal error on ${request.method} ${request.path}`)
      const client = /needs|unknown|already|only|cannot|does not/.test(reason)
      return respond(client ? 409 : 400, { error: reason })
    }
  }
}

/** A route's served fields: each a scalar kept when of its type, or a list of rows kept field by field. */
type MachineFields = Readonly<Record<string, 'string' | 'number' | 'boolean' | Readonly<Record<string, 'string' | 'number' | 'boolean'>>>>

/**
 * What each machine route serves of a success: what the page reads (face.ts
 * MachineShot, BrowserAnswer), nothing else. A start serves no host and no
 * token: they stay in the host, which acts with them.
 */
export const MACHINE_FIELDS = {
  SESSIONS: { sessions: { name: 'string', status: 'string' } },
  STARTED: { ok: 'boolean' },
  ACTED: { ok: 'boolean', png: 'string', text: 'string', url: 'string', title: 'string' },
  STOPPED: { ok: 'boolean' },
  CAPTURED: { ok: 'boolean', bytes: 'number', seconds: 'number', png: 'string' },
} as const satisfies Readonly<Record<string, MachineFields>>

/**
 * @param body - a successful answer of the machine service.
 * @param fields - the route's list.
 * @returns only those fields, of their type: the result asked for, never another
 * field of the service (a host, a token, a detail).
 */
export function machinePayload(body: Record<string, unknown>, fields: MachineFields): Record<string, unknown> {
  const kept: Record<string, unknown> = {}
  for (const [name, type] of Object.entries(fields)) {
    const value = body[name]
    if (typeof type === 'string') {
      if (typeof value === type) kept[name] = value
      continue
    }
    if (!Array.isArray(value)) continue
    kept[name] = value.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
      .map(row => Object.fromEntries(Object.entries(type)
        .filter(([field, kind]) => typeof row[field] === kind)
        .map(([field]) => [field, row[field]])))
  }
  return kept
}

/** The longest page title served: plain text, one line. */
export const MAX_SERVED_TITLE = 200

/**
 * @param host - a URL's host name (IPv6 between brackets as the URL gives it).
 * @returns whether it names this machine or a private network: never served
 * as the address of a visited page (it may be the agent itself, or a service
 * behind it).
 */
function internalHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (name === 'localhost' || name.endsWith('.localhost') || name === '::1' || name === '0.0.0.0' || name === '') return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(name)
  if (v4 !== null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  // IPv6: unique local (fc00::/7), link-local (fe80::/10), an IPv4 mapped one.
  if (name.includes(':')) return /^f[cd]/.test(name) || /^fe[89ab]/.test(name) || /^::ffff:/.test(name)
  return false
}

/**
 * An action's result as served: the visited page's address without its query
 * nor its fragment, omitted when it names an internal host or the agent itself;
 * its title as plain text, one line, MAX_SERVED_TITLE characters at most.
 * @param payload - the fields of the route's list.
 * @param agentHost - the agent's own host, when known.
 * @returns what is served.
 */
export function servedAction(payload: Record<string, unknown>, agentHost?: string): Record<string, unknown> {
  const { url, title, ...rest } = payload
  const served: Record<string, unknown> = { ...rest }
  if (typeof url === 'string') {
    try {
      const parsed = new URL(url)
      const own = agentHost !== undefined && agentHost !== '' && parsed.hostname.toLowerCase() === agentHost.toLowerCase()
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !internalHost(parsed.hostname) && !own && parsed.username === '' && parsed.password === '') {
        served.url = `${parsed.origin}${parsed.pathname}`
      }
    } catch {
      // Not an address: not served.
    }
  }
  if (typeof title === 'string') {
    const plain = title.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
    if (plain !== '') served.title = [...plain].slice(0, MAX_SERVED_TITLE).join('')
  }
  return served
}

/** What a member reads of a role table that cannot be read: its file and its error stay in the operator's log. */
export const GRANTS_UNREADABLE = 'la table des rôles est illisible'

/**
 * @param reader - who reads.
 * @param snapshot - the state.
 * @returns the last event this reader may read, as served to them.
 */
function servedLast(reader: Reader, snapshot: WorkbenchState): WorkbenchEvent | undefined {
  const found = snapshot.events.findLast(event => canReadEvent(reader, event, snapshot))
  return found === undefined ? undefined : servedEvent(reader, found, snapshot)
}

/**
 * @param code - a skill refusal's code.
 * @returns its one HTTP status, on every route: 404 for a skill not in the
 * library, 409 for a conflict with what is written (the ceiling of three, a
 * moved version, a name taken), 400 for a malformed request.
 */
function skillRefusalStatus(code: string): number {
  if (code === 'unknown-skill') return 404
  if (code === 'too-many-skills' || code === 'skill-changed' || code === 'skill-exists') return 409
  return 400
}

/**
 * Parse a JSON body.
 * @param body - raw text.
 * @returns the object, or an empty one when there is nothing to parse.
 */
function parseBody(body?: string): Record<string, unknown> {
  if (body === undefined || body.trim() === '') return {}
  const parsed: unknown = JSON.parse(body)
  return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
}

/** What starting the server needs. */
export interface MndtListenOptions extends MndtApiOptions {
  readonly port: number
  readonly host?: string
}

/** @param request - incoming message. @returns its body as text. */
async function readBody(request: IncomingMessage): Promise<string> {
  const parts: string[] = []
  for await (const chunk of request) parts.push(String(chunk))
  return parts.join('')
}

/**
 * Put the handler on the network.
 * @param options - handler options plus bind address.
 * @returns the listening server.
 */
export function startMndtApi(options: MndtListenOptions): Server {
  const handle = createMndtApi(options)
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const body = request.method === 'POST' ? await readBody(request) : undefined
      const result = await handle({
        method: request.method ?? 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([name, value]) => [name, Array.isArray(value) ? value[0] : value]),
        ),
        ...(body === undefined ? {} : { body }),
      })
      if (result.file !== undefined) {
        response.writeHead(result.status, {
          'content-type': result.file.contentType,
          'x-content-type-options': 'nosniff',
          // The page names its assets by content hash: they never change; the page itself is always re-read.
          'cache-control': result.file.contentType.startsWith('text/html') ? 'no-cache' : 'public, max-age=31536000, immutable',
        })
        response.end(result.file.data)
        return
      }
      response.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(result.body))
    })()
  }).listen(options.port, options.host ?? '127.0.0.1')
}

/** @param event - a product event. @returns one line for a log. */
export function eventLine(event: WorkbenchEvent): string {
  return `${event.at} ${event.actor} ${event.action} ${event.subject}`
}

/** @param brief - a produced brief. @returns its title. */
export function briefTitle(brief: Brief): string {
  return brief.title
}
