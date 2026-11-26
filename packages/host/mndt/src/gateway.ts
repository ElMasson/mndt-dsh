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
import { instanceTimeZone, JsonFileStore, WorkbenchService } from './core/index.ts'
import { reconcileInterrupted } from './reconcile.ts'
import type { ApprovalState, MissionKind } from './core/index.ts'
import type { Mission, PageState } from './types.ts'
import type {} from '@deepseek-ai/cordis-plugin-loader'
// Type-only: pulls the agents service and the session/workflow event maps.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workflow'
import { GRANTS_UNREADABLE, startMndtApi } from './api.ts'
import type { ModelChoice } from './api.ts'
import { loadTokens } from './identity.ts'
import type { GrantSource } from './policy.ts'
import { can, roleOf } from './policy.ts'
import { searchState } from './search.ts'
import { authorityGrants, fileGrants, localGrants } from './grants.ts'
import { DshMissionRunner, DshTurnRunner, toolsReadinessOf } from './runner.ts'
import type { ToolsReadiness } from './tools-ready.ts'
import { TEAM_MISSION_POLICY } from './tool-policy.ts'
import { canReadMission } from './visibility.ts'
import { TurnScheduler } from './turns.ts'
import { existsSync, readFileSync } from 'node:fs'
import { parsePrices } from './core/index.ts'
import type { PriceGrid } from './core/index.ts'
import { defaultAutomations, dueAutomations, firedFields, readAutomations, runAutomation, writeAutomations } from './automations.ts'
import type { Automation } from './automations.ts'
import { clearOperatorWarning, errorShape, warnOperator, warnOperatorOnce } from './operator-log.ts'
import { publicFailure } from './public-failure.ts'

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
 * @param dataDir - the space's data root (beside state.json).
 * @returns whether a server is configured for this space: its descriptor,
 * written by mount-connector.sh, is in <dataDir>/connectors. Read at each call.
 * Consulted on a declared solo workstation only (see requiredConfigured).
 */
export function configuredInSpace(dataDir: string): (server: string) => boolean {
  return server => existsSync(join(dataDir, 'connectors', `${server}.json`))
}

/**
 * @param proxyUserHeader - the proxy's identity header, if any.
 * @param dataDir - the space's data root.
 * @param env - the environment (DSH_MNDT_SOLO_WORKSTATION).
 * @returns whether a required server (approvals, the facts of a briefing) is
 * required: on a declared solo workstation, only when its space configures it;
 * anywhere else, always (a missing descriptor never lifts it).
 */
export function requiredServersRule(
  proxyUserHeader: string | undefined, dataDir: string, env: NodeJS.ProcessEnv = process.env,
): (server: string) => boolean {
  return soloWorkstation(proxyUserHeader, env) ? configuredInSpace(dataDir) : () => true
}

/**
 * @param proxyUserHeader - the header the proxy proves the person with, if any.
 * @param env - the environment.
 * @returns whether missions may use the engine's whole composition: only on a
 * host explicitly declared solo, and never behind the sign-on proxy.
 */
export function soloWorkstation(proxyUserHeader: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (proxyUserHeader !== undefined && proxyUserHeader !== '') return false
  return env.DSH_MNDT_SOLO_WORKSTATION === '1'
}

/**
 * The owners of a team instance: every subject the role table names owner.
 * The API and the scheduler read the same rule (any owner).
 * @param grants - the role table.
 * @returns the owners, lowercase.
 */
export function ownersOf(grants: readonly { readonly subject: string; readonly role: string }[]): ReadonlySet<string> {
  return new Set(grants.filter(grant => grant.role === 'owner').map(grant => grant.subject.toLowerCase()))
}

/**
 * @param item - an automation.
 * @param team - whether this is a team instance.
 * @param owners - the owners of the team instance.
 * @returns why the scheduler may not run it, or undefined when it may: on a team
 * instance, only the system's automations and an owner's, once an owner enabled
 * them (`enabledBy`, written by the server). The reason says what to do.
 */
