/**
 * The « conseil » mode (brief of 15/11, lot 2; contract with A1): a choice between options, argued by
 * 2 to 4 agents. The chair (the first member, whose turn calls the council) frames the question, by
 * name; then independent positions and critiques without author's name until the decision, a
 * decision by vote or synthesis, and the disagreements, always shown. A tie, a missed quorum, an
 * impossible synthesis or a vote for « none of these » asks a person, as the mutual help does. All
 * of it is read from `turn.council`, defensively, and shown in place under the turn's line.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { ChatAgent, ChatTurn } from './chat.ts'
import type { ChatTranslate } from './chatLocales.ts'
import { euros } from './format.ts'
import { renderBrief } from './markdown.tsx'

/** A position, by slot; its author only once the council has decided. */
export interface CouncilPosition {
  readonly slot: string
  /** The option chosen; undefined when the choice could not be read (shown « choix illisible »). */
  readonly choice?: number
  readonly text: string
  readonly agentId?: string
  readonly model?: string
}

/** A critique, by slot, about another position; its choice is the one counted. */
export interface CouncilCritique {
  readonly slot: string
  readonly about: string
  readonly text: string
  readonly choice?: number
}

/** A turn's council, as `turn.council` serves it. */
export interface TurnCouncil {
  readonly state: string
  /** The question put to the council. */
  readonly question?: string
  readonly framing?: string
  readonly options: readonly string[]
  readonly positions: readonly CouncilPosition[]
  readonly critiques: readonly CouncilCritique[]
  readonly decision?:
    | { readonly kind: 'vote'; readonly tally: Readonly<Record<number, number>>; readonly chosen?: number }
    | { readonly kind: 'synthesis'; readonly text: string; readonly agentId?: string; readonly chosen?: number }
  readonly dissent: readonly { readonly slot: string; readonly why?: string }[]
  /** Positions or critiques not counted, and why (by category before the decision). */
  readonly skipped: readonly { readonly slot?: string; readonly reason: string }[]
  readonly escalation?: { readonly question: string; readonly summary?: string; readonly answeredAt?: string; readonly messageId?: string }
  readonly eur?: number
  readonly capEur?: number
}

const MAX_TEXT = 20_000

/** @param value - anything. @returns a bounded, trimmed, non-empty text. */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_TEXT ? value.trim() : undefined
}
/** @param value - anything. @returns it as a record, if it is an object. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
/** @param value - anything. @returns a short slot name (« A »…). */
function slotOf(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Z]$/u.test(value) ? value : undefined
}
/**
 * @param value - an option's number as the core serves it (1-based, never a label).
 * @param count - the options. @returns its index in `options` (0-based), if valid.
 */
function indexOf(value: unknown, count: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= count ? value - 1 : undefined
}
/** @param value - anything. @returns a finite amount ≥ 0. */
function amountOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * @param turn - a turn as served.
 * @returns its council when its shape is known (a state and options); a position or critique whose
 * choice cannot be read stays, said « choix illisible »; anything else unreadable is left out, never
 * the whole council. No author is read before the decision, even if one were served.
 */
