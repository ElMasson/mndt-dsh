/**
 * The governance page.
 *
 * Every rule is decided by the Host. This page displays what the Host says and
 * forwards what the user asks. A Host refusal is shown with its reason rather
 * than swallowed: turning a refusal into an empty table would be exactly the
 * silent absence this page exists to avoid.
 *
 * Presentation follows the mndt shell: offwhite canvas, white cards, warm border,
 * small uppercase labels, pill badges, and a nav column on the left.
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

const TABS: readonly { key: GovernanceKey; id: string }[] = [
  { key: 'tabConnectors', id: 'connectors' },
  { key: 'tabAgents', id: 'agents' },
  { key: 'tabWorkflows', id: 'workflows' },
  { key: 'tabRights', id: 'rights' },
  { key: 'tabSharing', id: 'sharing' },
]

const ROLE_LABELS: Readonly<Record<string, GovernanceKey>> = {
  viewer: 'roleViewer',
  operator: 'roleOperator',
  admin: 'roleAdmin',
  owner: 'roleOwner',
}

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
  const [identity, setIdentity] = useState<string | null>(null)

  const fail = useCallback((text: string) => { setFailed(true); setNotice(text) }, [])

  const load = useCallback(async <T,>(
    read: () => Promise<{ ok: true; value: T } | { ok: false; error: { code?: unknown; message?: unknown } }>,
    apply: (value: T) => void,
  ): Promise<void> => {
    setLoading(true)
    try {
      const result = await read()
      if (result.ok) apply(result.value)
      else fail(failureText(result.error))
    } catch (error) {
      fail(error instanceof Error ? error.message : t('error'))
    } finally {
      setLoading(false)
    }
  }, [fail, t])

  const loadGrants = useCallback(() => load(() => api.list(), setRows), [api, load])
  const loadAgents = useCallback(() => load(() => api.agents(), setAgents), [api, load])
  const loadWorkspaces = useCallback(() => load(() => api.workspaces(), setWorkspaces), [api, load])
  const loadConnectors = useCallback(() => load(() => api.connectors(), setConnectors), [api, load])
  const loadAutomations = useCallback(() => load(() => api.automations(actor), setAutomations), [actor, api, load])

  const loadState = useCallback(async () => {
    try {
      const result = await api.tableState()
      if (result.ok) setIdentity(result.value.identity ?? null)
      if (result.ok && result.value.stale) setStale(result.value.detail)
      else setStale(null)
    } catch {
      // Staleness is a status, not a dependency: losing it must not hide the table.
    }
  }, [api])

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
    if (result.ok) { setFailed(false); setNotice(result.value.reason); setSubject('') } else fail(failureText(result.error))
    await loadGrants()
  }

  const revoke = async (row: GrantRow): Promise<void> => {
    const result = await api.removeGrant(actor, row.subject, row.scope)
    if (result.ok) { setFailed(false); setNotice(result.value.reason) } else fail(failureText(result.error))
    await loadGrants()
  }

  const createAutomation = async (): Promise<void> => {
    if (prompt.trim() === '') return
    const result = await api.createAutomation(actor, prompt.trim(), 60)
    if (result.ok) { setFailed(false); setNotice(t('accepted')); setPrompt('') } else fail(failureText(result.error))
    await loadAutomations()
  }

  const runAutomation = async (row: AutomationRow): Promise<void> => {
    const result = await api.runAutomationNow(actor, row.id)
    if (result.ok) { setFailed(false); setNotice(result.value.reason) } else fail(failureText(result.error))
  }

  /** @param value - number of rows. @returns a pill carrying it. */
  const countPill = (value: number): JSX.Element => (
    <span className="gov-pill" data-tone={value > 0 ? 'ok' : undefined}>{value}</span>
  )

  return (
    <section className="gov" aria-label={t('title')}>
      <header className="gov-head">
        <div>
          <h1 className="gov-title">{t('title')}</h1>
          <p className="gov-sub">{t('subtitle')}</p>
        </div>
        <div className="gov-head-state">
          {identity !== null && <span className="gov-pill" data-tone="id" title={t('identityHint')}>{identity}</span>}
          {stale === null
            ? <span className="gov-pill" data-tone="ok">{t('liveTable')}</span>
            : <span className="gov-pill" data-tone="warn">{t('staleTable')}</span>}
        </div>
      </header>

      <div className="gov-body">
        <nav className="gov-nav" aria-label={t('title')}>
          {TABS.map(tab => (
            <button key={tab.id} className="gov-nav-item" aria-selected={active === tab.id} onClick={() => setActive(tab.id)}>
              <span className="gov-nav-dot" aria-hidden="true" />
              {t(tab.key)}
            </button>
          ))}
        </nav>

        <div className="gov-panel">
          {loading && <p className="gov-status">{t('loading')}</p>}
          {stale !== null && (
            <div className="gov-banner" data-stale="true">
              <strong>{t('staleTable')}</strong>
              <span>{stale}</span>
            </div>
          )}
          {notice !== null && (
            <div className="gov-banner" data-tone={failed ? 'bad' : undefined} role="status">
              <span>{notice}</span>
            </div>
          )}

          {active === 'rights' && (
            <>
              <div className="gov-card">
                <div className="gov-card-head">
                  <h2 className="gov-card-title">{t('tabRights')}</h2>
                  {countPill(rows.length)}
                </div>
                <div className="gov-form">
                  <label className="gov-field">
                    <span className="gov-label">{t('actor')}</span>
                    <input className="gov-input" value={actor} placeholder="usr-id" onChange={event => setActor(event.target.value)} />
                  </label>
                  <label className="gov-field">
                    <span className="gov-label">{t('subject')}</span>
                    <input className="gov-input" value={subject} onChange={event => setSubject(event.target.value)} />
                  </label>
                  <label className="gov-field">
                    <span className="gov-label">{t('role')}</span>
                    <select className="gov-select" value={role} onChange={event => setRole(event.target.value)}>
                      <option value="viewer">{t('roleViewer')}</option>
                      <option value="operator">{t('roleOperator')}</option>
                      <option value="admin">{t('roleAdmin')}</option>
                      <option value="owner">{t('roleOwner')}</option>
                    </select>
                  </label>
                  <button className="gov-button" data-variant="primary" onClick={() => void submitGrant()}>{t('submit')}</button>
                  <span className="gov-status">{t('actorHint')}</span>
                </div>
              </div>

              <div className="gov-card">
                {rows.length === 0
                  ? <div className="gov-empty">{t('empty')}</div>
                  : (
                    <>
                      <div className="gov-row-head">
                        <span>{t('subject')}</span><span>{t('role')}</span><span>{t('scope')}</span><span>{t('actions')}</span>
                      </div>
                      <div className="gov-rows">
                        {rows.map(row => (
                          <div className="gov-row" key={`${row.subject}:${row.scope ?? '*'}`}>
                            <span className="gov-cell gov-mono">{row.subject}</span>
                            <span className="gov-cell">{t(ROLE_LABELS[row.role] ?? 'roleViewer')}</span>
                            <span className="gov-cell gov-muted">{row.scope ?? t('global')}</span>
                            <button className="gov-button" data-variant="quiet" onClick={() => void revoke(row)}>{t('revoke')}</button>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
              </div>
            </>
          )}

          {active === 'agents' && (
            <div className="gov-card">
              <div className="gov-card-head"><h2 className="gov-card-title">{t('tabAgents')}</h2>{countPill(agents.length)}</div>
              {agents.length === 0
                ? <div className="gov-empty">{t('empty')}</div>
                : (
                  <>
                    <div className="gov-row-head" data-columns="2"><span>{t('subject')}</span><span>{t('role')}</span></div>
                    <div className="gov-rows">
                      {agents.map(agent => (
                        <div className="gov-row" data-columns="2" key={agent.id}>
                          <span className="gov-cell gov-mono">{agent.id}</span>
                          <span className="gov-cell">{agent.name}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
            </div>
          )}

          {active === 'sharing' && (
            <div className="gov-card">
              <div className="gov-card-head"><h2 className="gov-card-title">{t('tabSharing')}</h2>{countPill(workspaces.length)}</div>
              {workspaces.length === 0
                ? <div className="gov-empty">{t('empty')}</div>
                : (
                  <>
                    <div className="gov-row-head" data-columns="2"><span>{t('subject')}</span><span>{t('scope')}</span></div>
                    <div className="gov-rows">
                      {workspaces.map(space => (
                        <div className="gov-row" data-columns="2" key={space.id}>
                          <span className="gov-cell">{space.title}</span>
                          <span className="gov-cell gov-mono gov-muted">{space.path}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
            </div>
          )}

          {active === 'connectors' && (
            <div className="gov-card">
              <div className="gov-card-head"><h2 className="gov-card-title">{t('tabConnectors')}</h2>{countPill(connectors.length)}</div>
              {connectors.length === 0
                ? <div className="gov-empty">{t('empty')}</div>
                : (
                  <>
                    <div className="gov-row-head" data-columns="3">
                      <span>{t('subject')}</span><span>{t('scope')}</span><span>{t('actions')}</span>
                    </div>
                    <div className="gov-rows">
                      {connectors.map(connector => (
                        <div className="gov-row" data-columns="3" key={connector.entry}>
                          <span className="gov-cell">{connector.server}</span>
                          <span className="gov-cell gov-mono gov-muted">{connector.module}</span>
                          <span className="gov-cell">
                            <span className="gov-pill" data-tone={connector.enabled ? 'ok' : undefined}>
                              {connector.enabled ? t('connectorEnabled') : t('connectorDisabled')}
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
            </div>
          )}

          {active === 'workflows' && (
            <>
              <div className="gov-card">
                <div className="gov-card-head"><h2 className="gov-card-title">{t('tabWorkflows')}</h2>{countPill(automations.length)}</div>
                <div className="gov-form">
                  <label className="gov-field">
                    <span className="gov-label">{t('actor')}</span>
                    <input className="gov-input" value={actor} placeholder="usr-id" onChange={event => setActor(event.target.value)} />
                  </label>
                  <label className="gov-field" style={{ flex: '1 1 320px' }}>
                    <span className="gov-label">{t('promptLabel')}</span>
                    <input className="gov-input" value={prompt} onChange={event => setPrompt(event.target.value)} />
                  </label>
                  <button className="gov-button" data-variant="primary" onClick={() => void createAutomation()}>{t('submit')}</button>
                </div>
              </div>

              <div className="gov-card">
                {automations.length === 0
                  ? <div className="gov-empty">{t('empty')}</div>
                  : (
                    <>
                      <div className="gov-row-head" data-columns="2"><span>{t('promptLabel')}</span><span>{t('actions')}</span></div>
                      <div className="gov-rows">
                        {automations.map(row => (
                          <div className="gov-row" data-columns="2" key={row.id}>
                            <span className="gov-cell">{row.prompt}</span>
                            <span className="gov-cell">
                              <button className="gov-button" onClick={() => void runAutomation(row)}>{t('run')}</button>
                            </span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
