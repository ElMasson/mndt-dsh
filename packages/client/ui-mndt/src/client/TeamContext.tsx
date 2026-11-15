/**
 * The channel's context, as mndt-web draws it beside a feed (`ChannelContextPanel`): a white card
 * of sections, CANAL, MANDATS, AGENTS, MÉMOIRE, DOCUMENTS, MEMBRES. Only what the workspace serves
 * is said; a section whose route does not exist yet says so (« Bientôt »), it shows nothing made up.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { ChatAgent, ChatChannel, MountedConnector } from './chat.ts'
import { euros } from './ChannelView.tsx'
import type { ChatTranslate } from './chatLocales.ts'
import { Icon } from './Icons.tsx'
import { shownName } from './TeamFeed.tsx'
import { TeamDocuments } from './TeamDocuments.tsx'
import type { DocumentsFace } from './documents.ts'

/** @param props - its title and content. @returns one section of the card. */
function Section(props: { readonly title: string; readonly children: ReactNode }): ReactNode {
  return (
    <section className="mw-ctx-section" aria-label={props.title}>
      <h3 className="mw-ctx-title">{props.title}</h3>
      {props.children}
    </section>
  )
}

/** @param email - an address. @returns the part before @, which stands for the name until it is served. */
export function nameOf(email: string): string {
  const at = email.indexOf('@')
  return at > 0 ? email.slice(0, at) : email
}

/** What the card reads and where its links lead. */
export interface TeamContextProps {
  readonly channel: ChatChannel
  readonly agents: readonly ChatAgent[]
  readonly t: ChatTranslate
  /** Open the memory place (« Toutes les mémoires »). */
  readonly onMemory: () => void
  /** Put an agent in the channel or take it out; resolves to the Host's reason when refused. */
  readonly onToggleAgent?: ((agentId: string, inChannel: boolean) => Promise<string | undefined>) | undefined
  /** Set the channel's connectors (the whole list); resolves to the Host's reason when refused. */
  readonly onConnectors?: ((servers: readonly string[]) => Promise<string | undefined>) | undefined
  /** The connectors mounted on the workbench; undefined while unread or not served. */
  readonly mounted?: readonly MountedConnector[] | undefined
  /** Why the mounted connectors could not be read, if they could not. */
  readonly mountedError?: string | undefined
  /** Whether the reader may change the channel's agents and connectors (workflows.write). */
  readonly canManage?: boolean | undefined
  /** The team's names by lower-case address, where they are served. */
  readonly names?: Readonly<Record<string, string>> | undefined
  /** The documents route; without it the section says « Bientôt ». */
  readonly documents?: DocumentsFace | undefined
}

