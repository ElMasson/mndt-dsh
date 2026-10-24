/**
 * The two signals that let an automation report a failed child turn.
 *
 * These are the failure paths a real run hit: `agent()` resolving while the
 * child turn died, and a run whose stop reason stayed `completed`. Nothing here
 * mounts an engine, so the decision is checked directly.
 */
import { describe, expect, it } from 'vitest'
import { failureOfAgentEnd, failureOfTurnEnd } from '../src/automations-failure.ts'

describe('automation failure signals', () => {
  it('reports a completed agent call as no failure', () => {
    expect(failureOfAgentEnd({ outcome: 'completed', seq: 1, label: 'agent' })).toBeUndefined()
  })

  it('reports a failed agent call with its position and label', () => {
    expect(failureOfAgentEnd({ outcome: 'error', seq: 2, label: 'count' }))
      .toBe('agent() call 2 ("count") ended error')
  })

  it('reports a child turn that ended in error', () => {
    expect(failureOfTurnEnd('child-1', { parentSession: 'child-1', kind: 'error', message: 'no model route' }))
      .toBe('the agent turn failed: no model route')
  })

  it('names the missing message rather than printing undefined', () => {
    expect(failureOfTurnEnd('child-1', { parentSession: 'child-1', kind: 'error', message: undefined }))
      .toBe('the agent turn failed: no message')
  })

  it('ignores a completed turn', () => {
    expect(failureOfTurnEnd('child-1', { parentSession: 'child-1', kind: 'completed', message: undefined })).toBeUndefined()
  })

  it('ignores a turn from another session', () => {
    expect(failureOfTurnEnd('child-1', { parentSession: 'other', kind: 'error', message: 'boom' })).toBeUndefined()
  })
})
