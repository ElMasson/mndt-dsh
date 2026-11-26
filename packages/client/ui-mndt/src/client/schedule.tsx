/**
 * Scheduled tasks (lane B, on A1's names): the card an agent leaves to propose one
 * (`propose_schedule`), read defensively. Its title and instructions are a model's text; its
 * cadence is a structure, said in words here (a technical format, not a judgement); its next runs
 * are the host's, shown in the instance's time zone so « à 08:00 » and the runs agree.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ChatRefusal } from './chat.ts'
import type { ChatAgent, ChatFace } from './chat.ts'
import type { ChatTranslate } from './chatLocales.ts'
import { euros, pageLanguage } from './format.ts'
import { renderBrief } from './markdown.tsx'
import { endWordOf } from './turnReason.ts'

/** A cadence as the core serves it. */
export type Cadence =
  | { readonly every: 'day'; readonly at: string }
  | { readonly every: 'week'; readonly days: readonly number[]; readonly at: string }
  | { readonly every: 'month'; readonly monthDay: number; readonly at: string }
  | { readonly cron: string }

/** Where a task's result is published. */
export type Destination = { readonly kind: 'channel'; readonly channelId: string } | { readonly kind: 'lane'; readonly member: string }

/** A proposed task as the page reads it. */
export interface ScheduleProposal {
  readonly title: string
  readonly instructions: string
  readonly cadence: Cadence
  readonly agentId: string
  readonly destination: Destination
  readonly eurPerRun: number
  readonly nextRuns: readonly string[]
  readonly timeZone?: string
  /** The month's bound, when the host serves it on the card. */
  readonly eurPerMonthMax?: number
}

const AT = /^(?:[01]\d|2[0-3]):[0-5]\d$/u

/** @param raw - a served cadence. @returns it, or undefined when it is not one of the four forms. */
export function cadenceOf(raw: unknown): Cadence | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const c = raw as Record<string, unknown>
  if (typeof c.cron === 'string' && c.cron.trim() !== '') return { cron: c.cron }
  const at = typeof c.at === 'string' && AT.test(c.at) ? c.at : undefined
  if (at === undefined) return undefined
  if (c.every === 'day') return { every: 'day', at }
  if (c.every === 'week' && Array.isArray(c.days)) {
    const days = c.days.filter((d): d is number => Number.isInteger(d) && (d as number) >= 1 && (d as number) <= 7)
    return days.length === 0 || days.length !== c.days.length ? undefined : { every: 'week', days: [...new Set(days)].sort(), at }
  }
  if (c.every === 'month' && Number.isInteger(c.monthDay) && (c.monthDay as number) >= 1 && (c.monthDay as number) <= 28) {
    return { every: 'month', monthDay: c.monthDay as number, at }
  }
  return undefined
}

/** @param raw - a served destination. @returns it, or undefined. */
function destinationOf(raw: unknown): Destination | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const d = raw as Record<string, unknown>
  if (d.kind === 'channel' && typeof d.channelId === 'string' && d.channelId !== '') return { kind: 'channel', channelId: d.channelId }
  if (d.kind === 'lane' && typeof d.member === 'string' && d.member !== '') return { kind: 'lane', member: d.member }
  return undefined
}

/** @param raw - instants as served. @returns the valid ISO instants, three at most. */
export function runsOf(raw: unknown): readonly string[] {
  return Array.isArray(raw) ? raw.filter((r): r is string => typeof r === 'string' && !Number.isNaN(Date.parse(r))).slice(0, 3) : []
}

/** @param raw - a served time zone. @returns it when the browser knows it, else undefined. */
export function zoneOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined
  try {
    new Intl.DateTimeFormat('fr', { timeZone: raw })
    return raw
  } catch {
    return undefined
  }
}

/**
 * The proposal a `propose_schedule` card carries, read field by field: any unreadable field makes it
 * unreadable, and an unreadable proposal is never validated blind.
 * @param card - a card as served. @returns the proposal, or undefined.
 */
