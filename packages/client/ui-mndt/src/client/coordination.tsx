/**
 * The « auteur puis vérificateur » mode (A1, #84): a channel can have one agent write and another,
 * of a different model, check the draft before it is published. Read here from what the core
 * serves, defensively: a value of another shape shows nothing rather than breaking the page.
 */
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ChatAgent, ChatChannel, ChatTurn, CoordinationChange } from './chat.ts'
import { euros } from './ChannelView.tsx'
import type { ChatTranslate } from './chatLocales.ts'

/** A channel's coordination, as `channel.coordination` serves it. */
export interface Coordination {
  readonly mode: 'author-verifier'
  readonly authorId: string
  readonly verifierId: string
}

/** One step of a coordinated turn, as `turn.steps` serves it. */
export interface TurnStep {
  readonly role: 'author' | 'verifier' | 'revision'
  readonly agentId: string
  readonly tokens?: number
  readonly eur?: number
  readonly verdict?: 'ok' | 'issues' | 'unreadable' | 'skipped'
  readonly notes?: readonly string[]
}


const ROLES = new Set(['author', 'verifier', 'revision'])
const VERDICT_WORDS = {
  ok: 'coordVerdictOk',
  issues: 'coordVerdictIssues',
  unreadable: 'coordVerdictUnreadable',
  skipped: 'coordVerdictSkipped',
} as const
const VERDICTS = new Set(['ok', 'issues', 'unreadable', 'skipped'])

/** @param value - anything. @returns it when it is a non-empty text of bounded length. */
function idOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && value.length <= 128 ? value : undefined
}

/** @param value - anything. @returns it when it is a finite, non-negative number. */
function amountOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * @param channel - a channel as served.
 * @returns its coordination when it is a well-formed author-verifier one, else undefined (alone).
 */
export function coordinationOf(channel: ChatChannel): Coordination | undefined {
  const raw: unknown = channel.coordination
  if (typeof raw !== 'object' || raw === null) return undefined
  const c = raw as Record<string, unknown>
  const authorId = idOf(c.authorId)
  const verifierId = idOf(c.verifierId)
  if (c.mode !== 'author-verifier' || authorId === undefined || verifierId === undefined || authorId === verifierId) return undefined
  return { mode: 'author-verifier', authorId, verifierId }
}

/**
 * @param turn - a turn as served.
 * @returns its steps, only when every one is well-formed and an author step leads; else none.
 */
export function stepsOf(turn: ChatTurn): readonly TurnStep[] {
  const raw: unknown = turn.steps
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8) return []
  const steps: TurnStep[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return []
    const s = item as Record<string, unknown>
    const agentId = idOf(s.agentId)
    if (typeof s.role !== 'string' || !ROLES.has(s.role) || agentId === undefined) return []
    if (s.verdict !== undefined && (typeof s.verdict !== 'string' || !VERDICTS.has(s.verdict))) return []
    const notes = Array.isArray(s.notes) ? s.notes.filter((n): n is string => typeof n === 'string' && n.trim() !== '').map(n => n.slice(0, 2000)) : []
    const tokens = amountOf(s.tokens)
    const eur = amountOf(s.eur)
    steps.push({
      role: s.role as TurnStep['role'],
      agentId,
      ...(tokens === undefined ? {} : { tokens }),
      ...(eur === undefined ? {} : { eur }),
      ...(s.verdict === undefined ? {} : { verdict: s.verdict as NonNullable<TurnStep['verdict']> }),
      ...(notes.length === 0 ? {} : { notes }),
    })
  }
  return steps[0]?.role === 'author' ? steps : []
}

/** @param a - an agent. @param b - another. @returns whether they run on the same model. */
function sameModel(a: ChatAgent, b: ChatAgent): boolean {
  return a.provider === b.provider && a.model === b.model
}

/**
 * The COORDINATION section of a channel's panel: « Seul » or « Auteur puis vérificateur »; in the
 * second, the author then the verifier are chosen among the channel's agents, by pills. A verifier
 * on the author's model is greyed, with the reason. Owners and admins change it; others read it.
 */
