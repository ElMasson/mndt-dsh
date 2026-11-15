/**
 * A channel's documents, as the team page reads them (contract sent to A1 on 15/11, after mndt-web's
 * `ChannelDocuments`): the list with what the reader may do, a deposit as multipart, a retirement
 * with its reason. Until the route exists the list answers « absent », and the page says « Bientôt »
 * without offering anything.
 */
import { readWithin } from './deadline.ts'

/** One document of a channel. */
export interface ChannelDocument {
  readonly id: string
  readonly name: string
  /** In bytes. */
  readonly size: number
  readonly type: string
  readonly pages?: number
  readonly dataClass?: string
  readonly uploadedBy: string
  readonly uploadedAt: string
  readonly canRetire: boolean
}

/** What a channel's list says. */
export interface DocumentsPage {
  readonly documents: readonly ChannelDocument[]
  readonly canDeposit: boolean
  /** The classes a deposit may carry; absent, documents carry none and none is asked. */
  readonly dataClasses?: readonly string[]
}

/** A refusal of the documents route, with its status so the page can say it in its words. */
export class DocumentsRefusal extends Error {
  /** @param message - the API's reason. @param status - the HTTP status. */
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'DocumentsRefusal'
  }
}

/** The documents of the team's channels. */
export interface DocumentsFace {
  /** @returns the channel's documents, or `absent` while the route is not served. */
  list(channelId: string): Promise<DocumentsPage | 'absent'>
  deposit(channelId: string, file: File, dataClass?: string): Promise<ChannelDocument>
  retire(channelId: string, documentId: string, reason: string): Promise<ChannelDocument>
}

/** The fetch the face uses; tests pass their own. */
export type DocumentsFetcher = (input: string, init?: RequestInit) => Promise<Response>

const BASE = '/mndt-api'

/** @param response - a refused answer. @returns its refusal, with the API's reason when it gave one. */
async function refusalOf(response: Response): Promise<DocumentsRefusal> {
  const body: unknown = await response.json().catch(() => ({}))
  const reason = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
    ? (body as { error: string }).error
    : `HTTP ${response.status}`
  return new DocumentsRefusal(reason, response.status)
}

/**
 * @param fetcher - the fetch to use (the browser's by default).
 * @returns the documents face over the product API.
 */
export function createHttpDocuments(fetcher: DocumentsFetcher = (input, init) => fetch(input, init)): DocumentsFace {
  const id = encodeURIComponent
  return {
    async list(channelId) {
      const path = `/channels/${id(channelId)}/documents`
      const response = await readWithin(path, signal => fetcher(`${BASE}${path}`, { credentials: 'include', signal }))
      // A channel the page just read answers 404 (or 501) only where the route does not exist yet.
      if (response.status === 404 || response.status === 501) return 'absent'
      if (!response.ok) throw await refusalOf(response)
      const body = await response.json() as Partial<DocumentsPage>
      return {
        documents: Array.isArray(body.documents) ? body.documents : [],
        canDeposit: body.canDeposit === true,
        ...(Array.isArray(body.dataClasses) && body.dataClasses.length > 0 ? { dataClasses: body.dataClasses } : {}),
      }
    },
    async deposit(channelId, file, dataClass) {
      const form = new FormData()
      form.append('file', file)
      if (dataClass !== undefined) form.append('dataClass', dataClass)
      const response = await fetcher(`${BASE}/channels/${id(channelId)}/documents`, { method: 'POST', credentials: 'include', body: form })
      if (!response.ok) throw await refusalOf(response)
      return (await response.json() as { document: ChannelDocument }).document
    },
    async retire(channelId, documentId, reason) {
      const response = await fetcher(`${BASE}/channels/${id(channelId)}/documents/${id(documentId)}/retire`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      })
      if (!response.ok) throw await refusalOf(response)
      return (await response.json() as { document: ChannelDocument }).document
    },
  }
}

/** What the double starts with, per channel; `absent` plays a workbench without the route. */
export type DocumentsSeed = Readonly<Record<string, DocumentsPage>> | 'absent'

/**
 * A double of the route, for the tests and the rehearsal: deposits and retirements change its lists.
 * @param seed - the lists it starts with, or `absent`.
 * @param you - who deposits.
 * @returns the face.
 */
export function createMockDocuments(seed: DocumentsSeed, you = 'stephane@datanalysis.re'): DocumentsFace {
  const pages = new Map<string, DocumentsPage>(seed === 'absent' ? [] : Object.entries(seed))
  let next = 1
  const pageOf = (channelId: string): DocumentsPage => pages.get(channelId) ?? { documents: [], canDeposit: true }
  return {
    list: channelId => Promise.resolve(seed === 'absent' ? 'absent' : pageOf(channelId)),
    deposit(channelId, file, dataClass) {
      const page = pageOf(channelId)
      if (file.size > 20 * 1024 * 1024) return Promise.reject(new DocumentsRefusal('too large', 413))
      const document: ChannelDocument = {
        id: `doc_${next++}`, name: file.name, size: file.size, type: file.type, uploadedBy: you,
        uploadedAt: new Date().toISOString(), canRetire: true, ...(dataClass === undefined ? {} : { dataClass }),
      }
      pages.set(channelId, { ...page, documents: [...page.documents, document] })
      return Promise.resolve(document)
    },
    retire(channelId, documentId) {
      const page = pageOf(channelId)
      const found = page.documents.find(d => d.id === documentId)
      if (found === undefined) return Promise.reject(new DocumentsRefusal('unknown document', 404))
      pages.set(channelId, { ...page, documents: page.documents.filter(d => d.id !== documentId) })
      return Promise.resolve(found)
    },
  }
}
