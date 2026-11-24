/**
 * Mutual help between agents before the human (brief of 14/11, contract with A1): an agent stuck in
 * a channel turn asks one or two peers of the channel. The help is read in `turn.help`,
 * served live, and shown in place under the turn's line, folded, unfolded while it runs. The
 * advices stay anonymous (« Avis A », « Avis B ») until the asking agent has read them; the outcome
 * is always visible. A person only ever answers: « Répondre et clore ce fil ». Every text an agent
 * wrote is shown through the safe renderer, headings as plain bold. Anything of another shape
 * shows nothing rather than breaking the page.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { ChatAgent, ChatTurn } from './chat.ts'
import type { ChatTranslate } from './chatLocales.ts'
import { euros, when } from './format.ts'
import { renderBrief } from './markdown.tsx'
import { shownName } from './TeamFeed.tsx'

/** What the asking agent needs from its peers. */
export type HelpNeed = 'fact' | 'opinion' | 'check' | 'choice'
/** How the asking agent read the advices. */
export type HelpVerdict = 'unblocked' | 'card' | 'escalate'

/** One peer's advice; its author only once the asking agent has read them all. */
export interface HelpAdvice {
  readonly slot: 'A' | 'B'
  readonly round: number
  readonly text: string
  readonly eur?: number
  readonly tokens?: number
  readonly agentId?: string
  readonly model?: string
}

/** A turn's question to a person, after its peers' help. */
export interface Escalation {
  readonly question: string
  readonly summary?: string
  readonly answeredAt?: string
  readonly answeredBy?: string
  /** The published question's message: a reply to it answers (when served). */
  readonly messageId?: string
}

/** A turn's help, as `turn.help` serves it. */
export interface TurnHelp {
  readonly state: 'asked' | 'advising' | 'reading' | 'done'
  readonly request: {
    readonly task: string
    readonly tried: string
    readonly blocker: string
    readonly options: readonly string[]
    readonly need: HelpNeed
  }
  readonly advices: readonly HelpAdvice[]
  readonly reading?: { readonly verdict: HelpVerdict; readonly retained?: string; readonly why?: string }
  readonly escalation?: Escalation
  readonly closedBy?: { readonly by?: string; readonly at?: string }
  readonly skipped: readonly { readonly slot?: 'A' | 'B'; readonly agentId?: string; readonly reason: string }[]
  readonly eur?: number
  readonly capEur?: number
}

const NEEDS = new Set(['fact', 'opinion', 'check', 'choice'])
const VERDICTS = new Set(['unblocked', 'card', 'escalate'])
const STATES = new Set(['asked', 'advising', 'reading', 'done'])
/** The longest text read from the help; beyond, the field is not read. */
const MAX_TEXT = 20_000

/** @param value - anything. @returns it when it is a bounded text, trimmed and not empty. */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_TEXT ? value.trim() : undefined
}

/** @param value - anything. @returns it when it is a finite count or amount ≥ 0. */
function amountOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** @param raw - tokens, a number or `{ input, output }`. @returns their sum, if read. */
function tokensOf(raw: unknown): number | undefined {
  if (typeof raw === 'number') return amountOf(raw)
  if (typeof raw !== 'object' || raw === null) return undefined
  const input = amountOf((raw as Record<string, unknown>).input)
  const output = amountOf((raw as Record<string, unknown>).output)
  return input === undefined && output === undefined ? undefined : (input ?? 0) + (output ?? 0)
}

/** @param value - anything. @returns a slot letter, if it is one. */
function slotOf(value: unknown): 'A' | 'B' | undefined {
  return value === 'A' || value === 'B' ? value : undefined
}

/** @param value - anything. @returns an ISO instant, if it is one. */
function instantOf(value: unknown): string | undefined {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined
}

