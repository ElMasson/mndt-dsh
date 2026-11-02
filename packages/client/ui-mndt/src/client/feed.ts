/**
 * Pure helpers of the collaboration page.
 *
 * Channels, feed composition and journal wording are computed here so the
 * component stays about rendering, and so the rules can be tested directly.
 */
import type { MemberRow, MandateRow, PageStateRow } from './face.ts'

/** One journal line as the Host reports it. */
export interface EventRow {
  readonly at: string
  readonly actor: string
  readonly action: string
  readonly subject: string
  readonly detail?: string
}

/** The state with the links the collaboration view needs. */
export interface CollabState extends PageStateRow {
  readonly events?: readonly EventRow[]
  readonly members?: readonly MemberRow[]
  readonly missions: readonly (PageStateRow['missions'][number] & { readonly mandateId?: string; readonly briefId?: string })[]
  readonly briefs: readonly (PageStateRow['briefs'][number] & { readonly missionId?: string })[]
  readonly approvals: readonly (PageStateRow['approvals'][number] & { readonly missionId?: string })[]
}

/** One result in the global search. */
export interface SearchHit {
  readonly id: string
  readonly kind: 'channel' | 'mission' | 'brief' | 'approval' | 'mandate' | 'person'
  readonly label: string
  readonly detail: string
}

/** One selectable channel. */
export interface Channel {
  readonly id: string
  readonly kind: 'team' | 'mandate' | 'system'
  readonly name: string
  readonly subject: string
  readonly badge?: number
}

/** One body in the feed. */
export type PostBody =
  | ReturnType<typeof missionPost>
  | { readonly kind: 'brief'; readonly title: string; readonly markdown: string; readonly author: string; readonly at: string }
  | { readonly kind: 'approval'; readonly id: string; readonly title: string; readonly approvalKind: string; readonly author: string; readonly at: string }
  | { readonly kind: 'event'; readonly action: string; readonly actor: string; readonly subject: string; readonly detail?: string | undefined; readonly at: string }

/** Anything the feed can show. */
export interface Post {
  readonly id: string
  readonly at: string
  readonly channel: string
  readonly body: PostBody
}

/** @param count - a number. @param singular - the word for one. @param plural - the word for several. @returns the right word. */
export function word(count: number, singular: string, plural: string): string {
  return count > 1 ? plural : singular
}

/** @param at - ISO time. @returns a short French clock. */
export function clockOf(at: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
}

/** @param at - ISO time. @returns a French day label. */
export function dayOf(at: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
}

/** @param a - ISO time. @returns milliseconds, or zero. */
export function timeOf(a: string): number {
  const value = new Date(a).getTime()
  return Number.isNaN(value) ? 0 : value
}

/** @param state - the page state. @param mandate - one mandate. @returns how many approvals relate to it. */
export function approvalsOfMandate(state: CollabState, mandate: MandateRow): number {
  const linked = state.approvals.filter(approval => approval.missionId !== undefined
    && state.missions.some(mission => mission.id === approval.missionId && mission.mandateId === mandate.id))
  return linked.length
}

/** @param state - the page state. @returns the channels to show. */
export function channelsOf(state: CollabState): Channel[] {
  const mandates = state.mandates ?? []
  const list: Channel[] = [{
    id: 'team',
    kind: 'team',
    name: 'equipe',
    subject: 'Tout ce qui se passe dans Duke Analytics',
  }]
  for (const mandate of mandates) {
    list.push({
      id: `mandate:${mandate.id}`,
      kind: 'mandate',
      /* v8 ignore next -- splitting a string always yields a first element */
      name: mandate.purpose === '' ? mandate.id : `${mandate.purpose} - ${mandate.delegataire.split('@')[0] ?? mandate.delegataire}`,
      subject: `${mandate.delegant} delegue a ${mandate.delegataire}`,
      badge: approvalsOfMandate(state, mandate),
    })
  }
  list.push({
    id: 'system',
    kind: 'system',
    name: 'systeme',
    subject: 'Briefing automatique, refus, expirations, journal',
  })
  return list
}

/**
 * @param mission - the mission.
 * @param brief - its brief, when it has one.
 * @param mandate - its mandate, when it has one.
 * @returns a mission card.
 */
export function missionPost(
  mission: CollabState['missions'][number],
  brief: CollabState['briefs'][number] | undefined,
  mandate: MandateRow | undefined,
) {
  const state = mission.status
  return {
    kind: 'mission' as const,
    title: mission.kind,
    prompt: mission.prompt,
    author: mission.createdBy,
    at: mission.createdAt,
    status: state,
    visibility: mission.visibility ?? 'private',
    mandate: mandate?.purpose,
    brief,
    error: mission.error,
  }
}

