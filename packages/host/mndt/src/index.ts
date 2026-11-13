/**
 * The mndt workbench host plugin.
 *
 * One gateway owns the product service, the identity this workstation acts as,
 * and the grant table it asks before anything changes. The HTTP face starts only
 * when a deployment gives it a port; mounting this plugin on a workstation costs
 * nothing else.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { WorkbenchGateway } from './gateway.ts'
import type { MndtConfig } from './gateway.ts'

export type * from './gateway.ts'
export type * from './types.ts'
export { WorkbenchGateway } from './gateway.ts'
export type { MndtConfig } from './gateway.ts'
export { authorityGrants, fileGrants, localGrants } from './grants.ts'
export { DshMissionRunner, DshTurnRunner, defaultFrame, mcpServerOf } from './runner.ts'
export { TurnScheduler, channelFolder } from './turns.ts'
export type { TurnEngine, TurnInput, TurnOutput } from './turns.ts'
export { createMndtApi, startMndtApi } from './api.ts'
export type { ConnectorInfo, MissionRunner, MndtApiOptions } from './api.ts'
export { loadTokens } from './identity.ts'
export type { IdentityOptions, ProvisionedToken } from './identity.ts'
export { can, roleOf } from './policy.ts'
export type { GrantSource } from './policy.ts'

/** Plugin name. */
export const name = 'mndt'

/**
 * Mount the product.
 * @param ctx - plugin context.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config: MndtConfig = {}): void {
  ctx.plugin(WorkbenchGateway, config)
}
