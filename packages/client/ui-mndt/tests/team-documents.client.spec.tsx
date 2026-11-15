// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamDocuments, sizeOf } from '../src/client/TeamDocuments.tsx'
import { DocumentsRefusal, createHttpDocuments, createMockDocuments } from '../src/client/documents.ts'
import type { DocumentsFace } from '../src/client/documents.ts'
import { chatFrench } from '../src/client/chatLocales.ts'

afterEach(() => { cleanup() })

const doc = {
  id: 'doc_1', name: '<img src=x onerror=alert(1)>.pdf', size: 248_312, type: 'application/pdf', pages: 3,
  uploadedBy: 'smarion@datanalysis.re', uploadedAt: '2026-11-14T09:00:00.000Z', canRetire: true,
}

/** @param body - the JSON. @param status - the HTTP status. @returns a response. */
function answer(status: number, body: unknown = {}): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

describe('the documents route, as the page reads it', () => {
  it('a 404 or a 501 on a known channel means the route is not served', async () => {
    expect(await createHttpDocuments(async () => answer(404)).list('chn_1')).toBe('absent')
    expect(await createHttpDocuments(async () => answer(501)).list('chn_1')).toBe('absent')
  })

  it('reads the list, what the reader may do, and the classes only when served', async () => {
    const face = createHttpDocuments(async () => answer(200, { documents: [doc], canDeposit: true }))
    expect(await face.list('chn_1')).toEqual({ documents: [doc], canDeposit: true })
    const classed = createHttpDocuments(async () => answer(200, { documents: [], canDeposit: false, dataClasses: ['C-int'] }))
    expect(await classed.list('chn_1')).toEqual({ documents: [], canDeposit: false, dataClasses: ['C-int'] })
  })

  it('deposits as multipart on the team API, and carries a refusal with its status', async () => {
    const fetcher = vi.fn(async (_input: string, _init?: RequestInit) => answer(413, { error: 'too large' }))
    const face = createHttpDocuments(fetcher)
    await expect(face.deposit('chn 1', new File(['x'], 'a.pdf'))).rejects.toMatchObject({ status: 413, message: 'too large' })
    expect(fetcher.mock.calls[0]?.[0]).toBe('/mndt-api/channels/chn%201/documents')
    expect(fetcher.mock.calls[0]?.[1]?.body).toBeInstanceOf(FormData)
  })

  it('says sizes as a person reads them', () => {
    expect(sizeOf(512)).toBe('512 o')
    expect(sizeOf(248_312)).toMatch(/^242,5\sKo$/u)
    expect(sizeOf(3 * 1024 * 1024)).toMatch(/^3\sMo$/u)
  })
})

describe('the DOCUMENTS section', () => {
  it('says « Bientôt » and offers nothing while the route is not served', async () => {
    render(<TeamDocuments face={createMockDocuments('absent')} channelId="chn_1" t={chatFrench} />)
    expect((await screen.findByTestId('documents-soon')).textContent).toBe('Bientôt : les documents du canal arrivent avec leur route.')
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByTestId('document-deposit')).toBeNull()
  })

  it('lists a document: its name as text, downloaded from the team API, and its facts', async () => {
    render(<TeamDocuments face={createMockDocuments({ chn_1: { documents: [doc], canDeposit: false } })} channelId="chn_1" names={{ 'smarion@datanalysis.re': 'Sophie Marion' }} t={chatFrench} />)
    const link = await screen.findByRole('link', { name: `Télécharger ${doc.name}` })
    // Another person's file name stays text: no element is made from it.
    expect(link.textContent).toBe(doc.name)
    expect(link.querySelector('img')).toBeNull()
    expect(link.getAttribute('href')).toBe('/mndt-api/channels/chn_1/documents/doc_1/content')
    expect(link.hasAttribute('download')).toBe(true)
    expect(screen.getByTestId('channel-document').textContent).toContain('3 pages')
    expect(screen.getByTestId('channel-document').textContent).toContain('Sophie Marion')
    expect(screen.queryByTestId('document-deposit')).toBeNull()
  })

  it('deposits without a class when none is served, and the list follows', async () => {
    render(<TeamDocuments face={createMockDocuments({ chn_1: { documents: [], canDeposit: true } })} channelId="chn_1" t={chatFrench} />)
    expect(await screen.findByText('Aucun document dans ce canal.')).toBeTruthy()
    expect(screen.queryByText('Classe de données')).toBeNull()
    fireEvent.change(screen.getByLabelText('Déposer un document'), { target: { files: [new File(['bonjour'], 'note.txt', { type: 'text/plain' })] } })
    fireEvent.click(screen.getByRole('button', { name: 'Déposer' }))
    await waitFor(() => { expect(screen.getByRole('link', { name: 'Télécharger note.txt' })).toBeTruthy() })
  })

  it('asks for a class only when the route serves classes', async () => {
    render(<TeamDocuments face={createMockDocuments({ chn_1: { documents: [], canDeposit: true, dataClasses: ['C-int', 'C-fin'] } })} channelId="chn_1" t={chatFrench} />)
    fireEvent.change(await screen.findByLabelText('Déposer un document'), { target: { files: [new File(['x'], 'a.pdf')] } })
    const send = screen.getByRole('button', { name: 'Déposer' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Classe de données'), { target: { value: 'C-int' } })
    expect(send.disabled).toBe(false)
  })

  it('says a refused deposit in words, by its kind', async () => {
    const refusing: DocumentsFace = {
      list: async () => ({ documents: [], canDeposit: true }),
      deposit: async () => { throw new DocumentsRefusal('unsupported', 415) },
      retire: async () => { throw new Error('non utilise') },
    }
    render(<TeamDocuments face={refusing} channelId="chn_1" t={chatFrench} />)
    fireEvent.change(await screen.findByLabelText('Déposer un document'), { target: { files: [new File(['x'], 'a.exe')] } })
    fireEvent.click(screen.getByRole('button', { name: 'Déposer' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Ce format n\'est pas accepté : PDF ou texte.')
  })

  it('retires a document with its reason, and the list follows', async () => {
    render(<TeamDocuments face={createMockDocuments({ chn_1: { documents: [doc], canDeposit: false } })} channelId="chn_1" t={chatFrench} />)
    fireEvent.click(await screen.findByTestId('document-retire'))
    const confirm = screen.getByRole('button', { name: 'Retirer ce document' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Motif (obligatoire)'), { target: { value: 'doublon' } })
    fireEvent.click(confirm)
    await waitFor(() => { expect(screen.getByText('Aucun document dans ce canal.')).toBeTruthy() })
  })
})
