import { describe, expect, it } from 'vitest'
import { GovernanceController, MemoryRbacStorage } from '@deepseek-ai/dsh-client-ui-governance'

async function seeded(): Promise<GovernanceController> {
  const controller = new GovernanceController(new MemoryRbacStorage())
  await controller.load()
  await controller.bootstrapOwner('stephane')
  return controller
}

describe('bootstrap', () => {
  it('makes the first subject owner on an empty table', async () => {
    const controller = await seeded()

    expect(controller.decide('stephane', 'rights.write').allowed).toBe(true)
    expect(controller.list()).toHaveLength(1)
  })

  it('refuses to bootstrap over an existing table', async () => {
    const controller = await seeded()

    const decision = await controller.bootstrapOwner('intruder')

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('already has grants')
    expect(controller.decide('intruder', 'rights.read').allowed).toBe(false)
  })
})

describe('host-side enforcement', () => {
  it('lets an owner grant a role to someone else', async () => {
    const controller = await seeded()

    const decision = await controller.setGrant('stephane', { subject: 'sara', role: 'operator' })

    expect(decision.allowed).toBe(true)
    expect(controller.decide('sara', 'workflows.write').allowed).toBe(true)
  })

  it('refuses a grant asked by someone without rights.write', async () => {
    const controller = await seeded()
    await controller.setGrant('stephane', { subject: 'sara', role: 'operator' })

    const decision = await controller.setGrant('sara', { subject: 'sara', role: 'owner' })

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('does not hold rights.write')
    expect(controller.decide('sara', 'rights.write').allowed).toBe(false)
  })

  it('refuses a removal asked by someone without rights.write', async () => {
    const controller = await seeded()
    await controller.setGrant('stephane', { subject: 'sara', role: 'admin' })

    const decision = await controller.removeGrant('sara', 'stephane')

    expect(decision.allowed).toBe(false)
    expect(controller.decide('stephane', 'rights.read').allowed).toBe(true)
  })

  it('keeps the last owner even when an owner asks', async () => {
    const controller = await seeded()

    const decision = await controller.removeGrant('stephane', 'stephane')

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('last owner')
  })
})

describe('persistence', () => {
  it('persists only accepted mutations', async () => {
    const storage = new MemoryRbacStorage()
    const controller = new GovernanceController(storage)
    await controller.load()
    await controller.bootstrapOwner('stephane')

    const refused = await controller.setGrant('ghost', { subject: 'ghost', role: 'owner' })
    expect(refused.allowed).toBe(false)

    const persisted = await storage.load()
    expect(persisted.grants.map(grant => grant.subject)).toEqual(['stephane'])
  })

  it('reloads what it saved', async () => {
    const storage = new MemoryRbacStorage()
    const first = new GovernanceController(storage)
    await first.load()
    await first.bootstrapOwner('stephane')
    await first.setGrant('stephane', { subject: 'client', role: 'viewer', scope: 'session-42' })

    const second = new GovernanceController(storage)
    await second.load()

    expect(second.decide('client', 'sharing.read', 'session-42').allowed).toBe(true)
    expect(second.decide('client', 'sharing.read', 'session-43').allowed).toBe(false)
  })

  it('exposes the snapshot for export', async () => {
    const controller = await seeded()

    const snapshot = controller.snapshot()

    expect(snapshot.grants).toEqual([{ subject: 'stephane', role: 'owner' }])
  })
})
