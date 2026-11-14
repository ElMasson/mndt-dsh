/**
 * The browser's way into the product.
 *
 * Every method answers a value, never a thrown error: a page can then show the
 * real reason instead of an empty list. The gateway owns the one workbench
 * service, so the page and the HTTP face never disagree about the state, and it
 * starts the HTTP face only when the deployment gives it a port.
 */
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import { JsonFileStore, WorkbenchService } from './core/index.ts'
import type { ApprovalState, MissionKind } from './core/index.ts'
import type { Mission, PageState } from './types.ts'
import type {} from '@deepseek-ai/cordis-plugin-loader'
// Type-only: pulls the agents service and the session/workflow event maps.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workflow'
import { startMndtApi } from './api.ts'
import { loadTokens } from './identity.ts'
import type { GrantSource } from './policy.ts'
import { can, roleOf } from './policy.ts'
import { searchState } from './search.ts'
import { authorityGrants, fileGrants, localGrants } from './grants.ts'
import { DshMissionRunner, DshTurnRunner } from './runner.ts'
import { TEAM_MISSION_POLICY } from './tool-policy.ts'
import { TurnScheduler } from './turns.ts'
import { readFileSync } from 'node:fs'
import { parsePrices } from './core/index.ts'
import type { PriceGrid } from './core/index.ts'
import { dueAutomations, firedFields, readAutomations, runAutomation, writeAutomations } from './automations.ts'
import type { Automation } from './automations.ts'

/** How the deployment configures the product. */
export interface MndtConfig {
  /** Port for the HTTP face. Absent means the page talks through Remote only. */
  readonly port?: number
  readonly host?: string
  /** Where the product state lives. */
  readonly statePath?: string
  /** Token table proving machine identities. */
  readonly tokensFile?: string
  /** Header an authenticating proxy fills; set only behind that proxy. */
  readonly proxyUserHeader?: string
  /** The team authority, when this deployment is in team mode. */
  readonly authority?: { readonly baseUrl: string; readonly token: string }
  /** Who this workstation acts as, for page-driven actions. */
  readonly identity?: string
  /** Solo mode: this identity holds owner. */
  readonly localOwner?: string
}

/** The Remote gateway. */
/**
 * @param path - the secret file the deployment mounted, if any.
 * @returns its trimmed content, or undefined when there is none (never an error that stops the API).
 */
function readGatewaySecret(path: string | undefined): string | undefined {
  if (path === undefined || path === '') return undefined
  try {
    const secret = readFileSync(path, 'utf8').trim()
    return secret === '' ? undefined : secret
  } catch {
    return undefined
  }
}

/**
 * Whether the workstation Remote is closed: it is on a team workbench, where
 * several people reach the same shell behind single sign-on (a proxy user
 * header is configured) and the product API serves each under their own identity.
 * @param proxyUserHeader - the header the proxy proves the person with, if any.
 * @returns the Remote's JSON refusal, or undefined when the Remote is open.
 */
export function teamRemoteRefusal(proxyUserHeader: string | undefined): string | undefined {
  if (proxyUserHeader === undefined || proxyUserHeader === '') return undefined
  return JSON.stringify({
    ok: false,
    error: 'on a team workbench the product API (/mndt-api) serves each person under their own identity; the workstation Remote is closed',
  })
}

export class WorkbenchGateway extends TypertRemoteService {
  /** Services read here: the agent runtime and the Loader's connector entries. */
  static inject = ['agents', 'loader']

  readonly service: WorkbenchService
  private readonly tokensFile: string | undefined
  private readonly proxyUserHeader: string | undefined
  private readonly identity: string
  private readonly grants: GrantSource
  private readonly statePath: string
  /** Where the editable briefing schedule lives; the API writes it, the poller reads it. */
  private readonly schedulePath: string
  /** The automation registry: the poller reads it, the API writes it. */
  private readonly automationsPath: string

