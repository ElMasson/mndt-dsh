import { describe, expect, it } from 'vitest'
import {
  MISSION_KINDS, channelsOf, clockOf, dayOf, feedOf, humansOf, missionPost, sentenceOf, subjectLabel, timeOf, word,
} from '../src/client/feed.ts'
import { translate } from '../src/client/locales.ts'
import type { Channel, CollabState } from '../src/client/feed.ts'

/** @returns a state with two mandates, one approval and a journal. */
function fixture(): CollabState {
  return {
    you: 'duke@datanalysis.re',
    canWrite: true,
    canAdmin: true,
    missions: [
      {
        id: 'mis_1', kind: 'briefing', prompt: 'briefing du matin', status: 'done', createdBy: 'scheduler',
        createdAt: '2026-11-01T07:30:00.000Z', visibility: 'team', briefId: 'brf_1',
      },
      {
        id: 'mis_2', kind: 'custom', prompt: 'revue de compte', status: 'running', createdBy: 'smarion@datanalysis.re',
        createdAt: '2026-11-01T08:30:00.000Z', visibility: 'private', mandateId: 'mnd_1',
      },
    ],
    briefs: [
      {
        id: 'brf_1', title: 'Briefing du matin', markdown: '# ok', status: 'draft', createdAt: '2026-11-01T07:31:00.000Z',
        createdBy: 'scheduler', missionId: 'mis_1',
      },
    ],
    approvals: [
      {
        id: 'apr_1', kind: 'spend', title: 'Valider la campagne', requestedBy: 'gouvernance@datanalysis.re',
        requestedAt: '2026-11-01T09:00:00.000Z', missionId: 'mis_2',
      },
    ],
    memories: [],
    mandates: [
      {
        id: 'mnd_1', delegant: 'gouvernance@datanalysis.re', delegataire: 'smarion@datanalysis.re',
        purpose: 'Reporting marketing', connectors: ['office365'], missionKinds: ['custom'], dailyCap: 3,
        expiresOn: '2026-11-30', state: 'active',
      },
    ],
    members: [{ subject: 'duke@datanalysis.re', role: 'owner' }],
    events: [
      { at: '2026-11-01T07:30:00.000Z', actor: 'scheduler', action: 'mission.done', subject: 'mis_1' },
      { at: '2026-11-01T09:00:00.000Z', actor: 'gouvernance@datanalysis.re', action: 'approval.requested', subject: 'apr_1' },
    ],
  }
}

/** @param overrides - fields to replace. @returns a new state. */
function stateWith(overrides: Partial<CollabState>): CollabState {
  return { ...fixture(), ...overrides }
}

/** @param state - the base state. @returns the state without its mandates. */
function withoutMandates(state: CollabState): Omit<CollabState, 'mandates'> {
  const { mandates: _mandates, ...rest } = state
  return rest
}

/** @param state - the base state. @returns the state without its journal. */
function withoutEvents(state: CollabState): Omit<CollabState, 'events'> {
  const { events: _events, ...rest } = state
  return rest
}

/** @param state - the base state. @returns the state without its members. */
function withoutMembers(state: CollabState): Omit<CollabState, 'members'> {
  const { members: _members, ...rest } = state
  return rest
}

/** @param id - channel id. @param kind - channel kind. @returns a bare channel. */
function channel(id: string, kind: Channel['kind']): Channel {
  return { id, kind, name: id, subject: '' }
}

const team = channel('team', 'team')
const system = channel('system', 'system')
const mandateChannel = channel('mandate:mnd_1', 'mandate')