export function automationRefusal(item: Automation, team: boolean, owners: ReadonlySet<string>): string | undefined {
  if (!team) return undefined
  const author = item.createdBy.toLowerCase()
  if (item.createdBy === 'scheduler') {
    // A system automation runs as shipped, or once an owner saved it (it is then
    // theirs). An admin could change its prompt before #63: a prompt that is not
    // the code's runs only after an owner read it and saved it.
    // Every field that steers the run is compared, the schedule aside: the prompt,
    // the kind (the mission's framing) and the mandate it would run under.
    const shipped = defaultAutomations().find(candidate => candidate.id === item.id)
    if (shipped === undefined || shipped.prompt !== item.prompt || shipped.kind !== item.kind || item.mandateId !== undefined) {
      return 'disabled: it is not as shipped (prompt, kind or mandate); on a team instance an owner reads it, saves it, then enables it'
    }
  } else if (!owners.has(author)) {
    return `disabled: created by ${item.createdBy}; on a team instance an owner opens it, checks its prompt and saves it to take it over, then enables it`
  }
  if (item.enabledBy === undefined || !owners.has(item.enabledBy.toLowerCase())) {
    return 'disabled: on a team instance an owner checks its prompt and enables it'
  }
  return undefined
}

/**
 * Whether the workstation Remote is closed. Closed by default: it serves one
 * person's workstation, so it opens only on a host declared solo
 * (DSH_MNDT_SOLO_WORKSTATION=1, see soloWorkstation), never behind the sign-on
 * proxy, where the product API serves each person under their own identity. A
 * missing or mistyped setting closes it rather than opening it to a team.
 * @param proxyUserHeader - the header the proxy proves the person with, if any.
 * @param env - the environment.
 * @returns the Remote's JSON refusal, or undefined when the Remote is open.
 */
export function teamRemoteRefusal(proxyUserHeader: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (soloWorkstation(proxyUserHeader, env)) return undefined
  const team = proxyUserHeader !== undefined && proxyUserHeader !== ''
  return JSON.stringify({
    ok: false,
    error: team
      ? 'on a team workbench the product API (/mndt-api) serves each person under their own identity; the workstation Remote is closed'
      : 'the workstation Remote is closed unless this host is declared solo: set DSH_MNDT_SOLO_WORKSTATION=1',
  })
}

/**
 * Keep the product API for the life of its plugin, and not one moment longer.
 *
 * Its start waits for the reconciliation and the tokens: a plugin unloaded
 * before the server listens must still close it once it does. Left open, it
 * would keep serving the state of an unloaded instance, whose scheduler is
 * gone, and hold the port its successor needs. A start that fails is said.
 * @param ready - the server, once it listens.
 * @param warn - the operator's line.
 * @returns the disposer the plugin's effect runs when it unloads.
 */
export function serveUntilUnloaded(
  ready: Promise<{ close(callback?: (error?: Error) => void): void }>,
  warn: (message: string) => void,
): () => void {
  let server: { close(callback?: (error?: Error) => void): void } | undefined
  let unloaded = false
  void ready.then((started) => {
    if (unloaded) {
      started.close()
      warn('mndt: the product API started after its plugin was unloaded: closed at once')
      return
    }
    server = started
  }).catch((error: unknown) => {
    warn(`mndt: the API did not start: ${errorShape(error)}`)
  })
  return () => {
    unloaded = true
    server?.close()
  }
}

export class WorkbenchGateway extends TypertRemoteService {
  /** Services read here: the agent runtime and the Loader's connector entries. */
  static inject = ['agents', 'loader']

  readonly service: WorkbenchService
  private readonly tokensFile: string | undefined
  private readonly proxyUserHeader: string | undefined
  private readonly identity: string
  private readonly grants: GrantSource
  /** Where the roles come from: see PageState.rolesFrom. */
  private readonly rolesFrom: 'authority' | 'file' | 'local'
  private readonly statePath: string
  /** Where the editable briefing schedule lives; the API writes it, the poller reads it. */
  private readonly schedulePath: string
  /** The automation registry: the poller reads it, the API writes it. */
  private readonly automationsPath: string

  /**
   * @param ctx - owning context.
   * @param config - deployment configuration.
   */
  /** When this process started: what a previous one left is older. */
  readonly #startedAt = new Date().toISOString()

  /**
   * When the automations' scheduler last made a pass (every 30 s), served on
   * GET /automations: a scheduler that stopped is read there, where nothing
   * else would say it.
   */
  #schedulerAt: string | undefined

