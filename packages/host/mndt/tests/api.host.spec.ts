import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/core/index.ts'
import { WorkbenchService } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import type { MissionRunner } from '../src/api.ts'
import { localGrants } from '../src/index.ts'

const owner = 'duke@datanalysis.re'
const viewer = 'contact@datanalysis.re'

/** A runner that produces a fixed brief. */
function fakeRunner(markdown = '## Points du jour\n\nRien de bloquant.'): MissionRunner {
  return { run: async () => ({ title: 'Briefing du jour', markdown, sources: [] }) }
}

/** An API wired for tests, with a real service in memory. */
function bench(runner: MissionRunner = fakeRunner()) {
  const service = new WorkbenchService({ store: new MemoryStore() })
  const api = createMndtApi({
    service,
    runner,
    identity: {
      tokens: {
        'tok-owner': { user: owner },
        'tok-viewer': { user: viewer },
      },
    },
    grants: {
      grants: async () => ({
        ok: true,
        grants: [
          { subject: owner, role: 'owner' },
          { subject: viewer, role: 'viewer' },
        ],
      }),
    },
    connectors: async () => ([{ module: 'mcp-client-attio', server: 'attio', enabled: true }]),
  })
  return { api, service }
}

const asOwner = { authorization: 'Bearer tok-owner' }
const asViewer = { authorization: 'Bearer tok-viewer' }

