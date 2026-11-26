/**
 * A channel's feed as mndt-web draws it (`ChannelFeed`, `MessageItem`, `TurnLine`,
 * `ApprovalDecision`): a day separator, one row per message with its author's icon, name and time,
 * the turns a mention started, and the cards they asked for, decided only by their buttons.
 *
 * What differs from mndt-web is said, not hidden: a turn shows on the message that started it (the
 * core keeps it there), and a decision is approve or refuse with its reason, which is what the core
 * accepts; there is no « changes requested » to show.
 */
import { Fragment, useState } from 'react'
import type { ReactNode } from 'react'
import type { ChatAgent, ChatChannel, ChatMessage, ChatTurn, MountedConnector, OfferedModel, OpenEscalation } from './chat.ts'
import { ADMIN_CEILING_EUR, AgentSheetView, proposalOf } from './TeamAgentForm.tsx'
import type { ChatTranslate } from './chatLocales.ts'
import type { DecideOptions } from './face.ts'
import type { ThreadCard } from './ChannelView.tsx'
import { clock, dayLong, euros, pageLanguage, when } from './format.ts'
import { ContextFrame, contextOf, contextProposalOf } from './channelContext.tsx'
import { HelpThread, helpOf } from './help.tsx'
import { PendingQuestion } from './pendingQuestion.tsx'
import { CouncilThread, councilOf } from './council.tsx'
import { coordinatedTurn, turnSteps } from './coordination.tsx'
import { Icon } from './Icons.tsx'
import { renderBrief } from './markdown.tsx'
import { endWordOf, turnEndWords } from './turnReason.ts'
import { ScheduleSheet, scheduleProposalOf } from './schedule.tsx'

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
  // A mission's report never joins the row above: its origin label must show on each one.
  if (m.author.kind === 'system' && 'mission' in m) return `m:${m.id}`
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
function WebTurn(props: {
  readonly turn: ChatTurn
  readonly agent: ChatAgent | undefined
  readonly agents: ReadonlyMap<string, ChatAgent>
  readonly t: ChatTranslate
}): ReactNode {
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
    const line = (
      <p className="mw-turn-failed" data-testid="chat-turn" data-status={turn.status}>
        <Icon name="AlertTriangle" size={14} />
        <span>
          {t(word)}{turnEndWords(turn, t) === undefined ? '' : ` : ${turnEndWords(turn, t) ?? ''}`}{turn.eur === undefined ? '' : ` · ${euros(turn.eur)}`}
        </span>
      </p>
    )
    // A stopped coordinated turn keeps its steps, its cost and its parts (#85).
    const steps = turnSteps(turn, props.agents, t)
    return steps === undefined ? line : <div className="mw-turn-coord">{line}{steps}</div>
  }
  // A coordinated turn (#84) says who wrote and who checked; unreadable steps fall back to the plain line.
  const coordinated = coordinatedTurn(turn, props.agents, t)
  if (coordinated !== undefined) return coordinated
  const seconds = turn.startedAt === undefined || turn.finishedAt === undefined
    ? undefined
    : (Date.parse(turn.finishedAt) - Date.parse(turn.startedAt)) / 1000
  const tokens = turn.tokens === undefined ? undefined : turn.tokens.input + turn.tokens.output
  // Who answered and what it cost, on the line; the duration, tokens and model on hover only.
  const parts = [
    `@${agent?.handle ?? turn.agentId}`,
    turn.eur === undefined ? undefined : euros(turn.eur),
  ].filter((part): part is string => part !== undefined)
  const detail = [
    seconds === undefined || Number.isNaN(seconds) ? undefined : t('webSeconds', { n: seconds.toLocaleString(pageLanguage() ?? 'fr', { maximumFractionDigits: 1 }) }),
    tokens === undefined ? undefined : t('webTokens', { n: tokens.toLocaleString(pageLanguage() ?? 'fr') }),
    agent?.model,
  ].filter((part): part is string => part !== undefined).join(' · ')
  return (
    <p className="mw-turn" data-testid="chat-turn" data-status="done">
      <span className="mw-chip mw-chip-strong">{t('webTurn')}</span>
      <span data-testid="chat-turn-cost" title={detail === '' ? undefined : detail}>{parts.join(' · ')}</span>
    </p>
  )
}

/**
 * The servers a turn ran without (#126): said under its line, in orange, so a reader knows the
 * answer did not consult them. Read defensively: server names only, nothing shown otherwise.
 */
