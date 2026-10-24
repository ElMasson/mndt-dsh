/**
 * The morning page.
 *
 * One screen, read in one call: what waits for a decision, what is running, what
 * was produced, and what the team chose to remember. Actions go through the Host
 * face, which checks the grant table before anything changes; this page never
 * decides on its own, it only shows what the Host answered.
 */
import { useCallback, useEffect, useState } from 'react'
import { CSS } from './styles.ts'
import type { MndtKey } from './locales.ts'

/** A mission as the page reads it. */
export interface MissionRow {
  readonly id: string
  readonly kind: string
  readonly prompt: string
  readonly status: string
  readonly createdBy: string
  readonly createdAt: string
  readonly error?: string
}

/** A brief as the page reads it. */
export interface BriefRow {
  readonly id: string
  readonly title: string
  readonly markdown: string
  readonly status: string
  readonly createdAt: string
}

/** An approval as the page reads it. */
export interface ApprovalRow {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly requestedBy: string
  readonly requestedAt: string
}

/** A memory note as the page reads it. */
export interface MemoryRow {
  readonly id: string
  readonly scope: string
  readonly kind: string
  readonly text: string
  readonly createdBy: string
}

/** What one read returns. */
export interface PageStateRow {
  readonly you: string
  readonly canWrite: boolean
  readonly missions: readonly MissionRow[]
  readonly briefs: readonly BriefRow[]
  readonly approvals: readonly ApprovalRow[]
  readonly memories: readonly MemoryRow[]
}

/** One outcome as the Host reports it. */
export interface OutcomeRow<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: string
}

/** One mounted connector, as the page reads it. */
export interface ConnectorRow {
  readonly module: string
  readonly server: string
  readonly enabled: boolean
}

/** The Host face this page needs. */
export interface MndtFace {
  state(): Promise<PageStateRow>
  runMission(kind: string, prompt: string): Promise<OutcomeRow<{ readonly mission: MissionRow; readonly brief?: BriefRow }>>
  decide(approvalId: string, decision: 'approved' | 'rejected', reason?: string): Promise<OutcomeRow<ApprovalRow>>
  approveBrief(briefId: string): Promise<OutcomeRow<BriefRow>>
  remember(scope: 'team' | 'user' | 'mission', kind: 'fact' | 'decision' | 'preference', text: string): Promise<OutcomeRow<MemoryRow>>
  connectors(): Promise<readonly ConnectorRow[]>
}

/** What the page receives from its plugin. */
export interface MndtPageProps {
  readonly t: (key: MndtKey) => string
  readonly api: MndtFace
}