export function scheduleProposalOf(card: { readonly kind: string }): ScheduleProposal | undefined {
  if (card.kind !== 'propose_schedule') return undefined
  const top = card as unknown as Record<string, unknown>
  // The core serves it as `scheduleProposal` (#161, api.ts), exactly what approval creates.
  const s = top.scheduleProposal
  if (typeof s !== 'object' || s === null) return undefined
  const f = s as Record<string, unknown>
  const cadence = cadenceOf(f.cadence)
  const destination = destinationOf(f.destination)
  const eur = f.eurPerRun
  if (typeof f.title !== 'string' || f.title.trim() === '' || typeof f.instructions !== 'string' || cadence === undefined
    || typeof f.agentId !== 'string' || f.agentId === '' || destination === undefined
    || typeof eur !== 'number' || !Number.isFinite(eur) || eur <= 0) return undefined
  const timeZone = zoneOf(top.timeZone)
  const month = top.eurPerMonthMax
  return {
    title: f.title.trim(), instructions: f.instructions, cadence, agentId: f.agentId, destination, eurPerRun: eur,
    nextRuns: runsOf(top.nextRuns), ...(timeZone === undefined ? {} : { timeZone }),
    ...(typeof month === 'number' && Number.isFinite(month) && month >= 0 ? { eurPerMonthMax: month } : {}),
  }
}

/** @param cadence - a cadence. @param t - the copy. @returns it in words. */
export function cadenceWords(cadence: Cadence, t: ChatTranslate): string {
  if ('cron' in cadence) return t('scheduleCustom')
  if (cadence.every === 'day') return t('scheduleDaily', { at: cadence.at })
  if (cadence.every === 'month') return t(cadence.monthDay === 1 ? 'scheduleMonthlyFirst' : 'scheduleMonthly', { day: cadence.monthDay, at: cadence.at })
  const days = cadence.days
  if (days.length === 5 && [1, 2, 3, 4, 5].every(d => days.includes(d))) return t('scheduleWeekdays', { at: cadence.at })
  if (days.length === 7) return t('scheduleDaily', { at: cadence.at })
  // Day names from the page's language: 2026-11-30 is a Monday (1), each day after it.
  const name = (d: number): string => new Intl.DateTimeFormat(pageLanguage() ?? 'fr', { weekday: 'long', timeZone: 'UTC' })
    .format(new Date(Date.UTC(2026, 10, 29 + d)))
  const names = days.map(name)
  const list = names.length === 1 ? names[0] ?? '' : `${names.slice(0, -1).join(', ')} ${t('scheduleAnd')} ${names[names.length - 1] ?? ''}`
  return t('scheduleWeekly', { days: list, at: cadence.at })
}

/** @param iso - an instant. @param zone - the instance's time zone. @returns it, in that zone and the page's language. */
export function runTime(iso: string, zone: string | undefined): string {
  return new Intl.DateTimeFormat(pageLanguage() ?? 'fr', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(zone === undefined ? {} : { timeZone: zone }),
  }).format(new Date(iso))
}

