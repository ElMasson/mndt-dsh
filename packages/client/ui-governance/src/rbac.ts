/**
 * Team RBAC, Host-side.
 *
 * This module is the authority for who may do what. It lives in the Host half
 * on purpose: a rule evaluated in the browser is a suggestion, because the
 * browser belongs to the user. Every decision here returns a value the caller
 * must act on; nothing throws on a simple denial, so a caller cannot turn a
 * refusal into an empty list by accident.
 *
 * Five surfaces, two levels each: reading a surface and changing it are
 * separate capabilities. A viewer can read sharing state without being able to
 * change it, which is the whole point of having more than one level.
 */

/** The five governance surfaces the page exposes. */
export type Surface = 'connectors' | 'agents' | 'workflows' | 'rights' | 'sharing'

/** Named roles. Ordered from least to most powerful. */
export type Role = 'viewer' | 'operator' | 'admin' | 'owner'

/** A capability is `<surface>.read` or `<surface>.write`. */
export type Capability = `${Surface}.read` | `${Surface}.write`

/** One grant: a subject holding a role, optionally scoped to a resource. */
export interface Grant {
  /** Stable subject identity (user id, team id, or a bot name). */
  readonly subject: string
  readonly role: Role
  /**
   * Optional narrowing. Absent means the grant applies to everything; present
   * means only to that resource. A scoped grant is how sharing stays possible
   * without making everyone an admin.
   */
  readonly scope?: string
}

/** The persisted shape. Kept plain JSON so a store can round-trip it. */
export interface RbacSnapshot {
  readonly grants: readonly Grant[]
}

/** A decision plus the reason, because a refusal must explain itself. */
export interface Decision {
  readonly allowed: boolean
  readonly reason: string
}

const ORDER: readonly Role[] = ['viewer', 'operator', 'admin', 'owner']

const SURFACES: readonly Surface[] = ['connectors', 'agents', 'workflows', 'rights', 'sharing']

/** Which capabilities each role grants. Cumulative, written out to stay readable. */
const ROLE_CAPABILITIES: Readonly<Record<Role, readonly Capability[]>> = {
  viewer: ['connectors.read', 'agents.read', 'workflows.read', 'rights.read', 'sharing.read'],
  operator: [
    'connectors.read', 'connectors.write',
    'agents.read', 'agents.write',
    'workflows.read', 'workflows.write',
    'rights.read',
    'sharing.read',
  ],
  admin: [
    'connectors.read', 'connectors.write',
    'agents.read', 'agents.write',
    'workflows.read', 'workflows.write',
    'rights.read', 'rights.write',
    'sharing.read', 'sharing.write',
  ],
  owner: [
    'connectors.read', 'connectors.write',
    'agents.read', 'agents.write',
    'workflows.read', 'workflows.write',
    'rights.read', 'rights.write',
    'sharing.read', 'sharing.write',
  ],
}

/** All capabilities, for validation and for the page's legend. */
export const ALL_CAPABILITIES: readonly Capability[] = SURFACES.flatMap(
  (surface): Capability[] => [`${surface}.read`, `${surface}.write`],
)

/**
 * Parse an untrusted value into a role.
 * @param value - candidate role name.
 * @returns the role, or undefined when the name is not a role.
 */
export function asRole(value: unknown): Role | undefined {
  return typeof value === 'string' && (ORDER as readonly string[]).includes(value)
    ? (value as Role)
    : undefined
}

/**
 * Compare two roles.
 * @param a - first role.
 * @param b - second role.
 * @returns negative when a is weaker, positive when stronger, 0 when equal.
 */
export function compareRoles(a: Role, b: Role): number {
  return ORDER.indexOf(a) - ORDER.indexOf(b)
}

/**
 * Capabilities a role carries.
 * @param role - the role.
 * @returns its capability list.
 */
export function capabilitiesOf(role: Role): readonly Capability[] {
  return ROLE_CAPABILITIES[role]
}

/** The grant table, with the invariants that make it safe to persist. */
export class RbacTable {
  #grants: Grant[] = []

