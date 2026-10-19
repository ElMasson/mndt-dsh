import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  JsonFileRbacStorage,
  defaultStatePath,
} from '@deepseek-ai/dsh-host-governance'
import { GovernanceController } from '@deepseek-ai/dsh-client-ui-governance/src/governance.ts'

const created: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-governance-'))
  created.push(dir)
  return dir
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

describe('json file storage', () => {
  it('returns an empty table when nothing was stored yet', async () => {
    const storage = new JsonFileRbacStorage(join(await tempDir(), 'rbac.json'))

    await expect(storage.load()).resolves.toEqual({ grants: [] })
  })

  it('round-trips a table through the disk', async () => {
    const path = join(await tempDir(), 'nested', 'rbac.json')
    const storage = new JsonFileRbacStorage(path)
    const controller = new GovernanceController(storage)
    await controller.load()
    await controller.bootstrapOwner('stephane')
    await controller.setGrant('stephane', { subject: 'client', role: 'viewer', scope: 'session-42' })

    const reloaded = new GovernanceController(new JsonFileRbacStorage(path))
    await reloaded.load()

    expect(reloaded.decide('client', 'sharing.read', 'session-42').allowed).toBe(true)
    expect(reloaded.decide('client', 'sharing.read', 'session-43').allowed).toBe(false)
  })

  it('writes valid JSON and leaves no temporary file behind', async () => {
    const dir = await tempDir()
    const path = join(dir, 'rbac.json')
    const storage = new JsonFileRbacStorage(path)

    await storage.save({ grants: [{ subject: 'stephane', role: 'owner' }] })

    const written = JSON.parse(await readFile(path, 'utf8')) as { grants: unknown[] }
    expect(written.grants).toHaveLength(1)
    await expect(readFile(`${path}.tmp`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses to read a file that is not a table', async () => {
    const path = join(await tempDir(), 'rbac.json')
    await writeFile(path, JSON.stringify({ notGrants: true }), 'utf8')

    await expect(new JsonFileRbacStorage(path).load()).resolves.toEqual({ grants: [] })
  })

  it('surfaces a corrupt file instead of pretending the table is empty', async () => {
    const path = join(await tempDir(), 'rbac.json')
    await writeFile(path, '{ this is not json', 'utf8')

    await expect(new JsonFileRbacStorage(path).load()).rejects.toThrow()
  })
})

describe('default path', () => {
  it('honours the environment override', () => {
    const previous = process.env.DSH_GOVERNANCE_HOME
    process.env.DSH_GOVERNANCE_HOME = 'C:/tmp/gov'
    try {
      expect(defaultStatePath().replaceAll('\\', '/')).toBe('C:/tmp/gov/rbac.json')
    } finally {
      if (previous === undefined) delete process.env.DSH_GOVERNANCE_HOME
      else process.env.DSH_GOVERNANCE_HOME = previous
    }
  })
})
