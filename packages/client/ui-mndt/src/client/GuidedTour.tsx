import { useEffect, useLayoutEffect, useState } from 'react'
import type { MndtKey } from './locales.ts'

/** Where the page records that the guided tour was completed once. */
const TOUR_KEY = 'mndt.tour.done'

export interface GuidedTourProps {
  /** Whether the tour is showing. */
  readonly open: boolean
  /** Closes the tour, whatever the step. */
  readonly onClose: () => void
  /** Copy resolver owned by the page. */
  readonly t: (key: MndtKey) => string
}

interface TourStep {
  readonly title: MndtKey
  readonly body: MndtKey
  /** How to find the element the step points at. */
  readonly find: () => Element | null
}

/** @param text - heading text to look for. @returns the section carrying it. */
function sectionByTitle(text: string): Element | null {
  const sections = Array.from(document.querySelectorAll('section'))
  return sections.find(section => (section.querySelector('h2')?.textContent ?? '').trim() === text) ?? null
}

/**
 * Guided tour: dims the page and points at one area at a time, with the reason
 * each area exists. It reads the page, never writes it, and remembers completion
 * in the browser so it does not open by itself again.
 * @param props - see {@link GuidedTourProps}.
 * @returns the tour overlay, or null when closed.
 */
export function GuidedTour(props: GuidedTourProps) {
  const [index, setIndex] = useState(0)
  const [box, setBox] = useState<{ top: number; left: number; width: number; height: number } | null>(null)
  const steps: TourStep[] = [
    { title: 'tourIdentityTitle', body: 'tourIdentityBody', find: () => document.querySelector('.mndt-head') },
    { title: 'tourMissionTitle', body: 'tourMissionBody', find: () => sectionByTitle(props.t('missions')) },
    { title: 'tourDecisionTitle', body: 'tourDecisionBody', find: () => sectionByTitle(props.t('decisions')) },
    { title: 'tourConnectorTitle', body: 'tourConnectorBody', find: () => sectionByTitle(props.t('connectors')) },
    { title: 'tourMemberTitle', body: 'tourMemberBody', find: () => sectionByTitle(props.t('members')) },
    { title: 'tourUsageTitle', body: 'tourUsageBody', find: () => sectionByTitle(props.t('usageTitle')) },
    { title: 'tourScheduleTitle', body: 'tourScheduleBody', find: () => sectionByTitle(props.t('scheduleTitle')) },
  ]
  const fallback: TourStep = { title: 'tourIdentityTitle', body: 'tourIdentityBody', find: () => null }
  const current = steps[Math.min(index, steps.length - 1)] ?? fallback

  useEffect(() => {
    if (!props.open) return
    setIndex(0)
  }, [props.open])

  useLayoutEffect(() => {
    if (!props.open) {
      setBox(null)
      return
    }
    const element = current.find()
    if (element === null) {
      setBox(null)
      return
    }
    element.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const measure = (): void => {
      const rect = element.getBoundingClientRect()
      setBox({ top: rect.top, left: rect.left, width: rect.width, height: rect.height })
    }
    measure()
    const handle = window.setInterval(measure, 400)
    return () => { window.clearInterval(handle) }
  }, [props.open, index])

  useEffect(() => {
    if (!props.open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
      if (event.key === 'ArrowRight') setIndex(value => Math.min(value + 1, steps.length - 1))
      if (event.key === 'ArrowLeft') setIndex(value => Math.max(value - 1, 0))
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [props.open, steps.length])

  if (!props.open) return null
  const finish = (): void => {
    try {
      window.localStorage.setItem(TOUR_KEY, '1')
    } catch {}
    props.onClose()
  }
  const last = index >= steps.length - 1
  const spotlight = box === null ? null : {
    top: Math.max(0, box.top - 8),
    left: Math.max(0, box.left - 8),
    width: box.width + 16,
    height: box.height + 16,
  }
  const cardTop = box === null ? 120 : Math.min(window.innerHeight - 220, box.top + box.height + 16)
  return (
    <div className="mndt-tour" role="dialog" aria-modal="true" aria-label={props.t('tourStart')}>
      {spotlight === null
        ? null
        : <div className="mndt-tour-ring" style={{ top: spotlight.top, left: spotlight.left, width: spotlight.width, height: spotlight.height }} />}
      <div className="mndt-tour-card" style={{ top: Math.max(16, cardTop), left: Math.max(16, window.innerWidth - 404) }}>
        <span className="mndt-tour-count">{index + 1} / {steps.length}</span>
        <h3 className="mndt-tour-title">{props.t(current.title)}</h3>
        <p className="mndt-tour-body">{props.t(current.body)}</p>
        <div className="mndt-tour-actions">
          <button className="mndt-button" onClick={finish}>{props.t('tourSkip')}</button>
          <span className="mndt-tour-spacer" />
          <button className="mndt-button" disabled={index === 0} onClick={() => { setIndex(value => Math.max(0, value - 1)) }}>
            {props.t('tourPrev')}
          </button>
          <button className="mndt-button" data-variant="primary" onClick={() => { if (last) finish(); else setIndex(value => Math.min(steps.length - 1, value + 1)) }}>
            {last ? props.t('tourDone') : props.t('tourNext')}
          </button>
        </div>
      </div>
    </div>
  )
}
