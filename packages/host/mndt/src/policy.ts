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

/** A row of the role table set aside: its number (from 1) and why. */
export interface SkippedGrant {
  readonly row: number
  readonly reason: string
}

/** The grant table as read: the grants and the rows set aside, or why it could not be read. */
export type GrantTable =
  | { readonly ok: true; readonly grants: readonly Grant[]; readonly skipped?: readonly SkippedGrant[] }
  | { readonly ok: false; readonly reason: string }

/** A source of the grant table: the authority when in team mode, a file otherwise. */
export interface GrantSource {
  /**
   * @returns the display name of each person who declares one (lower-case e-mail to name), empty when unknown.
   * A name is shown only; it never grants anything.
   */
  names?(): Promise<Readonly<Record<string, string>>>
  /**
   * @returns the grants, or the reason they could not be read. `skipped` names the
   * rows set aside (an invalid row grants nothing, the others are still served).
   */
  grants(): Promise<GrantTable>
}
