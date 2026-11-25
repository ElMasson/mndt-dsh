/**
 * What one person may read of the workbench: one rule per kind of record, used
 * by every route that serves it (cards, the page state, search, the journal of
 * events, a decision). A record is invisible by default; a route never decides
 * on its own.
 *
 * - A channel's card, message, update: its members only. One exception, for a
 *   card alone (decision of 24/11): when no member of its channel may decide
 *   it (an operator's lane, a channel with no owner nor admin), it rises to
 *   those who may decide (`rights.write`), its own content only — never the
 *   channel, its messages nor its documents.
 * - A card outside any channel (a mission's): the one who asked it, and those
 *   who may decide (`rights.write`); on a team instance, the one who asked it
 *   alone, plus the owners for an old card asked under « scheduler ».
 * - A mission, a brief: shared with the team, or its author. On a team
 *   instance (missions and automations are the owner's): the owner reads the
 *   shared ones, theirs and the automations'; anyone else, only their own.
 * - A memory note: shared with the team, or its author.
 * - A mandate: its two parties, and those who administer rights.
 * - An agent: the whole team (agents are declared for the team).
 */
import type { Approval, WorkbenchEvent, WorkbenchState } from './types.ts'

/** Who reads, with what they may see resolved once. */
export interface Reader {
  readonly identity: string
  /** Ids of the channels the person is a member of (their lane included). */
  readonly channels: ReadonlySet<string>
  /** Whether the person may decide cards and administer rights (`rights.write`). */
  readonly decider: boolean
  /**
   * Channels none of whose members may decide (`rights.write`): their cards
   * rise to the deciders. Resolved for a decider only; empty otherwise.
   */
  readonly channelsWithoutDecider?: ReadonlySet<string>
  /**
   * Missions and briefs on a team instance: `owner` for the owner, `member` for
   * anyone else. Absent on a solo workstation, where the shared rule applies.
   */
  readonly missionRole?: 'owner' | 'member'
}

/** The author an automation's run is recorded under before a team instance names the owner. */
export const AUTOMATION_AUTHOR = 'scheduler'

/**
 * @param reader - who reads.
 * @param item - a mission or a brief.
 * @returns whether the reader may see it (its prompt, its text, its sources).
 */
export function canReadMission(reader: Reader, item: { readonly visibility?: 'team' | 'private'; readonly createdBy: string }): boolean {
  if (item.createdBy === reader.identity) return true
  if (reader.missionRole === 'member') return false
  if (reader.missionRole === 'owner' && item.createdBy === AUTOMATION_AUTHOR) return true
  return (item.visibility ?? 'team') === 'team'
}

/**
 * @param reader - who reads.
 * @param approval - one card.
 * @returns whether the reader may see this card at all (title and payload included).
 */
export function canReadApproval(reader: Reader, approval: Approval): boolean {
  if (approval.channelId !== undefined) {
    if (reader.channels.has(approval.channelId)) return true
    // A card nobody in its channel may decide rises to the deciders: the card,
    // not the channel (its messages and documents stay its members').
    // A channel's context never rises (decision of 25/11): a decider from
    // outside must not write the content of a channel they do not read.
    return reader.decider && approval.kind !== 'propose_context' && (reader.channelsWithoutDecider?.has(approval.channelId) ?? false)
  }
  // A card outside any channel is a mission's. On a team instance it follows its
  // brief: the one who asked it alone (for an automation, the owner who enabled
  // it), plus the owners for an old card asked under « scheduler ». Never a
  // decider who did not ask it, another owner included.
  if (reader.missionRole !== undefined) {
    return approval.requestedBy === reader.identity
      || (reader.missionRole === 'owner' && approval.requestedBy === AUTOMATION_AUTHOR)
  }
  return reader.decider || approval.requestedBy === reader.identity
}

/**
 * Where a card comes from, for a reader outside its channel (a risen card): a
 * lane, or a channel, and nothing else of it (no name, no title). The screen
 * writes « depuis la lane de » its requester, or « depuis un canal sans décideur ».
 * @param reader - who reads.
 * @param approval - a card canReadApproval let through.
 * @param state - the state, for the channel's kind.
 * @returns the origin, or undefined for a card the reader reads in its channel (or with no channel).
 */
