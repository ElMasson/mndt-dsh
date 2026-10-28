import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/core/store.ts'
import { WorkbenchService } from '../src/core/service.ts'
import { draftRefusal, mandateState, missionRefusal, signRefusal } from '../src/mandates.ts'
import type { Mandate } from '../src/core/types.ts'

const owner = 'duke@datanalysis.re'
const operator = 'smarion@datanalysis.re'
const admin = 'admin@datanalysis.re'
const today = '2026-10-24'

/** A service with a predictable clock and ids. */
function bench(): WorkbenchService {
  let counter = 0
  return new WorkbenchService({
    store: new MemoryStore(),
    now: () => new Date('2026-10-24T08:00:00.000Z'),
    nextId: prefix => `${prefix}_${(counter += 1)}`,
  })
}

/** @param overrides - fields to change. @returns a valid draft. */
function draft(overrides: Partial<Parameters<WorkbenchService['createMandate']>[0]> = {}) {
  return {
    delegant: owner,
    delegataire: operator,
    purpose: 'preparation de dossiers',
    connectors: ['office365', 'attio'],
    missionKinds: ['briefing', 'custom'] as const,
    dailyCap: 2,
    expiresOn: '2026-11-30',
    ...overrides,
  }
}

describe('mandate rules', () => {
  it('refuses a mandate with no perimeter or a past date', () => {
    expect(draftRefusal(draft({ connectors: [] }), today)).toBe('a mandate needs at least one connector')
    expect(draftRefusal(draft({ missionKinds: [] }), today)).toBe('a mandate needs at least one mission kind')
    expect(draftRefusal(draft({ expiresOn: '2026-10-01' }), today)).toBe('the expiry is already past')
    expect(draftRefusal(draft({ dailyCap: 0 }), today)).toBe('the daily cap must be between 1 and 50')
    expect(draftRefusal(draft({ delegataire: owner }), today)).toBe('a person cannot delegate to themselves')
  })

  it('refuses a signer who is the delegant, and one without a mandate role', () => {
    const mandate = { id: 'mnd_1', ...draft(), state: 'proposed', createdAt: `${today}T08:00:00.000Z` } as Mandate
    expect(signRefusal(mandate, owner, 'owner', today)).toContain('cannot countersign their own mandate')
    expect(signRefusal(mandate, operator, 'operator', today)).toContain('not an owner or an admin')
    expect(signRefusal(mandate, admin, 'admin', today)).toBeUndefined()
  })

  it('turns an unsigned mandate into an active one only through a signature', async () => {
    const workbench = bench()
    const created = await workbench.createMandate(draft())
    expect(created.state).toBe('proposed')
    expect(missionRefusal(created, { identity: operator, kind: 'briefing', usedToday: 0 }, today)).toBe('the mandate is proposed')

    const signed = await workbench.signMandate(created.id, admin, 'admin')
    expect(signed).toMatchObject({ state: 'active', signedBy: admin })
    expect(missionRefusal(signed, { identity: operator, kind: 'briefing', usedToday: 0 }, today)).toBeUndefined()
  })

  it('refuses a signature from the delegant itself', async () => {
    const workbench = bench()
    const created = await workbench.createMandate(draft())
    await expect(workbench.signMandate(created.id, owner, 'owner')).rejects.toThrow('cannot countersign their own mandate')
  })

  it('enforces delegatee, kind and the daily cap', () => {
    const mandate = {
      id: 'mnd_1', ...draft(), state: 'active', createdAt: `${today}T08:00:00.000Z`,
      signedBy: admin, signedAt: `${today}T08:00:00.000Z`,
    } as Mandate
    expect(missionRefusal(mandate, { identity: 'contact@datanalysis.re', kind: 'briefing', usedToday: 0 }, today))
      .toBe(`this mandate belongs to ${operator}`)
    expect(missionRefusal(mandate, { identity: operator, kind: 'account-review', usedToday: 0 }, today))
      .toBe('this mandate does not allow a account-review mission')
    expect(missionRefusal(mandate, { identity: operator, kind: 'briefing', usedToday: 2 }, today))
      .toBe('daily limit reached: 2 of 2 missions today')
  })

  it('refuses a mission whose connectors the mandate does not open', () => {
    const mandate = {
      id: 'mnd_1', ...draft({ connectors: ['office365'], missionKinds: ['account-review'] }),
      state: 'active', createdAt: `${today}T08:00:00.000Z`, signedBy: admin, signedAt: `${today}T08:00:00.000Z`,
    } as Mandate
    expect(missionRefusal(mandate, { identity: operator, kind: 'account-review', usedToday: 0 }, today))
      .toBe('this mandate does not allow the attio connector needed by a account-review mission')
    const briefing = {
      id: 'mnd_2', ...draft({ connectors: ['office365', 'attio'], missionKinds: ['briefing'] }),
      state: 'active', createdAt: `${today}T08:00:00.000Z`,
    } as Mandate
    expect(missionRefusal(briefing, { identity: operator, kind: 'briefing', usedToday: 0 }, today)).toBeUndefined()
  })

  it('counts the missions a mandate has carried today, and stops after retirement', async () => {
    const workbench = bench()
    const created = await workbench.createMandate(draft({ dailyCap: 1 }))
    const signed = await workbench.signMandate(created.id, admin, 'admin')
    await workbench.createMission({ kind: 'briefing', prompt: 'matin', createdBy: operator, mandateId: signed.id })

    expect(await workbench.missionsToday(signed.id, operator)).toBe(1)
    expect(missionRefusal(signed, { identity: operator, kind: 'briefing', usedToday: 1 }, today))
      .toBe('daily limit reached: 1 of 1 missions today')

    const retired = await workbench.retireMandate(signed.id, owner, 'owner')
    expect(retired.state).toBe('retired')
    expect(missionRefusal(retired, { identity: operator, kind: 'briefing', usedToday: 0 }, today)).toBe('the mandate is retired')
  })

  it('treats an active mandate past its date as expired', () => {
    const mandate = {
      id: 'mnd_1', ...draft({ expiresOn: '2026-10-20' }), state: 'active', createdAt: `${today}T08:00:00.000Z`,
    } as Mandate
    expect(mandateState(mandate, today)).toBe('expired')
    expect(missionRefusal(mandate, { identity: operator, kind: 'briefing', usedToday: 0 }, today)).toBe('the mandate is expired')
  })

  it('reads an older state file as having no mandates instead of crashing', async () => {
    const store = new MemoryStore()
    await store.save({ version: 1, missions: [], briefs: [], memories: [], approvals: [], events: [] } as never)
    const workbench = new WorkbenchService({ store, now: () => new Date('2026-10-24T08:00:00.000Z') })
    expect(await workbench.mandates()).toEqual([])
  })
})