describe('channel list', () => {
  it('always offers the team and the system channel, plus one per mandate', () => {
    const channels = channelsOf(fixture())
    expect(channels.map(candidate => candidate.id)).toEqual(['team', 'mandate:mnd_1', 'system'])
    expect(channels[1]?.name).toBe('Reporting marketing - smarion')
    expect(channels[1]?.subject).toBe('gouvernance@datanalysis.re delegue a smarion@datanalysis.re')
  })

  it('names a mandate channel after its id when no purpose is written, and keeps a delegate without domain', () => {
    const state = fixture()
    const mandate = state.mandates?.[0]
    if (mandate === undefined) throw new Error('le jeu de donnees doit porter un mandat')
    const named = stateWith({ mandates: [{ ...mandate, purpose: '', delegataire: 'smarion' }] })
    const channels = channelsOf(named)
    expect(channels[1]?.name).toBe('mnd_1')
    expect(channels[1]?.subject).toContain('smarion')
  })

  it('counts the approvals linked to a mandate on its channel', () => {
    const channels = channelsOf(fixture())
    expect(channels[1]?.badge).toBe(1)
    expect(channels[0]?.badge).toBeUndefined()
  })
})

describe('feed composition', () => {
  it('shows missions, their brief and the journal in the team channel, newest first', () => {
    const posts = feedOf(fixture(), team)
    const kinds = posts.map(post => post.body.kind)
    expect(kinds).toContain('mission')
    expect(kinds).toContain('approval')
    expect(kinds).toContain('event')
    const times = posts.map(post => Date.parse(post.at))
    expect([...times].sort((left, right) => right - left)).toEqual(times)
  })

  it('keeps a mandate channel to its own missions and approvals', () => {
    const posts = feedOf(fixture(), mandateChannel)
    expect(posts.every(post => post.body.kind !== 'mission' || post.body.author === 'smarion@datanalysis.re')).toBe(true)
    expect(posts.some(post => post.body.kind === 'approval')).toBe(true)
    expect(posts.some(post => post.body.kind === 'brief')).toBe(false)
  })

  it('reads the system channel when no mandate is declared at all', () => {
    const bare = withoutMandates(fixture())
    expect(feedOf(bare, system).some(post => post.body.kind === 'mission')).toBe(true)
  })

  it('drops your own missions from the system channel', () => {
    const state = fixture()
    const mission = state.missions[0]
    if (mission === undefined) throw new Error('le jeu de donnees doit porter une mission')
    const posts = feedOf(stateWith({ missions: [{ ...mission, createdBy: state.you }] }), system)
    expect(posts.some(post => post.body.kind === 'mission')).toBe(false)
  })

  it('puts other people’s missions and the journal in the system channel', () => {
    const state = fixture()
    const posts = feedOf(state, system)
    const missions = posts.filter(post => post.body.kind === 'mission')
    expect(missions.every(post => post.body.kind === 'mission' && post.body.author !== state.you)).toBe(true)
    expect(posts.some(post => post.body.kind === 'event')).toBe(true)
  })

  it('marks a mission card private unless it was shared', () => {
    const state = fixture()
    const mission = state.missions[1]
    if (mission === undefined) throw new Error('le jeu de donnees doit porter une mission')
    const card = missionPost(mission, undefined, undefined)
    expect(card.visibility).toBe('private')
  })
})

