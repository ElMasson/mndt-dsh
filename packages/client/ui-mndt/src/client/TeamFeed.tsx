/**
 * A channel's feed as mndt-web draws it (`ChannelFeed`, `MessageItem`, `TurnLine`,
 * `ApprovalDecision`): a day separator, one row per message with its author's icon, name and time,
 * the turns a mention started, and the cards they asked for, decided only by their buttons.
 *
 * What differs from mndt-web is said, not hidden: a turn shows on the message that started it (the
 * core keeps it there), and a decision is approve or refuse with its reason, which is what the core
 * accepts; there is no « changes requested » to show.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { ChatAgent, ChatMessage, ChatTurn, MountedConnector, OfferedModel } from './chat.ts'
import { ADMIN_CEILING_EUR, AgentSheetView, proposalOf } from './TeamAgentForm.tsx'
import type { ChatTranslate } from './chatLocales.ts'
import type { DecideOptions } from './face.ts'
import type { ThreadCard } from './ChannelView.tsx'
import { clock, dayLong, euros, pageLanguage, when } from './format.ts'
import { Icon } from './Icons.tsx'
import { renderBrief } from './markdown.tsx'

/** How long the same author's next message joins the previous one without its own header. */
const GROUP_MS = 5 * 60 * 1000

/** @param email - an address. @param names - the team's names. @returns the name, else the part before @. */
export function shownName(email: string, names: Readonly<Record<string, string>> | undefined): string {
  // Only the team's own entries: an address such as « constructor@… » never reads a prototype member.
  const key = email.toLowerCase()
  if (names !== undefined && Object.hasOwn(names, key)) return names[key] ?? email
  const at = email.indexOf('@')
  return at > 0 ? email.slice(0, at) : email
}

/** @param m - a message. @returns who wrote it, as a stable key (to group messages). */
function authorKey(m: ChatMessage): string {
  return m.author.kind === 'human' ? `h:${m.author.email}` : m.author.kind === 'agent' ? `a:${m.author.agentId}` : 's'
}

/**
 * @param previous - the message before, if any. @param m - this message.
 * @returns whether it opens a new day, and whether it shows its own header.
 */
export function placeOf(previous: ChatMessage | undefined, m: ChatMessage): { readonly newDay: boolean; readonly header: boolean } {
  if (previous === undefined) return { newDay: true, header: true }
  const newDay = dayLong(previous.createdAt) !== dayLong(m.createdAt)
  const close = Date.parse(m.createdAt) - Date.parse(previous.createdAt) < GROUP_MS
  return { newDay, header: newDay || authorKey(previous) !== authorKey(m) || !close }
}

/** @param props - the day to say. @returns the separator mndt-web draws between days. */
export function DaySeparator(props: { readonly at: string }): ReactNode {
  return (
    <div className="mw-day" role="separator">
      <span className="mw-day-line" />
      <span>{dayLong(props.at)}</span>
      <span className="mw-day-line" />
    </div>
  )
}

/** One turn under the message that started it. */
function WebTurn(props: { readonly turn: ChatTurn; readonly agent: ChatAgent | undefined; readonly t: ChatTranslate }): ReactNode {
  const { turn, agent, t } = props
  if (turn.status === 'queued' || turn.status === 'running') {
    return (
      <p className="mw-turn-live" role="status" data-testid="chat-turn" data-status={turn.status}>
        <span className="mw-dots" aria-hidden="true"><span /><span /><span /></span>
        {turn.status === 'queued' ? t('webTurnQueued') : t('webTurnRunning')}
      </p>
    )
  }
  if (turn.status !== 'done') {
    const word = turn.status === 'failed' ? 'webTurnFailed' : turn.status === 'refused' ? 'webTurnRefused' : 'webTurnCancelled'
    return (
      <p className="mw-turn-failed" data-testid="chat-turn" data-status={turn.status}>
        <Icon name="AlertTriangle" size={14} />
        <span>{t(word)}{turn.reason === undefined ? '' : ` : ${turn.reason}`}</span>
      </p>
    )
  }
  const seconds = turn.startedAt === undefined || turn.finishedAt === undefined
    ? undefined
    : (Date.parse(turn.finishedAt) - Date.parse(turn.startedAt)) / 1000
  const tokens = turn.tokens === undefined ? undefined : turn.tokens.input + turn.tokens.output
  const parts = [
    `@${agent?.handle ?? turn.agentId}`,
    seconds === undefined || Number.isNaN(seconds) ? undefined : t('webSeconds', { n: seconds.toLocaleString(pageLanguage() ?? 'fr', { maximumFractionDigits: 1 }) }),
    tokens === undefined ? undefined : t('webTokens', { n: tokens.toLocaleString(pageLanguage() ?? 'fr') }),
    turn.eur === undefined ? undefined : euros(turn.eur),
    agent?.model,
  ].filter((part): part is string => part !== undefined)
  return (
    <p className="mw-turn" data-testid="chat-turn" data-status="done">
      <span className="mw-chip mw-chip-strong">{t('webTurn')}</span>
      <span data-testid="chat-turn-cost">{parts.join(' · ')}</span>
    </p>
  )
}