/** @param value - anything. @returns it as a record, if it is an object. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** @param raw - `help.escalation`. @returns it when well-formed. */
function escalationFrom(raw: unknown): Escalation | undefined {
  const e = recordOf(raw)
  const question = textOf(e?.question)
  if (e === undefined || question === undefined) return undefined
  const summary = textOf(e.summary)
  const answeredAt = instantOf(e.answeredAt)
  const answeredBy = textOf(e.answeredBy)
  const messageId = textOf(e.messageId)
  return {
    question,
    ...(summary === undefined ? {} : { summary }),
    ...(answeredAt === undefined ? {} : { answeredAt }),
    ...(answeredBy === undefined ? {} : { answeredBy }),
    ...(messageId === undefined ? {} : { messageId }),
  }
}

/**
 * @param turn - a turn as served.
 * @returns its help (`turn.help`) when its request is well-formed; else undefined (no help shown).
 * Before the asking agent has read the advices, no author is read, even if one were served.
 */
export function helpOf(turn: ChatTurn): TurnHelp | undefined {
  const h = recordOf(turn.help)
  if (h === undefined || typeof h.state !== 'string' || !STATES.has(h.state)) return undefined
  const r = recordOf(h.request)
  if (r === undefined) return undefined
  const task = textOf(r.task)
  const tried = textOf(r.tried)
  const blocker = textOf(r.blocker)
  const options = Array.isArray(r.options) ? r.options.map(textOf) : []
  if (task === undefined || tried === undefined || blocker === undefined || typeof r.need !== 'string' || !NEEDS.has(r.need)) return undefined
  if (options.some(o => o === undefined)) return undefined
  const rd = recordOf(h.reading)
  const reading = rd !== undefined && typeof rd.verdict === 'string' && VERDICTS.has(rd.verdict)
    ? {
      verdict: rd.verdict as HelpVerdict,
      ...(textOf(rd.retained) === undefined ? {} : { retained: textOf(rd.retained) as string }),
      ...(textOf(rd.why) === undefined ? {} : { why: textOf(rd.why) as string }),
    }
    : undefined
  // Authors only once the help is read and no question waits (#119): the same rule as a council.
  const escalationRaw = escalationFrom(h.escalation)
  const revealed = reading !== undefined && (escalationRaw === undefined || escalationRaw.answeredAt !== undefined)
  const advices: HelpAdvice[] = []
  for (const item of Array.isArray(h.advices) ? h.advices : []) {
    const a = recordOf(item)
    const slot = slotOf(a?.slot)
    const text = textOf(a?.text)
    if (a === undefined || slot === undefined || text === undefined) continue
    const round = typeof a.round === 'number' && Number.isInteger(a.round) && a.round >= 1 ? a.round : 1
    // Before the asking agent has read them, nothing per advice beyond its text: no cost, no author.
    const eur = revealed ? amountOf(a.eur) : undefined
    const tokens = revealed ? tokensOf(a.tokens) : undefined
    const agentId = revealed ? textOf(a.agentId) : undefined
    const model = revealed ? textOf(a.model) : undefined
    advices.push({
      slot, round, text,
      ...(eur === undefined ? {} : { eur }),
      ...(tokens === undefined ? {} : { tokens }),
      ...(agentId === undefined ? {} : { agentId }),
      ...(model === undefined ? {} : { model }),
    })
  }
  const skipped = (Array.isArray(h.skipped) ? h.skipped : []).flatMap((item: unknown) => {
    const k = recordOf(item)
    const reason = textOf(k?.reason)
    if (k === undefined || reason === undefined) return []
    const slot = slotOf(k.slot)
    const agentId = revealed ? textOf(k.agentId) : undefined
    return [{ reason, ...(slot === undefined ? {} : { slot }), ...(agentId === undefined ? {} : { agentId }) }]
  })
  const c = recordOf(h.closedBy)
  const closedBy = c === undefined ? undefined : {
    ...(textOf(c.by) === undefined ? {} : { by: textOf(c.by) as string }),
    ...(instantOf(c.at) === undefined ? {} : { at: instantOf(c.at) as string }),
  }
  const escalation = escalationFrom(h.escalation)
  const eur = amountOf(h.eur)
  const capEur = amountOf(h.capEur)
  return {
    state: h.state as TurnHelp['state'],
    request: { task, tried, blocker, options: options.filter((o): o is string => o !== undefined), need: r.need as HelpNeed },
    advices,
    skipped,
    ...(reading === undefined ? {} : { reading }),
    ...(escalation === undefined ? {} : { escalation }),
    ...(closedBy === undefined ? {} : { closedBy }),
    ...(eur === undefined ? {} : { eur }),
    ...(capEur === undefined ? {} : { capEur }),
  }
}

