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

/** @param ctx - the plugin context. @param message - one line, prefixed « mndt: ». */
export function warnOperator(ctx: Pick<Context, 'logger'>, message: string): void {
  ctx.logger.warn(message)
  process.stderr.write(`${message.replace(/[\r\n]+/g, ' ')}\n`)
}
