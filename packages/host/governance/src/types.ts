/**
 * Wire types of the governance Remote face.
 *
 * They live on their own public subpath (`@deepseek-ai/dsh-host-governance/types`)
 * because the Typert generator requires every boundary type to be exported from
 * a non-root type subpath.
 */

/** One grant, as it crosses the wire. `role` is validated on this side. */
export interface GrantRow {
  /** Who holds the grant. */
  readonly subject: string
  /** The role name; rejected on the Host side when it is not a known role. */
  readonly role: string
  /** Optional narrowing to one resource. */
  readonly scope?: string
}

/** One decision, as it crosses the wire. */
export interface DecisionRow {
  /** Whether the action is allowed. */
  readonly allowed: boolean
  /** Why, in words the page can show as-is. */
  readonly reason: string
}

/** The persisted table, as it crosses the wire. */
export interface SnapshotRow {
  /** Every grant, weakest first. */
  readonly grants: GrantRow[]
}
/** One agent preset, as it crosses the wire. */
export interface AgentRow {
  /** Preset identity. */
  readonly id: string
  /** Display name. */
  readonly name: string
}

/** One workspace, as it crosses the wire: what is shared and where it lives. */
export interface WorkspaceRow {
  /** Stable record id. */
  readonly id: string
  /** Display title. */
  readonly title: string
  /** Canonical directory path. */
  readonly path: string
}

/** Where the table the page is looking at came from, and whether it is live. */
export interface TableStateRow {
  /** True when the authority did not answer and the rows are cached. */
  readonly stale: boolean
  /** 'authority', 'cache', or 'local'. */
  readonly source: string
  /** Why the read was degraded, when it was. */
  readonly detail: string
}

/** One mounted connector, as it crosses the wire. */
export interface ConnectorRow {
  /** The Loader entry identity. */
  readonly entry: string
  /** The plugin module providing it. */
  readonly module: string
  /** The MCP server name it reserves, when the config declares one. */
  readonly server: string
  /** Whether the entry is enabled. */
  readonly enabled: boolean
}
