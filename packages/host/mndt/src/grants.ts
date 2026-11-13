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
export function authorityGrants(options: { baseUrl: string; token: string }): GrantSource {
  return {
    async grants() {
      try {
        const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/governance/snapshot`, {
          headers: { authorization: `Bearer ${options.token}` },
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
          grants.push({ subject, role, ...(typeof scope === 'string' ? { scope } : {}) })
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
 * A tenant's own role table, in one file (decided by Stephane, 13/11):
 * `{ "grants": [{ "subject": "<email>", "role": "owner|admin|operator|viewer" }] }`.
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
        grants.push({ subject: subject.trim().toLowerCase(), role })
      }
      return { ok: true, grants }
    },
  }
}