export function councilOf(turn: ChatTurn): TurnCouncil | undefined {
  const c = recordOf(turn.council)
  if (c === undefined || typeof c.state !== 'string' || c.state === '' || !Array.isArray(c.options)) return undefined
  const options = c.options.map(textOf)
  if (options.length < 2 || options.length > 6 || options.some(o => o === undefined)) return undefined
  const labels = options.filter((o): o is string => o !== undefined)
  const d = recordOf(c.decision)
  let decision: TurnCouncil['decision']
  if (d?.kind === 'vote' && recordOf(d.tally) !== undefined) {
    const tally: Record<number, number> = {}
    for (const [key, n] of Object.entries(recordOf(d.tally) ?? {})) {
      const i = indexOf(Number(key), labels.length)
      if (i === undefined || typeof n !== 'number' || !Number.isInteger(n) || n < 0) continue
      tally[i] = n
    }
    const chosen = indexOf(d.chosen, labels.length)
    decision = { kind: 'vote', tally, ...(chosen === undefined ? {} : { chosen }) }
  } else if (d?.kind === 'synthesis' && textOf(d.text) !== undefined) {
    const agentId = textOf(d.agentId)
    const chosen = indexOf(d.chosen, labels.length)
    decision = {
      kind: 'synthesis', text: textOf(d.text) as string,
      ...(agentId === undefined ? {} : { agentId }),
      ...(chosen === undefined ? {} : { chosen }),
    }
  }
  const e = recordOf(c.escalation)
  const question = textOf(e?.question)
  const escalation = e === undefined || question === undefined ? undefined : {
    question,
    ...(textOf(e.summary) === undefined ? {} : { summary: textOf(e.summary) as string }),
    ...(typeof e.answeredAt === 'string' && !Number.isNaN(Date.parse(e.answeredAt)) ? { answeredAt: e.answeredAt } : {}),
    ...(textOf(e.messageId) === undefined ? {} : { messageId: textOf(e.messageId) as string }),
  }
  // Authors only once the council is closed: a decision, and no question left open (C, #119).
  const decided = decision !== undefined && (escalation === undefined || escalation.answeredAt !== undefined)
  const positions: CouncilPosition[] = []
  for (const item of Array.isArray(c.positions) ? c.positions : []) {
    const p = recordOf(item)
    const slot = slotOf(p?.slot)
    const choice = indexOf(p?.choice, labels.length)
    const text = textOf(p?.text)
    if (p === undefined || slot === undefined || text === undefined) continue
    const agentId = decided ? textOf(p.agentId) : undefined
    const model = decided ? textOf(p.model) : undefined
    positions.push({
      slot, text,
      ...(choice === undefined ? {} : { choice }),
      ...(agentId === undefined ? {} : { agentId }),
      ...(model === undefined ? {} : { model }),
    })
  }
  const critiques: CouncilCritique[] = []
  for (const item of Array.isArray(c.critiques) ? c.critiques : []) {
    const k = recordOf(item)
    const slot = slotOf(k?.slot)
    // The slots criticised: one, or several.
    const aboutRaw = k?.about
    const abouts = Array.isArray(aboutRaw) ? aboutRaw.map(slotOf) : [slotOf(aboutRaw)]
    const about = abouts.length === 0 || abouts.some(x => x === undefined) ? undefined : abouts.join(', ')
    const choice = indexOf(k?.choice, labels.length)
    const text = textOf(k?.text)
    if (k === undefined || slot === undefined || about === undefined || text === undefined) continue
    critiques.push({ slot, about, text, ...(choice === undefined ? {} : { choice }) })
  }
  const dissent = (Array.isArray(c.dissent) ? c.dissent : []).flatMap((item: unknown) => {
    const x = recordOf(item)
    const slot = slotOf(x?.slot)
    if (x === undefined || slot === undefined) return []
    const why = textOf(x.why)
    return [{ slot, ...(why === undefined ? {} : { why }) }]
  })
  const skipped = (Array.isArray(c.skipped) ? c.skipped : []).flatMap((item: unknown) => {
    const x = recordOf(item)
    const reason = textOf(x?.reason)
    if (x === undefined || reason === undefined) return []
    const slot = slotOf(x.slot)
    return [{ reason, ...(slot === undefined ? {} : { slot }) }]
  })
  const framing = textOf(recordOf(c.framing)?.text)
  const eur = amountOf(c.eur)
  const capEur = amountOf(c.capEur)
  return {
    options: labels, positions, critiques, dissent, skipped,
    state: c.state,
    ...(textOf(c.question) === undefined ? {} : { question: textOf(c.question) as string }),
    ...(framing === undefined ? {} : { framing }),
    ...(decision === undefined ? {} : {
      decision: decision.kind === 'synthesis' && !decided ? { kind: 'synthesis' as const, text: decision.text, ...(decision.chosen === undefined ? {} : { chosen: decision.chosen }) } : decision,
    }),
    ...(escalation === undefined ? {} : { escalation }),
    ...(eur === undefined ? {} : { eur }),
    ...(capEur === undefined ? {} : { capEur }),
  }
}

