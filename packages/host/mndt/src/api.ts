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
import { isMissionKind } from './core/index.ts'
import type {
  ApprovalState,
  Brief,
  WorkbenchEvent,
  Mission,
  MissionStatus,
  Visibility,
} from './core/index.ts'
import type { WorkbenchService, MissionResult } from './core/index.ts'
import { identityOf } from './identity.ts'
import type { Headers, IdentityOptions } from './identity.ts'
import { readFile, writeFile } from 'node:fs/promises'
import { can, roleOf } from './policy.ts'
import type { GrantSource } from './policy.ts'
import type { PageState } from './types.ts'

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

export interface MndtApiOptions {
  /** Where the team authority lives, for the member screen. */
  readonly authority?: { readonly baseUrl: string; readonly token: string }
  /** The briefing schedule file, editable from the page. */
  readonly schedulePath?: string
  readonly service: WorkbenchService
  readonly runner: MissionRunner
  readonly identity: IdentityOptions
  readonly grants: GrantSource
  /** Mounted connectors, when the host can enumerate them. */
  readonly connectors?: () => Promise<readonly ConnectorInfo[]>
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

/**
 * Build the handler.
 * @param options - service, runner, identity and rights.
 * @returns the handler.
 */
export function createMndtApi(options: MndtApiOptions): MndtApi {
  const { service, runner, grants } = options

  /** @param capability - what the route needs. @returns the identity, or a refusal. */
  const authorise = async (
    identity: string,
    capability: 'workflows.write' | 'rights.write' | 'rights.read' | 'agents.write' | 'sharing.write',
  ): Promise<MndtApiResponse | undefined> => {
    const table = await grants.grants()
    if (!table.ok) return respond(503, { error: `cannot read the grant table: ${table.reason}` })
    const decision = can(table.grants, identity, capability)
    return decision.allowed ? undefined : respond(403, { error: decision.reason })
  }

  return async function handle(request: MndtApiRequest): Promise<MndtApiResponse> {
    const path = request.path.replace(/\/+$/, '') || '/'

    if (request.method === 'GET' && path === '/health') return respond(200, { ok: true })

    const identity = identityOf(request, options.identity)
    if (identity === undefined) return respond(401, { error: 'a bearer token or an authenticated proxy is required' })

    try {
      if (request.method === 'GET' && path === '/me') return respond(200, { you: identity })

      if (request.method === 'GET' && path === '/state') {
        const snapshot = await service.snapshot()
        const table = await grants.grants()
        const decision = table.ok
          ? can(table.grants, identity, 'workflows.write')
          : { allowed: false, reason: table.reason }
        const role = table.ok ? roleOf(table.grants, identity) : undefined
        const canAdmin = table.ok ? can(table.grants, identity, 'rights.write').allowed : false
        const canShare = table.ok ? can(table.grants, identity, 'sharing.write').allowed : false
        const page: PageState = {
          you: identity,
          canWrite: decision.allowed,
          ...(role === undefined ? {} : { role }),
          canAdmin,
          canShare,
          missions: snapshot.missions.filter(mission => mission.visibility === 'team' || mission.createdBy === identity).slice(0, 30),
          briefs: snapshot.briefs.filter(brief => (brief.visibility ?? 'team') === 'team' || brief.createdBy === identity).slice(0, 30),
          approvals: snapshot.approvals.filter(approval => approval.state === 'pending'),
          memories: snapshot.memories.filter(note => note.scope === 'team' || note.createdBy === identity).slice(0, 20),
          events: snapshot.events.slice(-40),
        }
        return respond(200, { page })
      }

      if (request.method === 'GET' && path === '/missions') {
        const status = request.query?.status
        const missions = await service.listMissions(status === undefined ? {} : { status: status as MissionStatus })
        return respond(200, { missions: missions.filter(mission => mission.visibility === 'team' || mission.createdBy === identity) })
      }

      if (request.method === 'POST' && path === '/missions') {
        const denied = await authorise(identity, 'workflows.write')
        if (denied !== undefined) return denied
        const input = parseBody(request.body)
        const kind = input.kind
        if (!isMissionKind(kind)) return respond(400, { error: `unknown mission kind: ${String(kind)}` })
        const prompt = typeof input.prompt === 'string' ? input.prompt : ''
        // Hybrid model: a mission a person starts is personal until they share
        // it. Automated missions are created by the service with 'team'.
        const visibility: Visibility = input.visibility === 'team' ? 'team' : 'private'
        const mission = await service.createMission({ kind, prompt, createdBy: identity, visibility })
        const started = await service.startMission(mission.id, 'pending')
        try {
          const result = await runner.run(started)
          const finished = await service.completeMission(started.id, result)
          return respond(201, finished)
        } catch (error) {
          const reason = messageOf(error)
          await service.failMission(started.id, reason)
          return respond(502, { error: reason, mission: await service.getMission(started.id) })
        }
      }

      if (request.method === 'GET' && path.startsWith('/missions/')) {
        const id = path.slice('/missions/'.length)
        const mission = await service.getMission(id)
        if (mission === undefined) return respond(404, { error: `no mission ${id}` })
        if (mission.visibility === 'private' && mission.createdBy !== identity) {
          return respond(403, { error: `mission ${id} is private to ${mission.createdBy}` })
        }
        const brief = mission.briefId === undefined ? undefined : await service.getBrief(mission.briefId)
        return respond(200, { mission, brief })
      }

      if (request.method === 'GET' && path === '/briefs') {
        const briefs = await service.listBriefs()
        return respond(200, {
          briefs: briefs.filter(brief => (brief.visibility ?? 'team') === 'team' || brief.createdBy === identity),
        })
      }

      if (request.method === 'GET' && path.startsWith('/briefs/')) {
        const id = path.slice('/briefs/'.length)
        const brief = await service.getBrief(id)
        if (brief === undefined) return respond(404, { error: `no brief ${id}` })
        if ((brief.visibility ?? 'team') === 'private' && brief.createdBy !== identity) {
          return respond(403, { error: `brief ${id} is private to ${brief.createdBy}` })
        }
        return respond(200, { brief })
      }

      if (request.method === 'POST' && /^\/briefs\/[^/]+\/approve$/.test(path)) {
        const denied = await authorise(identity, 'workflows.write')
        if (denied !== undefined) return denied
        const id = path.split('/')[2] ?? ''
        const brief = await service.approveBrief(id, identity)
        return respond(200, { brief })
      }

      if (request.method === 'GET' && path === '/approvals') {
        const state = (request.query?.state ?? 'pending') as ApprovalState | 'all'
        return respond(200, { approvals: await service.listApprovals(state) })
      }

      if (request.method === 'POST' && path === '/approvals') {
        const denied = await authorise(identity, 'workflows.write')
        if (denied !== undefined) return denied
        const input = parseBody(request.body)
        const kind = input.kind
        if (kind !== 'send-email' && kind !== 'publish' && kind !== 'spend' && kind !== 'delete') {
          return respond(400, { error: `unknown approval kind: ${String(kind)}` })
        }
        const approval = await service.requestApproval({
          kind,
          title: typeof input.title === 'string' ? input.title : '',
          payload: typeof input.payload === 'object' && input.payload !== null ? input.payload : {},
          requestedBy: identity,
          ...(typeof input.missionId === 'string' ? { missionId: input.missionId } : {}),
        })
        return respond(201, { approval })
      }

      if (request.method === 'POST' && /^\/approvals\/[^/]+\/decide$/.test(path)) {
        const denied = await authorise(identity, 'rights.write')
        if (denied !== undefined) return denied
        const id = path.split('/')[2] ?? ''
        const input = parseBody(request.body)
        const decision = input.decision
        if (decision !== 'approved' && decision !== 'rejected') {
          return respond(400, { error: 'decision must be approved or rejected' })
        }
        const approval = await service.decideApproval(id, identity, decision, typeof input.reason === 'string' ? input.reason : undefined)
        return respond(200, { approval })
      }

      if (request.method === 'POST' && /^\/missions\/[^/]+\/visibility$/.test(path)) {
        const id = path.split('/')[2] ?? ''
        const mission = await service.getMission(id)
        if (mission === undefined) return respond(404, { error: `no mission ${id}` })
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
        if (note === undefined) return respond(404, { error: `no memory ${id}` })
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

      if (request.method === 'GET' && path === '/schedule') {
        let at: string | undefined = process.env.DSH_MNDT_BRIEFING_AT
        if (options.schedulePath !== undefined) {
          const raw = await readFile(options.schedulePath, 'utf8').catch(() => '')
          if (raw.trim() !== '') {
            const record = JSON.parse(raw) as { at?: unknown; lastFiredDate?: unknown }
            if (typeof record.at === 'string') at = record.at
          }
        }
        return respond(200, { at: at ?? null })
      }

      if (request.method === 'POST' && path === '/schedule') {
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
        return respond(200, { at })
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
        if (!table.ok) return respond(503, { error: `cannot read the grant table: ${table.reason}` })
        const canAdmin = can(table.grants, identity, 'rights.write').allowed
        return respond(200, { members: table.grants, canAdmin })
      }

      if (request.method === 'POST' && (path === '/members/grant' || path === '/members/revoke')) {
        const denied = await authorise(identity, 'rights.write')
        if (denied !== undefined) return denied
        const authority = options.authority
        if (authority === undefined) {
          return respond(503, { error: 'this deployment has no team authority to write to' })
        }
        const input = parseBody(request.body)
        const subject = typeof input.subject === 'string' ? input.subject.trim().toLowerCase() : ''
        if (subject === '') return respond(400, { error: 'subject is required' })
        const body: Record<string, unknown> = { subject }
        if (path === '/members/grant') {
          if (input.role !== 'viewer' && input.role !== 'operator' && input.role !== 'admin' && input.role !== 'owner') {
            return respond(400, { error: 'role must be viewer, operator, admin or owner' })
          }
          body.role = input.role
        }
        let answer: { status: number; body: unknown }
        try {
          // The authority names its write routes /governance/grant and
          // /governance/revoke; the product exposes them under /members.
          const target = path === '/members/grant' ? '/governance/grant' : '/governance/revoke'
          const url = `${authority.baseUrl.replace(/\/$/, '')}${target}`
          const response = await fetch(url, {
            method: 'POST',
            headers: { authorization: `Bearer ${authority.token}`, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          answer = { status: response.status, body: await response.json().catch(() => ({})) }
        } catch (error) {
          return respond(502, { error: `authority unreachable: ${messageOf(error)}` })
        }
        return respond(answer.status, answer.body)
      }

      if (request.method === 'GET' && path === '/connectors') {
        const mounted = options.connectors === undefined ? [] : await options.connectors()
        return respond(200, { connectors: mounted })
      }

      if (request.method === 'GET' && path === '/events') {
        return respond(200, { events: await service.events(Number(request.query?.limit ?? 100)) })
      }

      return respond(404, { error: `no route ${request.method} ${path}` })
    } catch (error) {
      const reason = messageOf(error)
      // A state error is the caller's fault, anything else is ours; both are
      // reported, neither is swallowed.
      const client = /needs|unknown|already|only|cannot|does not/.test(reason)
      return respond(client ? 409 : 500, { error: reason })
    }
  }
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