describe('feed edge cases', () => {
  it('offers no mandate channel when the state carries no mandate', () => {
    expect(channelsOf(withoutMandates(fixture())).map(candidate => candidate.id)).toEqual(['team', 'system'])
  })

  it('keeps a mandate channel readable when the mandate itself is gone', () => {
    const posts = feedOf(stateWith({ mandates: [] }), mandateChannel)
    expect(posts.some(post => post.body.kind === 'mission')).toBe(true)
  })

  it('lets a team brief with no mission through, credited to the agent', () => {
    const briefs = [{ id: 'brf_2', title: 'Note libre', markdown: 'ok', status: 'draft', createdAt: '2026-11-01T10:00:00.000Z' }]
    const posts = feedOf(stateWith({ briefs }), team)
    const brief = posts.find(post => post.body.kind === 'brief')
    expect(brief?.body.kind).toBe('brief')
    expect(brief?.body.kind === 'brief' ? brief.body.author : '').toBe('agent')
  })

  it('keeps an approval with no mission in the team channel only', () => {
    const approvals = [{
      id: 'apr_9', kind: 'delete', title: 'Supprimer', requestedBy: 'duke@datanalysis.re',
      requestedAt: '2026-11-01T09:30:00.000Z',
    }]
    const state = stateWith({ approvals })
    expect(feedOf(state, team).some(post => post.body.kind === 'approval')).toBe(true)
    expect(feedOf(state, mandateChannel).some(post => post.body.kind === 'approval')).toBe(false)
  })

  it('carries the journal even without a detail and in the system channel', () => {
    const events = [{ at: '2026-11-01T11:00:00.000Z', actor: 'scheduler', action: 'mission.failed', subject: 'mis_1' }]
    const event = feedOf(stateWith({ events }), system).find(post => post.body.kind === 'event')
    expect(event?.body.kind === 'event' ? event.body.detail : 'x').toBeUndefined()
  })

  it('reads a feed whose state carries neither mandates nor journal', () => {
    const bare = withoutEvents(withoutMandates(fixture()))
    expect(feedOf(bare, team).length).toBeGreaterThan(0)
    expect(channelsOf(bare).length).toBe(2)
  })

  it('falls back to a private card when the state does not say the visibility', () => {
    const state = fixture()
    const mission = state.missions[0]
    if (mission === undefined) throw new Error('le jeu de donnees doit porter une mission')
    const card = missionPost({
      id: mission.id, kind: mission.kind, prompt: mission.prompt, status: mission.status,
      createdBy: mission.createdBy, createdAt: mission.createdAt,
    }, undefined, undefined)
    expect(card.visibility).toBe('private')
  })

  it('names the mandate of a mission card when one is known', () => {
    const state = fixture()
    const mission = state.missions[1]
    const mandate = state.mandates?.[0]
    if (mission === undefined || mandate === undefined) throw new Error('le jeu de donnees doit porter mission et mandat')
    const card = missionPost(mission, undefined, mandate)
    expect(card.mandate).toBe('Reporting marketing')
  })
})

describe('journal wording', () => {
  it('turns a subject and an action into something a person reads', () => {
    expect(subjectLabel('mis_123', translate)).toBe('une mission')
    expect(subjectLabel('brf_123', translate)).toBe('un brief')
    expect(subjectLabel('mnd_123', translate)).toBe('un mandat')
    expect(subjectLabel('apr_123', translate)).toBe('une approbation')
    expect(subjectLabel('inconnu', translate)).toBe('inconnu')
    expect(sentenceOf('mission.done', translate)).toBe('mission terminee')
    expect(sentenceOf('approval.rejected', translate)).toBe('approbation refusee')
    expect(sentenceOf('autre.action', translate)).toBe('autre.action')
  })

  it('formats a clock, a day and plural words', () => {
    expect(clockOf('2026-11-01T07:30:00.000Z')).toMatch(/\d{2}:\d{2}/)
    expect(dayOf('2026-11-01T07:30:00.000Z')).toMatch(/novembre/)
    expect(timeOf('pas une date')).toBe(0)
    expect(timeOf('2026-11-01T07:30:00.000Z')).toBe(Date.parse('2026-11-01T07:30:00.000Z'))
    expect(clockOf('pas une date')).toBe('')
    expect(dayOf('pas une date')).toBe('')
    expect(word(1, 'post', 'posts')).toBe('post')
    expect(word(3, 'post', 'posts')).toBe('posts')
  })

  it('lists the mission kinds the composer offers', () => {
    expect(MISSION_KINDS.map(kind => kind.value)).toContain('custom')
    expect(MISSION_KINDS.map(kind => kind.value)).toContain('weekly-synthesis')
  })

  it('falls back to no human when the state carries no members', () => {
    expect(humansOf(withoutMembers(fixture()))).toEqual([])
  })
})
