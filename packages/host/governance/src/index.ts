/**
 * Host half of the governance plugin: the persisted authority, exposed over
 * Typert Remote so the browser page can ask without ever deciding.
 *
 * It lives in a host package, not in the client package, because the authority
 * writes files and the client package is browser-pure by construction (a build
 * gate enforces it).
 *
 * The rules are not duplicated: this package consumes the single
 * `GovernanceController` the client package owns and that its tests cover, and
 * supplies the storage port it was designed around. This file adds the wire
 * boundary: local types the Remote projection can describe, and validation of
 * anything arriving from the browser before it reaches the rules.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the AgentPresetRegistry augmentation of Context.
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
// Type-only: pulls the default-model selection a programmatic Agent route reads.
import type {} from '@deepseek-ai/dsh-agent-default-model'
// Type-only: pulls the WorkspaceRegistry augmentation of Context.
import type {} from '@deepseek-ai/dsh-workspace'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  GovernanceController,
  type RbacStorage,
} from '@deepseek-ai/dsh-client-ui-governance/src/governance.ts'
import {
  asRole,
  type Capability,
} from '@deepseek-ai/dsh-client-ui-governance/src/rbac.ts'
import type { AutomationRow, AgentRow, ConnectorRow, DecisionRow, GrantRow, TableStateRow, WorkspaceRow  } from './types.ts'

export type * from './types.ts'

import { JsonFileRbacStorage } from './storage.ts'
import { AuthorityClient } from './authority-client.ts'
import { loadTableView } from './cache.ts'
import { AutomationService, JsonFileAutomationStorage, type Automation } from './automations.ts'
import { executeAutomation } from './automations-runner.ts'
import { AutomationScheduler } from './automations-scheduler.ts'
import { failureOfAgentEnd, failureOfTurnEnd } from './automations-failure.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { randomUUID } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the SessionStore augmentation and its `session/event` feed.
import type {} from '@deepseek-ai/dsh-session'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
// Type-only: pulls the WorkflowEngine augmentation of Context.
import type {} from '@deepseek-ai/dsh-workflow'
// Type-only: pulls the Loader augmentation of Context.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { homedir } from 'node:os'
import { join } from 'node:path'

export { JsonFileRbacStorage, defaultStatePath } from './storage.ts'
export { createAuthority, startAuthority } from './authority.ts'
export { AuthorityClient } from './authority-client.ts'
export type { AuthorityClientOptions, AuthorityGrant, AuthorityOutcome } from './authority-client.ts'
export type { AuthorityOptions, AuthorityRequest, AuthorityResponse, AuthorityListenOptions, AuthorityToken } from './authority.ts'


/** The Remote gateway: the browser's only way in. */
export class GovernanceGateway extends TypertRemoteService {
  /**
   * Services this gateway reads for the Agents, Sharing and automation-run
   * surfaces. Cordis refuses an undeclared service read with "cannot get
   * property <name> without inject", which surfaced as a raw gateway/internal
   * failure on those surfaces. The workflow engine is deliberately absent: the
   * web composition disables workflow-ptc, so it is looked up per run instead
   * (see {@link executeRow}) rather than gating this whole Remote face.
   */
  static inject = ['agentPresets', 'workspaceRegistry', 'agents']

  private readonly storage: RbacStorage
  private readonly automations: AutomationService
  private readonly scheduler: AutomationScheduler<Automation>
  private readonly controller: GovernanceController
  private readonly authority: AuthorityClient | undefined
  private readonly ready: Promise<void>

