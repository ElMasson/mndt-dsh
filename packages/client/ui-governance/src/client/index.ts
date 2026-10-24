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
import { GovernanceIcon } from './GovernanceIcon.tsx'
import { GovernancePage } from './GovernancePage.tsx'
import { installGovernanceStyles } from './styles.ts'
import { en, zh } from './locales.ts'
import type { GovernanceKey } from './locales.ts'
import type { TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { governance: GovernanceKey }
}

export { GovernancePage } from './GovernancePage.tsx'
export type { GovernanceKey } from './locales.ts'


/** Rejection used when the Host never published the governance Remote face. */
const unavailable = (): Promise<never> => Promise.reject(
  new Error('the governance Remote is not mounted on this workstation, so this page cannot read the table'),
)

/**
 * The Host face, or a stand-in that explains its absence.
 *
 * `ctx.get` rather than the property read on purpose: the property form is
 * reserved to services a plugin declares in `inject`, and this page must not
 * declare `remote.governance` — the api-remotes assembly mounts that namespace
 * asynchronously, so declaring it would park this page until the mount and fail
 * the whole Client boot when a Host never publishes an authority. Reading
 * through `ctx.get` keeps the face optional: present once mounted, and an
 * explicit "not mounted" rejection (never a silent empty table) when it is not.
 * @param ctx - Client root context.
 * @returns the mounted namespace, or one whose every call rejects with the reason.
 */
function governanceFace(ctx: ClientContext): TypertRemoteNamespaceMap['governance'] {
  const mounted: TypertRemoteNamespaceMap['governance'] | undefined = ctx.get('remote.governance')
  if (mounted !== undefined) return mounted
  return {
    list: unavailable,
    decide: unavailable,
    setGrant: unavailable,
    removeGrant: unavailable,
    bootstrapOwner: unavailable,
    automations: unavailable,
    createAutomation: unavailable,
    setAutomationEnabled: unavailable,
    deleteAutomation: unavailable,
    runAutomationNow: unavailable,
    agents: unavailable,
    connectors: unavailable,
    workspaces: unavailable,
    tableState: unavailable,
  }
}

/** Required services: the slot registry, the copy registry, and the Remote transport. */
export const inject = ['slots', 'locale', 'remote']

const NS = 'governance'

/**
 * Install governance copy and its page surface.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-governance: dictionaries')
  ctx.effect(installGovernanceStyles, 'ui-governance: styles')
  const t = ctx.locale.bind(NS)
  // The page lives in the main content area, keyed by the same id the sidebar
  // entry carries: clicking that entry selects this key. Rendering the page from
  // the panellist row itself is what confined it to the sidebar column.
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: 'governance',
    locale: NS,
    // Resolved on the page's first render, never during this plugin's apply:
    // the namespace is still being mounted then, and a read at apply time would
    // freeze the stand-in before the Host face exists.
    inject: () => ({ t, api: governanceFace(ctx) }),
  }, GovernancePage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: 'governance',
    order: 20,
    locale: NS,
    label: () => t('title'),
  }, GovernanceIcon))
}
