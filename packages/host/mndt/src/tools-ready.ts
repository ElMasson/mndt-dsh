/**
 * Whether the MCP servers a turn needs have registered their tools, waited for
 * before the turn's agent is created.
 *
 * The engine starts each MCP server of the profile asynchronously, and the
 * turn's tool policy copies the visible tool names once, when its agent is
 * created (tool-policy.ts, hideOutsidePolicy): a turn created before a server
 * has registered would never see that server's tools, and would run without
 * them in silence. So a turn first waits, for its servers' tools, up to a bound.
 * A server still absent at the bound is « unavailable »: the turns after it do
 * not wait for it again, until the registry registers it (tools/change).
 */
import { mcpServerOf } from './tool-policy.ts'

/** The registry as read here: the names of the tools registered now. */
export interface ToolsRegistryLike {
  schemas(): readonly { readonly name: string }[]
}

/**
 * The servers that count as ready only once ALL their tools are registered:
 * the approvals' are the cards of every turn, and a partial list would freeze
 * a partial allow-list. The names are the catalog's allow-list
 * (deploy/connectors/catalog.json, held equal by toolsReady.spec.ts). Any other
 * server is ready from its first tool.
 */
export const REQUIRED_TOOLS: Readonly<Record<string, readonly string[]>> = {
  approvals: ['request_approval', 'propose_agent', 'propose_context', 'propose_schedule', 'ask_peers', 'list_pending_approvals', 'read_approval'],
}

/** How long a turn waits at most for its servers' tools, in milliseconds. */
export const TOOLS_READY_TIMEOUT_MS = 45_000

/** What a turn found when it waited. */
export interface ToolsReadyOutcome {
  /** Servers whose tools are still not registered: the turn runs without them (or fails, for a required one). */
  readonly missing: readonly string[]
}

/** The servers' readiness, kept across turns. */
export class ToolsReadiness {
  readonly #registry: () => ToolsRegistryLike | undefined
  readonly #onChange: (listener: () => void) => () => void
  readonly #warn: (message: string) => void
  readonly #timeoutMs: number
  readonly #unavailable = new Set<string>()

  /**
   * @param registry - reads the tool registry (undefined: none mounted, nothing to wait for).
   * @param onChange - subscribes to the registry's changes (tools/change).
   * @param warn - the operator's log line.
   * @param timeoutMs - the bound of one wait.
   */
  constructor(
    registry: () => ToolsRegistryLike | undefined,
    onChange: (listener: () => void) => () => void,
    warn: (message: string) => void,
    timeoutMs: number = TOOLS_READY_TIMEOUT_MS,
  ) {
    this.#registry = registry
    this.#onChange = onChange
    this.#warn = warn
    this.#timeoutMs = timeoutMs
  }

  /** @param server - a server. @returns whether its tools are registered now (all of them for REQUIRED_TOOLS, one otherwise). */
  #registered(server: string): boolean {
    const registry = this.#registry()
    if (registry === undefined || typeof registry.schemas !== 'function') return true
    const names = registry.schemas().map(tool => tool.name)
    const expected = REQUIRED_TOOLS[server]
    if (expected !== undefined) return expected.every(tool => names.includes(`mcp__${server}__${tool}`))
    return names.some(name => mcpServerOf(name) === server)
  }

  /**
   * Wait until each server has a tool registered, or the bound; a server
   * already known unavailable is not waited for.
   * @param servers - the servers the turn needs.
   * @param signal - the turn's stop: a turn stopped (message deleted, agent
   * retired) leaves the wait at once, and marks no server unavailable.
   * @returns the servers still missing.
   */
  async waitFor(servers: readonly string[], signal?: AbortSignal): Promise<ToolsReadyOutcome> {
    // A server registered since is available again.
    for (const server of [...this.#unavailable]) if (this.#registered(server)) this.#unavailable.delete(server)
    const waited = servers.filter(server => !this.#registered(server) && !this.#unavailable.has(server))
    if (waited.length > 0 && signal?.aborted !== true) {
      await new Promise<void>((resolve) => {
        let unsubscribe = (): void => undefined
        const done = (): void => {
          clearTimeout(timer)
          unsubscribe()
          signal?.removeEventListener('abort', done)
          resolve()
        }
        const timer = setTimeout(done, this.#timeoutMs)
        const check = (): void => { if (waited.every(server => this.#registered(server))) done() }
        signal?.addEventListener('abort', done, { once: true })
        unsubscribe = this.#onChange(check)
        check()
      })
    }
    const missing = servers.filter(server => !this.#registered(server))
    // Stopped before the bound: nothing is learned about the servers.
    if (signal?.aborted === true) return { missing }
    for (const server of missing) {
      if (this.#unavailable.has(server)) continue
      this.#unavailable.add(server)
      this.#warn(`mndt: the tools of ${server} are not registered after ${Math.round(this.#timeoutMs / 1000)} s: its turns run without them until it registers`)
    }
    return { missing }
  }
}
