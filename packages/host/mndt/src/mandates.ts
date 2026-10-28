/**
 * The rules of a delegation mandate.
 *
 * A mandate is how a person lends their authority to an agent for a bounded
 * job: a few connectors, read only, a daily quota, and a date after which it
 * stops working. These rules live apart from the service and the HTTP face so
 * one test can prove them without a browser, a network or a clock.
 */
import type { Mandate, MandateState, MissionKind } from './core/types.ts'
import type { Role } from '@deepseek-ai/dsh-client-ui-governance/src/rbac.ts'

/** The connectors a mandate can open, all read only in this product. */
export const mandateConnectors: readonly string[] = ['office365', 'attio', 'approvals', 'workbench_facts']

/** The mission kinds a mandate can authorise. */
export const mandateKinds: readonly MissionKind[] = [
  'briefing', 'meeting-prep', 'account-review', 'invoice-chase', 'signal-watch', 'weekly-synthesis', 'custom',
]

/** The connectors each mission kind needs, so a mandate can be checked against it at admission. */
export const kindConnectors: Readonly<Record<MissionKind, readonly string[]>> = {
  briefing: ['office365', 'attio'],
  'meeting-prep': ['office365'],
  'account-review': ['attio'],
  'invoice-chase': ['attio'],
  'signal-watch': ['attio'],
  'weekly-synthesis': ['attio'],
  custom: [],
}

/** What a caller must say to propose a mandate. */
export interface MandateDraft {
  readonly delegant: string
  readonly delegataire: string
  readonly purpose: string
  readonly connectors: readonly string[]
  readonly missionKinds: readonly MissionKind[]
  readonly dailyCap: number
  readonly expiresOn: string
}

/** @param value - the candidate. @returns true when it looks like a date, 2026-10-27. */
export function isDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
}

/**
 * The state a mandate really has today, which is not always the one stored: an
 * active mandate whose date has passed is expired, and it must not authorise
 * anything even before someone writes that down.
 * @param mandate - the mandate.
 * @param today - current date, 2026-10-27.
 * @returns the effective state.
 */
export function mandateState(mandate: Mandate, today: string): MandateState {
  if (mandate.state === 'retired') return 'retired'
  if (mandate.state === 'proposed') return 'proposed'
  if (mandate.expiresOn < today) return 'expired'
  return 'active'
}

/**
 * Why a draft cannot become a mandate, in words a person can act on.
 * @param draft - what the caller asked for.
 * @param today - current date.
 * @returns the refusal, or undefined when the draft is valid.
 */
export function draftRefusal(draft: MandateDraft, today: string): string | undefined {
  if (draft.delegant.trim() === '') return 'a mandate needs a delegant'
  if (draft.delegataire.trim() === '') return 'a mandate needs a delegataire'
  if (draft.delegant.trim() === draft.delegataire.trim()) return 'a person cannot delegate to themselves'
  if (draft.purpose.trim() === '') return 'a mandate needs a purpose'
  if (!isDate(draft.expiresOn)) return 'the expiry must be a date, for example 2026-11-30'
  if (draft.expiresOn < today) return 'the expiry is already past'
  if (!Number.isInteger(draft.dailyCap) || draft.dailyCap < 1 || draft.dailyCap > 50) return 'the daily cap must be between 1 and 50'
  if (draft.connectors.length === 0) return 'a mandate needs at least one connector'
  for (const connector of draft.connectors) {
    if (!mandateConnectors.includes(connector)) return `unknown connector: ${connector}`
  }
  if (draft.missionKinds.length === 0) return 'a mandate needs at least one mission kind'
  for (const kind of draft.missionKinds) {
    if (!mandateKinds.includes(kind)) return `unknown mission kind: ${kind}`
  }
  return undefined
}

/**
 * Why a person cannot countersign, in words.
 * @param mandate - the mandate.
 * @param actor - the signer.
 * @param role - the signer's role.
 * @param today - current date.
 * @returns the refusal, or undefined when the signer may sign.
 */
export function signRefusal(mandate: Mandate, actor: string, role: Role | undefined, today: string): string | undefined {
  if (role !== 'owner' && role !== 'admin') return `${actor} is not an owner or an admin`
  if (actor === mandate.delegant) return 'the delegant cannot countersign their own mandate'
  if (mandate.state !== 'proposed') return `this mandate is ${mandateState(mandate, today)}, not waiting for a signature`
  if (mandate.expiresOn < today) return 'this mandate expired before it was signed'
  return undefined
}

/**
 * Why a mission may not run under a mandate.
 * @param mandate - the mandate.
 * @param request - who asks, for what kind, and how many ran today.
 * @param request.identity - the person or agent asking.
 * @param request.kind - the mission kind.
 * @param request.usedToday - missions already run under this mandate today.
 * @param today - current date.
 * @returns the refusal, or undefined when the mission is allowed.
 */
export function missionRefusal(
  mandate: Mandate,
  request: { readonly identity: string; readonly kind: MissionKind; readonly usedToday: number },
  today: string,
): string | undefined {
  const state = mandateState(mandate, today)
  if (state !== 'active') return `the mandate is ${state}`
  if (mandate.delegataire !== request.identity) return `this mandate belongs to ${mandate.delegataire}`
  if (!mandate.missionKinds.includes(request.kind)) return `this mandate does not allow a ${request.kind} mission`
  for (const connector of kindConnectors[request.kind]) {
    if (!mandate.connectors.includes(connector)) {
      return `this mandate does not allow the ${connector} connector needed by a ${request.kind} mission`
    }
  }
  if (request.usedToday >= mandate.dailyCap) return `daily limit reached: ${request.usedToday} of ${mandate.dailyCap} missions today`
  return undefined
}

/** @param value - the candidate. @returns true when it names a mandate state. */
export function isMandateState(value: unknown): value is MandateState {
  return value === 'proposed' || value === 'active' || value === 'expired' || value === 'retired'
}