export function CoordinationSection(props: {
  readonly channel: ChatChannel
  readonly agents: readonly ChatAgent[]
  readonly canManage: boolean
  readonly onChange?: ((change: CoordinationChange) => Promise<string | undefined>) | undefined
  readonly t: ChatTranslate
}): ReactNode {
  const { channel, t } = props
  const current = coordinationOf(channel)
  const here = props.agents.filter(a => channel.agents.includes(a.id) && a.retiredAt === undefined)
  const byId = new Map(props.agents.map(a => [a.id, a]))
  const writable = props.canManage && props.onChange !== undefined
  // The pair being chosen: opens on the channel's, or on nothing when « Auteur puis vérificateur » is picked.
  const [drafting, setDrafting] = useState(false)
  const [author, setAuthor] = useState<string | undefined>(current?.authorId)
  const [error, setError] = useState<string | undefined>(undefined)
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const send = async (change: CoordinationChange): Promise<void> => {
    if (busy.current || props.onChange === undefined) return
    busy.current = true
    setPending(true)
    const refused = await props.onChange(change)
    setError(refused)
    if (refused === undefined) setDrafting(false)
    busy.current = false
    setPending(false)
  }
  const paired = current !== undefined || drafting
  const handle = (id: string): string => `@${byId.get(id)?.handle ?? id}`
  if (!writable) {
    return (
      <p data-testid="coordination-read">
        {current === undefined ? t('coordSolo') : t('coordPair', { author: handle(current.authorId), verifier: handle(current.verifierId) })}
      </p>
    )
  }
  const authorAgent = author === undefined ? undefined : byId.get(author)
  return (
    <div data-testid="coordination">
      <div className="mw-pills" role="group" aria-label={t('coordMode')}>
        <button
          type="button"
          className="mw-pill"
          aria-pressed={!paired}
          aria-disabled={pending}
          onClick={() => {
            if (pending) return
            if (current === undefined) { setDrafting(false); return }
            void send({ mode: 'solo' })
          }}
        >
          {t('coordSoloButton')}
        </button>
        <button
          type="button"
          className="mw-pill"
          aria-pressed={paired}
          aria-disabled={pending || here.length < 2}
          title={here.length < 2 ? t('coordNeedsTwo') : undefined}
          onClick={() => { if (!pending && here.length >= 2) { setDrafting(true); setError(undefined) } }}
        >
          {t('coordPairButton')}
        </button>
      </div>
      {here.length < 2 ? <p className="mw-ctx-small mw-ctx-muted">{t('coordNeedsTwo')}</p> : undefined}
      {!paired || here.length < 2 ? undefined : (
        <>
          <p className="mw-ctx-small mw-ctx-muted">{t('coordAuthor')}</p>
          <div className="mw-pills" role="group" aria-label={t('coordAuthor')} data-testid="coord-author">
            {here.map(a => (
              <button
                key={a.id}
                type="button"
                className="mw-pill"
                aria-pressed={author === a.id}
                aria-disabled={pending}
                onClick={() => { if (!pending) { setAuthor(a.id); setDrafting(true); setError(undefined) } }}
              >
                @{a.handle}
              </button>
            ))}
          </div>
          <p className="mw-ctx-small mw-ctx-muted">{t('coordVerifier')}</p>
          <div className="mw-pills" role="group" aria-label={t('coordVerifier')} data-testid="coord-verifier">
            {here.map((a) => {
              const self = a.id === author
              const twin = authorAgent !== undefined && !self && sameModel(a, authorAgent)
              // The author this pill pairs with, when one click may send the pair.
              const pairWith = pending || self || twin ? undefined : author
              const inert = pairWith === undefined
              const why = author === undefined ? t('coordAuthorFirst') : self ? t('coordNotSelf') : twin ? t('coordSameModel') : undefined
              const chosen = !drafting && current?.verifierId === a.id && current.authorId === author
              return (
                <button
                  key={a.id}
                  type="button"
                  className="mw-pill"
                  aria-pressed={chosen}
                  aria-disabled={inert}
                  aria-label={why === undefined ? `@${a.handle}` : `@${a.handle}, ${why}`}
                  title={why}
                  data-off={twin || self ? 'true' : undefined}
                  onClick={() => {
                    if (pairWith === undefined) return
                    void send({ mode: 'author-verifier', author: pairWith, verifier: a.id })
                  }}
                >
                  @{a.handle}
                  {twin ? <span className="mw-pill-note" aria-hidden="true">{t('coordSameModelShort')}</span> : undefined}
                </button>
              )
            })}
          </div>
        </>
      )}
      {error === undefined ? undefined : <p role="alert" className="mw-ctx-error">{error}</p>}
    </div>
  )
}

