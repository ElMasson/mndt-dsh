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
import { CollabPage } from './CollabPage.tsx'
import type { MndtFace } from './face.ts'
import { createHttpFace, probe } from './httpFace.ts'
import { createHttpChat } from './httpChat.ts'
import type { ChatFace } from './chat.ts'
import { CHAT_NS, chatEn, chatFr, chatZh } from './chatLocales.ts'
import type { ChatKey } from './chatLocales.ts'
import { CSS } from './styles.ts'
import { en, fr, zh } from './locales.ts'
import type { MndtKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { mndt: MndtKey; 'mndt.chat': ChatKey }
}

export type { MndtKey } from './locales.ts'

const NS = 'mndt'

/** @param message - what the page should say. @returns a face whose every call refuses. */
function absentFace(message: string): MndtFace {
  const refuse = (): Promise<never> => Promise.reject(new Error(message))
  return {
    state: refuse,
    runMission: refuse,
    cancelMission: refuse,
    search: refuse,
    retryMission: refuse,
    decide: refuse,
    approveBrief: refuse,
    remember: refuse,
    shareMission: refuse,
    shareMemory: refuse,
    members: refuse,
    grantMember: refuse,
    revokeMember: refuse,
    usage: refuse,
    schedule: refuse,
    setSchedule: refuse,
    machineCapture: refuse,
    browserAct: refuse,
    browserStop: refuse,
    desktopAct: refuse,
    desktopStop: refuse,
    createMandate: refuse,
    signMandate: refuse,
    retireMandate: refuse,
    journal: refuse,
    automations: refuse,
    saveAutomation: refuse,
    toggleAutomation: refuse,
    runAutomationNow: refuse,
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
    cancelMission: async id => (await raw(() => mounted.cancelMission(id))) as never,
    search: async query => ((await raw(() => mounted.search(query))) as { hits: never }).hits,
    retryMission: async id => (await raw(() => mounted.retryMission(id))) as never,
    decide: async (id, decision, reason) => (await raw(() => mounted.decide(id, decision, reason))) as never,
    approveBrief: async id => (await raw(() => mounted.approveBrief(id))) as never,
    remember: async (scope, kind, text) => (await raw(() => mounted.remember(scope, kind, text))) as never,
    shareMission: async (id, visibility) => (await raw(() => mounted.shareMission(id, visibility))) as never,
    members: async () => (await raw(() => mounted.members())) as never,
    grantMember: async (subject, role) => (await raw(() => mounted.grantMember(subject, role))) as never,
    revokeMember: async subject => (await raw(() => mounted.revokeMember(subject))) as never,
    usage: async () => (await raw(() => mounted.usage())) as never,
    schedule: async () => (await raw(() => mounted.schedule())) as never,
    setSchedule: async at => (await raw(() => mounted.setSchedule(at))) as never,
    machineCapture: async url => (await raw(() => mounted.machineCapture(url))) as never,
    browserAct: async input => await raw(() => mounted.browserAct(input)),
    desktopAct: async input => await raw(() => mounted.desktopAct(input)),
    desktopStop: async () => await raw(() => mounted.desktopStop()),
    createMandate: async input => (await raw(() => mounted.createMandate(input))) as never,
    signMandate: async id => (await raw(() => mounted.signMandate(id))) as never,
    retireMandate: async id => (await raw(() => mounted.retireMandate(id))) as never,
    journal: async format => await raw(() => mounted.journal(format)),
    automations: async () => (await raw(() => mounted.automations())) as never,
    saveAutomation: async input => (await raw(() => mounted.saveAutomation(input))) as never,
    toggleAutomation: async (id, enabled) => (await raw(() => mounted.toggleAutomation(id, enabled))) as never,
    runAutomationNow: async id => (await raw(() => mounted.runAutomationNow(id))) as never,
    browserStop: async () => await raw(() => mounted.browserStop()),
    shareMemory: async (id, scope) => (await raw(() => mounted.shareMemory(id, scope))) as never,
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
/**
 * The team channels, over the product API only: where the API is not served, every call refuses
 * with that reason, and the page says the channels are not served here.
 * @returns the channel face.
 */
function chatFace(): ChatFace {
  const http = createHttpChat()
  const served = probe()
  const route = async <T>(pick: (face: ChatFace) => Promise<T>): Promise<T> => {
    // A workspace that is down keeps the HTTP face: its calls say so, and recover when it is back.
    if ((await served) === 'absent') throw new Error('the product API is not served on this workstation')
    return pick(http)
  }
  return {
    channels: () => route(next => next.channels()),
    createChannel: input => route(next => next.createChannel(input)),
    messages: channelId => route(next => next.messages(channelId)),
    changes: (channelId, since) => route(next => next.changes(channelId, since)),
    post: (channelId, text, replyTo) => route(next => next.post(channelId, text, replyTo)),
    remove: (channelId, messageId) => route(next => next.remove(channelId, messageId)),
    cards: () => route(next => next.cards()),
    agents: () => route(next => next.agents()),
    addAgents: (channelId, agentIds) => route(next => next.addAgents(channelId, agentIds)),
  }
}

function face(ctx: ClientContext): MndtFace {
  const http = createHttpFace()
  const remote = remoteFace(ctx)
  const choice = probe().then((served): MndtFace => {
    // Down is not absent: the page keeps the HTTP face, says the workspace does not answer, and
    // « Réessayer » reaches it again once it is back.
    if (served !== 'absent') return http
    if (remote !== undefined) return remote
    return absentFace('neither the product API nor the mndt Remote is mounted on this workstation')
  })
  const route = async <T>(pick: (face: MndtFace) => Promise<T>): Promise<T> => pick(await choice)
  return {
    state: () => route(next => next.state()),
    runMission: (kind, prompt) => route(next => next.runMission(kind, prompt)),
    cancelMission: id => route(next => next.cancelMission(id)),
    search: query => route(next => next.search(query)),
    retryMission: id => route(next => next.retryMission(id)),
    decide: (approvalId, decision, reason) => route(next => next.decide(approvalId, decision, reason)),
    approveBrief: briefId => route(next => next.approveBrief(briefId)),
    remember: (scope, kind, text) => route(next => next.remember(scope, kind, text)),
    shareMission: (id, visibility) => route(next => next.shareMission(id, visibility)),
    members: () => route(next => next.members()),
    grantMember: (subject, role) => route(next => next.grantMember(subject, role)),
    revokeMember: subject => route(next => next.revokeMember(subject)),
    usage: () => route(next => next.usage()),
    schedule: () => route(next => next.schedule()),
    setSchedule: at => route(next => next.setSchedule(at)),
    machineCapture: url => route(next => next.machineCapture(url)),
    browserAct: input => route(next => next.browserAct(input)),
    desktopAct: input => route(next => next.desktopAct(input)),
    desktopStop: () => route(next => next.desktopStop()),
    createMandate: input => route(next => next.createMandate(input)),
    signMandate: id => route(next => next.signMandate(id)),
    retireMandate: id => route(next => next.retireMandate(id)),
    journal: format => route(next => next.journal(format)),
    automations: () => route(next => next.automations()),
    saveAutomation: input => route(next => next.saveAutomation(input)),
    toggleAutomation: (id, enabled) => route(next => next.toggleAutomation(id, enabled)),
    runAutomationNow: id => route(next => next.runAutomationNow(id)),
    browserStop: () => route(next => next.browserStop()),
    shareMemory: (id, scope) => route(next => next.shareMemory(id, scope)),
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
  // French, as a language pack: the language (falling back to English), then this page's copy.
  ctx.effect(
    () => ctx.locale.addLanguage({ id: 'fr', label: 'Français', fallback: 'en' }),
    'ui-mndt: French',
  )
  ctx.effect(() => ctx.locale.register(NS, 'fr', fr), 'ui-mndt: French dictionary')
  ctx.effect(() => ctx.locale.register(CHAT_NS, { zh: chatZh, en: chatEn }), 'ui-mndt: channel dictionaries')
  ctx.effect(() => ctx.locale.register(CHAT_NS, 'fr', chatFr), 'ui-mndt: channel dictionary, French')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.id = 'mndt-workbench-styles'
    style.textContent = CSS
    document.head.append(style)
    return () => { style.remove() }
  }, 'ui-mndt: styles')
  const t = ctx.locale.bind(NS)
  const chat = chatFace()
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: 'mndt',
    locale: NS,
    inject: () => ({ api: face(ctx), t: ctx.locale.bind(NS), chat, tc: ctx.locale.bind(CHAT_NS) }),
  }, CollabPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: 'mndt',
    order: 8,
    locale: NS,
    label: () => t('title'),
  }, MndtIcon))
}