/**
 * @param card - a card as served.
 * @returns the handle of the agent whose turn asked for it, only when the API served a non-empty
 * text: `null`, `{}`, an empty or non-text handle all fall back to the person's line.
 */
export function agentHandleOf(card: ThreadCard): string | undefined {
  const agent: unknown = card.requestedByAgent
  if (typeof agent !== 'object' || agent === null) return undefined
  const handle = (agent as { handle?: unknown }).handle
  return typeof handle === 'string' && handle !== '' ? handle : undefined
}

/** The verdict of a card, coloured as mndt-web colours it. */
function StatusBadge(props: { readonly state: ThreadCard['state']; readonly t: ChatTranslate }): ReactNode {
  const state = props.state ?? 'pending'
  const [icon, word] = state === 'approved'
    ? ['CheckCircle2', 'webApproved'] as const
    : state === 'rejected' ? ['XCircle', 'webRejected'] as const : ['UserRound', 'webPending'] as const
  return (
    <span className="mw-status" data-state={state}>
      <Icon name={icon} size={14} />
      {props.t(word)}
    </span>
  )
}

/**
 * A card a turn asked for. Pending, it is decided by its buttons: approve, or refuse with a reason,
 * which the core requires too (a refusal without one is refused). Decided, it says who and when.
 */
