/**
 * What a turn did on its actor's computer (« Mon ordinateur »), noted by the API
 * as each action answers and taken once when the turn settles, as the refused
 * tools are (machine-tools.ts). The capture is the last one only, by sobriety.
 */
import type { MachineActivityEntry } from './core/index.ts'

/** The entries a turn keeps, the last ones. */
export const MAX_MACHINE_ACTIVITY = 20
/** The longest command kept on an entry. */
export const MAX_ACTIVITY_COMMAND = 200
/** A run that never settles (a crash) must not grow the map without end. */
const MAX_RUNS_NOTED = 200

interface Noted {
  entries: MachineActivityEntry[]
  /** The last capture, base64 PNG. */
  png?: string
}

const noted = new Map<string, Noted>()

/** @param runId - the run (a turn's id). @returns its record, created at the first note. */
function recordOf(runId: string): Noted {
  let record = noted.get(runId)
  if (record === undefined) {
    record = { entries: [] }
    noted.set(runId, record)
    while (noted.size > MAX_RUNS_NOTED) {
      const oldest = noted.keys().next().value
      if (oldest === undefined) break
      noted.delete(oldest)
    }
  }
  return record
}

/** @param url - an address as served (servedAction). @returns its host, or undefined. */
function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

/**
 * Note one action that answered, from its operation and its served answer.
 * Reading the page (text, screenshot) adds no entry, unless it shows a page
 * other than the last one noted (a click that navigated); its capture becomes
 * the turn's. The text typed is never kept: it can be a password.
 * @param runId - the turn.
 * @param kind - browser, desktop or terminal.
 * @param operation - what was asked (op, url, command…).
 * @param served - the answer as served (url and title already filtered by servedAction).
 * @param at - when.
 */
export function noteMachineAction(
  runId: string,
  kind: string,
  operation: Readonly<Record<string, unknown>>,
  served: Readonly<Record<string, unknown>>,
  at: string,
): void {
  if (runId === '') return
  const record = recordOf(runId)
  const op = typeof operation.op === 'string' ? operation.op : undefined
  const url = typeof served.url === 'string' ? served.url : undefined
  const title = typeof served.title === 'string' ? served.title : undefined
  const page = (): MachineActivityEntry => {
    const host = hostOf(url)
    return { at, kind: 'page', ...(url === undefined ? {} : { url }), ...(host === undefined ? {} : { host }), ...(title === undefined ? {} : { title }) }
  }
  let entry: MachineActivityEntry | undefined
  if (kind === 'terminal') {
    const command = typeof operation.command === 'string' ? [...operation.command].slice(0, MAX_ACTIVITY_COMMAND).join('') : undefined
    entry = { at, kind: 'command', ...(command === undefined || command === '' ? {} : { command }) }
  } else if (op === 'goto' || op === 'open') {
    entry = page()
  } else if (op === 'click') {
    entry = { at, kind: 'click', ...(hostOf(url) === undefined ? {} : { host: hostOf(url) }) }
  } else if (op === 'fill' || op === 'type' || op === 'key') {
    entry = { at, kind: 'type', ...(hostOf(url) === undefined ? {} : { host: hostOf(url) }) }
  } else if ((op === 'text' || op === 'screenshot') && url !== undefined) {
    const last = [...record.entries].reverse().find(candidate => candidate.url !== undefined)
    if (last?.url !== url) entry = page()
  }
  if (entry !== undefined) {
    record.entries.push(entry)
    if (record.entries.length > MAX_MACHINE_ACTIVITY) record.entries.splice(0, record.entries.length - MAX_MACHINE_ACTIVITY)
  }
  if (typeof served.png === 'string' && served.png !== '') {
    record.png = served.png
    // The capture belongs to the last entry: the flag moves with it.
    record.entries = record.entries.map(({ capture: _capture, ...rest }) => rest)
    const lastIndex = record.entries.length - 1
    if (lastIndex >= 0) record.entries[lastIndex] = { ...record.entries[lastIndex] as MachineActivityEntry, capture: true }
  }
}

/** @param runId - a settling turn. @returns what it did and its last capture, forgotten here. */
export function takeMachineActivity(runId: string): { readonly entries: readonly MachineActivityEntry[]; readonly png?: string } {
  const record = noted.get(runId)
  noted.delete(runId)
  if (record === undefined) return { entries: [] }
  // A capture with no entry to carry it (reads only): the capture is not kept.
  const carried = record.entries.some(entry => entry.capture === true)
  return { entries: record.entries, ...(carried && record.png !== undefined ? { png: record.png } : {}) }
}