/** @param approval - what is waiting. @returns the sentence a reader needs. */
function approvalMeta(approval: ApprovalRow): string {
  const asked = new Date(approval.requestedAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
  return `${approval.kind} · ${approval.requestedBy} · ${asked}`
}

/** The page. */
export function MndtPage({ t, api }: MndtPageProps): React.ReactElement {
  const [state, setState] = useState<PageStateRow | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [kind, setKind] = useState<'fact' | 'decision' | 'preference'>('fact')
  const [connectors, setConnectors] = useState<readonly ConnectorRow[]>([])

  useEffect(() => {
    const style = document.createElement('style')
    style.id = 'mndt-workbench-styles'
    style.textContent = CSS
    document.head.append(style)
    return () => { style.remove() }
  }, [])

  const load = useCallback(async (): Promise<void> => {
    try {
      setState(await api.state())
      setConnectors(await api.connectors().catch(() => []))
      setError(null)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [api])

  useEffect(() => { void load() }, [load])

  /** @param label - the action being attempted. @param work - the call. */
  const act = async (label: string, work: () => Promise<void>): Promise<void> => {
    setBusy(label)
    try {
      await work()
      await load()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(null)
    }
  }

  if (state === null) {
    return (
      <section className="mndt" aria-label={t('title')}>
        <header className="mndt-head">
          <div>
            <h1 className="mndt-title">{t('title')}</h1>
            <p className="mndt-sub">{error ?? t('loading')}</p>
          </div>
        </header>
      </section>
    )
  }

  return (
    <section className="mndt" aria-label={t('title')}>
      <header className="mndt-head">
        <div>
          <h1 className="mndt-title">{t('title')}</h1>
          <p className="mndt-sub">{t('subtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <span className="mndt-pill" data-tone="id" title={t('you')}>{state.you}</span>
          <span className="mndt-pill" data-tone={state.canWrite ? 'write' : undefined}>{state.canWrite ? t('writer') : t('readOnly')}</span>
        </div>
      </header>

      {error !== null && <p className="mndt-error">{error}</p>}

      <div className="mndt-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <section className="mndt-card">
            <div className="mndt-card-head">
              <h2 className="mndt-card-title">{t('decisions')}</h2>
              <span className="mndt-count">{state.approvals.length}</span>
            </div>
            <div className="mndt-card-body">
              {state.approvals.length === 0 && <p className="mndt-empty">{t('noDecisions')}</p>}
              {state.approvals.map(approval => (
                <div className="mndt-row" key={approval.id}>
                  <div className="mndt-row-head">
                    <span className="mndt-row-title">{approval.title}</span>
                    <span className="mndt-row-meta">{approvalMeta(approval)}</span>
                  </div>
                  <div className="mndt-row-actions">
                    <input
                      className="mndt-input"
                      placeholder={t('reason')}
                      value={reason}
                      onChange={(event) => { setReason(event.target.value) }}
                      aria-label={t('reason')}
                    />
                    <button
                      className="mndt-button"
                      data-variant="primary"
                      disabled={busy !== null || !state.canWrite}
                      onClick={() => {
                        void act('approve', async () => {
                          const result = await api.decide(approval.id, 'approved')
                          if (!result.ok) throw new Error(result.error ?? 'refused')
                        })
                      }}
                    >
                      {t('approve')}
                    </button>
                    <button
                      className="mndt-button"
                      data-variant="danger"
                      disabled={busy !== null || !state.canWrite || reason.trim() === ''}
                      onClick={() => {
                        void act('reject', async () => {
                          const result = await api.decide(approval.id, 'rejected', reason)
                          if (!result.ok) throw new Error(result.error ?? 'refused')
                        })
                      }}
                    >
                      {t('refuse')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="mndt-card">
            <div className="mndt-card-head">
              <h2 className="mndt-card-title">{t('missions')}</h2>
              <button
                className="mndt-button"
                data-variant="primary"
                disabled={busy !== null || !state.canWrite}
                onClick={() => {
                  void act('run', async () => {
                    const result = await api.runMission('briefing', 'Briefing du matin : agenda, courriers sans réponse, comptes à risque, échéances, réunions du jour.')
                    if (!result.ok) throw new Error(result.error ?? 'refused')
                  })
                }}
              >
                {busy === 'run' ? `${t('running')}…` : t('runBriefing')}
              </button>
            </div>
            <div className="mndt-card-body">
              {state.missions.length === 0 && <p className="mndt-empty">{t('noMissions')}</p>}
              {state.missions.slice(0, 8).map(mission => (
                <div className="mndt-row" key={mission.id}>
                  <div className="mndt-row-head">
                    <span className="mndt-row-title">{mission.kind}</span>
                    <span className="mndt-row-meta">{mission.status === 'failed' ? t('failed') : mission.status}</span>
                  </div>
                  <span className="mndt-row-meta">{mission.error ?? mission.prompt}</span>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <section className="mndt-card">
            <div className="mndt-card-head">
              <h2 className="mndt-card-title">{t('briefs')}</h2>
              <span className="mndt-count">{state.briefs.length}</span>
            </div>
            <div className="mndt-card-body">
              {state.briefs.length === 0 && <p className="mndt-empty">{t('noBriefs')}</p>}
              {state.briefs.slice(0, 6).map(brief => (
                <details className="mndt-details mndt-row" key={brief.id}>
                  <summary>{brief.title}</summary>
                  <div className="mndt-markdown">{brief.markdown}</div>
                  <div className="mndt-row-actions">
                    <span className="mndt-row-meta">{brief.status}</span>
                    {brief.status === 'draft' && state.canWrite && (
                      <button
                        className="mndt-button"
                        disabled={busy !== null}
                        onClick={() => {
                          void act('brief', async () => {
                            const result = await api.approveBrief(brief.id)
                            if (!result.ok) throw new Error(result.error ?? 'refused')
                          })
                        }}
                      >
                        {t('approve')}
                      </button>
                    )}
                  </div>
                </details>
              ))}
            </div>
          </section>

          <section className="mndt-card">
            <div className="mndt-card-head">
              <h2 className="mndt-card-title">{t('connectors')}</h2>
              <span className="mndt-count">{connectors.length}</span>
            </div>
            <div className="mndt-card-body">
              {connectors.length === 0 && <p className="mndt-empty">{t('noConnectors')}</p>}
              {connectors.slice(0, 12).map(connector => (
                <div className="mndt-row" key={connector.module}>
                  <span className="mndt-note">{connector.server}</span>
                  <span className="mndt-note-meta">{connector.enabled ? t('mounted') : t('off')}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="mndt-card">
            <div className="mndt-card-head">
              <h2 className="mndt-card-title">{t('memory')}</h2>
            </div>
            <div className="mndt-card-body">
              {state.memories.length === 0 && <p className="mndt-empty">{t('noMemory')}</p>}
              {state.memories.slice(0, 6).map(memory => (
                <div className="mndt-row" key={memory.id}>
                  <span className="mndt-note">{memory.text}</span>
                  <span className="mndt-note-meta">{memory.scope} · {memory.kind} · {memory.createdBy}</span>
                </div>
              ))}
              <textarea
                className="mndt-input mndt-textarea"
                placeholder={t('notePlaceholder')}
                value={note}
                onChange={(event) => { setNote(event.target.value) }}
                aria-label={t('notePlaceholder')}
              />
              <div className="mndt-row-actions">
                <select className="mndt-input" value={kind} onChange={(event) => { setKind(event.target.value as typeof kind) }} aria-label="kind">
                  <option value="fact">fact</option>
                  <option value="decision">decision</option>
                  <option value="preference">preference</option>
                </select>
                <button
                  className="mndt-button"
                  disabled={busy !== null || note.trim() === '' || !state.canWrite}
                  onClick={() => {
                    void act('remember', async () => {
                      const result = await api.remember('team', kind, note)
                      if (!result.ok) throw new Error(result.error ?? 'refused')
                      setNote('')
                    })
                  }}
                >
                  {t('remember')}
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </section>
  )
}