export function WebCard(props: {
  readonly card: ThreadCard
  readonly canDecide: boolean
  readonly onDecide: (id: string, decision: 'approved' | 'rejected', reason?: string, options?: DecideOptions) => Promise<string | undefined>
  readonly names?: Readonly<Record<string, string>> | undefined
  /** The connectors mounted, to say which ones a proposed agent would carry but cannot use. */
  readonly mounted?: readonly MountedConnector[] | undefined
  /** Whether the reader owns the team: only the owner validates a proposed ceiling above 5 EUR. */
  readonly isOwner?: boolean | undefined
  /** The models the core offers (`GET /models`); undefined while unknown. */
  readonly offered?: readonly OfferedModel[] | undefined
  readonly t: ChatTranslate
}): ReactNode {
  const { card, t } = props
  const state = card.state ?? 'pending'
  const proposal = card.kind === 'propose_agent' ? proposalOf(card.proposal) : undefined
  // The core accepts a proposed ceiling above 5 EUR only from the owner: an admin is told before
  // clicking, and only « Refuser » stays offered to them.
  const ownerOnly = proposal !== undefined && (proposal.eurPerMonth ?? 0) > ADMIN_CEILING_EUR && props.isOwner !== true
  // A proposal the page cannot read is never validated blind: only « Refuser » is offered, and why.
  const unreadable = card.kind === 'propose_agent' && proposal === undefined
  // What the proposal needs and the workbench no longer has: the core would refuse it, so only
  // « Refuser » is offered, and why. Unknown lists block nothing; the core still checks.
  const modelGone = proposal !== undefined && props.offered !== undefined
    && !props.offered.some(m => m.provider === proposal.provider && m.model === proposal.model)
  const unmountedNow = proposal === undefined || props.mounted === undefined ? []
    : (proposal.connectors ?? []).filter(server => !props.mounted?.some(m => m.server === server && m.enabled))
  const refuseOnly = unreadable || modelGone || unmountedNow.length > 0
  // The turn's agent asked, on behalf of the person who mentioned it and holds the rights; a field
  // the screen cannot read falls back to the person's line.
  const handle = agentHandleOf(card)
  const askedBy = handle === undefined
    ? t('webAskedBy', { name: shownName(card.requestedBy, props.names) })
    : t('webAskedByAgent', { agent: `@${handle}`, name: shownName(card.requestedBy, props.names) })
  const [reason, setReason] = useState('')
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const decide = async (decision: 'approved' | 'rejected'): Promise<void> => {
    if (decision === 'rejected' && reason.trim() === '') {
      setMissing(true)
      return
    }
    setMissing(false)
    setBusy(true)
    // The sheet above is the whole proposal: only then does the page say it shows it.
    const why = decision === 'rejected' ? reason.trim() : undefined
    setError(await (proposal === undefined
      ? props.onDecide(card.id, decision, why)
      : props.onDecide(card.id, decision, why, { showsProposal: true })))
    setBusy(false)
  }
  return (
    <article className="mw-card-box" data-testid="chat-card" data-state={state}>
      <div className="mw-card-head">
        <p className="mw-card-title">{proposal === undefined ? card.title : t('proposeAgentTitle', { name: proposal.name })}</p>
        <StatusBadge state={card.state} t={t} />
      </div>
      <p className="mw-card-meta">{askedBy} · {when(card.requestedAt)}</p>
      {/* An agent proposes an agent: the whole sheet, read-only, so one click validates what was read. */}
      {proposal === undefined ? undefined : <AgentSheetView proposal={proposal} mounted={props.mounted ?? []} t={t} />}
      {state !== 'pending' ? (
        <div className="mw-decided" data-testid="chat-card-decision">
          <p>
            <b>{state === 'approved' ? t('webApproved') : t('webRejected')}</b>
            {t('webDecidedBy', { name: shownName(card.decidedBy ?? '', props.names), date: when(card.decidedAt ?? '') })}
          </p>
          {card.reason === undefined ? undefined : <p className="mw-decided-reason">{card.reason}</p>}
        </div>
      ) : props.canDecide ? (
        <div className="mw-decide">
          <label className="mw-decide-label">
            {t('webComment')}
            <textarea
              className="mw-decide-input"
              rows={1}
              value={reason}
              onChange={(event) => { setReason(event.target.value); setMissing(false) }}
            />
          </label>
          {missing ? <p role="alert" className="mw-decide-error">{t('webReasonMissing')}</p> : undefined}
          {unreadable ? <p className="mw-decide-error" data-testid="proposal-unreadable">{t('proposeAgentUnreadable')}</p> : undefined}
          {modelGone ? (
            <p className="mw-decide-error" data-testid="proposal-model-gone">{t('proposeAgentModelGone', { model: `${proposal.provider}/${proposal.model}` })}</p>
          ) : undefined}
          {unmountedNow.length === 0 ? undefined : (
            <p className="mw-decide-error" data-testid="proposal-unmounted">{t('proposeAgentUnmounted', { names: unmountedNow.join(', ') })}</p>
          )}
          {ownerOnly ? <p className="mw-decide-error" data-testid="proposal-owner-only">{t('proposeAgentOwnerOnly', { max: ADMIN_CEILING_EUR })}</p> : undefined}
          <div className="mw-decide-buttons">
            {refuseOnly ? undefined : (
              <button type="button" className="mw-primary" disabled={busy || ownerOnly} onClick={() => { void decide('approved') }}>{t('webValidate')}</button>
            )}
            <button type="button" className="mw-secondary" disabled={busy} onClick={() => { void decide('rejected') }}>{t('webRefuse')}</button>
          </div>
          {error === undefined ? undefined : <p role="alert" className="mw-decide-error">{error}</p>}
        </div>
      ) : (
        <p className="mw-cannot">{t('webCannotDecide')}</p>
      )}
    </article>
  )
}