  constructor(ctx: Context, config: MndtConfig = {}) {
    super(ctx, 'mndt')
    this.statePath = config.statePath ?? process.env.DSH_MNDT_STATE ?? join(homedir(), '.dsh', 'mndt', 'state.json')
    this.schedulePath = join(dirname(this.statePath), 'briefing-schedule.json')
    this.automationsPath = join(dirname(this.statePath), 'automations.json')
    this.tokensFile = config.tokensFile ?? process.env.DSH_MNDT_TOKENS_FILE
    this.proxyUserHeader = config.proxyUserHeader ?? process.env.DSH_MNDT_PROXY_USER_HEADER
    // Behind the proxy (a team instance), a finished briefing is published in the
    // lane of the one who ran it: the team page has no other place to read it.
    this.service = new WorkbenchService({
      store: new JsonFileStore(this.statePath),
      warn: (message) => { warnOperator(ctx, message) },
      briefingsInLane: this.proxyUserHeader !== undefined && this.proxyUserHeader !== '',
    })
    this.identity = (config.identity ?? process.env.DSH_MNDT_IDENTITY ?? config.localOwner ?? process.env.DSH_MNDT_LOCAL_OWNER ?? 'local').toLowerCase()
    const baseUrl = process.env.DSH_MNDT_AUTHORITY ?? config.authority?.baseUrl
    const token = process.env.DSH_MNDT_AUTHORITY_TOKEN ?? config.authority?.token
    // Who holds which role: the team authority when one is configured, else the
    // tenant's own role file, else the local owner alone (solo mode).
    const grantsFile = process.env.DSH_MNDT_GRANTS_FILE
    this.rolesFrom = baseUrl !== undefined && baseUrl !== '' && token !== undefined
      ? 'authority'
      : grantsFile !== undefined && grantsFile !== '' ? 'file' : 'local'
    this.grants = baseUrl !== undefined && baseUrl !== '' && token !== undefined
      ? authorityGrants({ baseUrl, token }, (message) => { warnOperator(ctx, message) })
      : grantsFile !== undefined && grantsFile !== ''
        ? fileGrants(grantsFile, (message) => { warnOperator(ctx, message) })
        : localGrants(config.localOwner ?? process.env.DSH_MNDT_LOCAL_OWNER ?? this.identity)

    this.#scheduleAutomations(ctx)
    // What a previous process left unfinished is settled BEFORE the API opens,
    // and only what predates this start: a mention posted in the first seconds
    // is never cancelled as if it were left over.
    const reconciled = reconcileInterrupted(this.service, this.#startedAt,
      (message) => { warnOperator(ctx, message) }, (message) => { warnOperator(ctx, message) })

    const port = config.port ?? (process.env.DSH_MNDT_PORT === undefined ? undefined : Number(process.env.DSH_MNDT_PORT))
    if (port === undefined || !Number.isFinite(port)) return
    // The composition may pin the bind address; otherwise the deployment names it
    // through the environment, which is what a container needs.
    const host = config.host ?? process.env.DSH_MNDT_HOST
    const runner = this.missionRunner(ctx)
    // Agent turns of mentions: the price grid is the adapters lane's
    // deploy/llm/prices.json, copied beside the state (or MNDT_PRICES_FILE);
    // a model without a price, or priced null, is refused, never free.
    const prices = readPrices(process.env.MNDT_PRICES_FILE ?? join(dirname(this.statePath), 'prices.json'))
    const turns = new TurnScheduler({
      service: this.service,
      engine: new DshTurnRunner(ctx, this.readinessFor(ctx), this.requiredConfigured()),
      prices,
      dataDir: dirname(this.statePath),
      warn: (message) => { warnOperator(ctx, message) },
      timeZone: this.timeZoneFor(ctx),
    })
    // The front gateway's secret, from a file outside /state (DSH_MNDT_GATEWAY_SECRET_FILE):
    // without it, the API never believes the proxy's identity header.
    const gatewaySecret = readGatewaySecret(process.env.DSH_MNDT_GATEWAY_SECRET_FILE)
    if (this.proxyUserHeader !== undefined && gatewaySecret === undefined) {
      warnOperator(ctx, 'mndt: no gateway secret (DSH_MNDT_GATEWAY_SECRET_FILE): the proxy identity header is refused, every person reads 401')
    }
    const ready = reconciled.then(() => (this.tokensFile === undefined ? Promise.resolve({}) : loadTokens(this.tokensFile))).then(tokens =>
      startMndtApi({
        service: this.service,
        runner,
        identity: {
          tokens,
          ...(this.proxyUserHeader === undefined ? {} : { proxyUserHeader: this.proxyUserHeader }),
          ...(gatewaySecret === undefined ? {} : { gatewaySecret }),
        },
        grants: this.grants,
        // An internal fault of a route: its detail to the web log, never to the caller.
        warn: (message: string) => { warnOperator(ctx, message) },
        timeZone: this.timeZoneFor(ctx),
        schedulePath: this.schedulePath,
        automationsPath: this.automationsPath,
        schedulerAt: () => this.#schedulerAt,
        ...(process.env.MNDT_MACHINES_URL === undefined || process.env.MACHINES_TOKEN === undefined
          ? {}
          : { machines: { baseUrl: process.env.MNDT_MACHINES_URL, token: process.env.MACHINES_TOKEN } }),
        ...(this.rolesFrom === 'authority' && baseUrl !== undefined && token !== undefined
          ? { authority: { baseUrl, token } }
          : { rolesFrom: this.rolesFrom === 'file' ? 'file' as const : 'local' as const }),
        connectors: () => Promise.resolve(this.connectorRows()),
        models: () => Promise.resolve(modelChoices(prices, process.env.VLLM_QWEN_MODEL)),
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
    ctx.effect(() => serveUntilUnloaded(ready, (message) => { warnOperator(ctx, message) }), 'mndt: product API')
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
    const fire = (item: Automation, owner: string | undefined): void => {
      running.add(item.id)
      void (async () => {
        try {
          const outcome = await runAutomation(this.service, this.missionRunner(ctx), item, owner)
          const failures = outcome.outcome === 'done' ? 0 : (item.failures ?? 0) + 1
          const patch: Partial<Automation> = {
            lastMissionId: outcome.missionId,
            lastOutcome: outcome.outcome,
            failures,
            ...(failures >= 3 ? { enabled: false } : {}),
          }
          await persist(candidate => (candidate.id === item.id ? { ...candidate, ...patch } : candidate))
          // The outcome is the host's sentence (runAutomation), never a runtime's words.
          warnOperator(ctx, outcome.outcome === 'done'
            ? `mndt: automation ${item.id} done as ${outcome.missionId}`
            : `mndt: automation ${item.id} ${outcome.outcome} (${outcome.missionId})`)
        } catch (error) {
          warnOperator(ctx, `mndt: automation ${item.id} could not run: ${errorShape(error)}`)
        } finally {
          running.delete(item.id)
        }
      })()
    }
    const timeZone = this.timeZoneFor(ctx)
    // One line per start: two in one process would say the plugin was built twice.
    warnOperator(ctx, `mndt: automations scheduler started, zone ${timeZone}`)
    const tick = (): void => {
      // Its sign of life, first: a pass that fails later still says the scheduler runs.
      this.#schedulerAt = new Date().toISOString()
      // A reason that blocks every pass is said again each day, not only at start.
      const day = this.#schedulerAt.slice(0, 10)
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
          const team = this.proxyUserHeader !== undefined && this.proxyUserHeader !== ''
          const table = team ? await this.grants.grants() : undefined
          const owners = table?.ok === true ? ownersOf(table.grants) : new Set<string>()
          if (team && owners.size === 0) {
            // Without a readable owner nothing runs, and nothing is switched off either.
            // Said once, not at every pass of the tick (every 30 s).
            warnOperatorOnce(ctx, 'automations-owner', `mndt: automations skipped (${day}): the role table names no owner, or cannot be read`)
            return
          }
          clearOperatorWarning('automations-owner')
          if (team) {
            // On a team instance an automation runs once an owner enabled it. One
            // enabled otherwise (the deployment default auto_briefing included) is
            // switched off with its reason, so the page shows what runs and why not.
            const stray = items.filter(item => item.enabled && automationRefusal(item, true, owners) !== undefined)
            if (stray.length > 0) {
              await persist((candidate) => {
                const reason = stray.some(item => item.id === candidate.id) ? automationRefusal(candidate, true, owners) : undefined
                return reason === undefined ? candidate : { ...candidate, enabled: false, lastOutcome: reason }
              })
              for (const item of stray) warnOperator(ctx, `mndt: automation ${item.id} ${automationRefusal(item, true, owners) ?? 'disabled'}`)
              items = await readAutomations(this.automationsPath, legacyAt)
            }
          }
          for (const item of dueAutomations(items, now, timeZone)) {
            if (running.has(item.id)) {
              warnOperatorOnce(ctx, `automation-running-${item.id}`, `mndt: automation ${item.id} not started (${day}): its previous run is still going`)
              continue
            }
            await persist(candidate => (candidate.id === item.id ? { ...candidate, ...firedFields(now, timeZone) } : candidate))
            // The run is the owner's who enabled it (team), private.
            fire(item, team ? item.enabledBy?.toLowerCase() : undefined)
          }
          clearOperatorWarning('automations-read')
        } catch (error) {
          // Its shape only: a JSON error quotes the start of the file, a prompt.
          warnOperatorOnce(ctx, 'automations-read', `mndt: could not read the automations (${day}): ${errorShape(error)}`)
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
    if (!table.ok) return { allowed: false, reason: this.unreadableGrants(table.reason) }
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
   * @returns the mission runner. Its agent gets the team's allow-list (MCP tools
   * only, never the engine's shell, files, web or subagents) unless this host
   * is declared a solo workstation (DSH_MNDT_SOLO_WORKSTATION=1, refused on a
   * team instance): a missing or mistyped setting never opens the whole engine.
   */
  /**
   * @param reason - why the role table cannot be read (its file, row or code).
   * @returns what a machine tool's answer says of it: one sentence.
   */
  private unreadableGrants(reason: string): string {
    // Its file, row or code go to the operator's log, once per change of the reason.
    warnOperatorOnce(this.ctx, 'grants-unreadable', `mndt: the grant table cannot be read: ${reason}`)
    return GRANTS_UNREADABLE
  }

  /**
   * @param error - what failed under a machine tool.
   * @returns what its answer may say (public-failure.ts).
   */
  private publicError(error: unknown): string {
    return publicFailure(error, 'échec de l’opération', (line) => { warnOperator(this.ctx, line) }, 'a machine tool failed')
  }

  private missionRunner(ctx: Context): DshMissionRunner {
    const readiness = this.readinessFor(ctx)
    const configured = this.requiredConfigured()
    const timeZone = this.timeZoneFor(ctx)
    // Read at each mission: a facts server mounted later counts from its next briefing.
    // Unlike the approvals (required whatever is on disk), the descriptor's
    // disappearance LIFTS the facts' requirement: the runner says each such
    // passage once in the operator's log, and the mission records it.
    const factsConfigured = (): boolean => configuredInSpace(dirname(this.statePath))('workbench_facts')
    // What a mission cost, from the same grid as the turns' (read at each runner).
    const prices = readPrices(process.env.MNDT_PRICES_FILE ?? join(dirname(this.statePath), 'prices.json'))
    return new DshMissionRunner(ctx, soloWorkstation(this.proxyUserHeader)
      ? { readiness, configured, timeZone, factsConfigured, prices }
      : { tools: TEAM_MISSION_POLICY, readiness, configured, timeZone, factsConfigured, prices })
  }

  /**
   * @returns whether a required server (the approvals, the facts of a
   * briefing) is to be required here. Only a declared solo workstation
   * (soloWorkstation: opt-in, always false behind the proxy) mounts no
   * connector and so requires only those its space configures; anywhere else
   * they are required whatever is on disk — a missing descriptor never lifts
   * the requirement in silence.
   */
  private requiredConfigured(): (server: string) => boolean {
    return requiredServersRule(this.proxyUserHeader, dirname(this.statePath))
  }

  /**
   * @param ctx - the host context, for the operator's warning.
   * @returns the instance's time zone (DSH_MNDT_TIME_ZONE), or the process's when unset or invalid (said once).
   */
  private timeZoneFor(ctx: Context): string {
    const { timeZone, refused } = instanceTimeZone(process.env.DSH_MNDT_TIME_ZONE)
    // Once, whether asked by the turns or by each mission's runner.
    if (refused !== undefined) warnOperatorOnce(ctx, 'time-zone', refused)
    return timeZone
  }

  /** One readiness for turns and missions: a server's unavailability is remembered once. */
  private readiness: ToolsReadiness | undefined

  /** @param ctx - the host context. @returns the servers' readiness, made once. */
  private readinessFor(ctx: Context): ToolsReadiness {
    this.readiness ??= toolsReadinessOf(ctx)
    return this.readiness
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
      const decision = table.ok ? can(table.grants, this.identity, 'workflows.write') : { allowed: false, reason: this.unreadableGrants(table.reason) }
      const role = table.ok ? roleOf(table.grants, this.identity) : undefined
      const page: PageState = {
        you: this.identity,
        canWrite: decision.allowed,
        ...(role === undefined ? {} : { role }),
        canAdmin: table.ok && can(table.grants, this.identity, 'rights.write').allowed,
        rolesFrom: this.rolesFrom,
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
      return JSON.stringify({ ok: false, error: this.publicError(error) })
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
      return JSON.stringify({ ok: false, error: this.publicError(error) })
    }
    try {
      const result = await this.missionRunner(this.ctx).run(mission)
      const finished = await this.service.completeMission(mission.id, result)
      return JSON.stringify({ ok: true, value: finished })
    } catch (error) {
      // The runtime's words, for failMission: it serves the host's sentence and logs these.
      const raw = error instanceof Error ? error.message : String(error)
      await this.service.failMission(mission.id, raw).catch(() => undefined)
      const stored = await this.service.getMission(mission.id)
      // The host's sentence, as on the mission: the runtime's words are in the operator's log.
      return JSON.stringify({ ok: false, error: stored?.error ?? 'Erreur pendant l’exécution.', ...(stored === undefined ? {} : { value: { mission: stored } }) })
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
      return JSON.stringify({ ok: true, value: { hits: searchState(snapshot, this.identity, canAdmin, query, () => true,
        item => canReadMission({ identity: this.identity, channels: new Set(), decider: canAdmin }, item)) } })
    } catch (error) {
      return JSON.stringify({ ok: false, error: this.publicError(error) })
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
      return JSON.stringify({ ok: false, error: this.publicError(error) })
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
      return JSON.stringify({ ok: false, error: this.publicError(error) })
    }
    try {
      const result = await this.missionRunner(this.ctx).run(mission)
      return JSON.stringify({ ok: true, value: await this.service.completeMission(mission.id, result) })
    } catch (error) {
      // The runtime's words, for failMission: it serves the host's sentence and logs these.
      const raw = error instanceof Error ? error.message : String(error)
      await this.service.failMission(mission.id, raw).catch(() => undefined)
      return JSON.stringify({ ok: false, error: (await this.service.getMission(mission.id))?.error ?? 'Erreur pendant l’exécution.' })
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
      return JSON.stringify({ ok: false, error: this.publicError(error) })
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
      return JSON.stringify({ ok: false, error: this.publicError(error) })
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
      return JSON.stringify({ ok: false, error: this.publicError(error) })
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
/** The screen's three buttons for the tenant's known routes; any other priced model is « other ». */
const MODEL_KINDS: Readonly<Record<string, { readonly kind: ModelChoice['kind']; readonly label: string }>> = {
  'scaleway-genapi/deepseek-v4.1-flash': { kind: 'rapide', label: 'Rapide' },
  'scaleway-genapi/glm-5.3': { kind: 'analyse', label: 'Analyse' },
  'vllm-qwen/*': { kind: 'local', label: 'Qwen local' },
}

/**
 * The models an agent may be given: the priced routes of the grid. A route
 * priced for all its models (`<provider>/*`) is offered with the model its
 * environment names (VLLM_QWEN_MODEL for the H100), and not at all without one.
 * @param grid - the price grid.
 * @param qwenModel - the H100's model, from model.env.
 * @returns the choices, in the grid's order.
 */
export function modelChoices(grid: PriceGrid, qwenModel: string | undefined): ModelChoice[] {
  const choices: ModelChoice[] = []
  for (const [key, price] of Object.entries(grid)) {
    const at = key.indexOf('/')
    if (at <= 0) continue
    const provider = key.slice(0, at)
    let model = key.slice(at + 1)
    if (model === '*') {
      if (provider !== 'vllm-qwen' || qwenModel === undefined || qwenModel.trim() === '') continue
      model = qwenModel.trim()
    }
    const known = MODEL_KINDS[key]
    choices.push({
      provider,
      model,
      label: known?.label ?? model,
      kind: known?.kind ?? 'other',
      eur: price === null ? null : { input: price.input, output: price.output },
    })
  }
  return choices
}

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