  /**
   * Build a table from a snapshot.
   * @param snapshot - persisted grants; unknown roles are dropped rather than trusted.
   * @returns the table.
   */
  static fromSnapshot(snapshot: RbacSnapshot): RbacTable {
    const table = new RbacTable()
    for (const grant of snapshot.grants) {
      const role = asRole(grant.role)
      if (role === undefined || grant.subject.trim() === '') continue
      table.#grants.push({ subject: grant.subject, role, ...(grant.scope === undefined ? {} : { scope: grant.scope }) })
    }
    return table
  }

  /** @returns a plain snapshot safe to persist. */
  snapshot(): RbacSnapshot {
    return { grants: this.#grants.map(grant => ({ ...grant })) }
  }

  /** @returns every grant, weakest first, for display. */
  list(): readonly Grant[] {
    return [...this.#grants].sort(
      (a, b) => compareRoles(a.role, b.role) || a.subject.localeCompare(b.subject),
    )
  }

  /**
   * Add or replace a subject's grant.
   *
   * A last owner cannot be demoted: a table where nobody holds `owner` has no
   * one able to restore it, which is a lock-out, not a permission.
   * @param grant - the grant to record.
   * @returns the decision; a refusal leaves the table untouched.
   */
  set(grant: Grant): Decision {
    if (grant.subject.trim() === '') return { allowed: false, reason: 'a grant names its subject' }
    const role = asRole(grant.role)
    if (role === undefined) return { allowed: false, reason: `unknown role: ${String(grant.role)}` }

    const previous = this.#grants.find(
      item => item.subject === grant.subject && item.scope === grant.scope,
    )
    if (previous !== undefined && previous.role === 'owner' && role !== 'owner') {
      const owners = this.#grants.filter(item => item.role === 'owner').length
      if (owners <= 1) {
        return {
          allowed: false,
          reason: `${grant.subject} is the last owner: promote someone else before demoting them`,
        }
      }
    }

    this.#grants = this.#grants.filter(
      item => !(item.subject === grant.subject && item.scope === grant.scope),
    )
    this.#grants.push({ subject: grant.subject, role, ...(grant.scope === undefined ? {} : { scope: grant.scope }) })
    return { allowed: true, reason: `${grant.subject} is now ${role}` }
  }

  /**
   * Remove a subject's grant.
   * @param subject - whose grant to remove.
   * @param scope - undefined removes the global grant only; a string targets that scope.
   * @returns the decision; the last owner cannot be removed.
   */
  remove(subject: string, scope?: string): Decision {
    const target = this.#grants.find(item => item.subject === subject && item.scope === scope)
    if (target === undefined) return { allowed: false, reason: `no grant for ${subject}` }
    if (target.role === 'owner') {
      const owners = this.#grants.filter(item => item.role === 'owner').length
      if (owners <= 1) {
        return { allowed: false, reason: `${subject} is the last owner: the table would lock out` }
      }
    }
    this.#grants = this.#grants.filter(item => item !== target)
    return { allowed: true, reason: `grant removed for ${subject}` }
  }

  /**
   * Effective capabilities of a subject, global grants plus those scoped to the resource.
   * @param subject - whose capabilities to compute.
   * @param scope - the resource being touched, when there is one.
   * @returns the union of capabilities.
   */
  capabilitiesFor(subject: string, scope?: string): readonly Capability[] {
    const held = new Set<Capability>()
    for (const grant of this.#grants) {
      if (grant.subject !== subject) continue
      if (grant.scope !== undefined && grant.scope !== scope) continue
      for (const capability of capabilitiesOf(grant.role)) held.add(capability)
    }
    return ALL_CAPABILITIES.filter(capability => held.has(capability))
  }

  /**
   * Decide whether a subject may exercise a capability on a resource.
   * @param subject - the acting identity.
   * @param capability - what it wants to do.
   * @param scope - the resource, when the action targets one.
   * @returns the decision with its reason.
   */
  decide(subject: string, capability: Capability, scope?: string): Decision {
    if (!ALL_CAPABILITIES.includes(capability)) {
      return { allowed: false, reason: `unknown capability: ${capability}` }
    }
    const held = this.capabilitiesFor(subject, scope)
    if (held.includes(capability)) {
      return { allowed: true, reason: `${subject} holds ${capability}` }
    }
    return {
      allowed: false,
      reason: `${subject} does not hold ${capability}${scope === undefined ? '' : ` on ${scope}`}`,
    }
  }
}
