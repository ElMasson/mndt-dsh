/**
 * The channel's context, as mndt-web draws it beside a feed (`ChannelContextPanel`): a white card
 * of sections, CANAL, MANDATS, AGENTS, MÉMOIRE, DOCUMENTS, MEMBRES. Only what the workspace serves
 * is said; a section whose route does not exist yet says so (« Bientôt »), it shows nothing made up.
 */
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ChatAgent, ChatChannel, CoordinationChange, MountedConnector } from './chat.ts'
import { CoordinationSection, coordinationOf } from './coordination.tsx'
import { ContextSection } from './channelContext.tsx'
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
  /** Whether an agent can be taken out of the channel here (the face offers it). */
  readonly canRemoveAgents?: boolean | undefined
  /** Add a connector to the channel or take it out; resolves to the Host's reason when refused. */
  readonly onToggleConnector?: ((server: string, inChannel: boolean) => Promise<string | undefined>) | undefined
  /** The connectors mounted on the workbench; undefined while unread, `absent` where not served. */
  readonly mounted?: readonly MountedConnector[] | 'absent' | undefined
  /** Why the mounted connectors could not be read, if they could not. */
  readonly mountedError?: string | undefined
  /** Whether the reader may change the channel's agents and connectors (workflows.write). */
  readonly canManage?: boolean | undefined
  /** The team's names by lower-case address, where they are served. */
  readonly names?: Readonly<Record<string, string>> | undefined
  /** The documents route; without it the section says « Bientôt ». */
  readonly documents?: DocumentsFace | undefined
  /** Write the channel's context (owners and admins); absent, the context is read only. */
  readonly onContext?: ((text: string, version: number) => Promise<string | undefined>) | undefined
  /** Put a text in the channel's composer (the context's « Demander à @agent »). */
  readonly onAsk?: ((text: string) => void) | undefined
  /** Set the channel's coordination (#84); absent, the section is not shown. */
  readonly onCoordination?: ((change: CoordinationChange) => Promise<string | undefined>) | undefined
  /** Whether the reader may set it: owners and admins. */
  readonly canCoordinate?: boolean | undefined
}

/** @param props - the channel and its agents. @returns the context card's sections. */
export function TeamContext(props: TeamContextProps): ReactNode {
  const { channel, t } = props
  const here = props.agents.filter(a => channel.agents.includes(a.id))
  // Every declared agent, as a pill: in the channel or not, one click puts it in or takes it out.
  const declared = props.agents.filter(a => a.retiredAt === undefined || channel.agents.includes(a.id))
  const canManage = props.canManage === true
  // One change at a time: a ref, so a second click in the same frame cannot start another.
  const busy = useRef(false)
  const [pending, setPending] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [connectorError, setConnectorError] = useState<string | undefined>(undefined)
  const run = async (key: string, work: () => Promise<string | undefined>, say: (reason: string | undefined) => void): Promise<void> => {
    if (busy.current) return
    busy.current = true
    setPending(key)
    say(await work())
    busy.current = false
    setPending(undefined)
  }
  const toggleAgent = (agentId: string): void => {
    if (props.onToggleAgent === undefined) return
    const on = !channel.agents.includes(agentId)
    void run(`agent:${agentId}`, () => props.onToggleAgent?.(agentId, on) ?? Promise.resolve(undefined), setError)
  }
  const toggleConnector = (server: string): void => {
    if (props.onToggleConnector === undefined) return
    const on = !channel.connectors.includes(server)
    void run(`connector:${server}`, () => props.onToggleConnector?.(server, on) ?? Promise.resolve(undefined), setConnectorError)
  }
  const served = props.mounted === undefined || props.mounted === 'absent' ? undefined : props.mounted
  // The pills: what is mounted, and what the channel holds that is no longer mounted.
  const servers = [...new Set([...(served ?? []).map(m => m.server), ...channel.connectors])].sort()
  const enabled = new Set((served ?? []).filter(m => m.enabled).map(m => m.server))
  const connectorsWritable = canManage && served !== undefined && props.onToggleConnector !== undefined
  return (
    <div className="mw-ctx" data-testid="context-panel">
      <Section title={t('contextTitle')}>
        <ContextSection
          channel={channel}
          agents={props.agents}
          canEdit={props.canCoordinate === true}
          onSave={props.onContext}
          onAsk={props.onAsk}
          names={props.names}
          t={t}
        />
      </Section>
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
              // Taking an agent out needs the face to offer it; otherwise its pill stays as it is.
              const inert = !canManage || (on && props.canRemoveAgents !== true)
              return (
                <button
                  key={a.id}
                  type="button"
                  className="mw-pill"
                  aria-pressed={on}
                  aria-disabled={inert || pending !== undefined}
                  aria-label={on ? t('pillRemoveAgent', { handle: a.handle }) : t('pillAddAgent', { handle: a.handle })}
                  onClick={() => { if (!inert) toggleAgent(a.id) }}
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
      {props.onCoordination === undefined && coordinationOf(channel) === undefined ? undefined : (
        <Section title={t('coordTitle')}>
          <CoordinationSection
            channel={channel}
            agents={props.agents}
            canManage={props.canCoordinate === true}
            onChange={props.onCoordination}
            t={t}
          />
        </Section>
      )}
      <Section title={t('ctxConnectors')}>
        {props.mountedError !== undefined ? <p className="mw-ctx-muted" role="alert">{t('connUnreadable', { reason: props.mountedError })}</p> : undefined}
        {props.mounted === undefined && props.mountedError === undefined ? <p className="mw-ctx-muted">{t('docLoading')}</p> : undefined}
        {props.mounted === 'absent' ? <p className="mw-ctx-muted" data-testid="connectors-not-served">{t('connNotServed')}</p> : undefined}
        {served !== undefined && servers.length === 0 ? <p className="mw-ctx-muted">{t('connNone')}</p> : undefined}
        {servers.length === 0 ? undefined : (
          <div className="mw-pills" role="group" aria-label={t('ctxConnectors')} data-testid="connector-pills">
            {servers.map((server) => {
              const on = channel.connectors.includes(server)
              const off = served !== undefined && !enabled.has(server)
              // A connector that is not mounted cannot be added; one the channel still holds can be taken out.
              const inert = !connectorsWritable || (off && !on)
              const action = on ? t('pillRemoveConnector', { server }) : t('pillAddConnector', { server })
              return (
                <button
                  key={server}
                  type="button"
                  className="mw-pill"
                  aria-pressed={on}
                  aria-disabled={inert || pending !== undefined}
                  aria-label={off ? `${action}, ${t('connOff')}` : action}
                  data-off={off ? 'true' : undefined}
                  title={off ? t('connOff') : undefined}
                  onClick={() => { if (!inert) toggleConnector(server) }}
                >
                  {server}
                  {off ? <span className="mw-pill-note" aria-hidden="true">{t('connOff')}</span> : undefined}
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
