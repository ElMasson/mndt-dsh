/**
 * What one person may read of the workbench: one rule per kind of record, used
 * by every route that serves it (cards, the page state, search, the journal of
 * events, a decision). A record is invisible by default; a route never decides
 * on its own.
 *
 * - A channel's card, message, update: its members only.
 * - A card outside any channel (a mission's): the one who asked it, and those
 *   who may decide (`rights.write`).
 * - A mission, a brief, a memory note: shared with the team, or its author.
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
}

/**
 * @param reader - who reads.
 * @param approval - one card.
 * @returns whether the reader may see this card at all (title and payload included).
 */
export function canReadApproval(reader: Reader, approval: Approval): boolean {
  if (approval.channelId !== undefined)
    return reader.channels.has(approval.channelId)
  return reader.decider || approval.requestedBy === reader.identity
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
      return (
        mission !== undefined &&
        (mission.visibility === 'team' || mission.createdBy === reader.identity)
      )
    }
    case 'brief': {
      const brief = state.briefs.find(
        candidate => candidate.id === event.subject,
      )
      return (
        brief !== undefined &&
        ((brief.visibility ?? 'team') === 'team' ||
          brief.createdBy === reader.identity)
      )
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
      return (
        mandate !== undefined &&
        (reader.decider ||
          mandate.delegant === reader.identity ||
          mandate.delegataire === reader.identity)
      )
    }
    case 'agent':
      return true
    default:
      return false
  }
}
