/**
 * The browser's way into the product.
 *
 * Every method answers a value, never a thrown error: a page can then show the
 * real reason instead of an empty list. The gateway owns the one workbench
 * service, so the page and the HTTP face never disagree about the state, and it
 * starts the HTTP face only when the deployment gives it a port.
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import { JsonFileStore, WorkbenchService } from './core/index.ts'
import type { ApprovalState, MissionKind } from './core/index.ts'
import type { Approval, Brief, MemoryNote, Mission, Outcome, PageState, RunOutcome } from './types.ts'
import type {} from '@deepseek-ai/cordis-plugin-loader'
// Type-only: pulls the agents service and the session/workflow event maps.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workflow'
import { startMndtApi } from './api.ts'
import { loadTokens } from './identity.ts'
import type { GrantSource } from './policy.ts'
import { can } from './policy.ts'
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
  readonly #tokensFile: string | undefined
  readonly #proxyUserHeader: string | undefined
  readonly #identity: string
  readonly #grants: GrantSource
  readonly #statePath: string

  /**
   * @param ctx - owning context.
   * @param config - deployment configuration.
   */
  constructor(ctx: Context, config: MndtConfig = {}) {
    super(ctx, 'mndt')
    this.#statePath = config.statePath ?? process.env.DSH_MNDT_STATE ?? join(homedir(), '.dsh', 'mndt', 'state.json')
    this.service = new WorkbenchService({ store: new JsonFileStore(this.#statePath) })
    this.#tokensFile = config.tokensFile ?? process.env.DSH_MNDT_TOKENS_FILE
    this.#proxyUserHeader = config.proxyUserHeader ?? process.env.DSH_MNDT_PROXY_USER_HEADER
    this.#identity = (config.identity ?? process.env.DSH_MNDT_IDENTITY ?? config.localOwner ?? process.env.DSH_MNDT_LOCAL_OWNER ?? 'local').toLowerCase()
    const baseUrl = process.env.DSH_MNDT_AUTHORITY ?? config.authority?.baseUrl
    const token = process.env.DSH_MNDT_AUTHORITY_TOKEN ?? config.authority?.token
    this.#grants = baseUrl !== undefined && baseUrl !== '' && token !== undefined
      ? authorityGrants({ baseUrl, token })
      : localGrants(config.localOwner ?? process.env.DSH_MNDT_LOCAL_OWNER ?? this.#identity)

    const port = config.port ?? (process.env.DSH_MNDT_PORT === undefined ? undefined : Number(process.env.DSH_MNDT_PORT))
    if (port === undefined || !Number.isFinite(port)) return
    const runner = new DshMissionRunner(ctx)
    const ready = (this.#tokensFile === undefined ? Promise.resolve({}) : loadTokens(this.#tokensFile)).then(tokens =>
      startMndtApi({
        service: this.service,
        runner,
        identity: { tokens, ...(this.#proxyUserHeader === undefined ? {} : { proxyUserHeader: this.#proxyUserHeader }) },
        grants: this.#grants,
        connectors: () => Promise.resolve(this.connectorRows()),
        port,
        ...(config.host === undefined ? {} : { host: config.host }),
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
    const table = await this.#grants.grants()
    if (!table.ok) return { allowed: false, reason: `cannot read the grant table: ${table.reason}` }
    return can(table.grants, this.#identity, capability)
  }

  /** @returns everything the morning page shows. */
  @Remote('state')
  async state(): Promise<PageState> {
    const snapshot = await this.service.snapshot()
    const table = await this.#grants.grants()
    const decision = table.ok ? can(table.grants, this.#identity, 'workflows.write') : { allowed: false, reason: table.reason }
    return {
      you: this.#identity,
      canWrite: decision.allowed,
      missions: snapshot.missions.slice(0, 30),
      briefs: snapshot.briefs.slice(0, 30),
      approvals: snapshot.approvals.filter(approval => approval.state === 'pending'),
      memories: snapshot.memories.slice(0, 20),
      events: snapshot.events.slice(-40),
    }
  }

  /**
   * Run one mission for real.
   * @param kind - what the mission is.
   * @param prompt - the instruction as the person wrote it.
   * @returns the finished mission and its brief, or the reason it failed.
   */
  @Remote('runMission')
  async runMission(kind: MissionKind, prompt: string): Promise<Outcome<RunOutcome>> {
    const decision = await this.allowed('workflows.write')
    if (!decision.allowed) return { ok: false, error: decision.reason }
    let mission: Mission
    try {
      mission = await this.service.createMission({ kind, prompt, createdBy: this.#identity })
      await this.service.startMission(mission.id, 'page')
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    try {
      const result = await new DshMissionRunner(this.ctx).run(mission)
      const finished = await this.service.completeMission(mission.id, result)
      return { ok: true, value: finished }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await this.service.failMission(mission.id, reason).catch(() => undefined)
      const stored = await this.service.getMission(mission.id)
      return { ok: false, error: reason, ...(stored === undefined ? {} : { value: { mission: stored } }) }
    }
  }

  /**
   * Approve or refuse a brief.
   * @param briefId - the brief.
   * @returns the updated brief, or the reason it was refused.
   */
  @Remote('approveBrief')
  async approveBrief(briefId: string): Promise<Outcome<Brief>> {
    const decision = await this.allowed('workflows.write')
    if (!decision.allowed) return { ok: false, error: decision.reason }
    try {
      return { ok: true, value: await this.service.approveBrief(briefId, this.#identity) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
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
  async decide(approvalId: string, decision: ApprovalState, reason?: string): Promise<Outcome<Approval>> {
    const allowed = await this.allowed('rights.write')
    if (!allowed.allowed) return { ok: false, error: allowed.reason }
    try {
      return { ok: true, value: await this.service.decideApproval(approvalId, this.#identity, decision, reason) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
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
  async remember(scope: 'team' | 'user' | 'mission', kind: 'fact' | 'decision' | 'preference', text: string): Promise<Outcome<MemoryNote>> {
    const allowed = await this.allowed('agents.write')
    if (!allowed.allowed) return { ok: false, error: allowed.reason }
    try {
      return { ok: true, value: await this.service.remember({ scope, kind, text, createdBy: this.#identity }) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** @returns the mounted MCP connectors, for the connectors surface. */
  @Remote('connectors')
  connectors(): { module: string; server: string; enabled: boolean }[] {
    return this.connectorRows()
  }
}
