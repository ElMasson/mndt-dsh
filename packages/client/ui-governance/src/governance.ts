/**
 * Governance controller, Host-side.
 *
 * This is the only place that changes the grant table. Two rules make it the
 * authority rather than a convenience over `RbacTable`:
 *
 * - every mutation names its actor and is refused unless that actor holds
 *   `rights.write`; a caller cannot bypass the check by calling the table;
 * - a refused mutation changes nothing and is persisted by nobody, so a UI that
 *   ignores the answer still leaves the truth intact.
 *
 * Storage is an injected port. The controller never touches the filesystem, so
 * the rules are testable without a Cordis context and without a real home
 * directory.
 */
import { RbacTable, type Capability, type Decision, type Grant, type RbacSnapshot } from './rbac.ts'

/** Persistence port. A Host implementation backs it with a file or a store. */
export interface RbacStorage {
  /** @returns the persisted snapshot, or an empty one when nothing was stored yet. */
  load(): Promise<RbacSnapshot>
  /** @param snapshot - the complete table to persist. */
  save(snapshot: RbacSnapshot): Promise<void>
}

/** In-memory storage, for tests and for a first run without a home directory. */
export class MemoryRbacStorage implements RbacStorage {
  #snapshot: RbacSnapshot = { grants: [] }

  /** @returns the last saved snapshot. */
  async load(): Promise<RbacSnapshot> {
    return { grants: this.#snapshot.grants.map(grant => ({ ...grant })) }
  }

  /** @param snapshot - replaces the stored grants. */
  async save(snapshot: RbacSnapshot): Promise<void> {
    this.#snapshot = { grants: snapshot.grants.map(grant => ({ ...grant })) }
  }
}

/** The controller. Holds the table, guards mutations, persists accepted ones. */
export class GovernanceController {
  #table = new RbacTable()
  #loaded = false
  readonly #storage: RbacStorage

  /**
   * @param storage - where accepted mutations are persisted.
   */
  constructor(storage: RbacStorage = new MemoryRbacStorage()) {
    this.#storage = storage
  }

  /** Load the persisted table. Safe to call more than once. */
  async load(): Promise<void> {
    this.#table = RbacTable.fromSnapshot(await this.#storage.load())
    this.#loaded = true
  }

  /** @returns whether `load()` has run. */
  get loaded(): boolean {
    return this.#loaded
  }

  /** @returns every grant, weakest first. */
  list(): readonly Grant[] {
    return this.#table.list()
  }

  /**
   * Decide one capability for one subject.
   * @param subject - the acting identity.
   * @param capability - what it wants to do.
   * @param scope - the targeted resource, when there is one.
   * @returns the decision, with its reason.
   */
  decide(subject: string, capability: Capability, scope?: string): Decision {
    return this.#table.decide(subject, capability, scope)
  }

  /**
   * Record a grant on behalf of an actor.
   *
   * Refused when the actor does not hold `rights.write`, so a viewer cannot
   * promote themselves by calling this method directly.
   * @param actor - who is asking.
   * @param grant - the grant to record.
   * @returns the decision; the table is persisted only when allowed.
   */
  async setGrant(actor: string, grant: Grant): Promise<Decision> {
    const allowed = this.#table.decide(actor, 'rights.write', grant.scope)
    if (!allowed.allowed) return allowed

    const decision = this.#table.set(grant)
    if (decision.allowed) await this.#storage.save(this.#table.snapshot())
    return decision
  }

  /**
   * Remove a grant on behalf of an actor.
   * @param actor - who is asking.
   * @param subject - whose grant to remove.
   * @param scope - undefined targets the global grant only.
   * @returns the decision; the table is persisted only when allowed.
   */
  async removeGrant(actor: string, subject: string, scope?: string): Promise<Decision> {
    const allowed = this.#table.decide(actor, 'rights.write', scope)
    if (!allowed.allowed) return allowed

    const decision = this.#table.remove(subject, scope)
    if (decision.allowed) await this.#storage.save(this.#table.snapshot())
    return decision
  }

  /**
   * Bootstrap the first owner when the table is empty.
   *
   * Without this, a fresh install has no one able to grant anything: the table
   * would be safe and useless. It only fires on an empty table, never to
   * override an existing owner.
   * @param subject - the identity to make owner.
   * @returns the decision.
   */
  async bootstrapOwner(subject: string): Promise<Decision> {
    if (this.#table.list().length > 0) {
      return { allowed: false, reason: 'the table already has grants; bootstrap does not apply' }
    }
    const decision = this.#table.set({ subject, role: 'owner' })
    if (decision.allowed) await this.#storage.save(this.#table.snapshot())
    return decision
  }

  /** @returns the persisted shape, for a Host that inspects or exports it. */
  snapshot(): RbacSnapshot {
    return this.#table.snapshot()
  }
}