function ToolsUnavailable(props: { readonly turn: ChatTurn; readonly t: ChatTranslate }): ReactNode {
  const raw: unknown = props.turn.toolsUnavailable
  const servers = Array.isArray(raw)
    ? raw.filter((s): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(s))
    : []
  if (servers.length === 0) return undefined
  return (
    <p className="mw-turn-unchecked" role="note" data-testid="tools-unavailable">
      {props.t('toolsUnavailable', { servers: servers.join(', ') })}
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
  /** The card's channel as the reader sees it, for a proposed context: its context now. */
  readonly channel?: ChatChannel | undefined
  /** The card was asked for after the agent read its peers' help. */
  readonly fromHelp?: boolean | undefined
  /** The space's agents, to name the one a proposed task would run on. */
  readonly agents?: ReadonlyMap<string, ChatAgent> | undefined
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
  // A proposed channel context (lot 3): the whole text, and what it replaces. Unreadable, or the
  // context changed since it was proposed (a known channel only): « Refuser » only, and why.
  const contextProposal = card.kind === 'propose_context' ? contextProposalOf(card.contextProposal) : undefined
  const contextUnreadable = card.kind === 'propose_context' && contextProposal === undefined
  const contextNow = props.channel === undefined ? undefined : contextOf(props.channel)
  const contextStale = contextProposal !== undefined && props.channel !== undefined
    && contextProposal.baseVersion !== (contextNow?.version ?? 0)
  // A proposed task (on A1's names): the whole proposal, read field by field; unreadable, « Refuser » only.
  const schedule = scheduleProposalOf(card)
  const scheduleUnreadable = card.kind === 'propose_schedule' && schedule === undefined
  const refuseOnly = unreadable || modelGone || unmountedNow.length > 0 || contextUnreadable || contextStale || scheduleUnreadable
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
    setError(await (proposal === undefined && contextProposal === undefined && schedule === undefined
      ? props.onDecide(card.id, decision, why)
      : props.onDecide(card.id, decision, why, { showsProposal: true })))
    setBusy(false)
  }
  return (
    <article className="mw-card-box" data-testid="chat-card" data-state={state}>
      <div className="mw-card-head">
        <p className="mw-card-title">
          {proposal !== undefined ? t('proposeAgentTitle', { name: proposal.name })
            // The task's title is the model's: a fixed heading here, its title inside the sheet.
            : card.kind === 'propose_schedule' ? t('proposeScheduleTitle') : card.title}
        </p>
        <StatusBadge state={card.state} t={t} />
      </div>
      <p className="mw-card-meta">
        {askedBy} · {when(card.requestedAt)}
        {props.fromHelp === true ? <span className="mw-chip mw-help-chip" data-testid="card-from-help">{t('helpFromHelp')}</span> : undefined}
      </p>
      {/* An agent proposes an agent: the whole sheet, read-only, so one click validates what was read. */}
      {proposal === undefined ? undefined : <AgentSheetView proposal={proposal} mounted={props.mounted ?? []} t={t} />}
      {schedule === undefined ? undefined : (
        <ScheduleSheet
          proposal={schedule}
          agentHandle={props.agents?.get(schedule.agentId)?.handle}
          where={schedule.destination.kind === 'lane'
            ? t('scheduleLaneOf', { name: shownName(schedule.destination.member, props.names) })
            : props.channel !== undefined && props.channel.id === schedule.destination.channelId
              ? `# ${props.channel.title || props.channel.name}` : t('scheduleUnreadChannel')}
          t={t}
        />
      )}
      {scheduleUnreadable ? <p className="mw-decide-error" data-testid="schedule-unreadable">{t('proposeScheduleUnreadable')}</p> : undefined}
      {contextProposal === undefined ? undefined : (
        <div className="mw-context" data-testid="context-proposal">
          {contextProposal.text === '' ? <p className="mw-ctx-muted" data-testid="context-proposed">{t('proposeContextErase')}</p> : (
            <ContextFrame
              context={{ text: contextProposal.text, version: contextProposal.baseVersion + 1 }}
              names={props.names}
              t={t}
              testId="context-proposed"
              whole
            />
          )}
          {props.channel === undefined ? undefined : (
            <details className="mw-turn-steps" data-testid="context-replaced">
              <summary>{t('proposeContextReplaces')}</summary>
              {contextNow === undefined || contextNow.text === '' ? <p className="mw-ctx-muted">{t('proposeContextNone')}</p> : <ContextFrame context={contextNow} names={props.names} t={t} testId="context-current" />}
            </details>
          )}
        </div>
      )}
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
          {unreadable || contextUnreadable ? <p className="mw-decide-error" data-testid="proposal-unreadable">{t('proposeAgentUnreadable')}</p> : undefined}
          {contextStale ? <p className="mw-decide-error" data-testid="context-stale">{t('proposeContextStale')}</p> : undefined}
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
        // In a lane nobody but its member reads, the card goes up to the owners and admins (À traiter).
        <p className="mw-cannot" data-testid="card-raised">
          {/* The member who waits reads « en attente »; a decider never does (an origin is served to deciders only). */}
          {originOf(card) !== undefined ? t('webToDecide') : props.channel?.kind === 'solo' ? t('webAwaitsDecider') : t('webCannotDecide')}
        </p>
      )}
    </article>
  )
}