  /**
   * @param ctx - owning context.
   * @param storage - persistence port; defaults to the JSON file.
   */
  constructor(ctx: Context, storage: RbacStorage = new JsonFileRbacStorage()) {
    super(ctx, 'governance')
    this.storage = storage
    this.automations = new AutomationService(new JsonFileAutomationStorage(join(process.env.DSH_GOVERNANCE_HOME ?? join(homedir(), '.dsh', 'governance'), 'automations.json')))
    this.scheduler = new AutomationScheduler({
      list: () => this.automations.all(),
      run: async (row) => {
        const outcome = await this.executeRow(row)
        if (!outcome.allowed) throw new Error(outcome.reason)
      },
    })
    // The timer lives and dies with the plugin fiber.
    this.ctx.effect(() => {
      this.scheduler.start()
      return () => { this.scheduler.stop() }
    }, 'governance: automation scheduler')
    this.controller = new GovernanceController(storage)
    // Team mode: someone else decides, because only the authority can turn a
    // token into an identity. Solo mode keeps the local table.
    const baseUrl = process.env.DSH_GOVERNANCE_AUTHORITY
    const token = process.env.DSH_GOVERNANCE_TOKEN
    this.authority = baseUrl !== undefined && baseUrl !== '' && token !== undefined && token !== ''
      ? new AuthorityClient({ baseUrl, token })
      : undefined
    this.ready = this.controller.load()
  }

  /**
   * Every grant, weakest first.
   * @returns the table as wire rows.
   */
  @Remote('list')
  async list(): Promise<GrantRow[]> {
    await this.ready
    const view = await loadTableView({ authority: this.authority, storage: this.storage })
    return view.grants.map(grant => (grant.scope === undefined
      ? { subject: grant.subject, role: grant.role }
      : { subject: grant.subject, role: grant.role, scope: grant.scope }))
  }

  /**
   * Whether the table the page sees is live, and where it came from.
   * @returns the provenance of the current read.
   */
  @Remote('tableState')
  async tableState(): Promise<TableStateRow> {
    await this.ready
    const view = await loadTableView({ authority: this.authority, storage: this.storage })
    return { stale: view.stale, source: view.source, detail: view.detail }
  }

