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
 * The rule is applied twice on the agent the turn creates, and both follow the
 * engine's scope chain down to the workflow child that actually calls the
 * model: `restrict({ allow })` hides the rest from the model, and a guard
 * refuses at execution whatever the model names, including a tool mounted
 * after the turn started or one the agent's own layer registers (a restriction
 * never filters its own layer). The guard is the boundary; hiding is comfort.
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

/** @param name - a tool name. @returns the MCP server it comes from, if it is an MCP tool. */
export function mcpServerOf(name: string): string | undefined {
  if (!name.startsWith('mcp__')) return undefined
  const end = name.indexOf('__', 'mcp__'.length)
  return end < 0 ? undefined : name.slice('mcp__'.length, end)
}

/**
 * @param servers - the servers of the channel.
 * @returns the policy of a turn in that channel: its servers, the approvals, nothing else.
 */
export function channelPolicy(servers: readonly string[]): ToolPolicy {
  return { servers: new Set([...servers, ...ALWAYS_SERVERS]), tools: new Set(ALLOWED_TOOLS) }
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
  schemas(): readonly { readonly name: string }[]
  restrict(filter: { readonly allow?: readonly string[]; readonly deny?: readonly string[] }): () => void
  guard(guard: (execution: { readonly name: string }) => string | undefined): () => void
}

/**
 * Apply a policy to an agent being created: hide what it does not name, refuse
 * it at execution.
 * @param tools - the agent's scoped tools.
 * @param policy - the allow-list.
 * @returns the names left visible.
 */
export function applyToolPolicy(tools: ScopedToolsLike, policy: ToolPolicy): readonly string[] {
  const visible = tools.schemas().map(tool => tool.name).filter(name => toolRefusal(name, policy) === undefined)
  tools.restrict({ allow: visible })
  tools.guard(execution => toolRefusal(execution.name, policy))
  return visible
}