const NEED_WORDS = { fact: 'helpNeedFact', opinion: 'helpNeedOpinion', check: 'helpNeedCheck', choice: 'helpNeedChoice' } as const

/** @param help - a turn's help. @param t - the copy. @param names - the team's names. @returns its state in words. */
function stateWord(help: TurnHelp, t: ChatTranslate, names?: Readonly<Record<string, string>>): string {
  // Closed by a person: the core publishes nothing then, so the screen says who closed it.
  if (help.closedBy !== undefined) {
    return help.closedBy.by === undefined ? t('helpClosedByHuman') : t('helpClosedByWho', { who: shownName(help.closedBy.by, names) })
  }
  if (help.escalation?.answeredAt !== undefined) return t('helpClosedByHuman')
  // A question still waiting is said first, reading or not: it must never pass for a closed help.
  if (help.escalation !== undefined) return t('helpQuestion')
  // Ended without a reading (a restart, a stopped turn): said, with the reason the core gives.
  // (no question waits here: it was said just above)
  if (help.state === 'done' && help.reading === undefined) {
    const reasons = [...new Set(help.skipped.filter(k => k.slot === undefined).map(k => k.reason))]
    return reasons.length === 0 ? t('helpClosedUnread') : t('helpClosedUnreadWhy', { why: reasons.join(', ') })
  }
  if (help.reading === undefined) return help.state === 'reading' ? t('helpReading') : t('helpRunning')
  return help.reading.verdict === 'unblocked' ? t('helpUnblocked')
    : help.reading.verdict === 'card' ? t('helpCard') : t('helpQuestion')
}

/**
 * The help under a turn's line: who was asked (in words, not names, until read), its state always
 * visible, then folded the request in named fields, the advices, what was kept and why, the cost.
 * A person answers in one click when the agent asks them: the answer is posted in the thread.
 */
