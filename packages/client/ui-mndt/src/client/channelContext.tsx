/**
 * A channel's context (lot 3): « ce qu'il faut savoir ici », what the channel's agents read before
 * answering. One source, `channel.context` in the core's state, read by the channel's members only.
 * The core gives it to agents as facts between marks, never as orders: the screen never says it
 * configures them. Owners and admins write it in place; anyone else asks an agent, whose proposal
 * becomes a card. Every text is shown through the safe renderer, headings as plain bold.
 */
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ChatAgent, ChatChannel } from './chat.ts'
import type { ChatTranslate } from './chatLocales.ts'
import { when } from './format.ts'
import { renderBrief } from './markdown.tsx'
import { shownName } from './TeamFeed.tsx'

/** The longest context the core keeps, after trim(). */
export const MAX_CONTEXT = 4000
/** Beyond this many lines a context is folded. */
const FOLD_LINES = 8

/** A channel's context, as served. */
export interface ChannelContext {
  readonly text: string
  readonly version: number
  readonly updatedBy?: string
  readonly updatedAt?: string
}

/** A context an agent proposes on a card (`propose_context`). */
export interface ContextProposal {
  readonly text: string
  readonly baseVersion: number
}

/** @param value - anything. @returns it when it is a whole number ≥ 0. */
function versionOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * @param channel - a channel as served.
 * @returns its context when well-formed and not empty; anything else reads as no context.
 */
export function contextOf(channel: ChatChannel): ChannelContext | undefined {
  const raw: unknown = channel.context
  if (typeof raw !== 'object' || raw === null) return undefined
  const c = raw as Record<string, unknown>
  const version = versionOf(c.version)
  if (typeof c.text !== 'string' || c.text.trim() === '' || c.text.length > MAX_CONTEXT * 2 || version === undefined) return undefined
  return {
    text: c.text.trim(),
    version,
    ...(typeof c.updatedBy === 'string' && c.updatedBy !== '' ? { updatedBy: c.updatedBy } : {}),
    ...(typeof c.updatedAt === 'string' && !Number.isNaN(Date.parse(c.updatedAt)) ? { updatedAt: c.updatedAt } : {}),
  }
}

/**
 * A context proposed on a card, read strictly: a present field the page cannot read makes the
 * proposal unreadable (the card then offers « Refuser » only), never a shorter text.
 * @param raw - the card's `proposal`. @returns the proposal, or undefined.
 */
export function contextProposalOf(raw: unknown): ContextProposal | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const p = raw as Record<string, unknown>
  const baseVersion = versionOf(p.baseVersion)
  if (typeof p.text !== 'string' || baseVersion === undefined) return undefined
  const text = p.text.trim()
  if (text.length > MAX_CONTEXT) return undefined
  return { text, baseVersion }
}

/** @param text - a context. @param folded - whether to fold it. @returns its blocks, headings as plain bold. */
function contextBlocks(text: string, folded: boolean): ReactNode {
  const lines = text.split('\n')
  return renderBrief(folded ? lines.slice(0, FOLD_LINES).join('\n') : text, { plainHeadings: true })
}

/**
 * The context shown in its marked frame (« Écrit par X, date »), folded beyond eight lines.
 */
export function ContextFrame(props: {
  readonly context: ChannelContext
  readonly names?: Readonly<Record<string, string>> | undefined
  readonly t: ChatTranslate
  readonly testId?: string
}): ReactNode {
  const { context, t } = props
  const [open, setOpen] = useState(false)
  const long = context.text.split('\n').length > FOLD_LINES
  const who = context.updatedBy === undefined ? undefined : shownName(context.updatedBy, props.names)
  return (
    <div className="mw-quoted" data-testid={props.testId ?? 'channel-context'}>
      <p className="mw-quoted-head">
        {who === undefined ? t('contextWrittenUnknown')
          : context.updatedAt === undefined ? t('contextWrittenBy', { who })
            : t('contextWrittenByAt', { who, at: when(context.updatedAt) })}
      </p>
      <div className="mw-agent-text">{contextBlocks(context.text, long && !open)}</div>
      {long ? (
        <button type="button" className="mw-ctx-link mw-quoted-more" onClick={() => { setOpen(held => !held) }}>
          {open ? t('sheetFold') : t('contextUnfold')}
        </button>
      ) : undefined}
    </div>
  )
}

