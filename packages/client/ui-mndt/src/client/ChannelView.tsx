/**
 * The team channels of lot 1: their list with creation from one field, a channel's thread read
 * every two seconds through `?since=`, the composer with `@` completion, the cards a turn asked for,
 * and the channel's agents with what they spent this month.
 *
 * Everything shown is what the workbench served: who may write, which agents a message mentions,
 * whether a turn runs or is refused, what it cost. A message never decides anything; a card is
 * decided only through its button. A refusal is shown with the Host's reason, never as emptiness.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { ChatRefusal } from './chat.ts'
import type { ChatAgent, ChatChannel, ChatFace, ChatMessage, ChatTurn } from './chat.ts'
import type { ChatTranslate } from './chatLocales.ts'
import type { ApprovalRow } from './face.ts'
import { completeMention, mentionAt, mentionChoices } from './mention.ts'
import type { MentionQuery } from './mention.ts'
import { isHostDown } from './hostDown.ts'
import { renderBrief } from './markdown.tsx'
import { authorName, mergeThread, personName, settledTurns } from './thread.ts'

/** How often the thread is read again, in milliseconds. */
export const POLL_MS = 2000

/** How close to the bottom, in pixels, the reader still follows the newest message. */
const FOLLOW_PX = 80

/** A card a turn asked for: the approval, with where it was asked and, once decided, by whom. */
export interface ThreadCard extends ApprovalRow {
  readonly channelId?: string
  readonly messageId?: string
  /** Absent on a pending card read from the page state. */
  readonly state?: 'pending' | 'approved' | 'rejected'
  readonly decidedBy?: string
  readonly decidedAt?: string
  readonly reason?: string
}

/**
 * What to say of a refusal.
 * @param error - a thrown value.
 * @param t - the channels' copy.
 * @returns the Host's reason, or the page's own sentence for a refused right.
 */
export function reasonOf(error: unknown, t: ChatTranslate): string {
  // A 403 says the reader's role: the Host's English sentence is replaced by the page's own.
  if (error instanceof ChatRefusal && error.status === 403) return t('forbidden')
  if (isHostDown(error)) return t('hostDown')
  return error instanceof Error ? error.message : String(error)
}

/**
 * An amount in euros, small ones kept readable.
 * @param eur - the amount.
 * @returns it formatted in the page's language.
 */
