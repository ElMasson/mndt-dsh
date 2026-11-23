/**
 * How agents answer in a channel (A1, #84 and #85): alone; « auteur puis vérificateur », one agent
 * writes and another, of a different model, checks the draft before it is published; or « en
 * parallèle puis synthèse », two to four agents answer side by side and a last one synthesises. Read here from what the core
 * serves, defensively: a value of another shape shows nothing rather than breaking the page.
 */
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ChatAgent, ChatChannel, ChatTurn, CoordinationChange } from './chat.ts'
import { euros } from './ChannelView.tsx'
import type { ChatTranslate } from './chatLocales.ts'

/** A channel's coordination, as `channel.coordination` serves it. */
export type Coordination =
  | { readonly mode: 'author-verifier'; readonly authorId: string; readonly verifierId: string }
  | {
    readonly mode: 'parallel-synthesis'
    readonly workerIds: readonly string[]
    readonly synthesizerId: string
    readonly maxEurPerTurn: number
  }

/** The budget choices of a parallel turn, in euros (the core takes (0, 5]). */
const TURN_BUDGETS = [0.5, 1, 2, 5] as const

/** One step of a coordinated turn, as `turn.steps` serves it. */
export interface TurnStep {
  readonly role: 'author' | 'verifier' | 'revision' | 'worker' | 'synthesis'
  readonly agentId: string
  /** A worker's part, the only source of the parts (#85). */
  readonly text?: string
  /** On a revision: whether the corrected text replaced the draft (false: it came back empty). */
  readonly replaced?: boolean
  readonly tokens?: number
  readonly eur?: number
  readonly verdict?: 'ok' | 'issues' | 'unreadable' | 'skipped'
  readonly notes?: readonly string[]
}


const ROLES = new Set(['author', 'verifier', 'revision', 'worker', 'synthesis'])
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

/** @param a - a count, if read. @param b - another. @returns their sum, or undefined when neither was read. */
function sumOf(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
}

/**
 * @param channel - a channel as served.
 * @returns its coordination when it is a well-formed author-verifier one, else undefined (alone).
 */
export function coordinationOf(channel: ChatChannel): Coordination | undefined {
  const raw: unknown = channel.coordination
  if (typeof raw !== 'object' || raw === null) return undefined
  const c = raw as Record<string, unknown>
  if (c.mode === 'parallel-synthesis') {
    const synthesizerId = idOf(c.synthesizerId)
    const workers: unknown = c.workerIds
    if (synthesizerId === undefined || !Array.isArray(workers) || workers.length < 2 || workers.length > 4) return undefined
    const workerIds = workers.map(idOf)
    const distinct = new Set(workerIds).size === workerIds.length
    if (workerIds.some(id => id === undefined) || !distinct || workerIds.includes(synthesizerId)) return undefined
    const max = c.maxEurPerTurn
    const maxEurPerTurn = typeof max === 'number' && Number.isFinite(max) && max > 0 && max <= 5 ? max : undefined
    if (maxEurPerTurn === undefined) return undefined
    return { mode: 'parallel-synthesis', workerIds: workerIds.filter((id): id is string => id !== undefined), synthesizerId, maxEurPerTurn }
  }
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
    // As the core serves them: { input, output } (the cache counts are inside input). A bare number,
    // as an older double served, is read too.
    const raw = s.tokens
    const tokens = typeof raw === 'number' ? amountOf(raw)
      : typeof raw === 'object' && raw !== null
        ? sumOf(amountOf((raw as Record<string, unknown>).input), amountOf((raw as Record<string, unknown>).output))
        : undefined
    const eur = amountOf(s.eur)
    const text = typeof s.text === 'string' && s.text.trim() !== '' ? s.text.slice(0, 20_000) : undefined
    steps.push({
      role: s.role as TurnStep['role'],
      agentId,
      ...(text === undefined ? {} : { text }),
      ...(typeof s.replaced === 'boolean' ? { replaced: s.replaced } : {}),
      ...(tokens === undefined ? {} : { tokens }),
      ...(eur === undefined ? {} : { eur }),
      ...(s.verdict === undefined ? {} : { verdict: s.verdict as NonNullable<TurnStep['verdict']> }),
      ...(notes.length === 0 ? {} : { notes }),
    })
  }
  return steps[0]?.role === 'author' || steps[0]?.role === 'worker' ? steps : []
}

