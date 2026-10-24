/**
 * What an identity may do here.
 *
 * The grant table is the one the authority already owns: this module only reads
 * it, resolves the highest role a subject holds, and answers capability
 * questions. A refusal always carries its reason, so a route can explain itself
 * instead of returning an empty list.
 */
import { capabilitiesOf } from '@deepseek-ai/dsh-client-ui-governance/src/rbac.ts'
import { compareRoles } from '@deepseek-ai/dsh-client-ui-governance/src/rbac.ts'
import type { Capability, Grant, Role } from '@deepseek-ai/dsh-client-ui-governance/src/rbac.ts'

/** The role an identity holds, if any. */
export function roleOf(grants: readonly Grant[], subject: string): Role | undefined {
  const held = grants.filter(grant => grant.subject === subject)
  if (held.length === 0) return undefined
  return held.reduce<Role>((best, grant) => (compareRoles(grant.role, best) > 0 ? grant.role : best), 'viewer')
}

/**
 * Whether an identity holds one capability.
 * @param grants - the table, as the authority reports it.
 * @param subject - the proven identity.
 * @param capability - what the action needs.
 * @returns the decision and its reason.
 */
export function can(grants: readonly Grant[], subject: string, capability: Capability): { allowed: boolean; reason: string } {
  const role = roleOf(grants, subject)
  if (role === undefined) {
    return { allowed: false, reason: `${subject} holds no role in this team` }
  }
  const capabilities = capabilitiesOf(role)
  return capabilities.includes(capability)
    ? { allowed: true, reason: `${subject} is ${role} and holds ${capability}` }
    : { allowed: false, reason: `${subject} is ${role} and does not hold ${capability}` }
}

/** A source of the grant table: the authority when in team mode, a file otherwise. */
export interface GrantSource {
  /** @returns the grants, or the reason they could not be read. */
  grants(): Promise<{ readonly ok: true; readonly grants: readonly Grant[] } | { readonly ok: false; readonly reason: string }>
}
