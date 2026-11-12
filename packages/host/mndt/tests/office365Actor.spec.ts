/**
 * In application mode the Office365 connector reads the mailbox of the person
 * who mentioned the agent, and no other (decision D3). The workbench publishes
 * that person in the actor file for one turn at a time. A fake login and Graph
 * server records every path the connector asks for: two turns by two people in
 * two channels must each read their own mailbox only, and a turn with no person,
 * an agent identity or an outside address must not reach Graph at all.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

const connector = join(import.meta.dirname, '..', 'deploy', 'connectors', 'office365-mcp.mjs')

interface Message {
  readonly id?: number
  readonly result?: {
    readonly tools?: readonly { readonly name: string }[]
    readonly isError?: boolean
    readonly content?: readonly { readonly text?: string }[]
  }
}

let server: ReturnType<typeof createServer> | undefined
let child: ReturnType<typeof spawn> | undefined
let paths: string[] = []
let tokenRequests: string[] = []
let actorFile = ''
let output = ''
let nextId = 1

beforeEach(async () => {
  paths = []
  tokenRequests = []
  output = ''
  server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += String(chunk) })
    request.on('end', () => {
      const url = request.url ?? '/'
      response.writeHead(200, { 'content-type': 'application/json' })
      if (url.includes('/oauth2/v2.0/token')) {
        tokenRequests.push(body)
        response.end(JSON.stringify({ access_token: 'fake', expires_in: 3600 }))
        return
      }
      paths.push(url.split('?')[0]!)
      const owner = decodeURIComponent(url.split('/')[3] ?? '')
      response.end(JSON.stringify({ value: [{ subject: `courrier de ${owner}`, receivedDateTime: '2026-11-12T08:00:00Z', from: { emailAddress: { address: 'x@y.fr' } }, bodyPreview: '' }] }))
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const directory = mkdtempSync(join(tmpdir(), 'o365-'))
  actorFile = join(directory, 'mission-actor.json')
  child = spawn(process.execPath, [connector], {
    env: {
      ...process.env,
      OFFICE365_MODE: 'application',
      OFFICE365_TENANT_ID: 'tenant-test',
      OFFICE365_CLIENT_ID: 'client-test',
      OFFICE365_CLIENT_SECRET: 'not-a-secret',
      OFFICE365_ALLOWED_DOMAINS: 'datanalysis.re',
      OFFICE365_GRAPH_URL: `http://127.0.0.1:${port}/v1.0`,
      OFFICE365_LOGIN_URL: `http://127.0.0.1:${port}`,
      MNDT_ACTOR_FILE: actorFile,
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  child.stdout?.on('data', (chunk) => { output += String(chunk) })
})

afterEach(() => {
  child?.kill()
  child = undefined
  server?.close()
  server = undefined
  if (actorFile !== '') rmSync(actorFile, { force: true })
})

/** Send one request and wait for its answer. */
async function ask(method: string, params?: unknown): Promise<Message> {
  const id = nextId++
  child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = output.split('\n').filter(Boolean).map(line => JSON.parse(line) as Message).find(message => message.id === id)
    if (found !== undefined) return found
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error(`no answer to ${method}`)
}

const text = (message: Message): string => message.result?.content?.[0]?.text ?? ''

/** What the workbench does around a turn: publish the author of the mention. */
function turnBy(actor: string, channel: string): void {
  writeFileSync(actorFile, JSON.stringify({ actor, missionId: `turn-${channel}` }))
}

test('lists read tools only, nothing that sends', async () => {
  const listed = (await ask('tools/list')).result?.tools?.map(tool => tool.name) ?? []
  expect(listed.sort()).toEqual(['calendar_upcoming', 'mail_recent', 'mail_search'])
})

test('two turns in two channels each read the mailbox of their own author', async () => {
  turnBy('alice@datanalysis.re', 'a')
  const first = await ask('tools/call', { name: 'mail_recent', arguments: {} })
  turnBy('bob@datanalysis.re', 'b')
  const second = await ask('tools/call', { name: 'mail_recent', arguments: {} })
  expect(paths).toEqual(['/v1.0/users/alice%40datanalysis.re/messages', '/v1.0/users/bob%40datanalysis.re/messages'])
  expect(text(first)).toContain('alice@datanalysis.re')
  expect(text(second)).toContain('bob@datanalysis.re')
  expect(text(second)).not.toContain('alice')
  expect(tokenRequests[0]).toContain('grant_type=client_credentials')
})

test('the calendar follows the author too', async () => {
  turnBy('Carole@DataNalysis.re', 'c')
  await ask('tools/call', { name: 'calendar_upcoming', arguments: { days: 3 } })
  expect(paths).toEqual(['/v1.0/users/carole%40datanalysis.re/calendarView'])
})

test.each([
  ['no turn running', undefined],
  ['an agent identity', 'scheduler'],
  ['an address outside the allowed domains', 'someone@example.com'],
  ['a path disguised as an address', '../admin@datanalysis.re'],
])('refuses %s without calling Graph', async (_label, actor) => {
  if (actor !== undefined) turnBy(actor, 'x')
  const answer = await ask('tools/call', { name: 'mail_recent', arguments: {} })
  expect(answer.result?.isError).toBe(true)
  expect(paths).toEqual([])
  expect(tokenRequests).toEqual([])
})

test('once the turn settled, the previous author is not read again', async () => {
  turnBy('alice@datanalysis.re', 'a')
  await ask('tools/call', { name: 'mail_recent', arguments: {} })
  rmSync(actorFile, { force: true })
  const after = await ask('tools/call', { name: 'mail_search', arguments: { query: 'facture' } })
  expect(after.result?.isError).toBe(true)
  expect(paths).toEqual(['/v1.0/users/alice%40datanalysis.re/messages'])
})
