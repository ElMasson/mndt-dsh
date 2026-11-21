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
import type { GrantSource } from './policy.ts'

/** Ask the team authority for its grant table. */
export function authorityGrants(options: { baseUrl: string; token: string; timeoutMs?: number }): GrantSource {
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
        for (const row of rows) {
          const subject = (row as { subject?: unknown }).subject
          const role = asRole((row as { role?: unknown }).role)
          if (typeof subject !== 'string' || role === undefined) continue
          const scope = (row as { scope?: unknown }).scope
          grants.push({ subject: subject.trim().toLowerCase(), role, ...(typeof scope === 'string' ? { scope } : {}) })
        }
        return { ok: true, grants }
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

/**
 * A tenant's own role table, in one file (decided by Stephane, 13/11):
 * `{ "grants": [{ "subject": "<email>", "role": "owner|admin|operator|viewer", "name": "<shown>" }] }`,
 * `name` optional (80 characters at most), shown by the team screen and never granting anything.
 *
 * The file is read on every request, so a role changes without a restart.
 * Anything wrong refuses the whole table with its reason (a missing file, a
 * broken JSON, an unknown role, a row without a subject): a partial table read
 * in silence would grant or withhold rights nobody wrote.
 * @param path - the file, `/state/grants.json` in a tenant.
 * @returns the grant source.
 */
export function fileGrants(path: string): GrantSource {
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
          if (typeof subject === 'string' && typeof name === 'string' && isShownName(name)) {
            names[subject.trim().toLowerCase()] = name.trim()
          }
        }
        return names
      } catch {
        return {}
      }
    },
    async grants() {
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (error) {
        const code = (error as { code?: unknown }).code
        return { ok: false, reason: code === 'ENOENT' ? `the role file ${path} is missing` : `cannot read the role file ${path}: ${String(error)}` }
      }
      let rows: unknown
      try {
        rows = (JSON.parse(text) as { grants?: unknown }).grants
      } catch (error) {
        return { ok: false, reason: `the role file ${path} is not JSON: ${error instanceof Error ? error.message : String(error)}` }
      }
      if (!Array.isArray(rows)) return { ok: false, reason: `the role file ${path} has no "grants" list` }
      const grants: Grant[] = []
      for (const [index, row] of rows.entries()) {
        const subject = (row as { subject?: unknown }).subject
        const role = asRole((row as { role?: unknown }).role)
        if (typeof subject !== 'string' || subject.trim() === '' || role === undefined) {
          return { ok: false, reason: `the role file ${path}, row ${index + 1}: a subject (e-mail) and a role among owner, admin, operator, viewer are required` }
        }
        const name = (row as { name?: unknown }).name
        if (name !== undefined && (typeof name !== 'string' || !isShownName(name))) {
          return { ok: false, reason: `the role file ${path}, row ${index + 1}: a name is one line of 80 characters at most, without control characters` }
        }
        grants.push({ subject: subject.trim().toLowerCase(), role })
      }
      return { ok: true, grants }
    },
  }
}
