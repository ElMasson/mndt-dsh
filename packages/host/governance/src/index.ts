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
import type { AgentRow, ConnectorRow, DecisionRow, GrantRow, TableStateRow, WorkspaceRow } from './types.ts'

export type * from './types.ts'

import { JsonFileRbacStorage } from './storage.ts'
import { AuthorityClient } from './authority-client.ts'
import { loadTableView } from './cache.ts'
// Type-only: pulls the Loader augmentation of Context.
import type {} from '@deepseek-ai/cordis-plugin-loader'

export { JsonFileRbacStorage, defaultStatePath } from './storage.ts'
export { createAuthority, startAuthority } from './authority.ts'
export { AuthorityClient } from './authority-client.ts'
export type { AuthorityClientOptions, AuthorityGrant, AuthorityOutcome } from './authority-client.ts'
export type { AuthorityOptions, AuthorityRequest, AuthorityResponse, AuthorityListenOptions, AuthorityToken } from './authority.ts'


/** The Remote gateway: the browser's only way in. */
export class GovernanceGateway extends TypertRemoteService {
  /** Both rosters carry a surface; requiring them keeps a miss loud. */
  static inject = ['agentPresets', 'workspaceRegistry', 'loader']

  private readonly storage: RbacStorage
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