/**
 * Build the feed of one channel.
 * @param state - the page state.
 * @param channel - the selected channel.
 * @returns the posts, newest first.
 */
export function feedOf(state: CollabState, channel: Channel): Post[] {
  const mandates = state.mandates ?? []
  const mandateId = channel.kind === 'mandate' ? channel.id.slice('mandate:'.length) : undefined
  const mandate = mandates.find(candidate => candidate.id === mandateId)
  const missions = state.missions.filter((mission) => {
    if (channel.kind === 'system') {
      return mission.createdBy !== state.you
        && !(state.mandates ?? []).some(m => m.delegataire === mission.createdBy && m.state === 'active')
    }
    if (mandateId === undefined) return true
    return mission.mandateId === mandateId
  })
  const missionIds = new Set(missions.map(mission => mission.id))
  const briefs = state.briefs.filter(brief => brief.missionId === undefined || missionIds.has(brief.missionId))
  const posts: Post[] = []
  for (const mission of missions) {
    const brief = state.briefs.find(candidate => candidate.id === mission.briefId)
    posts.push({
      id: `mission:${mission.id}`,
      at: mission.createdAt,
      channel: channel.id,
      body: missionPost(mission, brief, mandate),
    })
  }
  if (channel.kind === 'team') {
    const known = new Set(missions.map(mission => mission.id))
    for (const brief of briefs) {
      if (brief.missionId !== undefined && known.has(brief.missionId)) continue
      posts.push({
        id: `brief:${brief.id}`,
        at: brief.createdAt,
        channel: channel.id,
        body: { kind: 'brief' as const, title: brief.title, markdown: brief.markdown, author: brief.createdBy ?? 'agent', at: brief.createdAt },
      })
    }
  }
  for (const approval of state.approvals) {
    if (channel.kind !== 'team' && (approval.missionId === undefined || !missionIds.has(approval.missionId))) continue
    posts.push({
      id: `approval:${approval.id}`,
      at: approval.requestedAt,
      channel: channel.id,
      body: { kind: 'approval' as const, id: approval.id, title: approval.title, approvalKind: approval.kind, author: approval.requestedBy, at: approval.requestedAt },
    })
  }
  if (channel.kind === 'system' || channel.kind === 'team') {
    for (const event of state.events ?? []) {
      posts.push({
        id: `event:${event.at}:${event.action}:${event.subject}`,
        at: event.at,
        channel: channel.id,
        body: { kind: 'event' as const, action: event.action, actor: event.actor, subject: event.subject, detail: event.detail, at: event.at },
      })
    }
  }
  posts.sort((a, b) => timeOf(b.at) - timeOf(a.at))
  return posts
}

/** @param state - the page state. @returns known human members. */
export function humansOf(state: CollabState): readonly MemberRow[] {
  return state.members ?? []
}

/** @param subject - the identifier an event points at. @returns a readable label. */
export function subjectLabel(subject: string): string {
  if (subject.startsWith('mis_')) return 'une mission'
  if (subject.startsWith('apr_')) return 'une approbation'
  if (subject.startsWith('mnd_')) return 'un mandat'
  if (subject.startsWith('brf_')) return 'un brief'
  return subject
}

/** @param action - the journal action. @returns a readable sentence. */
export function sentenceOf(action: string): string {
  const table: Record<string, string> = {
    'mission.created': 'mission lancee',
    'mission.started': 'mission lancee',
    'mission.queued': 'mission mise en file',
    'mission.done': 'mission terminee',
    'mission.completed': 'mission terminee',
    'mission.failed': 'mission echouee',
    'mission.refused': 'mission refusee',
    'approval.requested': 'approbation demandee',
    'approval.decided': 'approbation decidee',
    'approval.approved': 'approbation approuvee',
    'approval.rejected': 'approbation refusee',
    'mandate.proposed': 'mandat propose',
    'mandate.signed': 'mandat signe',
    'mandate.retired': 'mandat retire',
  }
  return table[action] ?? action
}

/** The missions a person can launch from a channel. */
export const MISSION_KINDS = [
  { value: 'custom', label: 'Demande libre' },
  { value: 'briefing', label: 'Briefing du matin' },
  { value: 'meeting-prep', label: 'Preparation de reunion' },
  { value: 'account-review', label: 'Revue de compte' },
  { value: 'invoice-chase', label: 'Relance de facture' },
  { value: 'signal-watch', label: 'Veille de signaux' },
  { value: 'weekly-synthesis', label: 'Synthese hebdomadaire' },
] as const
