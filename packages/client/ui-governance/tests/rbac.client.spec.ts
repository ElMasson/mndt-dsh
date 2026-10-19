import { describe, expect, it } from 'vitest'
import {
  ALL_CAPABILITIES,
  RbacTable,
  asRole,
  type RbacSnapshot,
  capabilitiesOf,
  compareRoles,
} from '@deepseek-ai/dsh-client-ui-governance'

describe('roles', () => {
  it('orders roles from weakest to strongest', () => {
    expect(compareRoles('viewer', 'admin')).toBeLessThan(0)
    expect(compareRoles('owner', 'admin')).toBeGreaterThan(0)
    expect(compareRoles('admin', 'admin')).toBe(0)
  })

  it('rejects a role name that does not exist', () => {
    expect(asRole('superuser')).toBeUndefined()
    expect(asRole(42)).toBeUndefined()
    expect(asRole('owner')).toBe('owner')
  })

  it('gives every role a read capability on every surface', () => {
    for (const role of ['viewer', 'operator', 'admin', 'owner'] as const) {
      const held = capabilitiesOf(role)
      for (const surface of ['connectors', 'agents', 'workflows', 'rights', 'sharing'] as const) {
        expect(held).toContain(`${surface}.read`)
      }
    }
  })

  it('never lets a viewer write anything', () => {
    expect(capabilitiesOf('viewer').some(capability => capability.endsWith('.write'))).toBe(false)
  })

  it('lets only rights-capable roles change rights', () => {
    expect(capabilitiesOf('operator')).not.toContain('rights.write')
    expect(capabilitiesOf('admin')).toContain('rights.write')
    expect(capabilitiesOf('owner')).toContain('rights.write')
  })
})

describe('decisions', () => {
  it('allows what the role holds and refuses the rest with a reason', () => {
    const table = new RbacTable()
    table.set({ subject: 'sara', role: 'operator' })

    expect(table.decide('sara', 'connectors.write').allowed).toBe(true)
    const denied = table.decide('sara', 'rights.write')
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toContain('does not hold rights.write')
  })

  it('refuses an unknown subject', () => {
    const table = new RbacTable()
    expect(table.decide('ghost', 'agents.read').allowed).toBe(false)
  })

  it('honours a scoped grant only on its resource', () => {
    const table = new RbacTable()
    table.set({ subject: 'client', role: 'viewer', scope: 'session-42' })

    expect(table.decide('client', 'sharing.read', 'session-42').allowed).toBe(true)
    expect(table.decide('client', 'sharing.read', 'session-43').allowed).toBe(false)
  })

  it('unions a global grant and a scoped one', () => {
    const table = new RbacTable()
    table.set({ subject: 'sara', role: 'viewer' })
    table.set({ subject: 'sara', role: 'operator', scope: 'session-42' })

    expect(table.decide('sara', 'workflows.write', 'session-42').allowed).toBe(true)
    expect(table.decide('sara', 'workflows.write').allowed).toBe(false)
  })

  it('refuses a capability that does not exist', () => {
    const table = new RbacTable()
    table.set({ subject: 'sara', role: 'owner' })
    const decision = table.decide('sara', 'billing.write' as never)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('unknown capability')
  })

  it('refuses a grant without a subject or with an unknown role', () => {
    const table = new RbacTable()
    expect(table.set({ subject: '  ', role: 'viewer' }).allowed).toBe(false)
    expect(table.set({ subject: 'x', role: 'root' as never }).allowed).toBe(false)
    expect(table.list()).toEqual([])
  })
})

describe('lock-out protection', () => {
  it('refuses to demote the last owner', () => {
    const table = new RbacTable()
    table.set({ subject: 'stephane', role: 'owner' })

    const decision = table.set({ subject: 'stephane', role: 'viewer' })

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('last owner')
    expect(table.decide('stephane', 'rights.write').allowed).toBe(true)
  })

  it('allows demoting an owner once another owner exists', () => {
    const table = new RbacTable()
    table.set({ subject: 'stephane', role: 'owner' })
    table.set({ subject: 'sara', role: 'owner' })

    expect(table.set({ subject: 'stephane', role: 'admin' }).allowed).toBe(true)
    expect(table.decide('stephane', 'rights.write').allowed).toBe(true)
    expect(table.decide('sara', 'rights.write').allowed).toBe(true)
  })

  it('refuses to remove the last owner', () => {
    const table = new RbacTable()
    table.set({ subject: 'stephane', role: 'owner' })

    expect(table.remove('stephane').allowed).toBe(false)
  })

  it('removes a non-owner grant', () => {
    const table = new RbacTable()
    table.set({ subject: 'sara', role: 'admin' })

    expect(table.remove('sara').allowed).toBe(true)
    expect(table.decide('sara', 'rights.read').allowed).toBe(false)
  })
})

describe('persistence', () => {
  it('round-trips through a snapshot', () => {
    const table = new RbacTable()
    table.set({ subject: 'stephane', role: 'owner' })
    table.set({ subject: 'sara', role: 'operator' })
    table.set({ subject: 'client', role: 'viewer', scope: 'session-42' })

    const restored = RbacTable.fromSnapshot(JSON.parse(JSON.stringify(table.snapshot())))

    expect(restored.list()).toEqual(table.list())
    expect(restored.decide('sara', 'connectors.write').allowed).toBe(true)
    expect(restored.decide('client', 'sharing.read', 'session-42').allowed).toBe(true)
  })

  it('drops untrustworthy rows instead of trusting them', () => {
    const restored = RbacTable.fromSnapshot({
      grants: [
        { subject: 'ok', role: 'viewer' },
        { subject: '', role: 'owner' },
        { subject: 'bad', role: 'root' },
      ],
    } as unknown as RbacSnapshot)

    expect(restored.list().map(grant => grant.subject)).toEqual(['ok'])
  })

  it('exposes a stable capability list for the page legend', () => {
    expect(ALL_CAPABILITIES).toHaveLength(10)
    expect(ALL_CAPABILITIES).toContain('sharing.write')
  })
})