/**
 * The council under a turn's line: who sat, how it decided, the outcome always visible with its
 * disagreements; folded, the chair's framing, the options, the positions and critiques by slot, the
 * count or the synthesis. A question for a person is answered in one field, where the answer counts.
 */
export function CouncilThread(props: {
  readonly turn: ChatTurn
  readonly council: TurnCouncil
  readonly agents: ReadonlyMap<string, ChatAgent>
  readonly onAnswer?: ((text: string, replyTo: string) => Promise<string | undefined>) | undefined
  readonly canAnswer?: boolean | undefined
  readonly t: ChatTranslate
}): ReactNode {
  const { council: c, t } = props
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const name = (id: string): string => `@${props.agents.get(id)?.handle ?? id}`
  const label = (i: number): string => c.options[i] ?? String(i + 1)
  /** @param i - a choice, if read. @returns its words: « option n : label », or « choix illisible ». */
  const choiceWords = (i: number | undefined): string => (i === undefined ? t('councilUnreadableChoice') : t('councilOption', { n: i + 1, option: label(i) }))
  const decided = c.decision !== undefined
  const waiting = c.escalation !== undefined && c.escalation.answeredAt === undefined
  // Running until it decides, asks a person, or ends otherwise (« done », « closed » after a restart).
  const ended = c.state === 'done' || c.state === 'closed'
  const running = !decided && c.escalation === undefined && !ended
  const members = c.positions.length
  // Ended without a decision: the core's reason (a restart, a stopped turn), when it gives one.
  const endReasons = [...new Set(c.skipped.filter(k => k.slot === undefined).map(k => k.reason))]
  const endedWords = endReasons.length === 0 ? t('councilEnded') : t('councilEndedWhy', { why: endReasons.join(', ') })
  const outcome = waiting ? t('helpQuestion')
    : c.escalation?.answeredAt !== undefined ? t('helpClosedByHuman')
      : c.decision?.kind === 'vote'
        ? (c.decision.chosen === undefined ? t('councilNoMajority') : t('councilChosen', { option: label(c.decision.chosen), n: c.decision.tally[c.decision.chosen] ?? 0, of: members }))
        : c.decision?.kind === 'synthesis'
          ? (c.decision.chosen === undefined
            ? t('councilSynthBy', { who: c.decision.agentId === undefined ? t('councilSynthesis') : name(c.decision.agentId) })
            : t('councilSynthChose', { option: label(c.decision.chosen), who: c.decision.agentId === undefined ? t('councilSynthesis') : name(c.decision.agentId) }))
          : ended ? endedWords : t('councilRunning')
  const target = props.canAnswer === true && waiting ? c.escalation.messageId : undefined
  const send = async (): Promise<void> => {
    if (props.onAnswer === undefined || target === undefined || answer.trim() === '' || busy) return
    setBusy(true)
    const refused = await props.onAnswer(answer.trim(), target)
    setError(refused)
    if (refused === undefined) setAnswer('')
    setBusy(false)
  }
  const chair = props.turn.agentId
  return (
    <div className="mw-help" data-testid="turn-council" data-state={running ? 'running' : 'done'}>
      <p className="mw-help-line">
        <span>{t('councilOf', { n: members })}</span>
        {' · '}
        <b data-testid="council-outcome">{outcome}</b>
        {c.eur === undefined ? '' : ` · ${c.capEur === undefined ? euros(c.eur) : t('helpCost', { eur: euros(c.eur), cap: euros(c.capEur) })}`}
      </p>
      {/* Disagreements are never folded, even when a decision is taken. */}
      {c.dissent.map(d => (
        <p key={d.slot} className="mw-turn-unchecked" role="note" data-testid="council-dissent">
          {t('councilDissent', { slot: d.slot })}{d.why === undefined ? '' : ` : ${d.why}`}
        </p>
      ))}
      {waiting ? (
        <div className="mw-turn-unchecked mw-help-question" role="note" data-testid="council-question">
          <p className="mw-help-question-text">{t('helpQuestionFor', { question: c.escalation.question })}</p>
          {c.escalation.summary === undefined ? undefined : <div className="mw-agent-text">{renderBrief(c.escalation.summary, { plainHeadings: true })}</div>}
          {props.onAnswer === undefined || target === undefined ? undefined : (
            <div className="mw-help-answer">
              <textarea className="mw-input" rows={2} aria-label={t('helpAnswerLabel')} value={answer} onChange={(event) => { setAnswer(event.target.value) }} />
              <button type="button" className="mw-primary" disabled={busy || answer.trim() === ''} onClick={() => { void send() }}>{t('helpAnswer')}</button>
              {error === undefined ? undefined : <p role="alert" className="mw-decide-error">{error}</p>}
            </div>
          )}
        </div>
      ) : undefined}
      <details className="mw-turn-steps" data-testid="council-steps" open={running}>
        <summary>{t('councilDetail')}</summary>
        {c.question === undefined ? undefined : <p className="mw-ctx-strong" data-testid="council-question-asked">{c.question}</p>}
        {c.framing === undefined ? undefined : (
          <div data-testid="council-framing">
            <p className="mw-ctx-strong">{t('councilFraming', { who: name(chair) })}</p>
            <div className="mw-turn-part mw-agent-text">{renderBrief(c.framing, { plainHeadings: true })}</div>
          </div>
        )}
        <ol className="mw-help-advices" data-testid="council-options">
          {c.options.map((o, i) => <li key={i}>{o}</li>)}
        </ol>
        <ul className="mw-help-advices">
          {c.positions.map((p) => {
            const critique = c.critiques.find(k => k.slot === p.slot)
            return (
              <li key={p.slot} data-testid="council-position">
                <span className="mw-ctx-strong">{t('councilPosition', { slot: p.slot, choice: choiceWords(p.choice) })}</span>
                {p.agentId === undefined ? '' : ` · ${name(p.agentId)}${p.model === undefined ? '' : ` (${p.model})`}`}
                <div className="mw-turn-part mw-agent-text">{renderBrief(p.text, { plainHeadings: true })}</div>
                {critique === undefined ? undefined : (
                  <div data-testid="council-critique">
                    <p className="mw-ctx-small">
                      <b>{t('councilCritique', { about: critique.about })}</b>
                      {' · '}
                      {/* No final choice: the position's counts, as the core does. */}
                      {critique.choice === undefined || critique.choice === p.choice ? t('councilConfirms')
                        : t('councilChanges', { n: critique.choice + 1, option: label(critique.choice) })}
                    </p>
                    <div className="mw-turn-part mw-agent-text">{renderBrief(critique.text, { plainHeadings: true })}</div>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
        {c.skipped.length === 0 ? undefined : (
          <ul className="mw-turn-notes" data-testid="council-skipped">
            {c.skipped.map((k, i) => (
              <li key={i}>{k.slot === undefined ? k.reason : t('councilSkipped', { slot: k.slot, reason: k.reason })}</li>
            ))}
          </ul>
        )}
        {c.decision?.kind === 'vote' ? (
          <p className="mw-pills" data-testid="council-tally">
            {c.options.map((o, i) => (
              <span key={i} className="mw-pill mw-pill-static" data-chosen={c.decision?.kind === 'vote' && c.decision.chosen === i ? 'true' : undefined}>
                {o} : {c.decision?.kind === 'vote' ? (c.decision.tally[i] ?? 0) : 0}
              </span>
            ))}
          </p>
        ) : c.decision?.kind === 'synthesis' ? (
          <div className="mw-turn-part mw-agent-text" data-testid="council-synthesis">{renderBrief(c.decision.text, { plainHeadings: true })}</div>
        ) : undefined}
      </details>
    </div>
  )
}
