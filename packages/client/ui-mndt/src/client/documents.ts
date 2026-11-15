/**
 * A channel's documents, as the team page reads them (contract agreed with A1 on 15/11, after
 * mndt-web's `ChannelDocuments`): the list with what the reader may do, a deposit as JSON with the
 * file in base64 (the API reads bodies as text), a retirement with its reason. Until the route exists
 * the list answers « absent », and the page says « Bientôt » without offering anything.
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

/** @param row - one row as served. @returns whether it has the shape of a document. */
export function isDocument(row: unknown): row is ChannelDocument {
  if (typeof row !== 'object' || row === null) return false
  const d = row as Record<string, unknown>
  return typeof d.id === 'string' && typeof d.name === 'string' && typeof d.size === 'number' && Number.isFinite(d.size)
    && typeof d.type === 'string' && typeof d.uploadedBy === 'string' && typeof d.uploadedAt === 'string'
    && typeof d.canRetire === 'boolean'
    && (d.pages === undefined || typeof d.pages === 'number') && (d.dataClass === undefined || typeof d.dataClass === 'string')
}

/** The largest file a deposit carries, as on mndt-web (the gateway allows the base64 overhead). */
export const MAX_DEPOSIT_BYTES = 20 * 1024 * 1024

/** @param file - a file. @returns its bytes in base64, without the data URL prefix. */
export async function base64Of(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let at = 0; at < bytes.length; at += chunk) binary += String.fromCharCode(...bytes.subarray(at, at + chunk))
  return btoa(binary)
}


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
      // 501 while the route is not served. A 404 is either the API's generic « no route … » there, or
      // a channel the reader cannot read (#55, « no channel <id> »): a refusal, said as such.
      if (response.status === 501) return 'absent'
      if (response.status === 404) {
        const refused: unknown = await response.json().catch(() => undefined)
        const error = typeof refused === 'object' && refused !== null ? (refused as { error?: unknown }).error : undefined
        if (typeof error !== 'string' || error.startsWith('no route')) return 'absent'
        throw new DocumentsRefusal(error, 404)
      }
      if (!response.ok) throw await refusalOf(response)
      const body = await response.json() as { documents?: unknown; canDeposit?: unknown; dataClasses?: unknown }
      return {
        // A row of another shape is dropped rather than drawn: the page never renders what it cannot read.
        documents: Array.isArray(body.documents) ? body.documents.filter(isDocument) : [],
        canDeposit: body.canDeposit === true,
        ...(Array.isArray(body.dataClasses) && body.dataClasses.length > 0
          ? { dataClasses: body.dataClasses.filter((c): c is string => typeof c === 'string') }
          : {}),
      }
    },
    async deposit(channelId, file, dataClass) {
      // Refused before sending: a file over the limit would only cost the upload to be refused.
      if (file.size > MAX_DEPOSIT_BYTES) throw new DocumentsRefusal('too large', 413)
      const body = {
        name: file.name,
        type: file.type,
        contentBase64: await base64Of(file),
        ...(dataClass === undefined ? {} : { dataClass }),
      }
      const response = await fetcher(`${BASE}/channels/${id(channelId)}/documents`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
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
