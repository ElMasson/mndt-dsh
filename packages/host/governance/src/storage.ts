/**
 * Durable storage for the grant table.
 *
 * It lives on its own module so the central authority and the local gateway can
 * share one implementation without pulling the Remote face into the authority.
 * Writes go through a temporary file and a rename: a crash mid-write leaves the
 * previous table intact instead of a truncated file that would load as an empty
 * table and silently drop every grant.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { RbacStorage } from '@deepseek-ai/dsh-client-ui-governance/src/governance.ts'
import type { RbacSnapshot } from '@deepseek-ai/dsh-client-ui-governance/src/rbac.ts'

/** Where the table is persisted when nothing overrides it. */
export function defaultStatePath(): string {
  const home = process.env.DSH_GOVERNANCE_HOME ?? join(homedir(), '.dsh', 'governance')
  return join(home, 'rbac.json')
}

/**
 * Durable storage for the grant table.
 *
 * Writes go through a temporary file and a rename, so a crash mid-write leaves
 * the previous table intact instead of a truncated file that would load as an
 * empty table and silently drop every grant.
 */
export class JsonFileRbacStorage implements RbacStorage {
  private readonly statePath: string

  /** @param path - file to read and write. */
  constructor(path: string = defaultStatePath()) {
    this.statePath = path
  }

  /** @returns the persisted table, or an empty one when the file does not exist. */
  async load(): Promise<RbacSnapshot> {
    try {
      const raw = await readFile(this.statePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as RbacSnapshot).grants)) {
        return { grants: [] }
      }
      return parsed as RbacSnapshot
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { grants: [] }
      throw error
    }
  }

  /** @param snapshot - replaces the stored table atomically. */
  async save(snapshot: RbacSnapshot): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true })
    const temporary = `${this.statePath}.tmp`
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    await rename(temporary, this.statePath)
  }
}