/**
 * The CE QU'IL FAUT SAVOIR ICI section of a channel's panel: the context in its frame; « Modifier »
 * in place for owners and admins (a change made meanwhile is said, never overwritten); one pill per
 * agent of the channel that asks it to propose one, for everyone (its proposal becomes a card).
 */
export function ContextSection(props: {
  readonly channel: ChatChannel
  readonly agents: readonly ChatAgent[]
  readonly canEdit: boolean
  /** Write it; resolves to the reason when refused. */
  readonly onSave?: ((text: string, version: number) => Promise<string | undefined>) | undefined
  /** Put a text in the channel's composer (« @agent … »). */
  readonly onAsk?: ((text: string) => void) | undefined
  readonly names?: Readonly<Record<string, string>> | undefined
  readonly t: ChatTranslate
}): ReactNode {
  const { channel, t } = props
  const context = contextOf(channel)
  const here = props.agents.filter(a => channel.agents.includes(a.id) && a.retiredAt === undefined)
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const editable = props.canEdit && props.onSave !== undefined
  const save = async (): Promise<void> => {
    if (busy.current || draft === undefined || props.onSave === undefined) return
    busy.current = true
    setPending(true)
    const refused = await props.onSave(draft, context?.version ?? 0)
    setError(refused)
    if (refused === undefined) setDraft(undefined)
    busy.current = false
    setPending(false)
  }
  return (
    <div className="mw-context" data-testid="context-section">
      <p className="mw-ctx-small mw-ctx-muted">{t('contextWhat')}</p>
      {draft === undefined ? (
        context === undefined
          ? <p className="mw-ctx-muted" data-testid="context-empty">{t('contextEmpty')}</p>
          : <ContextFrame context={context} names={props.names} t={t} />
      ) : (
        <div className="mw-context-edit">
          <textarea
            className="mw-input"
            rows={6}
            maxLength={MAX_CONTEXT}
            aria-label={t('contextTitle')}
            value={draft}
            onChange={(event) => { setDraft(event.target.value) }}
          />
          <span className="mw-counter" aria-live="polite">{t('agentPurposeCount', { count: draft.trim().length, max: MAX_CONTEXT })}</span>
          <div className="mw-decide-buttons">
            <button type="button" className="mw-primary" disabled={pending} onClick={() => { void save() }}>{t('agentSave')}</button>
            <button type="button" className="mw-secondary" disabled={pending} onClick={() => { setDraft(undefined); setError(undefined) }}>{t('cancel')}</button>
          </div>
        </div>
      )}
      {!editable || draft !== undefined ? undefined : (
        <button type="button" className="mw-secondary" onClick={() => { setDraft(context?.text ?? ''); setError(undefined) }}>
          {context === undefined ? t('contextWrite') : t('sheetEdit')}
        </button>
      )}
      {props.onAsk === undefined || here.length === 0 || draft !== undefined ? undefined : (
        <div className="mw-pills" role="group" aria-label={t('contextAsk')}>
          {here.map(a => (
            <button
              key={a.id}
              type="button"
              className="mw-pill"
              aria-label={t('contextAskOne', { handle: a.handle })}
              onClick={() => { props.onAsk?.(context === undefined ? t('contextAskText', { handle: a.handle }) : t('contextAskUpdateText', { handle: a.handle })) }}
            >
              @{a.handle}
            </button>
          ))}
        </div>
      )}
      {error === undefined ? undefined : <p role="alert" className="mw-ctx-error">{error}</p>}
    </div>
  )
}