describe('duke api', () => {
  it('answers health without credentials', async () => {
    const { api } = bench()
    const response = await api({ method: 'GET', path: '/health' })
    expect(response.status).toBe(200)
  })

  it('serves the page state to the person the proxy proved, with their own rights', async () => {
    const { api } = bench()
    const asOwnerState = await api({ method: 'GET', path: '/state', ...asOwner })
    const asViewerState = await api({ method: 'GET', path: '/state', ...asViewer })
    expect(asOwnerState.status).toBe(200)
    expect(asViewerState.status).toBe(200)
    const ownerPage = (asOwnerState.body as { page: { you: string; canWrite: boolean } }).page
    const viewerPage = (asViewerState.body as { page: { you: string; canWrite: boolean } }).page
    expect(ownerPage.you).toBe(owner)
    expect(viewerPage.you).toBe(viewer)
    expect(ownerPage.canWrite).toBe(true)
    expect(viewerPage.canWrite).toBe(false)
  })

  it('refuses every other route without a proven identity', async () => {
    const { api } = bench()
    for (const path of ['/me', '/missions', '/briefs', '/approvals', '/memory', '/connectors']) {
      const response = await api({ method: 'GET', path })
      expect(response.status).toBe(401)
      expect(response.body).toMatchObject({ error: expect.stringContaining('required') as never })
    }
  })

  it('names the caller the token proves', async () => {
    const { api } = bench()
    const response = await api({ method: 'GET', path: '/me', ...asOwner })
    expect(response.body).toEqual({ you: owner })
  })

  it('lets an owner run a mission and returns the produced brief', async () => {
    const { api } = bench()
    const response = await api({
      method: 'POST',
      path: '/missions',
      ...asOwner,
      body: JSON.stringify({ kind: 'briefing', prompt: 'Prepare the morning briefing' }),
    })

    expect(response.status).toBe(201)
    const body = response.body as { mission: { status: string; createdBy: string }; brief: { markdown: string; status: string } }
    expect(body.mission.status).toBe('done')
    expect(body.mission.createdBy).toBe(owner)
    expect(body.brief.markdown).toContain('Points du jour')
    expect(body.brief.status).toBe('draft')
  })

  it('refuses a mission from a viewer, with the reason', async () => {
    const { api } = bench()
    const response = await api({
      method: 'POST',
      path: '/missions',
      ...asViewer,
      body: JSON.stringify({ kind: 'briefing', prompt: 'x' }),
    })

    expect(response.status).toBe(403)
    expect((response.body as { error: string }).error).toContain('does not hold workflows.write')
  })

  it('reports a failed run as a failure, never as an empty brief', async () => {
    const { api } = bench({ run: async () => { throw new Error('the agent turn failed: model refused') } })
    const response = await api({
      method: 'POST',
      path: '/missions',
      ...asOwner,
      body: JSON.stringify({ kind: 'briefing', prompt: 'x' }),
    })

    expect(response.status).toBe(502)
    const body = response.body as { error: string; mission: { status: string; error: string } }
    expect(body.error).toContain('model refused')
    expect(body.mission.status).toBe('failed')
    expect(body.mission.error).toContain('model refused')
  })

  it('keeps a private mission to its author', async () => {
    const { api } = bench()
    const created = await api({
      method: 'POST',
      path: '/missions',
      ...asOwner,
      body: JSON.stringify({ kind: 'custom', prompt: 'x', visibility: 'private' }),
    })
    const id = (created.body as { mission: { id: string } }).mission.id

    expect((await api({ method: 'GET', path: `/missions/${id}`, ...asOwner })).status).toBe(200)
    const seenByViewer = await api({ method: 'GET', path: `/missions/${id}`, ...asViewer })
    expect(seenByViewer.status).toBe(403)
    const list = await api({ method: 'GET', path: '/missions', ...asViewer })
    expect((list.body as { missions: unknown[] }).missions).toHaveLength(0)
  })

  it('holds an external action until a person with rights decides', async () => {
    const { api } = bench()
    const requested = await api({
      method: 'POST',
      path: '/approvals',
      ...asOwner,
      body: JSON.stringify({ kind: 'send-email', title: 'Relance facture', payload: { to: 'client@example.com' } }),
    })
    expect(requested.status).toBe(201)
    const id = (requested.body as { approval: { id: string } }).approval.id

    const byViewer = await api({
      method: 'POST',
      path: `/approvals/${id}/decide`,
      ...asViewer,
      body: JSON.stringify({ decision: 'approved' }),
    })
    expect(byViewer.status).toBe(403)

    const byOwner = await api({
      method: 'POST',
      path: `/approvals/${id}/decide`,
      ...asOwner,
      body: JSON.stringify({ decision: 'approved' }),
    })
    expect(byOwner.status).toBe(200)
    expect((byOwner.body as { approval: { state: string } }).approval.state).toBe('approved')
  })

  it('keeps memory and shows it back, newest first', async () => {
    const { api } = bench()
    await api({ method: 'POST', path: '/memory', ...asOwner, body: JSON.stringify({ scope: 'team', kind: 'decision', text: 'Point quotidien à 8h30.' }) })
    await api({ method: 'POST', path: '/memory', ...asOwner, body: JSON.stringify({ scope: 'team', kind: 'fact', text: 'Deux clients en renouvellement.' }) })

    const response = await api({ method: 'GET', path: '/memory', ...asOwner })
    const body = response.body as { memories: { text: string }[] }
    expect(body.memories).toHaveLength(2)
    expect(body.memories[0]?.text).toContain('renouvellement')
  })

  it('lists the mounted connectors', async () => {
    const { api } = bench()
    const response = await api({ method: 'GET', path: '/connectors', ...asOwner })
    expect(response.body).toEqual({ connectors: [{ module: 'mcp-client-attio', server: 'attio', enabled: true }] })
  })

  it('serves the product history', async () => {
    const { api } = bench()
    await api({
      method: 'POST',
      path: '/missions',
      ...asOwner,
      body: JSON.stringify({ kind: 'briefing', prompt: 'x' }),
    })
    const response = await api({ method: 'GET', path: '/events', ...asOwner })
    const body = response.body as { events: { action: string }[] }
    expect(body.events.map(event => event.action)).toEqual(['mission.queued', 'mission.started', 'mission.done'])
  })
})

describe('solo mode', () => {
  it('refuses writes when nobody is nominated as owner', async () => {
    const source = localGrants(undefined)
    const decision = await source.grants()
    expect(decision.ok).toBe(false)
  })
})