/** The whole proposal, read-only, so one click validates what was read. */
export function ScheduleSheet(props: {
  readonly proposal: ScheduleProposal
  readonly agentHandle?: string | undefined
  readonly where: string
  readonly t: ChatTranslate
}): ReactNode {
  const { proposal: p, t } = props
  return (
    <div className="mw-context" data-testid="schedule-proposal">
      <p className="mw-ctx-small" data-testid="schedule-title">{p.title}</p>
      <dl className="mw-sheet-view">
        <dt>{t('scheduleWhen')}</dt>
        <dd data-testid="schedule-cadence">{cadenceWords(p.cadence, t)}</dd>
        {p.nextRuns.length === 0 ? undefined : (
          <>
            <dt>{t('scheduleNext')}</dt>
            <dd data-testid="schedule-runs">{p.nextRuns.map(r => runTime(r, p.timeZone)).join(' · ')}</dd>
          </>
        )}
        <dt>{t('scheduleWho')}</dt>
        <dd data-testid="schedule-agent">{props.agentHandle === undefined ? t('scheduleAgentUnknown') : `@${props.agentHandle}`}</dd>
        <dt>{t('scheduleWhere')}</dt>
        <dd data-testid="schedule-where">{props.where}</dd>
        <dt>{t('scheduleCost')}</dt>
        <dd data-testid="schedule-cost">
          {t('schedulePerRun', { eur: euros(p.eurPerRun) })}
          {p.eurPerMonthMax === undefined ? '' : ` · ${t('schedulePerMonth', { eur: euros(p.eurPerMonthMax) })}`}
        </dd>
      </dl>
      <details className="mw-turn-steps" data-testid="schedule-instructions">
        <summary>{t('scheduleInstructions')}</summary>
        <div className="mw-agent-text">{renderBrief(p.instructions, { plainHeadings: true })}</div>
      </details>
    </div>
  )
}

/** A task as the page reads it (`GET /schedules`). */
export interface ScheduleRow {
  readonly id: string
  readonly title: string
  readonly cadence?: Cadence
  readonly agentId: string
  readonly state: 'active' | 'paused'
  /** A run is under way (#169): said « en cours ». */
  readonly running: boolean
  readonly pausedBecause?: 'failures' | 'agent-retired' | 'agent-left' | 'requester-left' | 'owner'
  readonly nextRuns: readonly string[]
  readonly timeZone?: string
  readonly lastRunAt?: string
  readonly lastStatus?: 'done' | 'failed' | 'refused'
  readonly lastReasonKind?: string
  readonly lastEur?: number
  readonly eurThisMonth?: number
  readonly eurPerMonthMax?: number
  readonly missed: number
  readonly can: { readonly pause: boolean; readonly resume: boolean; readonly delete: boolean }
}

const PAUSED = ['failures', 'agent-retired', 'agent-left', 'requester-left', 'owner'] as const

/** @param n - a served amount. @returns it when finite and not negative. */
function eurOf(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
}

/**
 * One served task, read defensively. A gesture is offered only when `can` says so in so many words:
 * anything else leaves it hidden. A row without an id, a title or a known state is dropped.
 * @param raw - a served row. @returns it, or undefined.
 */
export function scheduleRowOf(raw: unknown): ScheduleRow | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id === '' || typeof r.title !== 'string' || r.title.trim() === '') return undefined
  if (r.state !== 'active' && r.state !== 'paused') return undefined
  const can = typeof r.can === 'object' && r.can !== null ? r.can as Record<string, unknown> : {}
  const cadence = cadenceOf(r.cadence)
  const timeZone = zoneOf(r.timeZone)
  const lastEur = eurOf(r.lastEur)
  const eurThisMonth = eurOf(r.eurThisMonth)
  const eurPerMonthMax = eurOf(r.eurPerMonthMax)
  return {
    id: r.id, title: r.title.trim(), agentId: typeof r.agentId === 'string' ? r.agentId : '', state: r.state,
    ...(cadence === undefined ? {} : { cadence }),
    ...(r.state === 'paused' && PAUSED.includes(r.pausedBecause as never) ? { pausedBecause: r.pausedBecause as NonNullable<ScheduleRow['pausedBecause']> } : {}),
    nextRuns: runsOf(r.nextRuns),
    ...(timeZone === undefined ? {} : { timeZone }),
    ...(typeof r.lastRunAt === 'string' && !Number.isNaN(Date.parse(r.lastRunAt)) ? { lastRunAt: r.lastRunAt } : {}),
    ...(lastEur === undefined ? {} : { lastEur }),
    ...(r.lastStatus === 'done' || r.lastStatus === 'failed' || r.lastStatus === 'refused' ? { lastStatus: r.lastStatus } : {}),
    ...(typeof r.lastReasonKind === 'string' && r.lastReasonKind !== '' ? { lastReasonKind: r.lastReasonKind } : {}),
    ...(eurThisMonth === undefined ? {} : { eurThisMonth }),
    ...(eurPerMonthMax === undefined ? {} : { eurPerMonthMax }),
    missed: Number.isInteger(r.missed) && (r.missed as number) > 0 ? r.missed as number : 0,
    running: r.running === true,
    can: { pause: can.pause === true, resume: can.resume === true, delete: can.delete === true },
  }
}

