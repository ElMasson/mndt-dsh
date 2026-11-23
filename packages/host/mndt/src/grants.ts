/**
 * Where the product state lives and who owns it.
 *
 * Kept apart from the plugin entry so the gateway and the HTTP face can both
 * import it without a cycle: a plugin module that imports the module that mounts
 * the plugin is a boot hazard, not a style question.
 */
import { asRole } from '@deepseek-ai/dsh-client-ui-governance/src/rbac.ts'
import type { Grant } from '@deepseek-ai/dsh-client-ui-governance/src/rbac.ts'
import { readFile } from 'node:fs/promises'
import type { GrantSource, SkippedGrant } from './policy.ts'
import { isPlainAscii } from './identity.ts'

/** Ask the team authority for its grant table. */
export function authorityGrants(
  options: { baseUrl: string; token: string; timeoutMs?: number },
  warn: (message: string) => void = () => {},
): GrantSource {
  return {
    async grants() {
      try {
        // Bounded too: role changes read the table inside their one-at-a-time section.
        const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/governance/snapshot`, {
          headers: { authorization: `Bearer ${options.token}` },
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        })
        if (!response.ok) return { ok: false, reason: `authority answered ${response.status}` }
        const body: unknown = await response.json()
        const rows = (body as { grants?: unknown }).grants
        if (!Array.isArray(rows)) return { ok: false, reason: 'authority answered without a grant table' }
        const grants: Grant[] = []
        const skipped: SkippedGrant[] = []
        for (const [index, row] of rows.entries()) {
          // The same rule as the role file's (#75): an invalid row is set aside, said, and grants nothing.
          const reason = rowRefusal(row)
          if (reason !== undefined) {
            skipped.push({ row: index + 1, reason })
            continue
          }
          const { subject, role } = row as { subject: string; role: unknown }
          const scope = (row as { scope?: unknown }).scope
          grants.push({ subject: subject.trim().toLowerCase(), role: asRole(role) as Grant['role'], ...(typeof scope === 'string' ? { scope } : {}) })
        }
        if (skipped.length > 0) logSkipped('the team authority', skipped, warn)
        return skipped.length > 0 ? { ok: true, grants, skipped } : { ok: true, grants }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

/** Solo mode: one named owner, and nobody else writes. */
export function localGrants(owner: string | undefined): GrantSource {
  return {
    grants() {
      if (owner === undefined || owner.trim() === '') {
        return Promise.resolve({ ok: false, reason: 'this workstation runs in solo mode and no local owner is configured' })
      }
      return Promise.resolve({ ok: true, grants: [{ subject: owner.trim().toLowerCase(), role: 'owner' }] })
    },
  }
}

/**
 * @param name - a display name from the role file.
 * @returns whether it can be shown as it is: one line, 1 to 80 characters, no control character.
 */
function isShownName(name: string): boolean {
  const shown = name.trim()
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  return shown !== '' && shown.length <= 80 && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(name)
}

/** The pause before the second read of a role file that read as broken (ms). */
const REREAD_MS = 50

type RowsRead = { readonly ok: true; readonly rows: readonly unknown[] } | { readonly ok: false; readonly reason: string }

/** @param path - the role file. @returns its rows, or why the file cannot be read. */
async function readRows(path: string): Promise<RowsRead> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return { ok: false, reason: code === 'ENOENT' ? `the role file ${path} is missing` : `cannot read the role file ${path}: ${String(error)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, reason: `the role file ${path} is not JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  // JSON, but not an object (null, a list, a number): said as such, never « not JSON ».
  const rows = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as { grants?: unknown }).grants : undefined
  return Array.isArray(rows) ? { ok: true, rows } : { ok: false, reason: `the role file ${path} has no "grants" list` }
}

/** @param row - one row of the role file. @returns why it is set aside, or undefined when it is valid. */
function rowRefusal(row: unknown): string | undefined {
  const subject = (row as { subject?: unknown } | null)?.subject
  const role = asRole((row as { role?: unknown } | null)?.role)
  if (typeof subject !== 'string' || subject.trim() === '' || role === undefined) {
    return 'a subject (e-mail) and a role among owner, admin, operator, viewer are required'
  }
  if (!isPlainAscii(subject)) return 'the subject is not a plain ASCII e-mail'
  const name = (row as { name?: unknown }).name
  if (name !== undefined && (typeof name !== 'string' || !isShownName(name))) {
    return 'a name is one line of 80 characters at most, without control characters'
  }
  return undefined
}

/** The rows last reported, per file: a set-aside row is logged once, not on every request. */
const reported = new Map<string, string>()

/**
 * @param path - the role file. @param skipped - its rows set aside.
 * @param warn - where to say it (the plugin's logger).
 */
function logSkipped(source: string, skipped: readonly SkippedGrant[], warn: (message: string) => void): void {
  const key = JSON.stringify(skipped)
  if (reported.get(source) === key) return
  reported.set(source, key)
  for (const { row, reason } of skipped) warn(`mndt: ${source}, row ${row}, is set aside and grants nothing: ${reason}`)
}

/**
 * A tenant's own role table, in one file (decided by Stephane, 13/11):
 * `{ "grants": [{ "subject": "<email>", "role": "owner|admin|operator|viewer", "name": "<shown>" }] }`,
 * `name` optional (80 characters at most), shown by the team screen and never granting anything.
 *
 * The file is read on every request, so a role changes without a restart.
 * A file that cannot be read (missing, broken JSON, no "grants" list) refuses
 * the whole table with its reason, after one second read: a read that falls in
 * the middle of a rewrite is not a broken file. An invalid ROW (an unknown role,
 * no subject, a subject not in plain ASCII, a bad name) grants nothing and is
 * set aside, named in `skipped` and logged: one mistyped line must not cut the
 * whole team off (#75 review). Nothing is granted that nobody wrote.
 * @param path - the file, `/state/grants.json` in a tenant.
 * @param warn - where a set-aside row is said, once per change of the file.
 * @returns the grant source.
 */
export function fileGrants(path: string, warn: (message: string) => void = () => {}): GrantSource {
  return {
    async names() {
      // The display names of the same file; a file that cannot be read gives none
      // (the grants say why), and a name never changes what anyone may do.
      try {
        const rows = (JSON.parse(await readFile(path, 'utf8')) as { grants?: unknown }).grants
        if (!Array.isArray(rows)) return {}
        // A null-prototype table: a subject named __proto__ or constructor stays a plain key.
        const names: Record<string, string> = Object.create(null) as Record<string, string>
        for (const row of rows) {
          const { subject, name } = row as { subject?: unknown; name?: unknown }
          if (typeof subject === 'string' && isPlainAscii(subject) && typeof name === 'string' && isShownName(name)) {
            names[subject.trim().toLowerCase()] = name.trim()
          }
        }
        return names
      } catch {
        return {}
      }
    },
    async grants() {
      let rows = await readRows(path)
      // A rewrite in progress (a truncated or half-written file) reads as broken
      // once: read again before concluding the file is.
      if (!rows.ok) rows = await new Promise<RowsRead>((resolve) => { setTimeout(() => { void readRows(path).then(resolve) }, REREAD_MS) })
      if (!rows.ok) return rows
      const grants: Grant[] = []
      const skipped: SkippedGrant[] = []
      for (const [index, row] of rows.rows.entries()) {
        const reason = rowRefusal(row)
        if (reason !== undefined) {
          skipped.push({ row: index + 1, reason })
          continue
        }
        const { subject, role } = row as { subject: string; role: unknown }
        grants.push({ subject: subject.trim().toLowerCase(), role: asRole(role) as Grant['role'] })
      }
      if (skipped.length > 0) logSkipped(`the role file ${path}`, skipped, warn)
      return skipped.length > 0 ? { ok: true, grants, skipped } : { ok: true, grants }
    },
  }
}