  /**
   * @param ctx - owning context.
   * @param config - deployment configuration.
   */
  constructor(ctx: Context, config: MndtConfig = {}) {
    super(ctx, 'mndt')
    this.statePath = config.statePath ?? process.env.DSH_MNDT_STATE ?? join(homedir(), '.dsh', 'mndt', 'state.json')
    this.schedulePath = join(dirname(this.statePath), 'briefing-schedule.json')
    this.automationsPath = join(dirname(this.statePath), 'automations.json')
    this.service = new WorkbenchService({ store: new JsonFileStore(this.statePath) })
    this.tokensFile = config.tokensFile ?? process.env.DSH_MNDT_TOKENS_FILE
    this.proxyUserHeader = config.proxyUserHeader ?? process.env.DSH_MNDT_PROXY_USER_HEADER
    this.identity = (config.identity ?? process.env.DSH_MNDT_IDENTITY ?? config.localOwner ?? process.env.DSH_MNDT_LOCAL_OWNER ?? 'local').toLowerCase()
    const baseUrl = process.env.DSH_MNDT_AUTHORITY ?? config.authority?.baseUrl
    const token = process.env.DSH_MNDT_AUTHORITY_TOKEN ?? config.authority?.token
    // Who holds which role: the team authority when one is configured, else the
    // tenant's own role file, else the local owner alone (solo mode).
    const grantsFile = process.env.DSH_MNDT_GRANTS_FILE
    this.grants = baseUrl !== undefined && baseUrl !== '' && token !== undefined
      ? authorityGrants({ baseUrl, token })
      : grantsFile !== undefined && grantsFile !== ''
        ? fileGrants(grantsFile)
        : localGrants(config.localOwner ?? process.env.DSH_MNDT_LOCAL_OWNER ?? this.identity)

    this.#scheduleAutomations(ctx)
    this.#reconcileInterrupted(ctx)

    const port = config.port ?? (process.env.DSH_MNDT_PORT === undefined ? undefined : Number(process.env.DSH_MNDT_PORT))
    if (port === undefined || !Number.isFinite(port)) return
    // The composition may pin the bind address; otherwise the deployment names it
    // through the environment, which is what a container needs.
    const host = config.host ?? process.env.DSH_MNDT_HOST
    const runner = this.missionRunner(ctx)
    // Agent turns of mentions: the price grid is the adapters lane's
    // deploy/llm/prices.json, copied beside the state (or MNDT_PRICES_FILE);
    // a model without a price, or priced null, is refused, never free.
    const turns = new TurnScheduler({
      service: this.service,
      engine: new DshTurnRunner(ctx),
      prices: readPrices(process.env.MNDT_PRICES_FILE ?? join(dirname(this.statePath), 'prices.json')),
      dataDir: dirname(this.statePath),
    })
    // The front gateway's secret, from a file outside /state (DSH_MNDT_GATEWAY_SECRET_FILE):
    // without it, the API never believes the proxy's identity header.
    const gatewaySecret = readGatewaySecret(process.env.DSH_MNDT_GATEWAY_SECRET_FILE)
    if (this.proxyUserHeader !== undefined && gatewaySecret === undefined) {
      ctx.logger.warn('mndt: no gateway secret (DSH_MNDT_GATEWAY_SECRET_FILE): the proxy identity header is refused, every person reads 401')
    }
    const ready = (this.tokensFile === undefined ? Promise.resolve({}) : loadTokens(this.tokensFile)).then(tokens =>
      startMndtApi({
        service: this.service,
        runner,
        identity: {
          tokens,
          ...(this.proxyUserHeader === undefined ? {} : { proxyUserHeader: this.proxyUserHeader }),
          ...(gatewaySecret === undefined ? {} : { gatewaySecret }),
        },
        grants: this.grants,
        schedulePath: this.schedulePath,
        automationsPath: this.automationsPath,
        ...(process.env.MNDT_MACHINES_URL === undefined || process.env.MACHINES_TOKEN === undefined
          ? {}
          : { machines: { baseUrl: process.env.MNDT_MACHINES_URL, token: process.env.MACHINES_TOKEN } }),
        ...(baseUrl === undefined || baseUrl === '' || token === undefined ? {} : { authority: { baseUrl, token } }),
        connectors: () => Promise.resolve(this.connectorRows()),
        turns,
        ...(process.env.DSH_MNDT_ORG_SLUG === undefined || process.env.DSH_MNDT_ORG_SLUG === ''
          ? {}
          : {
            org: {
              name: process.env.DSH_MNDT_ORG_NAME ?? process.env.DSH_MNDT_ORG_SLUG,
              slug: process.env.DSH_MNDT_ORG_SLUG,
              ...(process.env.DSH_MNDT_ENV === undefined || process.env.DSH_MNDT_ENV === '' ? {} : { env: process.env.DSH_MNDT_ENV }),
            },
          }),
        port,
        ...(host === undefined || host === '' ? {} : { host }),
      }),
    )
    ctx.effect(() => {
      let server: { close(callback?: (error?: Error) => void): void } | undefined
      void ready.then((started) => { server = started }).catch((error: unknown) => {
        ctx.logger.error(`mndt: the API did not start: ${error instanceof Error ? error.message : String(error)}`)
      })
      return () => { server?.close() }
    }, 'mndt: product API')
  }