/** One message of the feed, its turns and the cards they asked for. */
/**
 * Where a card raised to the deciders comes from, as the core serves it: a lane or a channel no decider
 * is in. Never a title: a reader outside the channel gets none of its metadata.
 * @param card - a card. @returns its origin, or undefined.
 */
export function originOf(card: ThreadCard): 'lane' | 'channel' | undefined {
  const raw: unknown = (card as { readonly origin?: unknown }).origin
  const kind = typeof raw === 'object' && raw !== null ? (raw as { readonly kind?: unknown }).kind : undefined
  return kind === 'lane' || kind === 'channel' ? kind : undefined
}

/** A failed mission's own categories, in its words; a turn's categories (a scheduled run) after them. */
const REASON_WORDS: ReadonlyMap<string, 'missionReasonNoAnswer' | 'missionReasonCut' | 'missionReasonCancelled' | 'missionReasonTools' | 'missionReasonFailed'> = new Map([
  ['no-answer', 'missionReasonNoAnswer'], ['cut', 'missionReasonCut'], ['cancelled', 'missionReasonCancelled'],
  ['tools', 'missionReasonTools'], ['failed', 'missionReasonFailed'],
] as const)

/** @param kind - a served category. @param t - the copy. @returns its words; an unknown one, the generic failure. */
function missionReasonWords(kind: string | undefined, t: ChatTranslate): string {
  const own = kind === undefined ? undefined : REASON_WORDS.get(kind)
  if (own !== undefined) return t(own)
  return endWordOf(kind, t) ?? t('missionReasonFailed')
}

/** A mission's report published in a lane, as the page reads it. */
interface PublishedMission {
  readonly title: string
  /** A scheduled task's run, or else a briefing (any other kind reads as a briefing). */
  readonly scheduled: boolean
  readonly failed: boolean
  /** Why it failed, as the host's category (never the provider's text); any string, read by lookup. */
  readonly reasonKind?: string
  readonly eur?: number
  readonly servers: readonly string[]
}

/**
 * The mission a system message publishes (a briefing's report in its owner's lane), read defensively.
 * Absent: an ordinary system message. Present but unreadable: still a model's text, never the host's.
 * @param m - a message. @returns what it publishes, or undefined.
 */
