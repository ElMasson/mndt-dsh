/**
 * The one rule for a failure that is served (an HTTP answer, a machine tool's
 * answer, a mission, a role table's reason): the host's words, never words it
 * did not write. A Refusal (core/refusal.ts) is the host's own sentence, meant
 * for whoever asked, and is served as such. Anything else (a network call, a
 * provider, the file system, a parser) may carry an internal detail (a path, an
 * address, a provider's identifier, a file's content): what is served is the
 * fixed sentence of the caller, and the error itself goes to the operator's log.
 *
 * Every served failure goes through publicFailure: a guard test
 * (publicFailure.spec.ts) refuses `messageOf(error)`, `error.message` or a raw
 * error in an answer anywhere else.
 */
import { Refusal } from './core/index.ts'
import { StateFileError } from './core/index.ts'
import { errorShape } from './operator-log.ts'

/**
 * @param error - what failed.
 * @param fallback - the fixed sentence served when it is not the host's refusal.
 * @param log - the operator's log (warnOperator, or the API's warn).
 * @param where - what was being done, the log line's head (« internal error on POST /channels »).
 * @returns what may be served of it.
 */
export function publicFailure(error: unknown, fallback: string, log: (line: string) => void, where = 'internal error'): string {
  if (error instanceof Refusal) return error.message
  log(`mndt: ${where}: ${rawDetail(error)}`)
  return fallback
}

/** @param error - anything thrown. @returns whether it is the host's own refusal (served as such). */
export function isRefusal(error: unknown): error is Refusal {
  return error instanceof Refusal
}

/**
 * @param error - an error the host did not write.
 * @returns what the operator's log says of it: a SyntaxError by its name and
 * position only (Node's message quotes the text it read), a state file error
 * with its path, any other by its name and message.
 */
export function rawDetail(error: unknown): string {
  if (error instanceof SyntaxError) return errorShape(error)
  if (error instanceof StateFileError) return `${error.name}: ${error.message} (${error.path})`
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
