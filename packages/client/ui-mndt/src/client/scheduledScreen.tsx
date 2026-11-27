/**
 * « Tâches planifiées », the owner's place in the team navigation (Stéphane, 26/11: the scheduled
 * missions were only reachable through Réglages → Automatisations, and none could be run by hand).
 * One list of the workspace's automations, each with its hour in words, its last run, its state,
 * and three gestures: run now (1 click), suspend, activate. A run's result reaches the owner's
 * lane, whatever its kind (#166): it is linked there.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ChatTranslate } from './chatLocales.ts'
import type { AutomationRow, MissionRow, MndtFace } from './face.ts'
import { when } from './format.ts'
import { cadenceWords, runTime } from './schedule.tsx'

const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/u

/** @param row - an automation. @returns its days in words, without the hour (days: 0 is Sunday on an automation). */
function automationDays(row: AutomationRow, t: ChatTranslate): string {
  const days = (row.days ?? []).filter(d => Number.isInteger(d) && d >= 0 && d <= 6).map(d => (d === 0 ? 7 : d))
  const words = days.length === 0 || days.length === 7
    ? cadenceWords({ every: 'day', at: '00:00' }, t)
    : cadenceWords({ every: 'week', days: [...new Set(days)].sort(), at: '00:00' }, t)
  // The cadence's words end with « à 00:00 »: the hour is shown apart, where it is changed.
  return words.replace(/\s\S+\s00:00$/u, '')
}

/** @param zone - the scheduler's zone, when served. @param t - the copy. @returns which hour it is. */
function zoneWords(zone: string | undefined, t: ChatTranslate): string {
  if (zone === 'Indian/Reunion') return t('scheduledZoneReunion')
  return zone === undefined ? t('scheduledZoneInstance') : t('scheduledZoneNamed', { zone })
}

/** @param row - an automation. @returns its hour in words (days: 0 is Sunday on an automation). */
function automationWhen(row: AutomationRow, t: ChatTranslate): string {
  if (!CLOCK.test(row.at)) return row.at
  const days = (row.days ?? []).filter(d => Number.isInteger(d) && d >= 0 && d <= 6).map(d => (d === 0 ? 7 : d))
  return days.length === 0 || days.length === 7
    ? cadenceWords({ every: 'day', at: row.at }, t)
    : cadenceWords({ every: 'week', days: [...new Set(days)].sort(), at: row.at }, t)
}

/**
 * @param row - an automation. @returns when it last ran: lastRunAt (a manual run included) when served,
 * else lastFiredDate; undefined when neither is.
 */
function lastRunOf(row: AutomationRow): string | undefined {
  if (row.lastRunAt !== undefined && !Number.isNaN(Date.parse(row.lastRunAt))) return when(row.lastRunAt)
  return row.lastFiredDate
}

/** What a row says after a gesture. */
type Said = { readonly id: string; readonly ran: true } | { readonly id: string; readonly error: string }