export function cardOrigin(reader: Reader, approval: Approval, state: WorkbenchState): { readonly kind: 'lane' | 'channel' } | undefined {
  if (approval.channelId === undefined || reader.channels.has(approval.channelId)) return undefined
  const channel = (state.channels ?? []).find(candidate => candidate.id === approval.channelId)
  return { kind: channel?.kind === 'solo' ? 'lane' : 'channel' }
}

/** @returns the card as served to this reader: its origin added when it rose from a channel they do not read. */
export function servedCard<T extends Approval>(reader: Reader, approval: T, state: WorkbenchState): T & { readonly origin?: { readonly kind: 'lane' | 'channel' } } {
  const origin = cardOrigin(reader, approval, state)
  return origin === undefined ? approval : { ...approval, origin }
}

/** What a risen card's journal line says to a reader outside its channel. */
export const RISEN_CARD_DETAIL = 'carte d’un canal que vous ne lisez pas'

/**
 * A readable event as served to this reader: the line of a card risen from a
 * channel they are not a member of carries nothing of that channel (its name,
 * its context version): its detail is replaced by a generic text.
 * @param reader - who reads.
 * @param event - an event canReadEvent let through.
 * @param state - the state, for the card.
 * @returns the event to serve.
 */
export function servedEvent(reader: Reader, event: WorkbenchEvent, state: WorkbenchState): WorkbenchEvent {
  if (!event.action.startsWith('approval.')) return event
  const approval = state.approvals.find(candidate => candidate.id === event.subject)
  if (approval?.channelId === undefined || reader.channels.has(approval.channelId)) return event
  return { ...event, detail: RISEN_CARD_DETAIL }
}

/**
 * @param reader - who reads.
 * @param event - one line of the journal.
 * @param state - the records the line points to.
 * @returns whether the reader may see this line (its subject, actor and detail).
 */
export function canReadEvent(
  reader: Reader,
  event: WorkbenchEvent,
  state: WorkbenchState,
): boolean {
  const [kind] = event.action.split('.')
  switch (kind) {
    case 'approval': {
      const approval = state.approvals.find(
        candidate => candidate.id === event.subject,
      )
      return approval !== undefined && canReadApproval(reader, approval)
    }
    case 'channel':
      return reader.channels.has(event.subject)
    case 'message':
      return event.detail !== undefined && reader.channels.has(event.detail)
    case 'mission': {
      if (event.action === 'mission.refused')
        return reader.decider || event.actor === reader.identity
      const mission = state.missions.find(
        candidate => candidate.id === event.subject,
      )
      return mission !== undefined && canReadMission(reader, mission)
    }
    case 'brief': {
      const brief = state.briefs.find(
        candidate => candidate.id === event.subject,
      )
      return brief !== undefined && canReadMission(reader, brief)
    }
    case 'memory': {
      const note = state.memories.find(
        candidate => candidate.id === event.subject,
      )
      return (
        note !== undefined &&
        (note.scope === 'team' || note.createdBy === reader.identity)
      )
    }
    case 'mandate': {
      const mandate = state.mandates.find(
        candidate => candidate.id === event.subject,
      )
      return mandate !== undefined && canReadMandate(reader.identity, reader.decider, mandate)
    }
    case 'agent':
      return true
    // Role changes asked through the members routes: for those who administer rights.
    case 'member':
      return reader.decider
    default:
      return false
  }
}

/**
 * A mandate: its two parties, and those who administer rights.
 * @param identity - the reader's e-mail (lower-case). @param canAdmin - whether they hold `rights.write`.
 * @param mandate - its parties. @returns whether the reader may see it.
 */
export function canReadMandate(
  identity: string,
  canAdmin: boolean,
  mandate: { readonly delegant: string; readonly delegataire: string },
): boolean {
  return canAdmin || mandate.delegataire === identity || mandate.delegant === identity
}
