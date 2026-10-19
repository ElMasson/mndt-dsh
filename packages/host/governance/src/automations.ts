/**
 * User-owned automations.
 *
 * An automation is a prompt a person saved for later, owned by that person. It is
 * deliberately not a shared object: the first cut of this surface keeps ownership
 * strict, so a reader can never list or modify somebody else's automation by
 * guessing an id.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** One saved automation. */
export interface Automation {
  /** Stable identifier. */
  readonly id: string
  /** Who owns it; only that identity may read or modify it. */
  readonly owner: string
  /** The prompt to run. */
  readonly prompt: string
  /** Whether it should run when triggered. */
  readonly enabled: boolean
  /** How often it runs, in minutes. */
  readonly everyMinutes: number
  /** ISO-8601 creation instant. */
  readonly createdAt: string
}

/** Persistence port, so the store is testable without a filesystem. */
export interface AutomationStorage {
  /** @returns every automation on record. */
  load(): Promise<Automation[]>
  /** @param automations - replaces the whole record atomically. */
  save(automations: Automation[]): Promise<void>
}

/** In-memory storage, used by tests and by a host without a writable home. */
export class MemoryAutomationStorage implements AutomationStorage {
  #rows: Automation[] = []

  /** @returns a copy of the rows. */
  async load(): Promise<Automation[]> {
    return this.#rows.map(row => ({ ...row }))
  }

  /** @param automations - the new rows. */
  async save(automations: Automation[]): Promise<void> {
    this.#rows = automations.map(row => ({ ...row }))
  }
}

/** Durable storage, written through a temporary file and a rename. */
export class JsonFileAutomationStorage implements AutomationStorage {
  readonly #path: string

  /** @param path - file to read and write. */
  constructor(path: string) {
    this.#path = path
  }

  /** @returns the persisted automations, or none when the file does not exist. */
  async load(): Promise<Automation[]> {
    try {
      const raw = await readFile(this.#path, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter((row): row is Automation => {
        if (typeof row !== 'object' || row === null) return false
        const candidate = row as Partial<Automation>
        return typeof candidate.id === 'string'
          && typeof candidate.owner === 'string'
          && typeof candidate.prompt === 'string'
          && typeof candidate.enabled === 'boolean'
          && typeof candidate.createdAt === 'string'
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  /** @param automations - replaces the stored record atomically. */
  async save(automations: Automation[]): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true })
    const temporary = `${this.#path}.tmp`
    await writeFile(temporary, `${JSON.stringify(automations, null, 2)}\n`, 'utf8')
    await rename(temporary, this.#path)
  }
}

/** What an automation operation answers. */
export interface AutomationOutcome {
  /** Whether the operation was accepted. */
  readonly allowed: boolean
  /** Why, in words the page can show as-is. */
  readonly reason: string
}

/** The automation surface, owned per identity. */
export class AutomationService {
  readonly #storage: AutomationStorage
  readonly #now: () => Date
  #rows: Automation[] | undefined
  #counter = 0

  /**
   * @param storage - persistence port.
   * @param now - clock seam.
   */
  constructor(storage: AutomationStorage, now: () => Date = () => new Date()) {
    this.#storage = storage
    this.#now = now
  }

  /** @returns the loaded rows, loading once. */
  async #load(): Promise<Automation[]> {
    if (this.#rows === undefined) this.#rows = await this.#storage.load()
    return this.#rows
  }

  /**
   * List one identity's automations.
   * @param owner - the identity asking.
   * @returns only that identity's rows.
   */
  async list(owner: string): Promise<Automation[]> {
    const rows = await this.#load()
    return rows.filter(row => row.owner === owner).map(row => ({ ...row }))
  }

  /**
   * Create an automation for one identity.
   * @param owner - the identity creating it.
   * @param prompt - what to run.
   * @returns the created row, or a refusal.
   */
  async create(owner: string, prompt: string, everyMinutes = 60): Promise<Automation | AutomationOutcome> {
    if (owner.trim() === '') return { allowed: false, reason: 'an owner is required' }
    if (prompt.trim() === '') return { allowed: false, reason: 'a prompt is required' }
    if (!Number.isInteger(everyMinutes) || everyMinutes < 1 || everyMinutes > 1440) {
      return { allowed: false, reason: 'the frequency must be 1 to 1440 minutes' }
    }
    const rows = await this.#load()
    this.#counter += 1
    const created: Automation = {
      id: `${this.#now().toISOString()}-${this.#counter}`,
      owner,
      prompt,
      enabled: true,
      everyMinutes,
      createdAt: this.#now().toISOString(),
    }
    this.#rows = [...rows, created]
    await this.#storage.save(this.#rows)
    return created
  }

  /**
   * Enable or disable one of the caller's automations.
   * @param owner - the identity asking.
   * @param id - the automation.
   * @param enabled - the new state.
   * @returns the outcome.
   */
  async setEnabled(owner: string, id: string, enabled: boolean): Promise<AutomationOutcome> {
    const rows = await this.#load()
    const row = rows.find(candidate => candidate.id === id)
    if (row === undefined) return { allowed: false, reason: `no automation ${id}` }
    if (row.owner !== owner) return { allowed: false, reason: 'this automation belongs to someone else' }
    this.#rows = rows.map(candidate => (candidate.id === id ? { ...candidate, enabled } : candidate))
    await this.#storage.save(this.#rows)
    return { allowed: true, reason: enabled ? 'automation enabled' : 'automation disabled' }
  }

  /**
   * Delete one of the caller's automations.
   * @param owner - the identity asking.
   * @param id - the automation.
   * @returns the outcome.
   */
  async remove(owner: string, id: string): Promise<AutomationOutcome> {
    const rows = await this.#load()
    const row = rows.find(candidate => candidate.id === id)
    if (row === undefined) return { allowed: false, reason: `no automation ${id}` }
    if (row.owner !== owner) return { allowed: false, reason: 'this automation belongs to someone else' }
    this.#rows = rows.filter(candidate => candidate.id !== id)
    await this.#storage.save(this.#rows)
    return { allowed: true, reason: 'automation removed' }
  }
}