  /**
   * Mark missions left `running` by a previous process as failed.
   *
   * A workbench restart kills the agent turn that owned the mission, so nothing
   * will ever finish it. Leaving it running would let the page show work that is
   * not happening: the mission is failed with the reason that actually occurred.
   * @param ctx - the host context, used for the log line.
   */
  #reconcileInterrupted(ctx: Context): void {
    void (async () => {
      try {
        const stuck = await this.service.listMissions({ status: 'running' })
        for (const mission of stuck) {
          await this.service.failMission(mission.id, 'interrupted by a workbench restart; no result was produced')
        }
        if (stuck.length > 0) {
          ctx.logger.warn(`mndt: ${stuck.length} mission(s) left running by a previous process were marked failed`)
        }
      } catch (error) {
        ctx.logger.error(`mndt: could not reconcile interrupted missions: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  }

  /**
   * Run the scheduled automations.
   *
   * The registry is read at every tick, so a change made from the page needs no
   * restart and survives one. A run already in flight for an item is never
   * doubled. Three failures in a row suspend the item, with the reason kept in
   * the registry for the page to show.
   * @param ctx - the host context, which owns the timer lifecycle and the runner.
   */
  #scheduleAutomations(ctx: Context): void {
    const running = new Set<string>()
    const every = Number(process.env.DSH_MNDT_BRIEFING_EVERY_MS ?? Number.NaN)
    const legacyAt = process.env.DSH_MNDT_BRIEFING_AT
    const persist = async (patch: (item: Automation) => Automation): Promise<void> => {
      const current = await readAutomations(this.automationsPath, legacyAt)
      await writeAutomations(this.automationsPath, current.map(patch))
    }
    const fire = (item: Automation): void => {
      running.add(item.id)
      void (async () => {
        try {
          const outcome = await runAutomation(this.service, this.missionRunner(ctx), item)
          const failures = outcome.outcome === 'done' ? 0 : (item.failures ?? 0) + 1
          const patch: Partial<Automation> = {
            lastMissionId: outcome.missionId,
            lastOutcome: outcome.outcome,
            failures,
            ...(failures >= 3 ? { enabled: false } : {}),
          }
          await persist(candidate => (candidate.id === item.id ? { ...candidate, ...patch } : candidate))
          if (outcome.outcome === 'done') ctx.logger.info(`mndt: automation ${item.id} done as ${outcome.missionId}`)
          else ctx.logger.error(`mndt: automation ${item.id} ${outcome.outcome}`)
        } catch (error) {
          ctx.logger.error(`mndt: automation ${item.id} could not run: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          running.delete(item.id)
        }
      })()
    }
    const tick = (): void => {
      void (async () => {
        try {
          let items = await readAutomations(this.automationsPath, legacyAt)
          if (Number.isFinite(every) && every > 0) {
            const minutes = Math.max(1, Math.round(every / 60_000))
            if (!items.some(item => item.id === 'auto_briefing' && item.everyMinutes === minutes)) {
              await writeAutomations(this.automationsPath, items.map(item => item.id === 'auto_briefing' ? { ...item, everyMinutes: minutes, enabled: true } : item))
              items = await readAutomations(this.automationsPath, legacyAt)
            }
          }
          const now = new Date()
          for (const item of dueAutomations(items, now)) {
            if (running.has(item.id)) continue
            await persist(candidate => (candidate.id === item.id ? { ...candidate, ...firedFields(now) } : candidate))
            fire(item)
          }
        } catch (error) {
          ctx.logger.warn(`mndt: could not read the automations: ${error instanceof Error ? error.message : String(error)}`)
        }
      })()
    }
    ctx.effect(() => {
      const handle = setInterval(tick, 30_000)
      tick()
      return () => { clearInterval(handle) }
    }, 'mndt: scheduled automations')
  }

  /** @returns the mounted MCP connectors. */
  private connectorRows(): { module: string; server: string; enabled: boolean }[] {
    const rows: { module: string; server: string; enabled: boolean }[] = []
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.group !== undefined) continue
      const module = entry.options.name
      if (!module.includes('mcp-client')) continue
      const config: unknown = entry.options.config
      const server = typeof config === 'object' && config !== null && 'serverName' in config
        && typeof (config as { serverName?: unknown }).serverName === 'string'
        ? (config as { serverName: string }).serverName
        : module
      rows.push({ module, server, enabled: !entry.disabled })
    }
    return rows.sort((a, b) => a.server.localeCompare(b.server))
  }

  /** @param capability - what an action needs. @returns whether this workstation may do it. */
  private async allowed(capability: 'workflows.write' | 'rights.write' | 'agents.write'): Promise<{ allowed: boolean; reason: string }> {
    const table = await this.grants.grants()
    if (!table.ok) return { allowed: false, reason: `cannot read the grant table: ${table.reason}` }
    return can(table.grants, this.identity, capability)
  }

  /**
   * On a team workbench (several people behind single sign-on), every person
   * reaches the same shell, so this Remote would act as the workstation's
   * identity for anyone: read everything, decide a card, run a mission as the
   * owner. There, the product API serves each person under their own identity,
   * and the Remote is closed. A workstation of one person keeps it.
   * @returns the refusal, as the Remote's JSON answer, or undefined when open.
   */
  /**
   * @param ctx - the host context.
   * @returns the mission runner: on a team instance, its agent gets the team's
   * allow-list (MCP tools only), never the engine's shell, files, web or subagents.
   */
  private missionRunner(ctx: Context): DshMissionRunner {
    return new DshMissionRunner(ctx, this.proxyUserHeader === undefined || this.proxyUserHeader === '' ? {} : { tools: TEAM_MISSION_POLICY })
  }

  private closedToTeam(): string | undefined {
    return teamRemoteRefusal(this.proxyUserHeader)
  }

  /** @returns everything the morning page shows, as JSON. */
  @Remote('state')
  async state(): Promise<string> {
    const closed = this.closedToTeam()
    if (closed !== undefined) return closed
    try {
      const snapshot = await this.service.snapshot()
      const table = await this.grants.grants()
      const decision = table.ok ? can(table.grants, this.identity, 'workflows.write') : { allowed: false, reason: table.reason }
      const role = table.ok ? roleOf(table.grants, this.identity) : undefined
      const page: PageState = {
        you: this.identity,
        canWrite: decision.allowed,
        ...(role === undefined ? {} : { role }),
        canAdmin: table.ok && can(table.grants, this.identity, 'rights.write').allowed,
        canShare: table.ok && can(table.grants, this.identity, 'sharing.write').allowed,
        missions: snapshot.missions.slice(0, 30),
        briefs: snapshot.briefs.slice(0, 30),
        approvals: snapshot.approvals.filter(approval => approval.state === 'pending'),
        memories: snapshot.memories.slice(0, 20),
        events: snapshot.events.slice(-40),
        mandates: snapshot.mandates,
      }
      return JSON.stringify({ ok: true, page })
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Run one mission for real.
   * @param kind - what the mission is.
   * @param prompt - the instruction as the person wrote it.
   * @returns the finished mission and its brief, or the reason it failed.
   */
  @Remote('runMission')
  async runMission(kind: MissionKind, prompt: string): Promise<string> {
    const closed = this.closedToTeam()
    if (closed !== undefined) return closed
    const decision = await this.allowed('workflows.write')
    if (!decision.allowed) return JSON.stringify({ ok: false, error: decision.reason })
    let mission: Mission
    try {
      mission = await this.service.createMission({ kind, prompt, createdBy: this.identity })
      await this.service.startMission(mission.id, 'page')
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
    try {
      const result = await this.missionRunner(this.ctx).run(mission)
      const finished = await this.service.completeMission(mission.id, result)
      return JSON.stringify({ ok: true, value: finished })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await this.service.failMission(mission.id, reason).catch(() => undefined)
      const stored = await this.service.getMission(mission.id)
      return JSON.stringify({ ok: false, error: reason, ...(stored === undefined ? {} : { value: { mission: stored } }) })
    }
  }

  /**
   * Search the whole state, not only the loaded page.
   * @param query - the search text.
   * @returns the matching rows, as JSON.
   */
  @Remote('search')
  async search(query: string): Promise<string> {
    const closed = this.closedToTeam()
    if (closed !== undefined) return closed
    try {
      const snapshot = await this.service.snapshot()
      const table = await this.grants.grants()
      const canAdmin = table.ok && can(table.grants, this.identity, 'rights.write').allowed
      return JSON.stringify({ ok: true, value: { hits: searchState(snapshot, this.identity, canAdmin, query, () => true) } })
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Stop a waiting mission.
   * @param id - the mission.
   * @returns the cancelled mission, or the reason it was refused.
   */
  @Remote('cancelMission')
  async cancelMission(id: string): Promise<string> {
    const closed = this.closedToTeam()
    if (closed !== undefined) return closed
    const decision = await this.allowed('workflows.write')
    if (!decision.allowed) return JSON.stringify({ ok: false, error: decision.reason })
    const rights = await this.allowed('rights.write')
    try {
      return JSON.stringify({ ok: true, value: await this.service.cancelMission(id, this.identity, rights.allowed) })
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Run a failed mission again.
   * @param id - the mission to repeat.
   * @returns the new mission and its brief, or the reason it failed.
   */
  @Remote('retryMission')
  async retryMission(id: string): Promise<string> {
    const closed = this.closedToTeam()
    if (closed !== undefined) return closed
    const decision = await this.allowed('workflows.write')
    if (!decision.allowed) return JSON.stringify({ ok: false, error: decision.reason })
    let mission: Mission
    try {
      mission = await this.service.retryMission(id, this.identity)
      await this.service.startMission(mission.id, 'page')
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
    try {
      const result = await this.missionRunner(this.ctx).run(mission)
      return JSON.stringify({ ok: true, value: await this.service.completeMission(mission.id, result) })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await this.service.failMission(mission.id, reason).catch(() => undefined)
      return JSON.stringify({ ok: false, error: reason })
    }
  }

  /**
   * Approve or refuse a brief.
   * @param briefId - the brief.
   * @returns the updated brief, or the reason it was refused.
   */
  @Remote('approveBrief')
  async approveBrief(briefId: string): Promise<string> {
    const closed = this.closedToTeam()
    if (closed !== undefined) return closed
    const decision = await this.allowed('workflows.write')
    if (!decision.allowed) return JSON.stringify({ ok: false, error: decision.reason })
    try {
      return JSON.stringify({ ok: true, value: await this.service.approveBrief(briefId, this.identity) })
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Decide a pending approval.
   * @param approvalId - the approval.
   * @param decision - approved or rejected.
   * @param reason - why, when rejected.
   * @returns the decided approval.
   */
  @Remote('decide')
  async decide(approvalId: string, decision: ApprovalState, reason?: string): Promise<string> {
    const closed = this.closedToTeam()
    if (closed !== undefined) return closed
    const allowed = await this.allowed('rights.write')
    if (!allowed.allowed) return JSON.stringify({ ok: false, error: allowed.reason })
    try {
      return JSON.stringify({ ok: true, value: await this.service.decideApproval(approvalId, this.identity, decision, reason) })
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Keep a note for later.
   * @param scope - team, user or mission.
   * @param kind - fact, decision or preference.
   * @param text - the note.
   * @returns the stored note.
   */
  @Remote('remember')
  async remember(scope: 'team' | 'user' | 'mission', kind: 'fact' | 'decision' | 'preference', text: string): Promise<string> {
    const closed = this.closedToTeam()
    if (closed !== undefined) return closed
    const allowed = await this.allowed('agents.write')
    if (!allowed.allowed) return JSON.stringify({ ok: false, error: allowed.reason })
    try {
      return JSON.stringify({ ok: true, value: await this.service.remember({ scope, kind, text, createdBy: this.identity }) })
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** @returns the mounted MCP connectors, for the connectors surface. */
  @Remote('connectors')
  connectors(): { module: string; server: string; enabled: boolean }[] {
    return this.connectorRows()
  }
}

/**
 * @param path - the price grid file.
 * @returns the grid; without a file, an empty grid (every turn refused, with its reason).
 */
function readPrices(path: string): PriceGrid {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return {}
    throw error
  }
  return parsePrices(text)
}
