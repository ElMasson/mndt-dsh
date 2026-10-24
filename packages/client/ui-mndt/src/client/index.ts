/**
 * Browser half of the morning page.
 *
 * It registers copy and the page surface, and performs no authorization
 * decision: the Host checks the grant table before anything changes. Two
 * transports are possible. Behind the single sign-on front the product API is
 * the only path that knows the person, because the proxy proves them on every
 * request; without that front, the in-process Remote is used for development.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { MndtIcon } from './MndtIcon.tsx'
import { MndtPage } from './MndtPage.tsx'
import type { MndtFace, MndtPageProps } from './MndtPage.tsx'
import { available, createHttpFace } from './httpFace.ts'
import { CSS } from './styles.ts'
import { en, zh } from './locales.ts'
import type { MndtKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { mndt: MndtKey }
}

export { MndtPage } from './MndtPage.tsx'
export type { MndtKey } from './locales.ts'

const NS = 'mndt'

/** @param message - what the page should say. @returns a face whose every call refuses. */
function absentFace(message: string): MndtFace {
  const refuse = (): Promise<never> => Promise.reject(new Error(message))
  return {
    state: refuse,
    runMission: refuse,
    decide: refuse,
    approveBrief: refuse,
    remember: refuse,
    connectors: refuse,
  }
}

/**
 * @param ctx - client root context.
 * @returns the mounted Remote face, or undefined when the Host plugin is missing.
 */
function remoteFace(ctx: ClientContext): MndtFace | undefined {
  const mounted = ctx.get('remote.mndt') as MndtFace | undefined
  if (mounted === undefined) return undefined
  // The host answers JSON strings, so the transport envelope is unwrapped first
  // and the payload parsed: a refusal keeps its own message.
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
    connectors: async () => {
      const answer = await mounted.connectors()
      const envelope = answer as { readonly ok?: unknown; readonly value?: unknown } | null
      const payload = envelope !== null && typeof envelope === 'object' && 'ok' in envelope ? envelope.value : answer
      return (Array.isArray(payload) ? payload : []) as never
    },
  }
}

/**
 * @param ctx - client root context.
 * @returns a face that picks the per-user API when it is served, else the Remote.
 */
function face(ctx: ClientContext): MndtFace {
  const http = createHttpFace()
  const remote = remoteFace(ctx)
  const choice = available().then((served): MndtFace => {
    if (served) return http
    if (remote !== undefined) return remote
    return absentFace('neither the product API nor the mndt Remote is mounted on this workstation')
  })
  const route = async <T>(pick: (face: MndtFace) => Promise<T>): Promise<T> => pick(await choice)
  return {
    state: () => route(next => next.state()),
    runMission: (kind, prompt) => route(next => next.runMission(kind, prompt)),
    decide: (approvalId, decision, reason) => route(next => next.decide(approvalId, decision, reason)),
    approveBrief: briefId => route(next => next.approveBrief(briefId)),
    remember: (scope, kind, text) => route(next => next.remember(scope, kind, text)),
    connectors: () => route(next => next.connectors()),
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
