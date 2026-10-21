/**
 * Reading the team table, with an honest fallback.
 *
 * When an authority is configured, it is the only truth: this module asks it and
 * caches the answer. When the authority cannot be reached, the cached table is
 * served again, but it is marked stale. Serving a cached table as if it were live
 * would be the quiet kind of lie this project keeps refusing: the page would show
 * grants that no longer exist, with no way for the reader to know.
 */
import type {
  AuthorityGrant,
} from './authority-client.ts'
import type { RbacSnapshot } from '@deepseek-ai/dsh-client-ui-governance/src/rbac.ts'
import type { RbacStorage } from '@deepseek-ai/dsh-client-ui-governance/src/governance.ts'
import { asRole } from '@deepseek-ai/dsh-client-ui-governance/src/rbac.ts'

/** Anything that can answer a snapshot. Structural, so a test can stand in. */
export interface SnapshotSource {
  /** @returns the table, or the reason it could not be read. */
  snapshot(): Promise<
    | { readonly ok: true; readonly grants: readonly AuthorityGrant[] }
    | { readonly ok: false; readonly reason: string; readonly status: number }
  >
}

/** What the page is told about the table it is looking at. */
export interface TableView {
  /** The rows to display. */
  readonly grants: readonly AuthorityGrant[]
  /** True when the authority did not answer and this is a cached read. */
  readonly stale: boolean
  /** Where the rows came from, for the page's status line. */
  readonly source: 'authority' | 'cache' | 'local'
  /** The reason, when the read was degraded. */
  readonly detail: string
}

/** What a read needs. */
export interface LoadTableViewInput {
  /** The authority, when the workstation is in team mode. */
  readonly authority: SnapshotSource | undefined
  /** The local store: the cache in team mode, the table in solo mode. */
  readonly storage: RbacStorage
}

/** @param snapshot - a persisted table. @returns its rows. */
function rowsOf(snapshot: RbacSnapshot): AuthorityGrant[] {
  return snapshot.grants.map(grant => (grant.scope === undefined
    ? { subject: grant.subject, role: grant.role }
    : { subject: grant.subject, role: grant.role, scope: grant.scope }))
}

/**
 * Turn wire rows into a persistable table.
 *
 * A role the rules do not know is dropped rather than stored: the authority
 * validates its input, so an unknown role here means a version skew, and writing
 * it into the cache would spread it to the next offline read.
 * @param rows - rows as the authority sent them.
 * @returns the snapshot and how many rows were dropped.
 */
export function toSnapshot(rows: readonly AuthorityGrant[]): { snapshot: RbacSnapshot; dropped: number } {
  const grants: RbacSnapshot['grants'][number][] = []
  let dropped = 0
  for (const row of rows) {
    const role = asRole(row.role)
    if (role === undefined) {
      dropped += 1
      continue
    }
    grants.push(row.scope === undefined
      ? { subject: row.subject, role }
      : { subject: row.subject, role, scope: row.scope })
  }
  return { snapshot: { grants }, dropped }
}

/**
 * Read the table, caching what the authority returns.
 * @param input - the authority (or none) and the local store.
 * @returns the rows plus their provenance.
 */
export async function loadTableView(input: LoadTableViewInput): Promise<TableView> {
  const { authority, storage } = input

  if (authority === undefined) {
    const local = await storage.load()
    return { grants: rowsOf(local), stale: false, source: 'local', detail: 'local table' }
  }

  let remote: Awaited<ReturnType<SnapshotSource['snapshot']>>
  try {
    remote = await authority.snapshot()
  } catch (error) {
    remote = {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      status: 0,
    }
  }

  if (remote.ok) {
    const { snapshot, dropped } = toSnapshot(remote.grants)
    await storage.save(snapshot)
    return {
      grants: rowsOf(snapshot),
      stale: false,
      source: 'authority',
      detail: dropped === 0 ? 'authority' : `authority, ${dropped} unknown role(s) dropped`,
    }
  }

  const cached = await storage.load()
  return {
    grants: rowsOf(cached),
    stale: true,
    source: 'cache',
    detail: remote.reason,
  }
}