/** @param a - an agent. @param b - another. @returns whether they run on the same model. */
function sameModel(a: ChatAgent, b: ChatAgent): boolean {
  return a.provider === b.provider && a.model === b.model
}

type Mode = 'solo' | 'author-verifier' | 'parallel-synthesis'

/**
 * The COORDINATION section of a channel's panel: « Seul », « Auteur puis vérificateur » or « En
 * parallèle puis synthèse », by pills, no drop-down. For the pair, the author then the verifier
 * (one of another model, else greyed with the reason); for the parallel turn, two to four workers,
 * the synthesiser (not a worker) and the turn's budget, then « Enregistrer ». Owners and admins
 * change it; others read it.
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
  // The mode picked here and not yet sent; otherwise the channel's.
  const [picked, setPicked] = useState<Mode | undefined>(undefined)
  const shown: Mode = picked ?? current?.mode ?? 'solo'
  const [author, setAuthor] = useState<string | undefined>(current?.mode === 'author-verifier' ? current.authorId : undefined)
  const [workers, setWorkers] = useState<readonly string[]>(current?.mode === 'parallel-synthesis' ? current.workerIds : [])
  const [synthesizer, setSynthesizer] = useState<string | undefined>(current?.mode === 'parallel-synthesis' ? current.synthesizerId : undefined)
  const [budget, setBudget] = useState<number>(current?.mode === 'parallel-synthesis' ? current.maxEurPerTurn : 1)
  const [error, setError] = useState<string | undefined>(undefined)
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const send = async (change: CoordinationChange): Promise<void> => {
    if (busy.current || props.onChange === undefined) return
    busy.current = true
    setPending(true)
    const refused = await props.onChange(change)
    setError(refused)
    if (refused === undefined) setPicked(undefined)
    busy.current = false
    setPending(false)
  }
  const handle = (id: string): string => `@${byId.get(id)?.handle ?? id}`
  if (!writable) {
    return (
      <p data-testid="coordination-read">
        {current === undefined ? t('coordSolo')
          : current.mode === 'author-verifier'
            ? t('coordPair', { author: handle(current.authorId), verifier: handle(current.verifierId) })
            : t('coordParallelRead', {
              workers: current.workerIds.map(handle).join(', '),
              synthesizer: handle(current.synthesizerId),
              max: euros(current.maxEurPerTurn),
            })}
      </p>
    )
  }
  const authorAgent = author === undefined ? undefined : byId.get(author)
  const pick = (mode: Mode): void => {
    if (pending) return
    setError(undefined)
    if (mode === 'solo') {
      if (current === undefined) setPicked(undefined)
      else void send({ mode: 'solo' })
      return
    }
    setPicked(mode === current?.mode ? undefined : mode)
  }
  const modePill = (mode: Mode, label: string, needs: number, why: string): ReactNode => {
    const short = mode !== 'solo' && here.length < needs
    return (
      <button
        type="button"
        className="mw-pill"
        aria-pressed={shown === mode}
        aria-disabled={pending || short}
        title={short ? why : undefined}
        onClick={() => { if (!short) pick(mode) }}
      >
        {label}
      </button>
    )
  }
  // The parallel turn as it would be sent, when it can be.
  const parallelReady = workers.length >= 2 && workers.length <= 4 && synthesizer !== undefined && !workers.includes(synthesizer)
  const parallelSame = current?.mode === 'parallel-synthesis' && synthesizer === current.synthesizerId && budget === current.maxEurPerTurn
    && workers.length === current.workerIds.length && workers.every((id, i) => id === current.workerIds[i])
  return (
    <div data-testid="coordination">
      <div className="mw-pills" role="group" aria-label={t('coordMode')}>
        {modePill('solo', t('coordSoloButton'), 0, '')}
        {modePill('author-verifier', t('coordPairButton'), 2, t('coordNeedsTwo'))}
        {modePill('parallel-synthesis', t('coordParallelButton'), 3, t('coordNeedsThree'))}
      </div>
      {here.length < 2 ? <p className="mw-ctx-small mw-ctx-muted">{t('coordNeedsTwo')}</p> : undefined}
      {shown !== 'author-verifier' || here.length < 2 ? undefined : (
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
                onClick={() => { if (!pending) { setAuthor(a.id); setPicked('author-verifier'); setError(undefined) } }}
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
              const why = author === undefined ? t('coordAuthorFirst') : self ? t('coordNotSelf') : twin ? t('coordSameModel') : undefined
              const chosen = picked === undefined && current?.mode === 'author-verifier' && current.verifierId === a.id && current.authorId === author
              return (
                <button
                  key={a.id}
                  type="button"
                  className="mw-pill"
                  aria-pressed={chosen}
                  aria-disabled={pairWith === undefined}
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
      {here.length === 2 ? <p className="mw-ctx-small mw-ctx-muted">{t('coordNeedsThree')}</p> : undefined}
      {shown !== 'parallel-synthesis' || here.length < 3 ? undefined : (
        <>
          <p className="mw-ctx-small mw-ctx-muted">{t('coordWorkers')}</p>
          <div className="mw-pills" role="group" aria-label={t('coordWorkers')} data-testid="coord-workers">
            {here.map((a) => {
              const on = workers.includes(a.id)
              const full = !on && workers.length >= 4
              const why = full ? t('coordFourAtMost') : undefined
              return (
                <button
                  key={a.id}
                  type="button"
                  className="mw-pill"
                  aria-pressed={on}
                  aria-disabled={pending || full}
                  aria-label={why === undefined ? `@${a.handle}` : `@${a.handle}, ${why}`}
                  title={why}
                  onClick={() => {
                    if (pending || full) return
                    setPicked('parallel-synthesis')
                    setError(undefined)
                    setWorkers(held => (on ? held.filter(id => id !== a.id) : [...held, a.id]))
                    // A worker cannot be the synthesiser too.
                    if (!on && synthesizer === a.id) setSynthesizer(undefined)
                  }}
                >
                  @{a.handle}
                </button>
              )
            })}
          </div>
          <p className="mw-ctx-small mw-ctx-muted">{t('coordSynthesizer')}</p>
          <div className="mw-pills" role="group" aria-label={t('coordSynthesizer')} data-testid="coord-synthesizer">
            {here.map((a) => {
              const worker = workers.includes(a.id)
              const why = worker ? t('coordIsWorker') : undefined
              return (
                <button
                  key={a.id}
                  type="button"
                  className="mw-pill"
                  aria-pressed={synthesizer === a.id}
                  aria-disabled={pending || worker}
                  aria-label={why === undefined ? `@${a.handle}` : `@${a.handle}, ${why}`}
                  title={why}
                  data-off={worker ? 'true' : undefined}
                  onClick={() => { if (!pending && !worker) { setSynthesizer(a.id); setPicked('parallel-synthesis'); setError(undefined) } }}
                >
                  @{a.handle}
                </button>
              )
            })}
          </div>
          <p className="mw-ctx-small mw-ctx-muted">{t('coordBudget')}</p>
          <div className="mw-pills" role="group" aria-label={t('coordBudget')} data-testid="coord-budget">
            {TURN_BUDGETS.map(value => (
              <button
                key={value}
                type="button"
                className="mw-pill"
                aria-pressed={budget === value}
                aria-disabled={pending}
                onClick={() => { if (!pending) { setBudget(value); setPicked('parallel-synthesis') } }}
              >
                {euros(value)}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="mw-primary"
            disabled={pending || !parallelReady || parallelSame}
            onClick={() => {
              if (!parallelReady) return
              void send({ mode: 'parallel-synthesis', workers, synthesizer, maxEurPerTurn: budget })
            }}
          >
            {t('coordSave')}
          </button>
        </>
      )}
      {error === undefined ? undefined : <p role="alert" className="mw-ctx-error">{error}</p>}
    </div>
  )
}

const STEP_WORDS = {
  author: 'coordStepAuthor',
  verifier: 'coordStepVerifier',
  revision: 'coordStepRevision',
  worker: 'coordStepWorker',
  synthesis: 'coordStepSynthesis',
} as const

/**
 * The steps of a coordinated turn, folded: each with its agent, verdict, cost and notes; a worker's
 * part is shown under its agent, as text. A missing part is said, with its reason.
 * @param steps - the turn's steps. @param agents - by id. @param t - the copy. @param open - unfolded.
 * @returns the folded list.
 */
