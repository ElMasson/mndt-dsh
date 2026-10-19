// @vitest-environment jsdom
/**
 * The page, rendered for real.
 *
 * This test mounts the component in jsdom with a stand-in Remote face and reads
 * the DOM. It exists because a compiling page and a page that displays something
 * are two different claims, and only the second one matters to the person using
 * it.
 */
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GovernancePage } from '@deepseek-ai/dsh-client-ui-governance/client'
import type { GovernanceKey } from '@deepseek-ai/dsh-client-ui-governance/client'
import type { TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'
// Type-only: pulls the generated Remote projection that declares 'governance'.
import type {} from '@deepseek-ai/dsh-host-governance/remote'

const t = (key: GovernanceKey): string => key

/** Minimal Remote face: every method the page knows, with swappable answers. */
function fakeApi(overrides: Partial<TypertRemoteNamespaceMap['governance']> = {}): TypertRemoteNamespaceMap['governance'] {
  return {
    list: vi.fn(async () => ({ ok: true as const, value: [] })),
    decide: vi.fn(async () => ({ ok: true as const, value: { allowed: true, reason: 'ok' } })),
    setGrant: vi.fn(async () => ({ ok: true as const, value: { allowed: true, reason: 'granted' } })),
    removeGrant: vi.fn(async () => ({ ok: true as const, value: { allowed: true, reason: 'removed' } })),
    bootstrapOwner: vi.fn(async () => ({ ok: true as const, value: { allowed: true, reason: 'bootstrapped' } })),
    agents: vi.fn(async () => ({ ok: true as const, value: [] })),
    workspaces: vi.fn(async () => ({ ok: true as const, value: [] })),
    connectors: vi.fn(async () => ({ ok: true as const, value: [] })),
    tableState: vi.fn(async () => ({ ok: true as const, value: { stale: false, source: 'local', detail: 'local table' } })),
    ...overrides,
  }
}

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render(api: TypertRemoteNamespaceMap['governance']): Promise<string> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<GovernancePage t={t} api={api} />)
  })
  return host.textContent ?? ''
}

afterEach(() => {
  if (root !== undefined) {
    act(() => { root?.unmount() })
  }
  host?.remove()
  root = undefined
  host = undefined
})

describe('the rights surface', () => {
  it('renders the grants the Host returned', async () => {
    const api = fakeApi({
      list: vi.fn(async () => ({
        ok: true as const,
        value: [
          { subject: 'stephane', role: 'owner' },
          { subject: 'client', role: 'viewer', scope: 'session-42' },
        ],
      })),
    })

    const text = await render(api)

    expect(api.list).toHaveBeenCalledTimes(1)
    expect(text).toContain('stephane')
    expect(text).toContain('owner')
    expect(text).toContain('session-42')
  })

  it('says the table is empty rather than showing nothing at all', async () => {
    const text = await render(fakeApi())

    expect(text).toContain('empty')
  })

  it('shows a read failure instead of an empty table', async () => {
    const api = fakeApi({
      list: vi.fn(async () => { throw new Error('socket hang up') }),
    })

    const text = await render(api)

    expect(text).toContain('socket hang up')
  })

  it('revokes a grant and reports the Host answer', async () => {
    const removeGrant = vi.fn(async () => ({ ok: true as const, value: { allowed: true, reason: 'removed by owner' } }))
    const api = fakeApi({
      list: vi.fn(async () => ({ ok: true as const, value: [{ subject: 'sara', role: 'admin' }] })),
      removeGrant,
    })

    await render(api)

    const button = [...(host?.querySelectorAll('button') ?? [])].find(element => element.textContent === 'revoke')
    expect(button).toBeDefined()
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(removeGrant).toHaveBeenCalledTimes(1)
    expect(host?.textContent).toContain('removed by owner')
  })

  it('renders the mounted connectors the Loader reported', async () => {
    const api = fakeApi({
      connectors: vi.fn(async () => ({
        ok: true as const,
        value: [{ entry: 'entry-1', module: 'dsh-mcp-client', server: 'office365', enabled: true }],
      })),
    })

    await render(api)
    const connectorsTab = [...(host?.querySelectorAll('button') ?? [])].find(element => element.textContent === 'tabConnectors')
    expect(connectorsTab).toBeDefined()
    await act(async () => {
      connectorsTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(api.connectors).toHaveBeenCalledTimes(1)
    expect(host?.textContent).toContain('office365')
    expect(host?.textContent).toContain('enabled')
  })

  it('warns that the table is cached when the authority is unreachable', async () => {
    const api = fakeApi({
      list: vi.fn(async () => ({ ok: true as const, value: [{ subject: 'stephane', role: 'owner' }] })),
      tableState: vi.fn(async () => ({
        ok: true as const,
        value: { stale: true, source: 'cache', detail: 'authority unreachable' },
      })),
    })

    const text = await render(api)

    expect(api.tableState).toHaveBeenCalledTimes(1)
    expect(text).toContain('staleTable')
    expect(text).toContain('authority unreachable')
  })

  it('shows the cached rows even while warning about them', async () => {
    const api = fakeApi({
      list: vi.fn(async () => ({ ok: true as const, value: [{ subject: 'stephane', role: 'owner' }] })),
      tableState: vi.fn(async () => ({
        ok: true as const,
        value: { stale: true, source: 'cache', detail: 'expired token' },
      })),
    })

    const text = await render(api)

    expect(text).toContain('stephane')
    expect(text).toContain('expired token')
  })
})