/**
 * @param failure - a refused gesture or a failed read. @param t - the copy.
 * @returns a fixed sentence by code; anything else (another refusal, a network error) the generic one.
 * Never the served or thrown message: it may carry a detail the reader has no use for.
 */
function scheduleRefusal(failure: unknown, t: ChatTranslate): string {
  if (failure instanceof ChatRefusal) {
    if (failure.code === 'not-allowed') return t('scheduleNotAllowed')
    if (failure.status === 404) return t('scheduleGone')
  }
  return t('scheduleUnavailable')
}

export type ScheduleFace = Pick<ChatFace, 'schedules' | 'pauseSchedule' | 'resumeSchedule' | 'deleteSchedule'>

/**
 * The tasks a channel receives, or an agent runs: one line each, its state, its next run, its cost,
 * and the gestures the host allows this reader. Nothing is shown when there is none.
 */
export function ScheduleList(props: {
  readonly face: ScheduleFace
  readonly query: { readonly channelId: string } | { readonly agentId: string }
  readonly agents: readonly ChatAgent[]
  readonly t: ChatTranslate
}): ReactNode {
  const { face, t } = props
  const [rows, setRows] = useState<readonly ScheduleRow[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [confirming, setConfirming] = useState<string | undefined>(undefined)
  const key = 'channelId' in props.query ? `c:${props.query.channelId}` : `a:${props.query.agentId}`
  const load = useCallback(async (): Promise<void> => {
    if (face.schedules === undefined) return
    try {
      const served = await face.schedules(props.query)
      setRows(served.map(scheduleRowOf).filter((r): r is ScheduleRow => r !== undefined))
      setError(undefined)
    } catch (failure) {
      // A core without the route (before #161) serves no list: nothing to show, not an error.
      if (failure instanceof ChatRefusal && failure.status === 404) {
        setRows([])
        return
      }
      setError(scheduleRefusal(failure, t))
    }
  }, [face, key, t])
  useEffect(() => { void load() }, [load])
  const act = async (id: string, gesture: (() => Promise<void>) | undefined): Promise<void> => {
    if (gesture === undefined) return
    setBusy(id)
    setError(undefined)
    try {
      await gesture()
    } catch (failure) {
      setError(scheduleRefusal(failure, t))
    }
    setConfirming(undefined)
    await load()
    setBusy(undefined)
  }
  if (rows === undefined && error === undefined) return undefined
  if (rows !== undefined && rows.length === 0 && error === undefined) return undefined
  return (
    // A section of its own, so that no title shows over an empty list.
    <section className="mw-ctx-section" aria-label={t('ctxTasks')} data-testid="schedule-list">
      <h3 className="mw-ctx-title">{t('ctxTasks')}</h3>
      {(rows ?? []).map((r) => {
        const agent = props.agents.find(a => a.id === r.agentId)
        return (
          <div key={r.id} className="mw-ctx-row" data-testid="schedule-row" data-state={r.state}>
            <p className="mw-ctx-small">
              <span className="mw-ctx-strong">{r.title}</span>
              {r.cadence === undefined ? '' : ` · ${cadenceWords(r.cadence, t)}`}
              {agent === undefined ? '' : ` · @${agent.handle}`}
              <span className="mw-chip" data-testid="schedule-state">{t(r.state === 'active' ? 'scheduleActive' : 'schedulePaused')}</span>
              {r.running ? <span className="mw-chip mw-chip-strong" data-testid="schedule-running">{t('scheduleRunning')}</span> : undefined}
            </p>
            <p className="mw-ctx-small mw-ctx-muted">
              {r.nextRuns[0] === undefined || r.state === 'paused' ? '' : t('scheduleNextOne', { at: runTime(r.nextRuns[0], r.timeZone) })}
              {r.lastRunAt === undefined ? '' : ` · ${t('scheduleLast', { at: runTime(r.lastRunAt, r.timeZone) })}${r.lastEur === undefined ? '' : `, ${euros(r.lastEur)}`}`}
              {r.lastStatus === 'done' ? ` · ${t('scheduleLastDone')}` : ''}
              {/* Refused before any call (the agent's month ceiling, or a model with no price): not a
                  failure, nothing is published, so the task is where it is said; it starts again next month. */}
              {r.lastStatus === 'refused' ? ` · ${t('scheduleLastRefused')}` : ''}
              {/* A restart interrupted the run; it is not a failure (#169): said as what it is. */}
              {r.lastStatus !== 'failed' ? '' : r.lastReasonKind === 'restart' ? ` · ${t('endRestart')}`
                : ` · ${t('scheduleLastFailed', { reason: endWordOf(r.lastReasonKind, t) ?? t('endError') })}`}
              {r.eurThisMonth === undefined ? '' : ` · ${t('scheduleMonth', { eur: euros(r.eurThisMonth) })}`}
              {r.eurPerMonthMax === undefined ? '' : ` ${t('scheduleMonthMax', { eur: euros(r.eurPerMonthMax) })}`}
            </p>
            {r.pausedBecause === undefined || r.pausedBecause === 'owner' ? undefined : (
              <p className="mw-ctx-small mw-ctx-muted" data-testid="schedule-paused-because">{t(`schedulePaused_${r.pausedBecause}`)}</p>
            )}
            {r.missed === 0 ? undefined : (
              <p className="mw-ctx-small mw-ctx-muted" data-testid="schedule-missed">{t(r.missed === 1 ? 'scheduleMissedOne' : 'scheduleMissedMany', { n: r.missed })}</p>
            )}
            <div className="mw-ctx-actions">
              {r.state === 'active' && r.can.pause ? (
                <button type="button" className="mw-secondary" disabled={busy === r.id} onClick={() => { void act(r.id, face.pauseSchedule === undefined ? undefined : () => face.pauseSchedule?.(r.id) ?? Promise.resolve()) }}>{t('schedulePause')}</button>
              ) : undefined}
              {r.state === 'paused' && r.can.resume ? (
                <button type="button" className="mw-secondary" disabled={busy === r.id} onClick={() => { void act(r.id, face.resumeSchedule === undefined ? undefined : () => face.resumeSchedule?.(r.id) ?? Promise.resolve()) }}>{t('scheduleResume')}</button>
              ) : undefined}
              {!r.can.delete ? undefined : confirming === r.id ? (
                <>
                  <button type="button" className="mw-text-button" data-tone="danger" disabled={busy === r.id} onClick={() => { void act(r.id, face.deleteSchedule === undefined ? undefined : () => face.deleteSchedule?.(r.id) ?? Promise.resolve()) }}>{t('scheduleDeleteConfirm')}</button>
                  <button type="button" className="mw-text-button" onClick={() => { setConfirming(undefined) }}>{t('cancel')}</button>
                </>
              ) : (
                <button type="button" className="mw-text-button" onClick={() => { setConfirming(r.id) }}>{t('scheduleDelete')}</button>
              )}
            </div>
          </div>
        )
      })}
      {error === undefined ? undefined : <p role="alert" className="mw-ctx-error">{error}</p>}
    </section>
  )
}