function stepsList(steps: readonly TurnStep[], agents: ReadonlyMap<string, ChatAgent>, t: ChatTranslate, open: boolean): ReactNode {
  const handle = (id: string): string => `@${agents.get(id)?.handle ?? id}`
  return (
    <details className="mw-turn-steps" data-testid="turn-steps" open={open}>
      <summary>{t('coordSteps', { count: steps.length })}</summary>
      <ol>
        {steps.map((s, index) => (
          <li key={`${s.role}-${index}`} data-role={s.role}>
            <span className="mw-ctx-strong">
              {s.role === 'worker' && s.verdict === 'skipped' ? t('coordStepMissing') : t(STEP_WORDS[s.role])}
            </span>
            {' '}{handle(s.agentId)}
            {s.verdict === undefined || (s.role === 'worker' && s.verdict === 'skipped') ? '' : ` · ${t(VERDICT_WORDS[s.verdict])}`}
            {s.eur === undefined ? '' : ` · ${euros(s.eur)}`}
            {s.tokens === undefined ? '' : ` · ${t('webTokens', { n: s.tokens.toLocaleString('fr') })}`}
            {s.role === 'worker' && s.text !== undefined ? <div className="mw-turn-part" data-testid="turn-part">{s.text}</div> : undefined}
            {s.notes === undefined ? undefined : (
              <ul className="mw-turn-notes">
                {s.notes.map((note, n) => <li key={n}>{note}</li>)}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </details>
  )
}

/**
 * The folded steps of a turn that did not finish (cancelled, failed): it keeps its steps (#85).
 * @param turn - the turn. @param agents - by id. @param t - the copy.
 * @returns the steps, or undefined when it has none readable.
 */
export function turnSteps(turn: ChatTurn, agents: ReadonlyMap<string, ChatAgent>, t: ChatTranslate): ReactNode {
  const steps = stepsOf(turn)
  return steps.length === 0 ? undefined : stepsList(steps, agents, t, false)
}

/**
 * A parallel turn's line: who answered side by side, how many parts came, who synthesised, the
 * total cost. Not synthesised or no part at all is said plainly, and the parts are shown unfolded.
 */
function parallelTurn(turn: ChatTurn, steps: readonly TurnStep[], agents: ReadonlyMap<string, ChatAgent>, t: ChatTranslate): ReactNode {
  const handle = (id: string): string => `@${agents.get(id)?.handle ?? id}`
  const workers = steps.filter(s => s.role === 'worker')
  const received = workers.filter(s => s.verdict === undefined && s.text !== undefined)
  const synthesis = steps.find(s => s.role === 'synthesis')
  const synthesised = synthesis !== undefined && synthesis.verdict === undefined
  const parts = [
    t('coordParallelBy', { handles: workers.map(s => handle(s.agentId)).join(', ') }),
    received.length === workers.length ? undefined : t('coordPartsOf', { got: received.length, total: workers.length }),
    synthesised ? t('coordSynthBy', { handle: handle(synthesis.agentId) }) : undefined,
    turn.eur === undefined ? undefined : euros(turn.eur),
  ].filter((part): part is string => part !== undefined)
  return (
    <div className="mw-turn mw-turn-coord" data-testid="chat-turn" data-status="done" data-coordinated="parallel">
      <p className="mw-turn-coord-line">
        <span className="mw-chip mw-chip-strong">{t('webTurn')}</span>
        <span data-testid="chat-turn-cost">{parts.join(' · ')}</span>
      </p>
      {synthesis === undefined ? (
        <p className="mw-turn-unchecked" role="note" data-testid="turn-no-part">{t('coordNoPart')}</p>
      ) : synthesised ? undefined : (
        <p className="mw-turn-unchecked" role="note" data-testid="turn-not-synthesised">
          {t('coordNotSynthesised', { reason: synthesis.notes?.[0] ?? t('coordVerdictSkipped') })}
        </p>
      )}
      {stepsList(steps, agents, t, !synthesised)}
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
  if (steps[0]?.role === 'worker') return parallelTurn(turn, steps, agents, t)
  const author = steps.find(s => s.role === 'author')
  const verifier = steps.find(s => s.role === 'verifier')
  if (author === undefined || verifier === undefined) return undefined
  const handle = (id: string): string => `@${agents.get(id)?.handle ?? id}`
  // The states, read from the steps, never from the published text (A1, #84):
  // ok → checked; issues + a revision that replaced the draft → corrected; issues + a revision that
  // came back empty → the draft published as is; issues + a revision « skipped » (or none) →
  // reservations not corrected; a revision whose outcome is not served (an older core) → never
  // « corrigé », said as not checked; verifier skipped or unreadable → not checked.
  const revision = steps.find(s => s.role === 'revision')
  const revised = revision !== undefined && revision.verdict === undefined && revision.replaced === true
  const emptyRevision = revision !== undefined && revision.verdict === undefined && revision.replaced === false
  const unknownRevision = revision !== undefined && revision.verdict === undefined && revision.replaced === undefined
  const unchecked = (verifier.verdict !== 'ok' && verifier.verdict !== 'issues') || (verifier.verdict === 'issues' && unknownRevision)
  const uncorrected = verifier.verdict === 'issues' && !revised && !emptyRevision && !unknownRevision
  const outcome = unchecked || uncorrected ? undefined
    : revised ? t('coordRevised') : t('coordConfirmed')
  const parts = [
    t('coordWrittenBy', { handle: handle(author.agentId) }),
    unchecked ? undefined : t('coordCheckedBy', { handle: handle(verifier.agentId) }),
    emptyRevision ? t('coordIssuesLeft') : undefined,
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
        <p className="mw-turn-unchecked" role="note" data-testid="turn-unchecked">
          {unknownRevision && verifier.verdict === 'issues'
            ? t('coordRevisionUnknown')
            : t('coordUnchecked', { handle: handle(verifier.agentId) })}
        </p>
      ) : undefined}
      {emptyRevision ? (
        <p className="mw-turn-unchecked" role="note" data-testid="turn-empty-revision">
          {/* Empty or identical to the draft: the core's note says which, as text, bounded. */}
          {t('coordEmptyRevision', { handle: handle(author.agentId) })}
          {revision.notes?.[0] === undefined ? '' : ` — ${revision.notes[0].length > 200 ? `${revision.notes[0].slice(0, 200)}…` : revision.notes[0]}`}
        </p>
      ) : undefined}
      {uncorrected ? (
        <p className="mw-turn-unchecked" role="note" data-testid="turn-uncorrected">
          {revision?.verdict === 'skipped' ? t('coordUncorrectedCeiling', { handle: handle(author.agentId) }) : t('coordUncorrected', { handle: handle(author.agentId) })}
        </p>
      ) : undefined}
      {stepsList(steps, agents, t, false)}
    </div>
  )
}