export function HelpThread(props: {
  readonly help: TurnHelp
  readonly agents: ReadonlyMap<string, ChatAgent>
  /** Post the person's answer in the thread, as a reply to the message given. */
  readonly onAnswer?: ((text: string, replyTo: string) => Promise<string | undefined>) | undefined
  /** The message whose turn asked: a reply to it closes a help still running. */
  readonly originMessageId?: string | undefined
  /** Whether the reader's answer counts (workflows.write): a viewer is offered no field. */
  readonly canAnswer?: boolean | undefined
  /** The team's names by lower-case address, where they are served. */
  readonly names?: Readonly<Record<string, string>> | undefined
  readonly t: ChatTranslate
}): ReactNode {
  const { help, t } = props
  const escalation = help.escalation
  const running = help.state !== 'done' && help.closedBy === undefined
  const waiting = escalation !== undefined && escalation.answeredAt === undefined
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const asked = new Set([...help.advices.map(a => a.slot), ...help.skipped.flatMap(k => (k.slot === undefined ? [] : [k.slot]))]).size
  const total = help.eur ?? help.advices.reduce((sum, a) => sum + (a.eur ?? 0), 0)
  const name = (id: string): string => `@${props.agents.get(id)?.handle ?? id}`
  const send = async (): Promise<void> => {
    if (props.onAnswer === undefined || target === undefined || busy) return
    if (answer.trim() === '') {
      setError(t('answerEmpty'))
      return
    }
    setBusy(true)
    const refused = await props.onAnswer(answer.trim(), target)
    setError(refused)
    if (refused === undefined) setAnswer('')
    setBusy(false)
  }
  // Where a person's answer goes: the published question when the agent asks; the turn's own message
  // while the help runs (it closes it). Only an answer that counts is offered.
  const target = props.canAnswer !== true ? undefined
    : waiting ? escalation.messageId
      : running ? props.originMessageId : undefined
  const answerField = props.onAnswer === undefined || target === undefined ? undefined : (
    <div className="mw-help-answer">
      <textarea
        className="mw-input"
        rows={2}
        aria-label={t('helpAnswerLabel')}
        value={answer}
        onChange={(event) => { setAnswer(event.target.value) }}
      />
      <button type="button" className="mw-primary" disabled={busy} onClick={() => { void send() }}>
        {t('helpAnswer')}
      </button>
      {error === undefined ? undefined : <p role="alert" className="mw-decide-error">{error}</p>}
    </div>
  )
  return (
    <div className="mw-help" data-testid="turn-help" data-state={running ? 'running' : 'done'}>
      <p className="mw-help-line">
        <span>{t(asked <= 1 ? 'helpAskedOne' : 'helpAskedMany', { n: asked })}</span>
        {' · '}
        <b data-testid="help-state">{stateWord(help, t, props.names)}</b>
        {total > 0 ? ` · ${help.capEur === undefined ? euros(total) : t('helpCost', { eur: euros(total), cap: euros(help.capEur) })}` : ''}
      </p>
      {waiting ? (
        <div className="mw-turn-unchecked mw-help-question" role="note" data-testid="help-question">
          <p className="mw-help-question-text">{t('helpQuestionFor', { question: escalation.question })}</p>
          {escalation.summary === undefined ? undefined : <div className="mw-agent-text">{renderBrief(escalation.summary, { plainHeadings: true })}</div>}
          {answerField}
        </div>
      ) : undefined}
      {running ? answerField : undefined}
      <details className="mw-turn-steps" data-testid="help-steps" open={running}>
        <summary>{t('helpDetail')}</summary>
        <dl className="mw-sheet-view" data-testid="help-request">
          <dt>{t('helpTask')}</dt><dd>{help.request.task}</dd>
          <dt>{t('helpTried')}</dt><dd>{help.request.tried}</dd>
          <dt>{t('helpBlocker')}</dt><dd>{help.request.blocker}</dd>
          {help.request.options.length === 0 ? undefined : (
            <><dt>{t('helpOptions')}</dt><dd><ul className="mw-turn-notes">{help.request.options.map((o, i) => <li key={i}>{o}</li>)}</ul></dd></>
          )}
          <dt>{t('helpNeed')}</dt><dd>{t(NEED_WORDS[help.request.need])}</dd>
        </dl>
        <ol className="mw-help-advices">
          {help.advices.map((a, i) => (
            <li key={`${a.slot}-${a.round}-${i}`} data-testid="help-advice">
              <span className="mw-ctx-strong">
                {t('helpAdvice', { slot: a.slot })}
                {a.round > 1 ? ` · ${t('helpSecondRound')}` : ''}
              </span>
              {a.agentId === undefined ? '' : ` · ${name(a.agentId)}${a.model === undefined ? '' : ` (${a.model})`}`}
              {a.eur === undefined ? '' : ` · ${euros(a.eur)}`}
              <div className="mw-turn-part mw-agent-text">{renderBrief(a.text, { plainHeadings: true })}</div>
            </li>
          ))}
          {help.skipped.map((k, i) => (
            <li key={`skip-${i}`} data-testid="help-skipped">
              <span className="mw-ctx-strong">{k.slot === undefined ? t('helpPeerSkipped') : t('helpAdviceMissing', { slot: k.slot })}</span>
              {k.agentId === undefined ? '' : ` · ${name(k.agentId)}`}
              <p className="mw-ctx-muted">{k.reason}</p>
            </li>
          ))}
        </ol>
        {help.reading === undefined ? undefined : (
          <div className="mw-help-reading" data-testid="help-reading">
            {help.reading.retained === undefined ? undefined : <p><b>{t('helpRetained')}</b> {help.reading.retained}</p>}
            {help.reading.why === undefined ? undefined : <p><b>{t('helpWhy')}</b> {help.reading.why}</p>}
          </div>
        )}
        {help.closedBy === undefined ? undefined : (
          <p className="mw-ctx-muted" data-testid="help-closed">
            {t('helpClosedBy', { at: help.closedBy.at === undefined ? '' : when(help.closedBy.at) })}
          </p>
        )}
      </details>
    </div>
  )
}
