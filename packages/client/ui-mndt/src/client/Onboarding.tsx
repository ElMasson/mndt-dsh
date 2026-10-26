import { useState } from 'react'
import type { MndtKey } from './locales.ts'

/** Where the page records that the first-run card was dismissed. */
const DISMISS_KEY = 'mndt.onboarding.dismissed'

export interface OnboardingProps {
  /** Identity the product resolved for this visitor. */
  readonly you: string
  /** Whether this visitor may act, not only read. */
  readonly canWrite: boolean
  /** How many missions already exist. */
  readonly missionCount: number
  /** How many decisions are waiting. */
  readonly pendingCount: number
  /** How many connectors are mounted. */
  readonly connectorCount: number
  /** True while another action is running. */
  readonly busy: boolean
  /** Runs the first mission from the card. */
  readonly onRunBriefing: () => void
  /** Opens the guided tour. */
  readonly onStartTour: () => void
  /** Copy resolver owned by the page. */
  readonly t: (key: MndtKey) => string
}

/**
 * First-run card: the four gestures that make the product legible, with the
 * state each one actually reached, and how a team shares it. Dismissible, and
 * the dismissal is remembered in the browser.
 * @param props - see {@link OnboardingProps}.
 * @returns the onboarding card, or null once dismissed.
 */
export function Onboarding(props: OnboardingProps) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return window.localStorage.getItem(DISMISS_KEY) === '1'
    } catch {
      return false
    }
  })
  if (dismissed) return null
  const steps: { key: MndtKey; done: boolean; value: string }[] = [
    { key: 'stepIdentity', done: props.you !== '', value: props.canWrite ? props.t('writer') : props.t('readOnly') },
    { key: 'stepMission', done: props.missionCount > 0, value: String(props.missionCount) },
    { key: 'stepDecision', done: props.pendingCount === 0, value: props.pendingCount === 0 ? props.t('stepNone') : String(props.pendingCount) },
    { key: 'stepConnector', done: props.connectorCount > 0, value: String(props.connectorCount) },
  ]
  return (
    <section className="mndt-card mndt-onboarding" aria-label={props.t('onboardingTitle')}>
      <div className="mndt-card-head">
        <div>
          <h2 className="mndt-card-title">{props.t('onboardingTitle')}</h2>
          <p className="mndt-sub">{props.t('onboardingLead')}</p>
        </div>
        <div className="mndt-row-actions">
          <button className="mndt-button" data-variant="primary" onClick={props.onStartTour}>
            {props.t('tourStart')}
          </button>
          <button
            className="mndt-button"
            onClick={() => {
              try {
                window.localStorage.setItem(DISMISS_KEY, '1')
              } catch {}
              setDismissed(true)
            }}
          >
            {props.t('onboardingDismiss')}
          </button>
        </div>
      </div>
      <div className="mndt-card-body">
        <ol className="mndt-steps">
          {steps.map(step => (
            <li className="mndt-step" data-done={step.done} key={step.key}>
              <span className="mndt-step-dot" aria-hidden="true">{step.done ? '✓' : '·'}</span>
              <span className="mndt-step-label">{props.t(step.key)}</span>
              <span className="mndt-step-value">{step.value}</span>
              {step.key === 'stepMission' && props.canWrite && (
                <button className="mndt-button" disabled={props.busy} onClick={props.onRunBriefing}>
                  {props.t('runBriefing')}
                </button>
              )}
            </li>
          ))}
        </ol>
        <div className="mndt-team">
          <h3 className="mndt-team-title">{props.t('teamTitle')}</h3>
          <p className="mndt-empty">{props.t('teamLead')}</p>
          <p className="mndt-empty">{props.t('teamRoles')}</p>
          <p className="mndt-empty">{props.t('teamShared')}</p>
          <code className="mndt-team-cmd">{props.t('teamAdd')}</code>
        </div>
      </div>
    </section>
  )
}
