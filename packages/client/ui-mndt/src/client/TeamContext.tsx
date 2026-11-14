/**
 * The channel's context, as mndt-web draws it beside a feed (`ChannelContextPanel`): a white card
 * of sections, CANAL, MANDATS, AGENTS, MÉMOIRE, DOCUMENTS, MEMBRES. Only what the workspace serves
 * is said; a section whose route does not exist yet says so (« Bientôt »), it shows nothing made up.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { ChatAgent, ChatChannel } from './chat.ts'
import { euros } from './ChannelView.tsx'
import type { ChatTranslate } from './chatLocales.ts'
import { Icon } from './Icons.tsx'

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
  /** Add an agent to the channel; resolves to the Host's reason when refused. */
  readonly onAdd?: ((agentId: string) => Promise<string | undefined>) | undefined
  /** The team's names by lower-case address, where they are served. */
  readonly names?: Readonly<Record<string, string>> | undefined
}

/** @param props - the channel and its agents. @returns the context card's sections. */
export function TeamContext(props: TeamContextProps): ReactNode {
  const { channel, t } = props
  const here = props.agents.filter(a => channel.agents.includes(a.id))
  const addable = props.agents.filter(a => !channel.agents.includes(a.id) && a.retiredAt === undefined)
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const add = async (): Promise<void> => {
    if (choice === '' || busy || props.onAdd === undefined) return
    setBusy(true)
    const refused = await props.onAdd(choice)
    setBusy(false)
    setError(refused)
    if (refused === undefined) setChoice('')
  }
  return (
    <div className="mw-ctx" data-testid="context-panel">
      <Section title={t('ctxChannel')}>
        <p>{channel.kind === 'solo' ? t('ctxKindLane') : t('ctxKindTeam')}</p>
      </Section>
      <Section title={t('ctxMandates')}>
        <p className="mw-ctx-muted">{t('ctxMandatesSoon')}</p>
      </Section>
      <Section title={t('agents')}>
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
        {props.onAdd === undefined || addable.length === 0 ? undefined : (
          <form className="mw-ctx-add" onSubmit={(event) => { event.preventDefault(); void add() }} data-testid="chat-agent-add">
            <select className="mw-ctx-select" aria-label={t('addAgent')} value={choice} onChange={(event) => { setChoice(event.target.value) }}>
              <option value="">{t('chooseAgent')}</option>
              {addable.map(a => <option key={a.id} value={a.id}>@{a.handle} · {a.name}</option>)}
            </select>
            <button type="submit" className="mw-secondary" disabled={choice === '' || busy}>{t('add')}</button>
          </form>
        )}
        {error === undefined ? undefined : <p role="alert" className="mw-ctx-error">{error}</p>}
      </Section>
      <Section title={t('ctxMemory')}>
        <p className="mw-ctx-small mw-ctx-muted">
          {t('ctxMemoryNote')}{' '}
          <button type="button" className="mw-ctx-link" onClick={props.onMemory}>{t('ctxAllMemories')}</button>
        </p>
      </Section>
      <Section title={t('ctxDocuments')}>
        <p className="mw-ctx-muted">{t('ctxDocumentsSoon')}</p>
      </Section>
      <Section title={t('members')}>
        <ul className="mw-ctx-members">
          {channel.members.map(email => (
            <li key={email} className="mw-ctx-member" title={email}>
              <Icon name="User" className="mw-ctx-icon" />
              <span className="mw-ctx-strong">{props.names?.[email.toLowerCase()] ?? nameOf(email)}</span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  )
}
