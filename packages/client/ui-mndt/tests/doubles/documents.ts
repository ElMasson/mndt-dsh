/**
 * A double of the documents route, for the tests and the rehearsal: deposits and retirements change
 * its lists. Never part of what is served.
 */
import { DocumentsRefusal, MAX_DEPOSIT_BYTES } from '../../src/client/documents.ts'
import type { ChannelDocument, DocumentsFace, DocumentsPage } from '../../src/client/documents.ts'

/** What the double starts with, per channel; `absent` plays a workbench without the route. */
export type DocumentsSeed = Readonly<Record<string, DocumentsPage>> | 'absent'

/**
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
      if (file.size > MAX_DEPOSIT_BYTES) return Promise.reject(new DocumentsRefusal('too large', 413))
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
