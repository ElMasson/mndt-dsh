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
    // The host answers JSON strings, so the transport envelope is unwrapped
    // first and the payload parsed: a refusal keeps its own message.
    const raw = async (work: () => Promise<unknown>): Promise<Record<string, unknown>> => {
      const answer = await work()
      const envelope = answer as { readonly ok?: unknown; readonly value?: unknown; readonly error?: unknown } | null
      if (envelope !== null && typeof envelope === 'object' && 'ok' in envelope) {
        if (envelope.ok === false) throw new Error(typeof envelope.error === 'string' ? envelope.error : 'the Host refused the call')
        return JSON.parse(String(envelope.value)) as Record<string, unknown>
      }
      return JSON.parse(String(answer)) as Record<string, unknown>
    }
    const fail = (parsed: Record<string, unknown>): never => {
      throw new Error(typeof parsed.error === 'string' ? parsed.error : 'the Host refused the call')
    }
    return {
      state: async () => {
        const parsed = await raw(() => mounted.state())
        if (parsed.ok === false) fail(parsed)
        return parsed.page as never
      },
      runMission: async (kind, prompt) => (await raw(() => mounted.runMission(kind, prompt))) as never,
      decide: async (id, decision, reason) => (await raw(() => mounted.decide(id, decision, reason))) as never,
      approveBrief: async id => (await raw(() => mounted.approveBrief(id))) as never,
      remember: async (scope, kind, text) => (await raw(() => mounted.remember(scope, kind, text))) as never,
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