/** One message of the feed, its turns and the cards they asked for. */
export function WebMessage(props: {
  readonly message: ChatMessage
  readonly header: boolean
  readonly agents: ReadonlyMap<string, ChatAgent>
  readonly cards: readonly ThreadCard[]
  readonly canDecide: boolean
  readonly onDecide: (id: string, decision: 'approved' | 'rejected', reason?: string, options?: DecideOptions) => Promise<string | undefined>
  /** The author may delete their own message; the Host still decides. */
  readonly onRemove?: (() => Promise<string | undefined>) | undefined
  /** Open À traiter, where the waiting cards are. */
  readonly onPending?: (() => void) | undefined
  readonly names?: Readonly<Record<string, string>> | undefined
  readonly mounted?: readonly MountedConnector[] | undefined
  readonly isOwner?: boolean | undefined
  readonly offered?: readonly OfferedModel[] | undefined
  readonly t: ChatTranslate
}): ReactNode {
  const { message: m, agents, t } = props
  const agent = m.author.kind === 'agent' ? agents.get(m.author.agentId) : undefined
  const name = m.author.kind === 'human'
    ? shownName(m.author.email, props.names)
    : m.author.kind === 'agent' ? agent?.name ?? `@${m.author.agentId}` : 'mndt'
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const waiting = props.cards.filter(card => (card.state ?? 'pending') === 'pending').length
  return (
    <article className="mw-message" data-author={m.author.kind} data-testid="chat-message" data-id={m.id}>
      {/* Deleting one's own message stays possible on a joined row, which has no header. */}
      {props.onRemove === undefined || m.deletedAt !== undefined ? undefined : confirming ? (
        <span className="mw-message-actions">
          <button
            type="button"
            className="mw-text-button"
            data-tone="danger"
            onClick={() => { void props.onRemove?.().then((refused) => { setError(refused); setConfirming(false) }) }}
          >
            {t('confirmDelete')}
          </button>
          <button type="button" className="mw-text-button" onClick={() => { setConfirming(false) }}>{t('cancel')}</button>
        </span>
      ) : (
        <button type="button" className="mw-text-button mw-message-actions" onClick={() => { setConfirming(true) }}>{t('delete')}</button>
      )}
      {!props.header ? undefined : (
        <div className="mw-message-head">
          <Icon name={m.author.kind === 'agent' ? 'Bot' : m.author.kind === 'human' ? 'User' : 'ShieldCheck'} className="mw-slate" />
          <span className="mw-message-name">{name}</span>
          {m.author.kind === 'agent' ? <span className="mw-chip mw-chip-strong">{t('webAgent')}</span> : undefined}
          <span className="mw-message-time">{clock(m.createdAt)}</span>
        </div>
      )}
      {error === undefined ? undefined : <p role="alert" className="mw-decide-error">{error}</p>}
      {m.deletedAt !== undefined ? (
        <p className="mw-message-removed">{t('webRemoved')}</p>
      ) : m.author.kind === 'agent' ? (
        // An agent writes Markdown (tables, lists, bold): read, never shown as raw markers.
        <div className="mw-message-body mw-agent-text" data-testid="chat-markdown">{renderBrief(m.text)}</div>
      ) : (
        <p className="mw-message-body">{m.text}</p>
      )}
      {(m.turns ?? []).map(turn => <WebTurn key={turn.id} turn={turn} agent={agents.get(turn.agentId)} t={t} />)}
      {waiting === 0 || props.onPending === undefined ? undefined : (
        <p className="mw-waiting">
          <Icon name="Inbox" size={14} />
          <button type="button" className="mw-text-button" onClick={props.onPending}>
            {waiting === 1 ? t('webCardWaiting') : t('webCardsWaiting', { n: waiting })}
          </button>
        </p>
      )}
      {props.cards.map(card => (
        <WebCard
          key={card.id}
          card={card}
          canDecide={card.canDecide ?? props.canDecide}
          onDecide={props.onDecide}
          names={props.names}
          mounted={props.mounted}
          isOwner={props.isOwner}
          offered={props.offered}
          t={t}
        />
      ))}
    </article>
  )
}
