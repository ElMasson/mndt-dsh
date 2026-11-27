/**
 * A mandate's thread in Réglages → Administration → Mandats (moved from the old team feed, 27/11): the
 * missions run under it, newest first, with their status in words. Nothing when there is none.
 */
import type { ReactNode } from 'react'
import type { ChatTranslate } from './chatLocales.ts'
import { when } from './format.ts'

/** A mission as the mandate lists it. */
interface MandateRun { readonly id: string; readonly prompt: string; readonly status: string; readonly createdAt: string }

/** @param props - the mandate's missions and the copy. @returns its thread, or nothing. */
export function MandateRuns(props: { readonly missions: readonly MandateRun[]; readonly t: ChatTranslate }): ReactNode {
  const { t } = props
  if (props.missions.length === 0) return undefined
  const recent = [...props.missions].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 10)
  return (
    <details className="mw-turn-steps" data-testid="mandate-runs">
      <summary>{t(recent.length === 1 ? 'mandateRunsOne' : 'mandateRunsMany', { n: props.missions.length })}</summary>
      <ul className="mw-ctx-list">
        {recent.map(m => (
          <li key={m.id} className="mw-ctx-small" data-testid="mandate-run">
            {m.prompt.length > 90 ? `${m.prompt.slice(0, 90)}…` : m.prompt} · {when(m.createdAt)} · {t(m.status === 'failed' ? 'runFailed' : m.status === 'succeeded' || m.status === 'done' ? 'runDone' : m.status === 'running' ? 'runRunning' : m.status === 'queued' ? 'runQueued' : m.status === 'cancelled' ? 'runCancelled' : 'runOther')}
          </li>
        ))}
      </ul>
    </details>
  )
}