export function euros(eur: number): string {
  const lang = typeof document === 'undefined' ? 'fr' : document.documentElement.lang || 'fr'
  return new Intl.NumberFormat(lang, { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(eur)
}

/** @param iso - an instant. @returns its time of day. */
function clock(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/* ------------------------------------------------------------------ the list */

/**
 * The channels group of the rail: the solo lane first, then the team channels, and a channel
 * created from its title alone.
 */
export function ChannelList(props: {
  readonly channels: readonly ChatChannel[]
  readonly selected: string | undefined
  readonly onSelect: (id: string) => void
  readonly onCreate: (title: string) => Promise<string | undefined>
  readonly t: ChatTranslate
}): ReactNode {
  const { channels, selected, t } = props
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const ready = title.trim() !== ''
  const submit = async (): Promise<void> => {
    if (!ready || busy) return
    setBusy(true)
    const refused = await props.onCreate(title.trim())
    setBusy(false)
    if (refused === undefined) {
      setCreating(false)
      setTitle('')
      setError(undefined)
    } else setError(refused)
  }
  return (
    <div className="mndt-channel-group" data-testid="chat-channels">
      <div className="mndt-channel-group-head">
        <span>{t('channels')}</span>
        <button
          type="button"
          className="mndt-channel-add"
          aria-label={t('newChannel')}
          aria-expanded={creating}
          onClick={() => { setCreating(open => !open) }}
        >+</button>
      </div>
      {creating ? (
        <form
          className="mndt-channel-create"
          onSubmit={(event) => { event.preventDefault(); void submit() }}
        >
          <label className="mndt-field-label">
            {t('channelTitle')}
            <input
              className="mndt-input"
              value={title}
              placeholder={t('channelTitlePlaceholder')}
              onChange={(event) => { setTitle(event.target.value) }}
            />
          </label>
          {error === undefined ? undefined : <span role="alert" className="mndt-error">{error}</span>}
          <div className="mndt-row">
            <button type="submit" className="mndt-button" data-tone="primary" disabled={!ready || busy}>{t('create')}</button>
            <button type="button" className="mndt-button" onClick={() => { setCreating(false) }}>{t('cancel')}</button>
          </div>
        </form>
      ) : undefined}
      {channels.map(c => (
        <button
          key={c.id}
          type="button"
          className="mndt-channel"
          data-active={c.id === selected}
          data-kind={c.kind}
          onClick={() => { props.onSelect(c.id) }}
        >
          <span className="mndt-channel-hash">{c.kind === 'solo' ? '•' : '#'}</span>
          <span className="mndt-channel-name">{c.kind === 'solo' ? t('lane') : c.title || c.name}</span>
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ the thread */

/** The status words of a turn. */
const TURN_WORD = {
  queued: 'turnQueued',
  running: 'turnRunning',
  done: 'turnDone',
  failed: 'turnFailed',
  refused: 'turnRefused',
  cancelled: 'turnCancelled',
} as const

/**
 * One turn under the message that started it: the agent, its state, its cost and its trace.
 */
function TurnLine(props: {
  readonly turn: ChatTurn
  readonly agent: ChatAgent | undefined
  readonly openTrace?: ((sessionId: string) => void) | undefined
  readonly t: ChatTranslate
}): ReactNode {
  const { turn, agent, t } = props
  const tokens = turn.tokens ? turn.tokens.input + turn.tokens.output : undefined
  return (
    <div className="mndt-turn" data-status={turn.status} data-testid="chat-turn">
      <span className="mndt-role" data-agent="true">@{agent?.handle ?? turn.agentId}</span>
      <span className="mndt-pill" data-tone="state">{t(TURN_WORD[turn.status])}</span>
      {turn.status === 'done' && tokens !== undefined && turn.eur !== undefined ? (
        <span className="mndt-hint" data-testid="chat-turn-cost">{t('turnCost', { tokens: tokens.toLocaleString(), eur: euros(turn.eur) })}</span>
      ) : undefined}
      {turn.reason === undefined ? undefined : <span className="mndt-hint">{turn.reason}</span>}
      {turn.sessionId === undefined ? undefined : props.openTrace === undefined ? (
        <code className="mndt-hint">{t('traceId', { id: turn.sessionId })}</code>
      ) : (
        <button type="button" className="mndt-link" onClick={() => { props.openTrace?.(turn.sessionId ?? '') }}>{t('trace')}</button>
      )}
    </div>
  )
}

/**
 * A card a turn asked for, decided only by its button; a refusal carries its reason.
 */
function CardView(props: {
  readonly card: ThreadCard
  readonly canDecide: boolean
  readonly onDecide: (id: string, decision: 'approved' | 'rejected', reason?: string) => Promise<string | undefined>
  readonly t: ChatTranslate
}): ReactNode {
  const { card, t } = props
  const decided = card.state === 'approved' || card.state === 'rejected'
  const [refusing, setRefusing] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const decide = async (decision: 'approved' | 'rejected', why?: string): Promise<void> => {
    setBusy(true)
    setError(await props.onDecide(card.id, decision, why))
    setBusy(false)
  }
  return (
    <article className="mndt-post-card" data-kind="approval" data-state={card.state ?? 'pending'} data-testid="chat-card">
      <div className="mndt-post-head">
        <span className="mndt-post-kind">{t('card')}</span>
        <span className="mndt-hint">{t('askedBy', { name: card.requestedBy })}</span>
      </div>
      <p className="mndt-post-body">{card.title}</p>
      {decided ? (
        // A decided card stays where it was asked, with who decided and when; no button any more.
        <p className="mndt-post-meta" data-testid="chat-card-decision">
          {card.state === 'approved'
            ? t('cardApproved', { name: personName(card.decidedBy ?? ''), time: clock(card.decidedAt ?? '') })
            : t('cardRefused', { name: personName(card.decidedBy ?? ''), time: clock(card.decidedAt ?? ''), reason: card.reason ?? '' })}
        </p>
      ) : props.canDecide ? (
        <div className="mndt-post-actions">
          <button type="button" className="mndt-button" data-tone="primary" disabled={busy} onClick={() => { void decide('approved') }}>{t('approve')}</button>
          {refusing ? undefined : (
            <button type="button" className="mndt-button" disabled={busy} onClick={() => { setRefusing(true) }}>{t('refuse')}</button>
          )}
        </div>
      ) : undefined}
      {refusing && !decided ? (
        <form className="mndt-row" onSubmit={(event) => { event.preventDefault(); if (reason.trim() !== '') void decide('rejected', reason.trim()) }}>
          <input className="mndt-input" aria-label={t('refuseReason')} placeholder={t('refuseReason')} value={reason} onChange={(event) => { setReason(event.target.value) }} />
          {/* The Host refuses a refusal without a reason: the page asks for it first. */}
          <button type="submit" className="mndt-button" disabled={busy || reason.trim() === ''} title={t('reasonNeeded')}>{t('confirmRefuse')}</button>
        </form>
      ) : undefined}
      {error === undefined ? undefined : <span role="alert" className="mndt-error">{error}</span>}
    </article>
  )
}

/** One message, its turns and the cards they asked for. */
function MessageView(props: {
  readonly message: ChatMessage
  /** The author may delete their own message; the Host still decides. */
  readonly onRemove?: (() => Promise<string | undefined>) | undefined
  readonly agents: ReadonlyMap<string, ChatAgent>
  readonly cards: readonly ThreadCard[]
  readonly canDecide: boolean
  readonly onDecide: (id: string, decision: 'approved' | 'rejected', reason?: string) => Promise<string | undefined>
  readonly openTrace?: ((sessionId: string) => void) | undefined
  readonly t: ChatTranslate
}): ReactNode {
  const { message: m, agents, t } = props
  const name = authorName(m, agents) ?? t('system')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const remove = async (): Promise<void> => {
    if (props.onRemove === undefined) return
    setBusy(true)
    setError(await props.onRemove())
    setBusy(false)
    setConfirming(false)
  }
  return (
    <div className="mndt-message" data-author={m.author.kind} data-testid="chat-message" data-id={m.id}>
      <div className="mndt-post-head">
        <span className="mndt-role" data-agent={m.author.kind === 'agent' ? 'true' : undefined}>{name}</span>
        <span className="mndt-post-time">{clock(m.createdAt)}</span>
        {props.onRemove === undefined || m.deletedAt !== undefined ? undefined : confirming ? (
          <span className="mndt-message-actions">
            <button type="button" className="mndt-link" data-tone="danger" disabled={busy} onClick={() => { void remove() }}>
              {t('confirmDelete')}
            </button>
            <button type="button" className="mndt-link" disabled={busy} onClick={() => { setConfirming(false) }}>{t('cancel')}</button>
          </span>
        ) : (
          <button type="button" className="mndt-link mndt-message-actions" onClick={() => { setConfirming(true) }}>{t('delete')}</button>
        )}
      </div>
      {error === undefined ? undefined : <span role="alert" className="mndt-error">{error}</span>}
      {m.deletedAt !== undefined ? (
        <p className="mndt-message-text mndt-hint">{t('deleted')}</p>
      ) : m.author.kind === 'agent' ? (
        // An agent writes Markdown (tables, lists, bold): read, never shown as raw markers.
        <div className="mndt-message-text mndt-message-markdown" data-testid="chat-markdown">{renderBrief(m.text)}</div>
      ) : (
        <p className="mndt-message-text">{m.text}</p>
      )}
      {(m.turns ?? []).map(turn => (
        <TurnLine key={turn.id} turn={turn} agent={agents.get(turn.agentId)} openTrace={props.openTrace} t={t} />
      ))}
      {props.cards.map(card => (
        <CardView key={card.id} card={card} canDecide={props.canDecide} onDecide={props.onDecide} t={t} />
      ))}
    </div>
  )
}

/**
 * A channel's thread and its composer. The first page is read once, then the changes since the
 * cursor the Host returned, every two seconds; each message keeps its last copy.
 */
export function ChannelThread(props: {
  readonly chat: ChatFace
  readonly channel: ChatChannel
  readonly agents: readonly ChatAgent[]
  readonly cards: readonly ThreadCard[]
  readonly canDecide: boolean
  readonly onDecide: (id: string, decision: 'approved' | 'rejected', reason?: string) => Promise<string | undefined>
  readonly openTrace?: ((sessionId: string) => void) | undefined
  /** Why the cards could not be read: said in the thread, never shown as « no card ». */
  readonly cardsError?: string | undefined
  /** The reader's e-mail: their own messages offer « Delete ». */
  readonly you?: string | undefined
  /** A turn ended: what it asked for (cards, spending) is now on the Host. */
  readonly onSettled?: (() => void) | undefined
  readonly t: ChatTranslate
  /** For tests: how often to read again. */
  readonly pollMs?: number
}): ReactNode {
  const { chat, channel, t } = props
  const [thread, setThread] = useState<readonly ChatMessage[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const cursor = useRef<string | undefined>(undefined)
  // The feed follows the newest message while the reader is at the bottom; scrolled up, it stays put.
  const feed = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  // What is shown, read by the poll to tell which turns a page brings to an end.
  const shown = useRef<readonly ChatMessage[]>([])
  const onSettled = useRef(props.onSettled)
  onSettled.current = props.onSettled
  const byAgent = useMemo(() => new Map(props.agents.map(a => [a.id, a])), [props.agents])

  useEffect(() => {
    let live = true
    cursor.current = undefined
    atBottom.current = true
    shown.current = []
    setThread(undefined)
    setError(undefined)
    const read = async (): Promise<void> => {
      try {
        const page = cursor.current === undefined
          ? await chat.messages(channel.id)
          : await chat.changes(channel.id, cursor.current)
        if (!live) return
        cursor.current = page.cursor
        const ended = settledTurns(shown.current, page.messages)
        shown.current = mergeThread(shown.current, page.messages)
        setThread(held => mergeThread(held ?? [], page.messages))
        setError(undefined)
        if (ended > 0) onSettled.current?.()
      } catch (failure) {
        if (live) setError(reasonOf(failure, t))
      }
    }
    void read()
    const timer = setInterval(() => { void read() }, props.pollMs ?? POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [chat, channel.id, props.pollMs])

  const last = thread === undefined || thread.length === 0 ? undefined : thread[thread.length - 1]
  const lastSeen = last === undefined ? '' : `${last.id}:${last.updatedAt}:${String(props.cards.length)}`
  useEffect(() => {
    const box = feed.current
    if (box !== null && atBottom.current) box.scrollTop = box.scrollHeight
  }, [lastSeen])

  const followed = (): void => {
    const box = feed.current
    if (box !== null) atBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < FOLLOW_PX
  }

  const posted = useCallback((message: ChatMessage): void => {
    atBottom.current = true
    shown.current = mergeThread(shown.current, [message])
    setThread(held => mergeThread(held ?? [], [message]))
  }, [])

  const removeOf = (m: ChatMessage): (() => Promise<string | undefined>) | undefined => {
    if (props.you === undefined || m.author.kind !== 'human' || m.author.email !== props.you) return undefined
    return async () => {
      try {
        const removed = await chat.remove(channel.id, m.id)
        setThread(held => mergeThread(held ?? [], [removed]))
        return undefined
      } catch (failure) {
        return reasonOf(failure, t)
      }
    }
  }

  const cardsOf = (messageId: string): ThreadCard[] =>
    props.cards.filter(card => card.channelId === channel.id && card.messageId === messageId)

  return (
    <section className="mndt-thread" aria-label={channel.kind === 'solo' ? t('lane') : `# ${channel.title || channel.name}`}>
      <div className="mndt-thread-feed" data-testid="chat-thread" ref={feed} onScroll={followed}>
        {error === undefined ? undefined : <p role="alert" className="mndt-error mndt-error-banner">{t('unreadable', { reason: error })}</p>}
        {props.cardsError === undefined ? undefined : (
          <p role="alert" className="mndt-error mndt-error-banner">{t('cardsUnreadable', { reason: props.cardsError })}</p>
        )}
        {thread === undefined ? (
          error === undefined ? <p className="mndt-hint">{t('loading')}</p> : undefined
        ) : thread.length === 0 ? (
          <p className="mndt-hint" data-testid="chat-empty">{t('empty')}</p>
        ) : thread.map(m => (
          <MessageView
            key={m.id}
            message={m}
            onRemove={removeOf(m)}
            agents={byAgent}
            cards={cardsOf(m.id)}
            canDecide={props.canDecide}
            onDecide={props.onDecide}
            openTrace={props.openTrace}
            t={t}
          />
        ))}
      </div>
      <Composer chat={chat} channel={channel} agents={props.agents} onPosted={posted} t={t} />
    </section>
  )
}

/* ------------------------------------------------------------------ the composer */

/**
 * Write to the channel; `@` offers this channel's agents. Enter sends, Shift+Enter breaks the line.
 * A refusal (rights, empty text) is shown with the Host's reason; the text stays.
 */
function Composer(props: {
  readonly chat: ChatFace
  readonly channel: ChatChannel
  readonly agents: readonly ChatAgent[]
  readonly onPosted: (message: ChatMessage) => void
  readonly t: ChatTranslate
}): ReactNode {
  const { chat, channel, t } = props
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const box = useRef<HTMLTextAreaElement | null>(null)
  const query: MentionQuery | null = mentionAt(text, caret)
  const choices = query === null ? [] : mentionChoices(query, channel.agents, props.agents)

  const pick = (handle: string): void => {
    if (query === null) return
    const next = completeMention(text, query, caret, handle)
    setText(next.text)
    setCaret(next.caret)
    setActive(0)
    requestAnimationFrame(() => {
      box.current?.focus()
      box.current?.setSelectionRange(next.caret, next.caret)
    })
  }
  const send = async (): Promise<void> => {
    if (!text.trim() || busy) return
    setBusy(true)
    try {
      props.onPosted(await chat.post(channel.id, text))
      setText('')
      setCaret(0)
      setError(undefined)
    } catch (failure) {
      setError(reasonOf(failure, t))
    }
    setBusy(false)
  }
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (choices.length > 0) {
      if (event.key === 'ArrowDown') { event.preventDefault(); setActive(i => (i + 1) % choices.length); return }
      if (event.key === 'ArrowUp') { event.preventDefault(); setActive(i => (i - 1 + choices.length) % choices.length); return }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const chosen = choices[active] ?? choices[0]
        if (chosen) pick(chosen.handle)
        return
      }
      if (event.key === 'Escape') { event.preventDefault(); setCaret(0); return }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  return (
    <div className="mndt-composer" data-testid="chat-composer">
      <div className="mndt-composer-frame">
        {channel.agents.length === 0 ? (
          <span className="mndt-composer-note" data-testid="chat-no-agent">{t('noAgentHere')}</span>
        ) : (
          <span className="mndt-composer-note">{t('notADecision')}</span>
        )}
        {choices.length === 0 ? undefined : (
          <ul className="mndt-mention-list" role="listbox" aria-label={t('mentionHint')} data-testid="chat-mentions">
            {choices.map((a, i) => (
              <li
                key={a.id}
                role="option"
                aria-selected={i === active}
                className="mndt-mention"
                onMouseDown={(event) => { event.preventDefault(); pick(a.handle) }}
              >
                <b>@{a.handle}</b> <span className="mndt-hint">{a.name}</span>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={box}
          className="mndt-input mndt-composer-input"
          aria-label={t('composer')}
          placeholder={t('composerPlaceholder')}
          rows={2}
          value={text}
          onChange={(event) => { setText(event.target.value); setCaret(event.target.selectionStart); setActive(0) }}
          onSelect={(event) => { setCaret(event.currentTarget.selectionStart) }}
          onKeyDown={onKey}
        />
        {error === undefined ? undefined : <span role="alert" className="mndt-error">{error}</span>}
        <div className="mndt-composer-actions">
          <button type="button" className="mndt-button" data-tone="primary" disabled={!text.trim() || busy} onClick={() => { void send() }}>
            {busy ? t('sending') : t('send')}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ the agents */

/**
 * The channel's agents: model, what they spent this month against their ceiling; and adding a
 * declared agent to the channel, as a colleague. The Host decides who may (a refusal is shown).
 */
export function ChannelAgents(props: {
  readonly channel: ChatChannel
  readonly agents: readonly ChatAgent[]
  readonly t: ChatTranslate
  /** Add an agent to the channel; resolves to the Host's reason when refused. */
  readonly onAdd?: ((agentId: string) => Promise<string | undefined>) | undefined
}): ReactNode {
  const { channel, t } = props
  const here = props.agents.filter(a => channel.agents.includes(a.id))
  const addable = props.agents.filter(a => !channel.agents.includes(a.id) && a.retiredAt === undefined)
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const add = async (): Promise<void> => {
    if (!choice || busy || props.onAdd === undefined) return
    setBusy(true)
    const refused = await props.onAdd(choice)
    setBusy(false)
    setError(refused)
    if (refused === undefined) setChoice('')
  }
  return (
    <div className="mndt-context-block" data-testid="chat-agents">
      <h3 className="mndt-context-title">{t('agents')}</h3>
      {here.length === 0 ? <p className="mndt-hint">{t('agentNone')}</p> : (
        <ul className="mndt-plain-list">
          {here.map(a => (
            <li key={a.id} data-testid="chat-agent">
              <b>@{a.handle}</b> {a.name}
              <span className="mndt-hint" style={{ display: 'block' }}>{t('agentModel', { provider: a.provider, model: a.model })}</span>
              <span className="mndt-hint" style={{ display: 'block' }} data-testid="chat-agent-month">
                {t('agentMonth', { spent: euros(a.eurThisMonth ?? 0), ceiling: euros(a.eurPerMonth) })}
              </span>
            </li>
          ))}
        </ul>
      )}
      {props.onAdd === undefined || addable.length === 0 ? undefined : (
        <form className="mndt-row" onSubmit={(event) => { event.preventDefault(); void add() }} data-testid="chat-agent-add">
          <select className="mndt-input" aria-label={t('addAgent')} value={choice} onChange={(event) => { setChoice(event.target.value) }}>
            <option value="">{t('chooseAgent')}</option>
            {addable.map(a => <option key={a.id} value={a.id}>@{a.handle} · {a.name}</option>)}
          </select>
          <button type="submit" className="mndt-button" disabled={!choice || busy}>{t('add')}</button>
        </form>
      )}
      {error === undefined ? undefined : <span role="alert" className="mndt-error">{error}</span>}
    </div>
  )
}
