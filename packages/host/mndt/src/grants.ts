/**
 * Where the product state lives and who owns it.
 *
 * Kept apart from the plugin entry so the gateway and the HTTP face can both
 * import it without a cycle: a plugin module that imports the module that mounts
 * the plugin is a boot hazard, not a style question.
 */
import { asRole } from '@deepseek-ai/dsh-client-ui-governance/src/rbac.ts'
import type { Grant } from '@deepseek-ai/dsh-client-ui-governance/src/rbac.ts'
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
