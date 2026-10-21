/**
 * The governance page.
 *
 * Every rule is decided by the Host. This page displays what the Host says and
 * forwards what the user asks. A Host refusal is shown with its reason rather
 * than swallowed: turning a refusal into an empty table would be exactly the
 * silent absence this page exists to avoid.
 */
import { useCallback, useEffect, useState } from 'react'
import type { TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentRow, AutomationRow, ConnectorRow, GrantRow, WorkspaceRow } from '@deepseek-ai/dsh-host-governance/types'
import type { GovernanceKey } from './locales.ts'

/** Props handed by the slot registration. */
export interface GovernancePageProps {
  /** Resolves a localised string. */
  t: (key: GovernanceKey) => string
  /** The Host Remote face, as generated from the gateway. */
  api: TypertRemoteNamespaceMap['governance']
}

const TABS: readonly { key: GovernanceKey; id: string; wired: boolean }[] = [
  { key: 'tabConnectors', id: 'connectors', wired: true },
  { key: 'tabAgents', id: 'agents', wired: true },
  { key: 'tabWorkflows', id: 'workflows', wired: true },
  { key: 'tabRights', id: 'rights', wired: true },
  { key: 'tabSharing', id: 'sharing', wired: true },
]

/** @param failure - the Host failure. @returns the text to show. */
function failureText(failure: { code?: unknown; message?: unknown }): string {
  const code = typeof failure.code === 'string' ? failure.code : 'host failure'
  const message = typeof failure.message === 'string' ? failure.message : ''
  return message === '' ? code : `${code}: ${message}`
}

/**
 * Render the governance surface.
 * @param props - slot copy resolver and Host Remote face.
 * @returns The page element.
 */