/** @param props - the face, the copy and how to open the owner's lane. @returns the screen. */
export function ScheduledScreen(props: {
  readonly api: Pick<MndtFace, 'automations' | 'toggleAutomation' | 'runAutomationNow' | 'saveAutomation'> & Partial<Pick<MndtFace, 'retryMission' | 'cancelMission'>>
  /**
   * The owner's missions (the page state): its scheduled runs and the missions run by hand, newest
   * first, under « Derniers passages », with Relancer and Annuler (moved from the old team feed).
   */
  readonly missions?: readonly MissionRow[] | undefined
  /** Read the page state again after a mission gesture. */
  readonly onMissionsChanged?: (() => void) | undefined
  readonly onLane: () => void
  readonly title: string
  readonly t: ChatTranslate
}): ReactNode {
  const { api, t } = props
  const [rows, setRows] = useState<readonly AutomationRow[] | undefined>(undefined)
  const [zone, setZone] = useState<string | undefined>(undefined)
  // How long the scheduler has been silent, on the server's clock alone; undefined when unknown.
  const [silentFor, setSilentFor] = useState<number | undefined>(undefined)
  const [schedulerAt, setSchedulerAt] = useState<string | undefined>(undefined)
  // The line whose hour is being changed in place, and the hour typed.
  const [editing, setEditing] = useState<{ readonly id: string; readonly at: string } | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [said, setSaid] = useState<Said | undefined>(undefined)
  // One gesture at a time: a second click before the first answer does nothing (a ref, set at once).
  const inFlight = useRef(false)
  const load = useCallback(async (): Promise<void> => {
    try {
      const answer = await api.automations()
      setRows(answer.items)
      setZone(typeof answer.timeZone === 'string' && answer.timeZone !== '' ? answer.timeZone : undefined)
      const last = typeof answer.schedulerAt === 'string' ? Date.parse(answer.schedulerAt) : Number.NaN
      const server = typeof answer.serverAt === 'string' ? Date.parse(answer.serverAt) : Number.NaN
      // Both instants come from the server: a browser clock off by minutes changes nothing. Either
      // unreadable or missing, the age is unknown and nothing is said.
      setSchedulerAt(Number.isNaN(last) ? undefined : answer.schedulerAt)
      setSilentFor(Number.isNaN(last) || Number.isNaN(server) ? undefined : server - last)
      setFailed(false)
    } catch {
      // Not the thrown text: a fixed sentence (an owner-only 404 or a network error alike).
      setFailed(true)
    }
  }, [api])
  useEffect(() => { void load() }, [load])
  /** @param row - the line. @param gesture - what to do. Runs it alone, and always frees the line. */
  const once = async (row: AutomationRow, gesture: () => Promise<void>): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(row.id)
    setSaid(undefined)
    try {
      await gesture()
      await load()
    } finally {
      inFlight.current = false
      setBusy(undefined)
    }
  }
  const run = (row: AutomationRow): Promise<void> => once(row, async () => {
    try {
      const outcome = await api.runAutomationNow(row.id)
      // A 200 can still say it failed (« failed: … »): a fixed sentence, never the rest of the text.
      const failed = !outcome.ok || (outcome.value?.outcome ?? '').startsWith('failed')
      setSaid(failed
        ? { id: row.id, error: t(outcome.ok ? 'scheduledRunFailed' : 'scheduledRunRefused') }
        // #166: every automation of the owner publishes its result in their lane.
        : { id: row.id, ran: true })
    } catch {
      setSaid({ id: row.id, error: t('scheduledRunRefused') })
    }
  })
  /** A new hour, sent only as HH:MM: the core turns any other value into 07:30 without a word. */
  const saveHour = (row: AutomationRow, at: string): Promise<void> => once(row, async () => {
    setEditing(undefined)
    if (at === row.at) return
    if (!CLOCK.test(at)) {
      setSaid({ id: row.id, error: t('scheduledHourInvalid') })
      return
    }
    try {
      const outcome = await api.saveAutomation({ id: row.id, at })
      if (!outcome.ok) setSaid({ id: row.id, error: t(outcome.code === 'bad-time' ? 'scheduledHourInvalid' : 'scheduledHourRefused') })
    } catch {
      setSaid({ id: row.id, error: t('scheduledHourRefused') })
    }
  })
  const toggle = (row: AutomationRow): Promise<void> => once(row, async () => {
    try {
      const outcome = await api.toggleAutomation(row.id, !row.enabled)
      if (!outcome.ok) setSaid({ id: row.id, error: t('scheduledToggleRefused') })
    } catch {
      setSaid({ id: row.id, error: t('scheduledToggleRefused') })
    }
  })
  return (
    <section className="mw-screen" data-testid="team-scheduled">
      <h1 className="mw-title">{props.title}</h1>
      {failed ? <p className="mw-empty" role="alert">{t('scheduledUnreadable')}</p> : undefined}
      {/* A scheduler silent for over 2 minutes is said, with its last sign of life; no field, no alarm. */}
      {schedulerAt === undefined || silentFor === undefined || silentFor <= 120_000 ? undefined : (
        <p className="mw-decide-error" role="alert" data-testid="scheduler-stopped">
          {t('scheduledSchedulerStopped', { at: runTime(schedulerAt, zone) })}
        </p>
      )}
      {rows === undefined && !failed ? <p className="mw-empty">{t('scheduledLoading')}</p> : undefined}
      {rows !== undefined && rows.length === 0 ? <div className="mw-empty-state"><p>{t('scheduledNone')}</p></div> : undefined}
      {rows === undefined || rows.length === 0 ? undefined : (
        <div className="mw-card">
          {rows.map(row => (
            <div key={row.id} className="mw-ctx-row" data-testid="scheduled-row" data-enabled={row.enabled ? 'true' : 'false'}>
              <p className="mw-ctx-small">
                <span className="mw-ctx-strong">{row.name}</span>
                {` · ${automationDays(row, t)} `}
                {editing?.id === row.id ? (
                  <input
                    type="time"
                    className="mw-input mw-input-time"
                    aria-label={t('scheduledHourLabel', { name: row.name })}
                    value={editing.at}
                    autoFocus
                    onChange={(event) => { setEditing({ id: row.id, at: event.target.value }) }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') { event.preventDefault(); void saveHour(row, editing.at) }
                      if (event.key === 'Escape') { event.preventDefault(); setEditing(undefined) }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="mw-text-button"
                    data-testid="scheduled-hour"
                    disabled={busy === row.id}
                    aria-label={t('scheduledHourChange', { name: row.name, at: row.at })}
                    onClick={() => { setEditing({ id: row.id, at: row.at }) }}
                  >
                    {CLOCK.test(row.at) ? t('scheduledAt', { at: row.at }) : automationWhen(row, t)}
                  </button>
                )}
                <span className="mw-ctx-muted" data-testid="scheduled-zone">{` (${zoneWords(zone, t)})`}</span>
                <span className="mw-chip" data-testid="scheduled-state">{t(row.enabled ? 'scheduleActive' : 'scheduledSuspended')}</span>
              </p>
              {!row.enabled || row.nextRunAt === undefined || Number.isNaN(Date.parse(row.nextRunAt)) ? undefined : (
                <p className="mw-ctx-small mw-ctx-muted" data-testid="scheduled-next">{t('scheduleNextOne', { at: runTime(row.nextRunAt, zone) })}</p>
              )}
              {lastRunOf(row) === undefined ? undefined : (
                <p className="mw-ctx-small mw-ctx-muted" data-testid="scheduled-last">
                  {t('scheduledLastRun', { date: lastRunOf(row) ?? '' })}
                  {row.lastOutcome === undefined ? '' : ` · ${row.lastOutcome.startsWith('failed') ? t('scheduledLastFailed') : t('scheduledLastDone')}`}
                </p>
              )}
              <div className="mw-ctx-actions">
                <button type="button" className="mw-primary" disabled={busy === row.id} onClick={() => { void run(row) }}>{t('scheduledRunNow')}</button>
                <button type="button" className="mw-secondary" disabled={busy === row.id} onClick={() => { void toggle(row) }}>
                  {t(row.enabled ? 'scheduledSuspend' : 'scheduledActivate')}
                </button>
              </div>
              {said?.id !== row.id ? undefined : 'error' in said ? <p role="alert" className="mw-ctx-error">{said.error}</p> : (
                <p className="mw-ctx-small" role="status" data-testid="scheduled-ran">
                  {t('scheduledRan')}
                  {' '}<button type="button" className="mw-ctx-link" onClick={props.onLane}>{t('scheduledSeeInLane')}</button>
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      {props.missions === undefined || props.missions.length === 0 ? undefined : (
        <RecentRuns missions={props.missions} api={api} onChanged={props.onMissionsChanged} t={t} />
      )}
    </section>
  )
}

/** The newest missions shown under « Derniers passages ». */
const RECENT = 20

/** @param status - a mission's status as served. @returns its word key. */
function missionWord(status: string): 'runQueued' | 'runRunning' | 'runDone' | 'runFailed' | 'runCancelled' | 'runOther' {
  return status === 'queued' ? 'runQueued' : status === 'running' ? 'runRunning' : status === 'succeeded' || status === 'done' ? 'runDone'
    : status === 'failed' ? 'runFailed' : status === 'cancelled' ? 'runCancelled' : 'runOther'
}

/**
 * « Derniers passages »: the scheduled runs and the missions run by hand, in one place (moved from the
 * old team feed, 27/11). Relancer a failed one, Annuler one that waits or runs, one gesture at a time;
 * a refusal reads a fixed sentence. A mission's error is the host's sentence (#157), shown as text.
 */
function RecentRuns(props: {
  readonly missions: readonly MissionRow[]
  readonly api: Partial<Pick<MndtFace, 'retryMission' | 'cancelMission'>>
  readonly onChanged?: (() => void) | undefined
  readonly t: ChatTranslate
}): ReactNode {
  const { t } = props
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [refused, setRefused] = useState<string | undefined>(undefined)
  const inFlight = useRef(false)
  const recent = [...props.missions].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, RECENT)
  const act = async (id: string, gesture: ((missionId: string) => Promise<{ readonly ok: boolean }>) | undefined): Promise<void> => {
    if (gesture === undefined || inFlight.current) return
    inFlight.current = true
    setBusy(id)
    setRefused(undefined)
    try {
      const outcome = await gesture(id)
      if (!outcome.ok) setRefused(id)
      props.onChanged?.()
    } catch {
      setRefused(id)
    } finally {
      inFlight.current = false
      setBusy(undefined)
    }
  }
  return (
    <section className="mw-ctx-section" aria-label={t('runsTitle')} data-testid="recent-runs">
      <h2 className="mw-ctx-title">{t('runsTitle')}</h2>
      {recent.map(m => (
        <div key={m.id} className="mw-ctx-row" data-testid="recent-run" data-status={m.status}>
          <p className="mw-ctx-small">
            <span className="mw-ctx-strong">{m.prompt.length > 90 ? `${m.prompt.slice(0, 90)}…` : m.prompt}</span>
            {` · ${when(m.createdAt)}`}
            <span className="mw-chip" data-testid="recent-run-status">{t(missionWord(m.status))}</span>
          </p>
          {m.error === undefined ? undefined : <p className="mw-ctx-small mw-ctx-muted">{m.error}</p>}
          <div className="mw-ctx-actions">
            {m.status !== 'failed' || props.api.retryMission === undefined ? undefined : (
              <button type="button" className="mw-secondary" disabled={busy === m.id} onClick={() => { void act(m.id, props.api.retryMission) }}>{t('runRetry')}</button>
            )}
            {(m.status !== 'queued' && m.status !== 'running') || props.api.cancelMission === undefined ? undefined : (
              <button type="button" className="mw-text-button" disabled={busy === m.id} onClick={() => { void act(m.id, props.api.cancelMission) }}>{t('runCancel')}</button>
            )}
          </div>
          {refused === m.id ? <p role="alert" className="mw-ctx-error">{t('runRefused')}</p> : undefined}
        </div>
      ))}
    </section>
  )
}
