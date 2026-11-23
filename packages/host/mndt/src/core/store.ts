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
  load(): Promise<WorkbenchState> {
    return Promise.resolve(this.#state)
  }

  /** @param state - the state to keep. */
  save(state: WorkbenchState): Promise<void> {
    this.#state = state
    return Promise.resolve()
  }
}

/**
 * The state file cannot be read as a state. An internal fault, never a
 * refusal: its message names no path (a caller may see it), the path is kept
 * apart for the operator's log.
 */
export class StateFileError extends Error {
  readonly path: string
  constructor(message: string, path: string) {
    super(message)
    this.name = 'StateFileError'
    this.path = path
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
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      // Node's message quotes the start of the text read: a team's messages.
      // Only the position is kept.
      const position = error instanceof SyntaxError ? /\bposition (\d+)/.exec(error.message)?.[1] : undefined
      throw new StateFileError(`the workbench state is not JSON${position === undefined ? '' : ` (at position ${position})`}; refusing to overwrite it`, this.#path)
    }
    if (typeof parsed !== 'object' || parsed === null || (parsed as { version?: unknown }).version !== 1) {
      throw new StateFileError('the workbench state is not a version 1 state; refusing to overwrite it', this.#path)
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