export function GovernancePage({ t, api }: GovernancePageProps): JSX.Element {
  const [active, setActive] = useState('rights')
  const [rows, setRows] = useState<GrantRow[]>([])
  const [agents, setAgents] = useState<AgentRow[]>([])
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([])
  const [connectors, setConnectors] = useState<ConnectorRow[]>([])
  const [automations, setAutomations] = useState<AutomationRow[]>([])
  const [prompt, setPrompt] = useState('')
  const [actor, setActor] = useState('')
  const [subject, setSubject] = useState('')
  const [role, setRole] = useState('viewer')
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [stale, setStale] = useState<string | null>(null)

  const fail = useCallback((text: string) => {
    setFailed(true)
    setNotice(`${t('refused')}: ${text}`)
  }, [t])

  const loadGrants = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.list()
      if (result.ok) setRows(result.value)
      else fail(failureText(result.error))
    } catch (error) {
      fail(error instanceof Error ? error.message : t('error'))
    } finally {
      setLoading(false)
    }
  }, [api, fail, t])

  const loadState = useCallback(async () => {
    try {
      const result = await api.tableState()
      if (result.ok && result.value.stale) setStale(result.value.detail)
      else setStale(null)
    } catch {
      // Staleness is a status, not a dependency: losing it must not hide the table.
    }
  }, [api])

  const loadAgents = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.agents()
      if (result.ok) setAgents(result.value)
      else fail(failureText(result.error))
    } catch (error) {
      fail(error instanceof Error ? error.message : t('error'))
    } finally {
      setLoading(false)
    }
  }, [api, fail, t])

  const loadAutomations = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.automations(actor)
      if (result.ok) setAutomations(result.value)
      else fail(failureText(result.error))
    } catch (error) {
      fail(error instanceof Error ? error.message : t('error'))
    } finally {
      setLoading(false)
    }
  }, [api, actor, fail, t])

  const createAutomation = async (): Promise<void> => {
    if (prompt.trim() === '') return
    const result = await api.createAutomation(actor, prompt.trim(), 60)
    if (result.ok) {
      setFailed(false)
      setNotice(t('accepted'))
      setPrompt('')
    } else {
      fail(failureText(result.error))
    }
    await loadAutomations()
  }

  const runAutomation = async (row: AutomationRow): Promise<void> => {
    const result = await api.runAutomationNow(actor, row.id)
    if (result.ok) {
      setFailed(false)
      setNotice(`${t('accepted')}: ${result.value.reason}`)
    } else {
      fail(failureText(result.error))
    }
  }

  const loadConnectors = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.connectors()
      if (result.ok) setConnectors(result.value)
      else fail(failureText(result.error))
    } catch (error) {
      fail(error instanceof Error ? error.message : t('error'))
    } finally {
      setLoading(false)
    }
  }, [api, fail, t])

  const loadWorkspaces = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.workspaces()
      if (result.ok) setWorkspaces(result.value)
      else fail(failureText(result.error))
    } catch (error) {
      fail(error instanceof Error ? error.message : t('error'))
    } finally {
      setLoading(false)
    }
  }, [api, fail, t])

  useEffect(() => {
    if (active === 'rights') { void loadGrants(); void loadState() }
    if (active === 'agents') void loadAgents()
    if (active === 'sharing') void loadWorkspaces()
    if (active === 'connectors') void loadConnectors()
    if (active === 'workflows') void loadAutomations()
  }, [active, loadGrants, loadState, loadAgents, loadConnectors, loadAutomations, loadWorkspaces])

  const submitGrant = async (): Promise<void> => {
    if (subject.trim() === '') return
    const result = await api.setGrant(actor, { subject: subject.trim(), role })
    if (result.ok) {
      setFailed(false)
      setNotice(`${t('accepted')}: ${result.value.reason}`)
      setSubject('')
    } else {
      fail(failureText(result.error))
    }
    await loadGrants()
  }

  const revoke = async (row: GrantRow): Promise<void> => {
    const result = await api.removeGrant(actor, row.subject, row.scope)
    if (result.ok) {
      setFailed(false)
      setNotice(`${t('accepted')}: ${result.value.reason}`)
    } else {
      fail(failureText(result.error))
    }
    await loadGrants()
  }

  const tab = TABS.find(item => item.id === active)

  return (
    <section className="dsh-governance" aria-label={t('title')}>
      <header>
        <h1>{t('title')}</h1>
        <p>{t('subtitle')}</p>
      </header>

      <nav role="tablist">
        {TABS.map(item => (
          <button
            key={item.id}
            role="tab"
            aria-selected={active === item.id}
            onClick={() => setActive(item.id)}
          >
            {t(item.key)}
          </button>
        ))}
      </nav>

      {loading && <p role="status">{t('loading')}</p>}
      {stale !== null && <p role="alert" data-stale="true">{t('staleTable')}: {stale}</p>}
      {notice !== null && <p role="status" data-refused={failed}>{notice}</p>}

      {tab !== undefined && !tab.wired && <p role="status">{t('notWired')}</p>}

      {active === 'agents' && (
        agents.length === 0
          ? <p role="status">{t('empty')}</p>
          : (
            <table>
              <thead>
                <tr>
                  <th>{t('subject')}</th>
                  <th>{t('role')}</th>
                </tr>
              </thead>
              <tbody>
                {agents.map(agent => (
                  <tr key={agent.id}>
                    <td>{agent.id}</td>
                    <td>{agent.name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
      )}

      {active === 'workflows' && (
        <div>
          <label>
            {t('actor')}
            <input value={actor} onChange={event => setActor(event.target.value)} placeholder="usr-id" />
          </label>
          <div>
            <label>
              Prompt
              <input value={prompt} onChange={event => setPrompt(event.target.value)} />
            </label>
            <button onClick={() => void createAutomation()}>{t('submit')}</button>
          </div>
          {automations.length === 0
            ? <p role="status">{t('empty')}</p>
            : (
              <table>
                <thead>
                  <tr>
                    <th>Prompt</th>
                    <th>{t('actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {automations.map(row => (
                    <tr key={row.id}>
                      <td>{row.prompt}</td>
                      <td>
                        <button onClick={() => void runAutomation(row)}>{t('submit')}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
      )}

      {active === 'connectors' && (
        connectors.length === 0
          ? <p role="status">{t('empty')}</p>
          : (
            <table>
              <thead>
                <tr>
                  <th>{t('subject')}</th>
                  <th>{t('scope')}</th>
                  <th>{t('actions')}</th>
                </tr>
              </thead>
              <tbody>
                {connectors.map(connector => (
                  <tr key={connector.entry}>
                    <td>{connector.server}</td>
                    <td>{connector.module}</td>
                    <td>{connector.enabled ? 'enabled' : 'disabled'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
      )}

      {active === 'sharing' && (
        workspaces.length === 0
          ? <p role="status">{t('empty')}</p>
          : (
            <table>
              <thead>
                <tr>
                  <th>{t('subject')}</th>
                  <th>{t('scope')}</th>
                </tr>
              </thead>
              <tbody>
                {workspaces.map(space => (
                  <tr key={space.id}>
                    <td>{space.title}</td>
                    <td>{space.path}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
      )}

      {active === 'rights' && (
        <div>
          <label>
            {t('actor')}
            <input
              value={actor}
              onChange={event => setActor(event.target.value)}
              placeholder="usr-id"
            />
          </label>
          <small>{t('actorHint')}</small>

          <div>
            <label>
              {t('subject')}
              <input value={subject} onChange={event => setSubject(event.target.value)} />
            </label>
            <label>
              {t('role')}
              <select value={role} onChange={event => setRole(event.target.value)}>
                <option value="viewer">viewer</option>
                <option value="operator">operator</option>
                <option value="admin">admin</option>
                <option value="owner">owner</option>
              </select>
            </label>
            <button onClick={() => void submitGrant()}>{t('submit')}</button>
          </div>

          {!loading && rows.length === 0
            ? <p role="status">{t('empty')}</p>
            : (
              <table>
                <thead>
                  <tr>
                    <th>{t('subject')}</th>
                    <th>{t('role')}</th>
                    <th>{t('scope')}</th>
                    <th>{t('actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => (
                    <tr key={`${row.subject}:${row.scope ?? '*'}`}>
                      <td>{row.subject}</td>
                      <td>{row.role}</td>
                      <td>{row.scope ?? t('global')}</td>
                      <td>
                        <button onClick={() => void revoke(row)}>{t('revoke')}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
      )}
    </section>
  )
}