export function publishedMissionOf(m: ChatMessage): PublishedMission | undefined {
  if (m.author.kind !== 'system' || !('mission' in m)) return undefined
  const raw: unknown = (m as { readonly mission?: unknown }).mission
  const at = (key: string): unknown => (typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)[key] : undefined)
  const title = at('title')
  const eur = at('eur')
  const tools = at('toolsUnavailable')
  return {
    title: typeof title === 'string' && title.trim() !== '' && title.length <= 120 ? title.trim() : '',
    scheduled: at('kind') === 'scheduled',
    failed: at('status') === 'failed',
    ...(typeof at('reasonKind') === 'string' ? { reasonKind: at('reasonKind') as string } : {}),
    ...(typeof eur === 'number' && Number.isFinite(eur) && eur >= 0 ? { eur } : {}),
    // Server names only (a technical format), as on a turn.
    servers: Array.isArray(tools) ? tools.filter((s): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(s)) : [],
  }
}

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
  /** Whether the reader's answer to an agent counts (workflows.write). */
  readonly canAnswer?: boolean | undefined
  /** Post a person's answer to an agent's question, as a reply to it. */
  readonly onAnswer?: ((text: string, replyTo: string) => Promise<string | undefined>) | undefined
  /** The question this message publishes (after a help or a council), answered under it. */
  readonly asks?: OpenEscalation | undefined
  /** The messages of the thread that publish a question: a turn whose question is one of them says so, not twice. */
  readonly askedIds?: ReadonlyMap<string, OpenEscalation> | undefined
  readonly channel?: ChatChannel | undefined
  readonly offered?: readonly OfferedModel[] | undefined
  readonly t: ChatTranslate
}): ReactNode {
  const { message: m, agents, t } = props
  // The cards a turn of this message asked for after reading its peers' help.
  const fromHelp = (m.turns ?? []).some(turn => helpOf(turn)?.reading?.verdict === 'card')
  const agent = m.author.kind === 'agent' ? agents.get(m.author.agentId) : undefined
  // A mission's report is a model's text: labelled by its origin, never shown as the host's word.
  const published = publishedMissionOf(m)
  const name = m.author.kind === 'human'
    ? shownName(m.author.email, props.names)
    : m.author.kind === 'agent' ? agent?.name ?? `@${m.author.agentId}`
      : published !== undefined ? t(published.scheduled ? 'scheduleResultLabel' : 'briefingLabel') : 'mndt'
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
          <Icon name={m.author.kind === 'agent' || published !== undefined ? 'Bot' : m.author.kind === 'human' ? 'User' : 'ShieldCheck'} className="mw-slate" />
          <span className="mw-message-name" title={published === undefined ? undefined : t('briefingByModel')}>{name}</span>
          {m.author.kind === 'agent' ? <span className="mw-chip mw-chip-strong">{t('webAgent')}</span> : undefined}
          {published === undefined ? undefined : <span className="mw-chip" data-testid="mission-origin">{t('briefingChip')}</span>}
          {/* The title is the model's (its first heading): second-tier text, never the author's name. */}
          {published === undefined || published.title === '' ? undefined : (
            <span className="mw-message-time" data-testid="mission-title">{published.title}</span>
          )}
          {published?.eur === undefined ? undefined : <span className="mw-message-time" data-testid="mission-eur">{euros(published.eur)}</span>}
          <span className="mw-message-time">{clock(m.createdAt)}</span>
        </div>
      )}
      {error === undefined ? undefined : <p role="alert" className="mw-decide-error">{error}</p>}
      {m.deletedAt !== undefined ? (
        <p className="mw-message-removed">{t('webRemoved')}</p>
      ) : m.author.kind === 'agent' ? (
        // An agent writes Markdown (tables, lists, bold): read, never shown as raw markers.
        <div className="mw-message-body mw-agent-text" data-testid="chat-markdown">{renderBrief(m.text)}</div>
      ) : published !== undefined && published.failed ? (
        // The host's one line on a failed mission; its reason is the runtime's: plain text, no Markdown.
        <p className="mw-message-body mw-decide-error" data-testid="mission-failed">
          {/* Never m.text: before the core's category is installed it may carry the provider's raw reason. */}
          {t(published.scheduled ? 'scheduleFailedBecause' : 'missionFailedBecause', { reason: missionReasonWords(published.reasonKind, t) })}
        </p>
      ) : published !== undefined ? (
        // A model wrote it: read as an agent's text, its headings kept plain.
        m.text.trim() === ''
          ? <p className="mw-message-body mw-ctx-muted">{t('briefingEmpty')}</p>
          : <div className="mw-message-body mw-agent-text" data-testid="mission-report">{renderBrief(m.text, { plainHeadings: true })}</div>
      ) : (
        <p className="mw-message-body">{m.text}</p>
      )}
      {published === undefined || published.servers.length === 0 ? undefined : (
        <p className="mw-turn-unchecked" role="note" data-testid="mission-tools-unavailable">
          {t('missionToolsUnavailable', { servers: published.servers.join(', ') })}
        </p>
      )}
      {props.asks === undefined ? undefined : (
        <PendingQuestion
          escalation={props.asks}
          onAnswer={props.onAnswer === undefined || props.canAnswer !== true
            ? undefined
            : text => props.onAnswer?.(text, m.id) ?? Promise.resolve(undefined)}
          t={t}
        />
      )}
      {(m.turns ?? []).map((turn) => {
        // A turn whose agent asked its peers: the help shows in place, under the turn's line.
        const help = helpOf(turn)
        // A council's deliberation shows in place too, under the chair's turn.
        const council = councilOf(turn)
        return (
          <Fragment key={turn.id}>
            <WebTurn turn={turn} agent={agents.get(turn.agentId)} agents={agents} t={t} />
            <ToolsUnavailable turn={turn} t={t} />
            {council === undefined ? undefined : (
              <CouncilThread
                turn={turn}
                council={council}
                agents={agents}
                onAnswer={props.onAnswer}
                canAnswer={props.canAnswer}
                questionBelow={council.escalation?.messageId !== undefined && props.askedIds?.has(council.escalation.messageId) === true}
                t={t}
              />
            )}
            {help === undefined ? undefined : (
              <HelpThread
                help={help}
                agents={agents}
                onAnswer={props.onAnswer}
                originMessageId={m.id}
                canAnswer={props.canAnswer}
                names={props.names}
                questionBelow={help.escalation?.messageId !== undefined && props.askedIds?.has(help.escalation.messageId) === true}
                t={t}
              />
            )}
          </Fragment>
        )
      })}
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
          channel={props.channel}
          fromHelp={fromHelp}
          agents={agents}
          t={t}
        />
      ))}
    </article>
  )
}
