/**
 * An agent's open question in À traiter, answered where it is read: its channel and its hour first,
 * the question, the summary, one field and « Répondre et clore ce fil » (a reply to the published
 * question, as in the channel). The button stays active: an empty answer is said, not silently
 * refused. A reader whose answer would not count (no workflows.write) is offered the channel only.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { OpenEscalation } from './chat.ts'
import type { ChatTranslate } from './chatLocales.ts'
import { when } from './format.ts'
import { renderBrief } from './markdown.tsx'

/** @param props - the question, where it lives, and how to answer it. @returns its item in À traiter. */
export function PendingQuestion(props: {
  readonly escalation: OpenEscalation
  /** The channel, in words (« # compta »), when the reader sees it. */
  readonly where?: string | undefined
  readonly onOpen?: (() => void) | undefined
  /** Post the answer as a reply to the published question; resolves to the reason when refused. */
  readonly onAnswer?: ((text: string) => Promise<string | undefined>) | undefined
  readonly t: ChatTranslate
}): ReactNode {
  const { escalation: e, t } = props
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const send = async (): Promise<void> => {
    if (props.onAnswer === undefined || busy) return
    if (answer.trim() === '') {
      setError(t('answerEmpty'))
      return
    }
    setBusy(true)
    const refused = await props.onAnswer(answer.trim())
    setError(refused)
    if (refused === undefined) setAnswer('')
    setBusy(false)
  }
  return (
    <div className="mw-queue-item mw-turn-unchecked mw-help-question" data-testid="pending-question">
      {props.where === undefined && e.at === undefined ? undefined : (
        <p className="mw-ctx-small" data-testid="pending-question-where">
          {[props.where, e.at === undefined ? undefined : when(e.at)].filter((x): x is string => x !== undefined).join(' · ')}
        </p>
      )}
      <p className="mw-help-question-text">
        {t(e.kind === 'council' ? 'councilQuestionFor' : 'helpQuestionFor', { question: e.question })}
      </p>
      {e.summary === undefined ? undefined : <div className="mw-agent-text">{renderBrief(e.summary, { plainHeadings: true })}</div>}
      {props.onAnswer === undefined ? undefined : (
        <div className="mw-help-answer">
          <textarea
            className="mw-input"
            rows={2}
            aria-label={t('helpAnswerLabel')}
            value={answer}
            onChange={(event) => { setAnswer(event.target.value); setError(undefined) }}
          />
          <button type="button" className="mw-primary" disabled={busy} onClick={() => { void send() }}>{t('helpAnswer')}</button>
          {error === undefined ? undefined : <p role="alert" className="mw-decide-error">{error}</p>}
        </div>
      )}
      {props.where === undefined || props.onOpen === undefined ? undefined : (
        <button type="button" className="mw-queue-where" onClick={props.onOpen}>{t('helpOpenThread', { where: props.where })}</button>
      )}
    </div>
  )
}
