/**
 * The DOCUMENTS section of a channel's context card, as mndt-web draws it (`ChannelDocuments`):
 * the documents with their size, who deposited them and when, a deposit when the reader may, and a
 * retirement with its reason. While the route is not served it says « Bientôt » and offers nothing.
 *
 * Content is downloaded only, from the team API on the same origin; nothing is previewed in the page.
 * A file's name comes from another person: it is shown as text, cut cleanly, never interpreted.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ChatTranslate } from './chatLocales.ts'
import { DocumentsRefusal } from './documents.ts'
import type { ChannelDocument, DocumentsFace, DocumentsPage } from './documents.ts'
import { pageLanguage, when } from './format.ts'
import { Icon } from './Icons.tsx'
import { shownName } from './TeamFeed.tsx'

/** What a deposit may be (.pdf .txt .md .csv, as the API accepts). */
const ACCEPT = '.pdf,.txt,.md,.csv,application/pdf,text/plain,text/markdown,text/csv'

/** @param bytes - a size. @returns it in the units a person reads (« 1,2 Mo »). */
export function sizeOf(bytes: number): string {
  const units = ['o', 'Ko', 'Mo', 'Go']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toLocaleString(pageLanguage() ?? 'fr', { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit] ?? 'o'}`
}

/** @param error - a refused deposit. @param t - the copy. @returns what to tell the person, by its kind. */
function depositRefusal(error: unknown, t: ChatTranslate): string {
  if (error instanceof DocumentsRefusal) {
    if (error.status === 413) return t('docTooLarge')
    if (error.status === 415) return t('docFormat')
    if (error.status === 403) return t('docForbidden')
    return t('docRefused', { reason: error.message })
  }
  return t('docRefused', { reason: error instanceof Error ? error.message : String(error) })
}

/** The section's props. */
export interface TeamDocumentsProps {
  readonly face: DocumentsFace
  readonly channelId: string
  readonly names?: Readonly<Record<string, string>> | undefined
  readonly t: ChatTranslate
}

/** @param props - the channel and the documents face. @returns the section's content. */
export function TeamDocuments(props: TeamDocumentsProps): ReactNode {
  const { face, channelId, t } = props
  const [page, setPage] = useState<DocumentsPage | 'absent' | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const load = useCallback(async (): Promise<void> => {
    try {
      setPage(await face.list(channelId))
      setError(undefined)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [face, channelId])
  useEffect(() => {
    setPage(undefined)
    void load()
  }, [load])

  if (error !== undefined) return <p className="mw-ctx-muted" role="alert">{t('docUnreadable', { reason: error })}</p>
  if (page === undefined) return <p className="mw-ctx-muted">{t('docLoading')}</p>
  if (page === 'absent') return <p className="mw-ctx-muted" data-testid="documents-soon">{t('ctxDocumentsSoon')}</p>
  return (
    <div className="mw-docs" data-testid="channel-documents">
      {page.documents.length === 0 ? <p className="mw-ctx-muted">{t('docNone')}</p> : (
        <ul className="mw-docs-list">
          {page.documents.map(document => (
            <DocumentRow
              key={document.id}
              channelId={channelId}
              document={document}
              face={face}
              names={props.names}
              onChanged={load}
              t={t}
            />
          ))}
        </ul>
      )}
      {page.canDeposit ? <DepositForm face={face} channelId={channelId} classes={page.dataClasses} onDone={load} t={t} /> : undefined}
    </div>
  )
}

/** One document: its name to download, what it is, and its retirement when the reader may. */
function DocumentRow(props: {
  readonly channelId: string
  readonly document: ChannelDocument
  readonly face: DocumentsFace
  readonly names?: Readonly<Record<string, string>> | undefined
  readonly onChanged: () => Promise<void>
  readonly t: ChatTranslate
}): ReactNode {
  const { document: d, t } = props
  const [retiring, setRetiring] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const href = `/mndt-api/channels/${encodeURIComponent(props.channelId)}/documents/${encodeURIComponent(d.id)}/content`
  const facts = [
    d.pages === undefined ? undefined : d.pages === 1 ? t('docPages1') : t('docPages', { n: d.pages }),
    sizeOf(d.size),
    d.dataClass,
    shownName(d.uploadedBy, props.names),
    when(d.uploadedAt),
  ].filter((fact): fact is string => fact !== undefined && fact !== '')
  const retire = async (): Promise<void> => {
    if (reason.trim() === '' || busy) return
    setBusy(true)
    try {
      await props.face.retire(props.channelId, d.id, reason.trim())
      setError(undefined)
      await props.onChanged()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
    setBusy(false)
  }
  return (
    <li className="mw-doc" data-testid="channel-document">
      <div className="mw-doc-row">
        <Icon name="FileText" className="mw-ctx-icon" />
        <span className="mw-doc-main">
          {/* Same origin, downloaded, never shown in the page; the name is text. */}
          <a className="mw-doc-name" href={href} download={d.name} title={d.name} aria-label={t('docDownload', { name: d.name })}>{d.name}</a>
          <span className="mw-doc-facts">{facts.join(' · ')}</span>
        </span>
        {d.canRetire && !retiring ? (
          <button type="button" className="mw-secondary mw-doc-retire" onClick={() => { setRetiring(true) }} data-testid="document-retire">{t('docRetire')}</button>
        ) : undefined}
      </div>
      {!retiring ? undefined : (
        <form className="mw-doc-retiring" onSubmit={(event) => { event.preventDefault(); void retire() }}>
          <label className="mw-doc-label">
            {t('docReason')}
            <input className="mw-doc-input" value={reason} onChange={(event) => { setReason(event.target.value) }} />
          </label>
          <p className="mw-ctx-small mw-ctx-muted">{t('docRetireNote')}</p>
          <div className="mw-doc-buttons">
            <button type="submit" className="mw-secondary" disabled={reason.trim() === '' || busy}>{t('docRetireThis')}</button>
            <button type="button" className="mw-secondary" onClick={() => { setRetiring(false) }}>{t('cancel')}</button>
          </div>
          {error === undefined ? undefined : <p role="alert" className="mw-ctx-error">{error}</p>}
        </form>
      )}
    </li>
  )
}

/** The deposit box of mndt-web: a file, its class where classes are served, and « Déposer ». */
function DepositForm(props: {
  readonly face: DocumentsFace
  readonly channelId: string
  readonly classes?: readonly string[] | undefined
  readonly onDone: () => Promise<void>
  readonly t: ChatTranslate
}): ReactNode {
  const { t } = props
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | undefined>(undefined)
  const [dataClass, setDataClass] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const needsClass = props.classes !== undefined
  const ready = file !== undefined && (!needsClass || dataClass !== '')
  const send = async (): Promise<void> => {
    if (file === undefined || !ready || busy) return
    setBusy(true)
    try {
      await props.face.deposit(props.channelId, file, needsClass ? dataClass : undefined)
      setFile(undefined)
      setDataClass('')
      setError(undefined)
      if (input.current !== null) input.current.value = ''
      await props.onDone()
    } catch (failure) {
      setError(depositRefusal(failure, t))
    }
    setBusy(false)
  }
  return (
    <form className="mw-deposit" data-testid="document-deposit" onSubmit={(event) => { event.preventDefault(); void send() }}>
      <label htmlFor={`${id}-file`} className="mw-deposit-title">{t('docDeposit')}</label>
      <input
        id={`${id}-file`}
        ref={input}
        type="file"
        accept={ACCEPT}
        className="mw-deposit-file"
        aria-describedby={`${id}-help`}
        onChange={(event) => { setFile(event.target.files?.[0]); setError(undefined) }}
      />
      <p id={`${id}-help`} className="mw-ctx-small mw-ctx-muted">{t('docHelp')}</p>
      {!needsClass ? undefined : (
        <label className="mw-doc-label">
          {t('docClass')}
          <select className="mw-doc-input" value={dataClass} onChange={(event) => { setDataClass(event.target.value) }}>
            <option value="">{t('docChoose')}</option>
            {(props.classes ?? []).map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      )}
      <button type="submit" className="mw-primary mw-deposit-send" disabled={!ready || busy}>
        <Icon name="Upload" />
        {t('docSend')}
      </button>
      {error === undefined ? undefined : <p role="alert" className="mw-ctx-error">{error}</p>}
    </form>
  )
}
