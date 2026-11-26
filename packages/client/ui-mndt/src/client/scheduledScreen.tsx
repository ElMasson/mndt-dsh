/**
 * « Tâches planifiées », the owner's place in the team navigation (Stéphane, 26/11: the scheduled
 * missions were only reachable through Réglages → Automatisations, and none could be run by hand).
 * One list of the workspace's automations, each with its hour in words, its last run, its state,
 * and three gestures: run now (1 click), suspend, activate. A run's result reaches the owner's
 * lane only for a briefing (the core publishes no other kind there): only then is it linked.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ChatTranslate } from './chatLocales.ts'
import type { AutomationRow, MndtFace } from './face.ts'
import { when } from './format.ts'
import { cadenceWords } from './schedule.tsx'

/** @param row - an automation. @returns its hour in words (days: 0 is Sunday on an automation). */
function automationWhen(row: AutomationRow, t: ChatTranslate): string {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(row.at)) return row.at
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
type Said = { readonly id: string; readonly ran: boolean; readonly lane: boolean } | { readonly id: string; readonly error: string }

/** @param props - the face, the copy and how to open the owner's lane. @returns the screen. */
export function ScheduledScreen(props: {
  readonly api: Pick<MndtFace, 'automations' | 'toggleAutomation' | 'runAutomationNow'>
  readonly onLane: () => void
  readonly title: string
  readonly t: ChatTranslate
}): ReactNode {
  const { api, t } = props
  const [rows, setRows] = useState<readonly AutomationRow[] | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [said, setSaid] = useState<Said | undefined>(undefined)
  // One gesture at a time: a second click before the first answer does nothing (a ref, set at once).
  const inFlight = useRef(false)
  const load = useCallback(async (): Promise<void> => {
    try {
      setRows((await api.automations()).items)
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
        : { id: row.id, ran: true, lane: row.kind === 'briefing' })
    } catch {
      setSaid({ id: row.id, error: t('scheduledRunRefused') })
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
      {rows === undefined && !failed ? <p className="mw-empty">{t('scheduledLoading')}</p> : undefined}
      {rows !== undefined && rows.length === 0 ? <div className="mw-empty-state"><p>{t('scheduledNone')}</p></div> : undefined}
      {rows === undefined || rows.length === 0 ? undefined : (
        <div className="mw-card">
          {rows.map(row => (
            <div key={row.id} className="mw-ctx-row" data-testid="scheduled-row" data-enabled={row.enabled ? 'true' : 'false'}>
              <p className="mw-ctx-small">
                <span className="mw-ctx-strong">{row.name}</span>
                {` · ${automationWhen(row, t)}`}
                <span className="mw-chip" data-testid="scheduled-state">{t(row.enabled ? 'scheduleActive' : 'scheduledSuspended')}</span>
              </p>
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
                  {said.lane ? <>{' '}<button type="button" className="mw-ctx-link" onClick={props.onLane}>{t('scheduledSeeInLane')}</button></> : ` ${t('scheduledRanElsewhere')}`}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
