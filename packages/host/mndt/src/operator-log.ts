/**
 * What the workbench tells its operator.
 *
 * The bundles mount no log exporter, so a plugin's `ctx.logger.warn` reaches
 * nothing an operator reads: on 23/11 the integration rehearsal showed that
 * neither the web log nor the container output carried a single mndt warning
 * (a role-file row set aside, a mandate retired on load, a missing gateway
 * secret). Each warning is written to the process's standard error as well,
 * which the image's entrypoint sends to the web log (DSH_MNDT_WEB_LOG on a
 * team tenant): the logger stays for a future exporter.
 */
import type { Context } from '@deepseek-ai/cordis'

/** The longest line written: a warning names a fact, it never carries a document. */
export const MAX_OPERATOR_LINE = 1000

// A closed standard error (EPIPE) must not bring the workbench down through
// an 'error' event nobody listens to: a warning that cannot be written is lost,
// the process goes on.
process.stderr.on('error', () => undefined)

/**
 * @param message - a warning; parts of it may come from the state or from
 * files people write (a mandate's parties, an automation's author, an error).
 * @returns it on one plain line: control characters (terminal escapes, NUL),
 * DEL and the Unicode line and paragraph separators become a space, so a value
 * cannot forge another « mndt: » line nor drive the terminal reading the log;
 * at most MAX_OPERATOR_LINE characters.
 */
export function operatorLine(message: string): string {
  const flat = message.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
  return flat.length <= MAX_OPERATOR_LINE ? flat : `${flat.slice(0, MAX_OPERATOR_LINE - 1)}…`
}

/** @param ctx - the plugin context. @param message - one fact, prefixed « mndt: ». */
export function warnOperator(ctx: Pick<Context, 'logger'>, message: string): void {
  const line = operatorLine(message)
  ctx.logger.warn(line)
  process.stderr.write(`${line}\n`)
}

/** The last warning said for each recurring check, so a check run every minute speaks once. */
const said = new Map<string, string>()

/**
 * Say a warning of a check that runs again and again (the automations tick):
 * once when it starts, again only when it changes, never at every pass.
 * @param ctx - the plugin context.
 * @param key - the check.
 * @param message - its warning.
 */
export function warnOperatorOnce(ctx: Pick<Context, 'logger'>, key: string, message: string): void {
  if (said.get(key) === message) return
  said.set(key, message)
  warnOperator(ctx, message)
}

/** @param key - a recurring check that passes again: its next failure is said anew. */
export function clearOperatorWarning(key: string): void {
  said.delete(key)
}

/**
 * @param error - an error reading a file people write.
 * @returns what it is without its text: its name, its code, and for a JSON
 * syntax error its position. Node's JSON errors quote the start of the input,
 * which for the automations is a prompt.
 */
export function errorShape(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error'
  const code = (error as { code?: unknown }).code
  const position = error instanceof SyntaxError ? /\bposition (\d+)/.exec(error.message)?.[1] : undefined
  return [error.name, typeof code === 'string' ? code : undefined, position === undefined ? undefined : `at position ${position}`]
    .filter(part => part !== undefined)
    .join(' ')
}
