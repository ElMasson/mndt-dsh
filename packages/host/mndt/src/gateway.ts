/**
 * The browser's way into the product.
 *
 * Every method answers a value, never a thrown error: a page can then show the
 * real reason instead of an empty list. The gateway owns the one workbench
 * service, so the page and the HTTP face never disagree about the state, and it
 * starts the HTTP face only when the deployment gives it a port.
 */
import { join, dirname } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
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
import { authorityGrants, localGrants } from './grants.ts'
import { DshMissionRunner } from './runner.ts'

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

  /**
   * @param ctx - owning context.
   * @param config - deployment configuration.
   */
  constructor(ctx: Context, config: MndtConfig = {}) {
    super(ctx, 'mndt')
    this.statePath = config.statePath ?? process.env.DSH_MNDT_STATE ?? join(homedir(), '.dsh', 'mndt', 'state.json')
    this.schedulePath = join(dirname(this.statePath), 'briefing-schedule.json')
    this.service = new WorkbenchService({ store: new JsonFileStore(this.statePath) })
    this.tokensFile = config.tokensFile ?? process.env.DSH_MNDT_TOKENS_FILE
    this.proxyUserHeader = config.proxyUserHeader ?? process.env.DSH_MNDT_PROXY_USER_HEADER
    this.identity = (config.identity ?? process.env.DSH_MNDT_IDENTITY ?? config.localOwner ?? process.env.DSH_MNDT_LOCAL_OWNER ?? 'local').toLowerCase()
    const baseUrl = process.env.DSH_MNDT_AUTHORITY ?? config.authority?.baseUrl
    const token = process.env.DSH_MNDT_AUTHORITY_TOKEN ?? config.authority?.token
    this.grants = baseUrl !== undefined && baseUrl !== '' && token !== undefined
      ? authorityGrants({ baseUrl, token })
      : localGrants(config.localOwner ?? process.env.DSH_MNDT_LOCAL_OWNER ?? this.identity)

    this.#scheduleBriefing(ctx)
    this.#reconcileInterrupted(ctx)

    const port = config.port ?? (process.env.DSH_MNDT_PORT === undefined ? undefined : Number(process.env.DSH_MNDT_PORT))
    if (port === undefined || !Number.isFinite(port)) return
    // The composition may pin the bind address; otherwise the deployment names it
    // through the environment, which is what a container needs.
    const host = config.host ?? process.env.DSH_MNDT_HOST
    const runner = new DshMissionRunner(ctx)
    const ready = (this.tokensFile === undefined ? Promise.resolve({}) : loadTokens(this.tokensFile)).then(tokens =>
      startMndtApi({
        service: this.service,
        runner,
        identity: { tokens, ...(this.proxyUserHeader === undefined ? {} : { proxyUserHeader: this.proxyUserHeader }) },
        grants: this.grants,
        schedulePath: this.schedulePath,
        ...(baseUrl === undefined || baseUrl === '' || token === undefined ? {} : { authority: { baseUrl, token } }),
        connectors: () => Promise.resolve(this.connectorRows()),
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
   * Run the morning briefing on a schedule.
   *
   * The hour is read from a small file the page can edit, so a change needs no
   * deploy and survives a restart. A run already in flight is never doubled.
   * `DSH_MNDT_BRIEFING_EVERY_MS` keeps a fixed interval for proving the path
   * quickly; the daily hour is what runs in production.
   * @param ctx - the host context, which owns the timer lifecycle.
   */
  #scheduleBriefing(ctx: Context): void {
    const every = Number(process.env.DSH_MNDT_BRIEFING_EVERY_MS ?? Number.NaN)
    const envAt = process.env.DSH_MNDT_BRIEFING_AT
    let running = false
    const fire = (): void => {
      if (running) return
      running = true
      void (async () => {
        try {
          const mission = await this.service.createMission({
            kind: 'briefing',
            prompt: 'Briefing du matin : agenda, courriers sans réponse, comptes à risque, échéances, réunions du jour. '
              + 'Consulte les outils de lecture des connecteurs montés, par exemple Attio et Office365 en lecture, et cite ce que tu lis réellement. '
              + 'Si une rubrique n\'a aucune source accessible, dis-le au lieu de l\'inventer.',
            createdBy: 'scheduler',
          })
          await this.service.startMission(mission.id, 'scheduled')
          try {
            const outcome = await new DshMissionRunner(ctx).run(mission)
            await this.service.completeMission(mission.id, outcome)
            ctx.logger.info(`mndt: scheduled briefing ${mission.id} done`)
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            await this.service.failMission(mission.id, reason).catch(() => undefined)
            ctx.logger.error(`mndt: scheduled briefing failed: ${reason}`)
          }
        } finally {
          running = false
        }
      })()
    }
    ctx.effect(() => {
      if (Number.isFinite(every)) {
        const handle = setInterval(fire, every)
        return () => { clearInterval(handle) }
      }
      // Poll once a minute: the file may change at any time, including while the
      // workbench is running, and a restart must keep honouring it.
      if (envAt === undefined) {
        void readFile(this.schedulePath, 'utf8').catch(() => undefined)
      }
      const tick = (): void => {
        void (async () => {
          try {
            const raw = await readFile(this.schedulePath, 'utf8').catch(() => '')
            let record: { at?: unknown; lastFiredDate?: unknown } = {}
            if (raw.trim() !== '') record = JSON.parse(raw) as typeof record
            const at = typeof record.at === 'string' ? record.at : envAt
            if (typeof at !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) return
            const now = new Date()
            const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
            const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
            if (clock !== at || record.lastFiredDate === today) return
            await writeFile(this.schedulePath, JSON.stringify({ at, lastFiredDate: today }), 'utf8')
            fire()
          } catch (error) {
            ctx.logger.warn(`mndt: could not read the briefing schedule: ${error instanceof Error ? error.message : String(error)}`)
          }
        })()
      }
      const handle = setInterval(tick, 30_000)
      tick()
      return () => { clearInterval(handle) }
    }, 'mndt: scheduled briefing')
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

  /** @returns everything the morning page shows, as JSON. */
  @Remote('state')
  async state(): Promise<string> {
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
      const result = await new DshMissionRunner(this.ctx).run(mission)
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
   * Approve or refuse a brief.
   * @param briefId - the brief.
   * @returns the updated brief, or the reason it was refused.
   */
  @Remote('approveBrief')
  async approveBrief(briefId: string): Promise<string> {
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
