/**
 * Persisting the workbench state.
 *
 * The file store writes through a temporary file and a rename, so a crash mid
 * write cannot leave a half-parsed table behind. A corrupted file is refused
 * loudly instead of being silently replaced by an empty one: losing the team's
 * history without a word is the kind of quiet failure this project refuses.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { emptyState } from './types.ts'
import type { WorkbenchState } from './types.ts'

/** Anything that can load and save the whole state. */
export interface WorkbenchStore {
  load(): Promise<WorkbenchState>
  save(state: WorkbenchState): Promise<void>
}

/** A store that keeps everything in memory, for tests. */
export class MemoryStore implements WorkbenchStore {
  #state: WorkbenchState = emptyState

  /** @returns the state last saved. */
  async load(): Promise<WorkbenchState> {
    return this.#state
  }

  /** @param state - the state to keep. */
  async save(state: WorkbenchState): Promise<void> {
    this.#state = state
  }
}

/** A store backed by one JSON file. */
export class JsonFileStore implements WorkbenchStore {
  readonly #path: string

  /** @param path - the file to read and write. */
  constructor(path: string) {
    this.#path = path
  }

  /** @returns the persisted state, or an empty one when the file is absent. */
  async load(): Promise<WorkbenchState> {
    let text: string
    try {
      text = await readFile(this.#path, 'utf8')
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return emptyState
      throw error
    }
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || (parsed as { version?: unknown }).version !== 1) {
      throw new Error(`workbench state at ${this.#path} is not a version 1 state; refusing to overwrite it`)
    }
    return parsed as WorkbenchState
  }

  /** @param state - the state to persist, atomically. */
  async save(state: WorkbenchState): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true })
    const temporary = `${this.#path}.tmp`
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(temporary, this.#path)
  }
}
