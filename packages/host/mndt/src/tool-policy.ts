/**
 * What an agent of the team may call: one allow-list, data in one place, and
 * everything it does not name is refused.
 *
 * A turn of a channel reaches the MCP servers its channel allows and the
 * approvals server (asking for a card is never an action). Nothing else: no
 * shell, no file, no web, no subagent, no MCP resource browsing, no change of
 * working directory. Those tools come from the engine's default composition
 * and would follow it silently if the rule were a deny-list.
 *
 * Where it applies: the model is called by the workflow CHILD of the agent a
 * turn creates, and an agent's scope does not inherit its parent agent's (its
 * scope parent is its preset generation). A restriction or a guard set on the
 * turn's agent would therefore never reach the child. The policy is scoped to
 * the turn's session lineage instead: a guard on the host context refuses, for
 * any agent whose session is the turn's or descends from it, whatever the
 * policy does not name; and every agent of that lineage, the child included,
 * gets the same `restrict({ allow })` when it is created. The guard is the
 * boundary; hiding keeps the model from asking.
 * @module
 */

/** The servers every agent of the team may reach. */
export const ALWAYS_SERVERS: readonly string[] = ['approvals']

/**
 * Tools outside MCP an agent of the team may call, by exact name. Empty on
 * purpose: adding one here is a decision, reviewed as such.
 */
export const ALLOWED_TOOLS: readonly string[] = []

/** One agent's allow-list. */
export interface ToolPolicy {
  /** The MCP servers allowed, or `'any'` for every mounted server. */
  readonly servers: ReadonlySet<string> | 'any'
  /** The tools outside MCP allowed, by exact name. */
  readonly tools: ReadonlySet<string>
}

/**
 * @param server - a server name.
 * @returns whether it reads back unambiguously from mcp__<server>__<tool>: no
 * `__` inside, no final `_` (render-connectors.py refuses the same names).
 */
export function isServerName(server: string): boolean {
  return /^[a-z][a-z0-9_-]{0,62}$/.test(server) && !server.includes('__') && !server.endsWith('_')
}

/** @param name - a tool name. @returns the MCP server it comes from, if it is an MCP tool of a well-named server. */
export function mcpServerOf(name: string): string | undefined {
  if (!name.startsWith('mcp__')) return undefined
  const end = name.indexOf('__', 'mcp__'.length)
  if (end < 0) return undefined
  const server = name.slice('mcp__'.length, end)
  return isServerName(server) ? server : undefined
}

/**
 * @param servers - the servers of the channel.
 * @returns the policy of a turn in that channel: its servers, the approvals, nothing else.
 */
export function channelPolicy(servers: readonly string[]): ToolPolicy {
  // A badly named server is never allowed: its tools could not be told apart.
  return { servers: new Set([...servers, ...ALWAYS_SERVERS].filter(isServerName)), tools: new Set(ALLOWED_TOOLS) }
}

/**
 * The policy of a step that only reads a text it is given (the verifier of an
 * « auteur puis vérificateur » turn): no server at all, not even the approvals,
 * no tool. A draft can carry a document's words: nothing in it may act.
 */
export const NO_TOOLS_POLICY: ToolPolicy = { servers: new Set(), tools: new Set() }

/**
 * @param servers - the agent's servers that the channel allows.
 * @returns the policy of a step that gathers but asks for nothing: its
 * connectors, without the approvals (a worker of « en parallèle puis
 * synthèse »: up to four workers must not ask four cards for one action).
 */
export function noCardsPolicy(servers: readonly string[]): ToolPolicy {
  const connectors = servers.filter(isServerName).filter(server => !ALWAYS_SERVERS.includes(server))
  return { servers: new Set(connectors), tools: new Set(ALLOWED_TOOLS) }
}

/** The policy of a mission on a team instance: MCP tools only, never the engine's own. */
export const TEAM_MISSION_POLICY: ToolPolicy = { servers: 'any', tools: new Set(ALLOWED_TOOLS) }

/**
 * @param name - a tool name.
 * @param policy - the allow-list.
 * @returns why the tool is refused, or undefined when the policy names it.
 */