/**
 * The agent-turn line of a coordinated turn: who wrote, who checked, what came of it, the total
 * cost; the steps folded below. An impossible check is said plainly, never shown as checked.
 * @param turn - a finished turn. @param agents - the agents by id. @param t - the copy.
 * @returns the line, or undefined when the turn is not coordinated or its steps are unreadable.
 */
export function coordinatedTurn(turn: ChatTurn, agents: ReadonlyMap<string, ChatAgent>, t: ChatTranslate): ReactNode {
  const steps = stepsOf(turn)
  const author = steps.find(s => s.role === 'author')
  const verifier = steps.find(s => s.role === 'verifier')
  if (author === undefined || verifier === undefined) return undefined
  const handle = (id: string): string => `@${agents.get(id)?.handle ?? id}`
  // The four states, read from the steps, never from the published text (A1, #84):
  // ok → checked; issues + revision without verdict → corrected; issues + revision « skipped » (or no
  // revision at all) → reservations not corrected; verifier skipped or unreadable → not checked.
  const revision = steps.find(s => s.role === 'revision')
  const revised = revision !== undefined && revision.verdict === undefined
  const unchecked = verifier.verdict !== 'ok' && verifier.verdict !== 'issues'
  const uncorrected = verifier.verdict === 'issues' && !revised
  const outcome = unchecked || uncorrected ? undefined
    : revised ? t('coordRevised') : t('coordConfirmed')
  const parts = [
    t('coordWrittenBy', { handle: handle(author.agentId) }),
    unchecked ? undefined : t('coordCheckedBy', { handle: handle(verifier.agentId) }),
    outcome,
    turn.eur === undefined ? undefined : euros(turn.eur),
  ].filter((part): part is string => part !== undefined)
  return (
    <div className="mw-turn mw-turn-coord" data-testid="chat-turn" data-status="done" data-coordinated="true">
      <p className="mw-turn-coord-line">
        <span className="mw-chip mw-chip-strong">{t('webTurn')}</span>
        <span data-testid="chat-turn-cost">{parts.join(' · ')}</span>
      </p>
      {unchecked ? (
        <p className="mw-turn-unchecked" role="note" data-testid="turn-unchecked">{t('coordUnchecked', { handle: handle(verifier.agentId) })}</p>
      ) : undefined}
      {uncorrected ? (
        <p className="mw-turn-unchecked" role="note" data-testid="turn-uncorrected">
          {revision?.verdict === 'skipped' ? t('coordUncorrectedCeiling', { handle: handle(author.agentId) }) : t('coordUncorrected', { handle: handle(author.agentId) })}
        </p>
      ) : undefined}
      <details className="mw-turn-steps" data-testid="turn-steps">
        <summary>{t('coordSteps', { count: steps.length })}</summary>
        <ol>
          {steps.map((s, index) => (
            <li key={`${s.role}-${index}`}>
              <span className="mw-ctx-strong">{t(s.role === 'author' ? 'coordStepAuthor' : s.role === 'verifier' ? 'coordStepVerifier' : 'coordStepRevision')}</span>
              {' '}{handle(s.agentId)}
              {s.verdict === undefined ? '' : ` · ${t(VERDICT_WORDS[s.verdict])}`}
              {s.eur === undefined ? '' : ` · ${euros(s.eur)}`}
              {s.tokens === undefined ? '' : ` · ${t('webTokens', { n: s.tokens.toLocaleString('fr') })}`}
              {s.notes === undefined ? undefined : (
                <ul className="mw-turn-notes">
                  {s.notes.map((note, n) => <li key={n}>{note}</li>)}
                </ul>
              )}
            </li>
          ))}
        </ol>
      </details>
    </div>
  )
}