  /**
   * The connector surface: MCP client entries the Loader actually mounted.
   *
   * Each MCP client instance connects to one server and reserves its name, so
   * this reports what is running rather than what a config file claims. A module
   * that is not an MCP client is not a connector and is left out.
   * @returns one row per mounted MCP client entry.
   */
  @Remote('connectors')
  async connectors(): Promise<ConnectorRow[]> {
    const rows: ConnectorRow[] = []
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.group !== undefined) continue
      const module = entry.options.name
      if (!module.includes('mcp-client')) continue
      const config: unknown = entry.options.config
      const server = typeof config === 'object' && config !== null && 'serverName' in config && typeof config.serverName === 'string'
        ? config.serverName
        : module
      rows.push({
        entry: String(entry.id),
        module,
        server,
        enabled: entry.disabled !== true,
      })
    }
    return rows.sort((a, b) => a.server.localeCompare(b.server))
  }

  /**
   * Execute one automation through the real path.
   * @param automation - the row to run.
   * @returns the decision, with the runner's reason when it failed.
   */
  private async executeRow(automation: Automation): Promise<DecisionRow> {
    let created: AgentHandle | undefined
    const outcome = await executeAutomation({
      createAgent: async () => {
        const sessionId = brandString<SessionId>(randomUUID())
        // A programmatic root agent has no parent to inherit a route from. Take
        // the deployment default the way the headless runner does, or the loop
        // has no provider/model to build a request with and the `{{model}}`
        // prompt variable stays empty (the turn then fails before any call).
        const selection = this.ctx.get('agentDefaultModel')?.currentSelection()
        created = await this.ctx.agents.create({
          sessionId,
          ...selection === undefined
            ? {}
            : { agentOptions: { provider: selection.provider, model: selection.model } },
        })
        return { dispose: () => created?.dispose() ?? Promise.resolve() }
      },
      startWorkflow: async (_handle, prompt) => {
        if (created === undefined) throw new Error('the agent was not created')
        // Optional on purpose: a Host that disables workflow-ptc still mounts
        // every read surface. Running an automation reports the missing engine
        // instead of failing with a Cordis "without inject" error.
        const engine = this.ctx.get('workflowEngine')
        if (engine === undefined) {
          throw new Error('governance: this Host does not mount the workflow engine, so an automation cannot run')
        }
        const run = engine.start({
          script: `return await agent(${JSON.stringify(prompt)})`,
          meta: { name: 'automation', description: 'Scheduled user automation' },
          parent: created.agent,
        })
        // A settled run only reports the script's own stop reason: the engine's
        // `agent()` resolves `null` when a child run fails, so a completed script
        // can hide a failed turn. Read the two contracts that do report it —
        // `workflow/agent-end` for the child outcome and the child session's
        // `turn/end` for the real reason — instead of trusting the label.
        const childSessionId = created.agent.session.header.id
        const failures: string[] = []
        const stopAgentEnd = this.ctx.on('workflow/agent-end', (info, agent) => {
          if (info.id !== run.id) return
          const failure = failureOfAgentEnd({ outcome: agent.outcome, seq: agent.seq, label: agent.label })
          if (failure !== undefined) failures.push(failure)
        })
        const stopTurnEnd = this.ctx.on('session/event', (session, event) => {
          if (event.type !== 'turn/end') return
          const { reason } = event.data
          const failure = failureOfTurnEnd(childSessionId, {
            parentSession: session.header.parentSession,
            kind: reason.kind,
            message: reason.kind === 'error' ? reason.error.message : undefined,
          })
          if (failure !== undefined) failures.push(failure)
        })
        try {
          const settled = await run.result
          if (failures.length > 0) throw new Error(failures.join('; '))
          return settled
        } finally {
          stopAgentEnd()
          stopTurnEnd()
        }
      },
    }, automation)
    return outcome.ok
      ? { allowed: true, reason: 'automation ran' }
      : { allowed: false, reason: outcome.reason ?? 'automation failed' }
  }

  /**
   * The caller's automations.
   * @param actor - the identity asking; only its own rows are returned.
   * @returns its automations.
   */
  @Remote('automations')
  async automationsList(actor: string): Promise<AutomationRow[]> {
    const rows = await this.automations.list(actor)
    return rows.map(row => ({ ...row, everyMinutes: 60 }))
  }

  /**
   * Create an automation for the caller.
   * @param actor - the owner.
   * @param prompt - what to run.
   * @returns the created row, or a refusal.
   */
  @Remote('createAutomation')
  async createAutomation(actor: string, prompt: string, everyMinutes: number): Promise<AutomationRow | DecisionRow> {
    const created = await this.automations.create(actor, prompt, everyMinutes)
    if ('allowed' in created) return created
    return created
  }

  /**
   * Enable or disable one of the caller's automations.
   * @param actor - the identity asking.
   * @param id - the automation.
   * @param enabled - the new state.
   * @returns the decision.
   */
  @Remote('setAutomationEnabled')
  async setAutomationEnabled(actor: string, id: string, enabled: boolean): Promise<DecisionRow> {
    return this.automations.setEnabled(actor, id, enabled)
  }

  /**
   * Delete one of the caller's automations.
   * @param actor - the identity asking.
   * @param id - the automation.
   * @returns the decision.
   */
  @Remote('deleteAutomation')
  async deleteAutomation(actor: string, id: string): Promise<DecisionRow> {
    return this.automations.remove(actor, id)
  }

  /**
   * Run one automation now, through the real execution path.
   * @param actor - the identity asking; must own the automation.
   * @param id - the automation.
   * @returns the decision, with the runner's refusal reason when it failed.
   */
  @Remote('runAutomationNow')
  async runAutomationNow(actor: string, id: string): Promise<DecisionRow> {
    const rows = await this.automations.list(actor)
    const automation = rows.find(row => row.id === id)
    if (automation === undefined) return { allowed: false, reason: `no automation ${id} for this owner` }
    return this.executeRow(automation)
  }

  /**
   * The agent surface: every declared preset, as a row.
   *
   * Reading the roster is not a privilege: it names what exists, it does not let
   * anyone run it. Starting an agent stays behind the Host's own gates.
   * @returns one row per preset.
   */
  @Remote('agents')
  async agents(): Promise<AgentRow[]> {
    const presets = await this.ctx.agentPresets.list()
    return presets.map(preset => ({ id: preset.id, name: preset.name ?? preset.id }))
  }

  /**
   * The sharing surface: every registered workspace.
   *
   * A workspace is what the team shares work in. Reading the registry names the
   * spaces and their paths; it does not grant access to their contents.
   * @returns one row per workspace.
   */
  @Remote('workspaces')
  async workspaces(): Promise<WorkspaceRow[]> {
    return this.ctx.workspaceRegistry.list().map(workspace => ({
      id: String(workspace.id),
      title: workspace.title,
      path: workspace.path,
    }))
  }

  /**
   * Decide one capability for one subject.
   * @param subject - the identity being checked.
   * @param capability - what it wants to do.
   * @param scope - the targeted resource, when there is one.
   * @returns the decision with its reason.
   */
  @Remote('decide')
  async decide(subject: string, capability: string, scope?: string): Promise<DecisionRow> {
    await this.ready
    const decision = this.controller.decide(subject, capability as Capability, scope)
    return { allowed: decision.allowed, reason: decision.reason }
  }

  /**
   * Record a grant on behalf of an actor.
   * @param actor - the identity asking. The Remote boundary does not authenticate
   *   it today: the generated client signature takes the agent id as a parameter,
   *   so this is a declared identity, not a proven one. The table is still
   *   guarded, so a viewer cannot grant anything, but callers must not treat this
   *   as proof of who is calling.
   * @param grant - the grant to record.
   * @returns the decision; nothing is persisted when refused.
   */
  @Remote('setGrant')
  async setGrant(actor: string, grant: GrantRow): Promise<DecisionRow> {
    await this.ready
    const role = asRole(grant.role)
    if (role === undefined) {
      return { allowed: false, reason: `unknown role: ${grant.role}` }
    }
    const authority = this.authority
    if (authority !== undefined) {
      const outcome = await authority.grant(grant.subject, role, grant.scope)
      return { allowed: outcome.ok, reason: outcome.reason }
    }
    const decision = await this.controller.setGrant(actor, {
      subject: grant.subject,
      role,
      ...(grant.scope === undefined ? {} : { scope: grant.scope }),
    })
    return { allowed: decision.allowed, reason: decision.reason }
  }

  /**
   * Remove a grant on behalf of an actor.
   * @param actor - the identity asking, with the same caveat as setGrant.
   * @param subject - whose grant to remove.
   * @param scope - undefined targets the global grant only.
   * @returns the decision; nothing is persisted when refused.
   */
  @Remote('removeGrant')
  async removeGrant(actor: string, subject: string, scope?: string): Promise<DecisionRow> {
    await this.ready
    const authority = this.authority
    if (authority !== undefined) {
      const outcome = await authority.revoke(subject, scope)
      return { allowed: outcome.ok, reason: outcome.reason }
    }
    const decision = await this.controller.removeGrant(actor, subject, scope)
    return { allowed: decision.allowed, reason: decision.reason }
  }

  /**
   * Make the first identity owner, only on an empty table.
   * @param subject - the identity to make owner.
   * @returns the decision.
   */
  @Remote('bootstrapOwner')
  async bootstrapOwner(subject: string): Promise<DecisionRow> {
    await this.ready
    const decision = await this.controller.bootstrapOwner(subject)
    return { allowed: decision.allowed, reason: decision.reason }
  }
}

/**
 * Mount the governance gateway.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(GovernanceGateway)
}
