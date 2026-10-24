/**
 * Browser half of the morning page.
 *
 * It registers copy and the page surface, and performs no authorization
 * decision: the Host checks the grant table before anything changes. The Remote
 * face is read after mounting, never during apply, because the namespace is
 * still being mounted then.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { MndtIcon } from './MndtIcon.tsx'
import { MndtPage } from './MndtPage.tsx'
import type { MndtFace, MndtPageProps } from './MndtPage.tsx'
import { CSS } from './styles.ts'
import { en, zh } from './locales.ts'
import type { MndtKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { mndt: MndtKey }
}

export { MndtPage } from './MndtPage.tsx'
export type { MndtKey } from './locales.ts'

const NS = 'mndt'

/** @param ctx - client root context. @returns the mounted face, or one that explains its absence. */
function face(ctx: ClientContext): MndtFace {
  const mounted = ctx.get('remote.mndt') as MndtFace | undefined
  if (mounted !== undefined) {
    // A Remote call resolves through the generated transport, which answers an
    // envelope ({ ok, value | error }) rather than the bare host return value.
    // Unwrap it once here so the page sees the shape it was written against.
    const unwrap = <T>(raw: unknown): T => {
      // Temporary diagnostic: the transport answer is what decides whether this
      // page can render at all, so an unexpected shape must be visible.
      console.warn('mndt raw', JSON.stringify(raw)?.slice(0, 300))
      const record = raw as { readonly ok?: unknown; readonly value?: unknown; readonly error?: unknown } | null
      if (record !== null && typeof record === 'object' && 'ok' in record) {
        if (record.ok === false) {
          throw new Error(typeof record.error === 'string' ? record.error : 'the Host refused the call')
        }
        return (record.value ?? raw) as T
      }
      return raw as T
    }
    return {
      state: async () => unwrap(await mounted.state()),
      runMission: async (kind, prompt) => unwrap(await mounted.runMission(kind, prompt)),
      decide: async (id, decision, reason) => unwrap(await mounted.decide(id, decision, reason)),
      approveBrief: async id => unwrap(await mounted.approveBrief(id)),
      remember: async (scope, kind, text) => unwrap(await mounted.remember(scope, kind, text)),
    }
  }
  const absent = (): Promise<never> => Promise.reject(new Error(
    'the mndt Remote is not mounted on this workstation: the mndt host plugin is missing from this composition',
  ))
  return {
    state: absent,
    runMission: absent,
    decide: absent,
    approveBrief: absent,
    remember: absent,
  }
}

/** Required services: slots, copy and the Remote transport. */
export const inject = ['slots', 'locale', 'remote']

/**
 * Install the page.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-mndt: dictionaries')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.id = 'mndt-workbench-styles'
    style.textContent = CSS
    document.head.append(style)
    return () => { style.remove() }
  }, 'ui-mndt: styles')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: 'mndt',
    locale: NS,
    inject: (): MndtPageProps => ({ t, api: face(ctx) }),
  }, MndtPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: 'mndt',
    order: 8,
    locale: NS,
    label: () => t('title'),
  }, MndtIcon))
}