export function toolRefusal(name: string, policy: ToolPolicy): string | undefined {
  if (policy.tools.has(name)) return undefined
  const server = mcpServerOf(name)
  if (server === undefined) return `the tool ${name} is not open to the agents of the team`
  if (policy.servers === 'any' || policy.servers.has(server)) return undefined
  return `the MCP server ${server} is not allowed in this channel`
}

/** The scoped tools face of an agent being created, structurally. */
export interface ScopedToolsLike {
  /** The tools one scope sees (an agent is its own scope key); without one, the global layer only. */
  schemas(scope?: unknown): readonly { readonly name: string }[]
  restrict(filter: { readonly allow?: readonly string[]; readonly deny?: readonly string[] }): () => void
  guard(guard: (execution: { readonly name: string }) => string | undefined): () => void
}

/**
 * Hide from one agent what a policy does not name.
 * @param tools - the agent's scoped tools.
 * @param policy - the allow-list.
 * @param agent - the agent, the key of its scope: its tools live on the agent
 * plane (its preset), so the global view alone would list none of them and
 * the allow-list would hide everything, the approvals included.
 * @returns the names left visible.
 */
export function hideOutsidePolicy(tools: ScopedToolsLike, policy: ToolPolicy, agent: unknown): readonly string[] {
  const visible = tools.schemas(agent).map(tool => tool.name).filter(name => toolRefusal(name, policy) === undefined)
  tools.restrict({ allow: visible })
  return visible
}

/** An agent as the policy sees it, structurally. */
export interface LineageAgentLike {
  readonly session: { readonly header: { readonly id: string; readonly parentSession?: string | undefined } }
  readonly ctx: { readonly tools: ScopedToolsLike }
}

/** The host context face the policy uses, structurally. */
export interface PolicyHostLike {
  /** The live agents, to walk a session's ancestry up to its root. */
  readonly agents: { get(id: never): LineageAgentLike | undefined }
  readonly tools: {
    guard(guard: (execution: { readonly name: string; readonly agent?: LineageAgentLike | undefined }) => string | undefined): () => void
  }
  on(event: 'agent/created', listener: (payload: { readonly agent: LineageAgentLike }) => void): () => void
}

/**
 * Apply a policy to one session and every session descending from it, for as
 * long as the returned disposer is not called.
 * @param host - the host context (not an agent's: the guard must see every agent).
 * @param rootSessionId - the session of the agent the run creates.
 * @param policy - the allow-list.
 * @returns the disposer.
 */
export function scopeToolPolicy(host: PolicyHostLike, rootSessionId: string, policy: ToolPolicy): () => void {
  const lineage = new Set([rootSessionId])
  // A descendant may call a tool before it, or its parent, was announced: the
  // whole ancestry is walked through the live agents, so a grandchild whose
  // parent never ran a tool is still recognised. Every agent met on a path that
  // reaches the root joins the lineage. An agent outside every lineage (the
  // owner's own shell, another run) is untouched: this guard is the run's only.
  const inLineage = (agent: LineageAgentLike | undefined): boolean => {
    const path: string[] = []
    let header = agent?.session.header
    for (let depth = 0; header !== undefined && depth < 64; depth += 1) {
      if (lineage.has(header.id)) {
        for (const id of path) lineage.add(id)
        return true
      }
      path.push(header.id)
      const parent = header.parentSession
      if (parent === undefined) return false
      if (lineage.has(parent)) {
        for (const id of path) lineage.add(id)
        return true
      }
      header = host.agents.get(parent as never)?.session.header
    }
    return false
  }
  const stopGuard = host.tools.guard(execution => (inLineage(execution.agent) ? toolRefusal(execution.name, policy) : undefined))
  // A child is announced before its first step: hide there what it may not call.
  // A throw here fails the child's creation, so the run fails closed.
  const stopCreated = host.on('agent/created', ({ agent }) => {
    if (inLineage(agent)) hideOutsidePolicy(agent.ctx.tools, policy, agent)
  })
  return () => {
    stopCreated()
    stopGuard()
  }
}