/** @param props - the channel and its agents. @returns the context card's sections. */
export function TeamContext(props: TeamContextProps): ReactNode {
  const { channel, t } = props
  const here = props.agents.filter(a => channel.agents.includes(a.id))
  // Every declared agent, as a pill: in the channel or not, one click puts it in or takes it out.
  const declared = props.agents.filter(a => a.retiredAt === undefined || channel.agents.includes(a.id))
  const canManage = props.canManage === true
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const toggleAgent = async (agentId: string): Promise<void> => {
    if (busy !== undefined || props.onToggleAgent === undefined) return
    setBusy(`agent:${agentId}`)
    setError(await props.onToggleAgent(agentId, !channel.agents.includes(agentId)))
    setBusy(undefined)
  }
  const [connectorError, setConnectorError] = useState<string | undefined>(undefined)
  const toggleConnector = async (server: string): Promise<void> => {
    if (busy !== undefined || props.onConnectors === undefined) return
    const next = channel.connectors.includes(server)
      ? channel.connectors.filter(s => s !== server)
      : [...channel.connectors, server]
    setBusy(`connector:${server}`)
    setConnectorError(await props.onConnectors(next))
    setBusy(undefined)
  }
  // The pills: what is mounted, and what the channel holds that is no longer mounted.
  const servers = [...new Set([...(props.mounted ?? []).map(m => m.server), ...channel.connectors])].sort()
  const enabled = new Set((props.mounted ?? []).filter(m => m.enabled).map(m => m.server))
  return (
    <div className="mw-ctx" data-testid="context-panel">
      <Section title={t('ctxChannel')}>
        <p>{channel.kind === 'solo' ? t('ctxKindLane') : t('ctxKindTeam')}</p>
      </Section>
      <Section title={t('ctxMandates')}>
        <p className="mw-ctx-muted">{t('ctxMandatesSoon')}</p>
      </Section>
      <Section title={t('agents')}>
        {declared.length === 0 ? <p className="mw-ctx-muted">{t('agentsNoneDeclared')}</p> : (
          <div className="mw-pills" role="group" aria-label={t('agentsOfChannel')} data-testid="agent-pills">
            {declared.map((a) => {
              const on = channel.agents.includes(a.id)
              return (
                <button
                  key={a.id}
                  type="button"
                  className="mw-pill"
                  aria-pressed={on}
                  disabled={!canManage || busy !== undefined}
                  onClick={() => { void toggleAgent(a.id) }}
                >
                  @{a.handle}
                </button>
              )
            })}
          </div>
        )}
        {canManage || declared.length === 0 ? undefined : <p className="mw-ctx-small mw-ctx-muted">{t('chipsReadOnly')}</p>}
        {here.length === 0 ? <p className="mw-ctx-muted">{t('agentNone')}</p> : (
          <ul className="mw-ctx-list">
            {here.map(a => (
              <li key={a.id} className="mw-ctx-item" data-testid="chat-agent">
                <p className="mw-ctx-strong">{a.name} <span className="mw-ctx-muted">· @{a.handle}</span></p>
                <p className="mw-ctx-small">{t('ctxLlm', { provider: a.provider, model: a.model })}</p>
                <p className="mw-ctx-small mw-ctx-muted" data-testid="chat-agent-month">
                  {t('agentMonth', { spent: euros(a.eurThisMonth ?? 0), ceiling: euros(a.eurPerMonth) })}
                </p>
              </li>
            ))}
          </ul>
        )}
        {error === undefined ? undefined : <p role="alert" className="mw-ctx-error">{error}</p>}
      </Section>
      <Section title={t('ctxConnectors')}>
        {props.mountedError !== undefined ? <p className="mw-ctx-muted" role="alert">{t('connUnreadable', { reason: props.mountedError })}</p> : undefined}
        {props.mounted === undefined && props.mountedError === undefined ? <p className="mw-ctx-muted">{t('docLoading')}</p> : undefined}
        {props.mounted !== undefined && servers.length === 0 ? <p className="mw-ctx-muted">{t('connNone')}</p> : undefined}
        {servers.length === 0 ? undefined : (
          <div className="mw-pills" role="group" aria-label={t('ctxConnectors')} data-testid="connector-pills">
            {servers.map((server) => {
              const on = channel.connectors.includes(server)
              const off = !enabled.has(server)
              return (
                <button
                  key={server}
                  type="button"
                  className="mw-pill"
                  aria-pressed={on}
                  data-off={off ? 'true' : undefined}
                  // A connector that is not mounted cannot be added; one the channel still holds can be taken out.
                  disabled={!canManage || busy !== undefined || (off && !on)}
                  title={off ? t('connOff') : undefined}
                  onClick={() => { void toggleConnector(server) }}
                >
                  {server}
                  {off ? <span className="mw-pill-note">{t('connOff')}</span> : undefined}
                </button>
              )
            })}
          </div>
        )}
        {canManage || servers.length === 0 ? undefined : <p className="mw-ctx-small mw-ctx-muted">{t('chipsReadOnly')}</p>}
        {connectorError === undefined ? undefined : <p role="alert" className="mw-ctx-error">{connectorError}</p>}
      </Section>
      <Section title={t('ctxMemory')}>
        <p className="mw-ctx-small mw-ctx-muted">
          {t('ctxMemoryNote')}{' '}
          <button type="button" className="mw-ctx-link" onClick={props.onMemory}>{t('ctxAllMemories')}</button>
        </p>
      </Section>
      <Section title={t('ctxDocuments')}>
        {props.documents === undefined
          ? <p className="mw-ctx-muted">{t('ctxDocumentsSoon')}</p>
          : <TeamDocuments face={props.documents} channelId={channel.id} names={props.names} t={t} />}
      </Section>
      <Section title={t('members')}>
        <ul className="mw-ctx-members">
          {channel.members.map(email => (
            <li key={email} className="mw-ctx-member" title={email}>
              <Icon name="User" className="mw-ctx-icon" />
              <span className="mw-ctx-strong">{shownName(email, props.names)}</span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  )
}
