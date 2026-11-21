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
  /**
   * @returns the display name of each person who declares one (lower-case e-mail to name), empty when unknown.
   * A name is shown only; it never grants anything.
   */
  names?(): Promise<Readonly<Record<string, string>>>
  /** @returns the grants, or the reason they could not be read. */
  grants(): Promise<{ readonly ok: true; readonly grants: readonly Grant[] } | { readonly ok: false; readonly reason: string }>
}

/**
 * Whether `actor` may move `subject` to `next` (undefined: revoke). The
 * authority is called with this deployment's own token, so these rules are
 * the product's, applied before anything is forwarded:
 * - nobody changes their own role;
 * - an admin never grants owner, nor a role above their own;
 * - only an owner changes or removes an owner's role;
 * - there is always at least one owner left.
 * @param grants - the current table.
 * @param actor - who asks.
 * @param subject - whose role changes.
 * @param next - the new role, or undefined to revoke.
 * @returns the refusal and its status, or undefined when allowed.
 */
export function roleChangeRefusal(
  grants: readonly Grant[],
  actor: string,
  subject: string,
  next: Role | undefined,
): { status: 403 | 409; reason: string } | undefined {
  const actorRole = roleOf(grants, actor)
  if (actorRole === undefined) return { status: 403, reason: `${actor} holds no role in this team` }
  if (subject === actor) return { status: 403, reason: 'nobody changes their own role' }
  const before = roleOf(grants, subject)
  if (actorRole !== 'owner') {
    if (next === 'owner') return { status: 403, reason: 'only an owner grants the owner role' }
    if (next !== undefined && compareRoles(next, actorRole) > 0) {
      return { status: 403, reason: `${actor} is ${actorRole} and cannot grant ${next}` }
    }
    if (before === 'owner') return { status: 403, reason: 'only an owner changes or removes an owner' }
    if (before !== undefined && compareRoles(before, actorRole) > 0) {
      return { status: 403, reason: `${actor} is ${actorRole} and cannot change a ${before}` }
    }
  }
  if (before === 'owner' && next !== 'owner') {
    const owners = new Set(grants.filter(grant => grant.role === 'owner').map(grant => grant.subject))
    owners.delete(subject)
    if (owners.size === 0) return { status: 409, reason: 'the team must keep at least one owner' }
  }
  return undefined
}
