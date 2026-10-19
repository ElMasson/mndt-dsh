/**
 * Browser half of the governance page.
 *
 * It registers copy and the page surface. It deliberately performs no
 * authorization decision: the Host half owns the rules, the page only displays
 * and requests. A panel that decided rights in the browser would be a
 * suggestion, not a guard.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the generated Remote projection that types ctx.remote.governance.
import type {} from '@deepseek-ai/dsh-host-governance/remote'
import { GovernancePage } from './GovernancePage.tsx'
import { en, zh } from './locales.ts'
import type { GovernanceKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { governance: GovernanceKey }
}

export { GovernancePage } from './GovernancePage.tsx'
export type { GovernanceKey } from './locales.ts'

/** Required services: the slot registry and the copy registry. */
export const inject = ['slots', 'locale']

const NS = 'governance'

/**
 * Install governance copy and its page surface.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-governance: dictionaries')
  const t = ctx.locale.bind(NS)
  const api = ctx.remote.governance
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: 'governance',
    priority: 0,
    locale: NS,
    inject: () => ({ t, api }),
  }, GovernancePage))
}
