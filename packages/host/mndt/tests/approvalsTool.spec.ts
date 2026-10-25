/**
 * A mission may ask a person to decide, and may never decide for them.
 *
 * The tool server is the seam where that rule lives, so it is tested against a
 * fake product API: the decision tool must not even be listed unless the
 * deployment explicitly allows it, and an unknown kind must be refused before
 * any request reaches the API.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

const tool = join(import.meta.dirname, '..', 'deploy', 'connectors', 'approvals-mcp.mjs')

interface Received {
  readonly method: string
  readonly path: string
  readonly body: string
}

interface Message {
  readonly id?: number
  readonly result?: {
    readonly tools?: readonly { readonly name: string }[]
    readonly isError?: boolean
    readonly content?: readonly { readonly text?: string }[]
  }
}

let child: ReturnType<typeof spawn> | undefined
let server: ReturnType<typeof createServer> | undefined

afterEach(() => {
  child?.kill()
  child = undefined
  server?.close()
  server = undefined
})

/**
 * Start a fake product API and the tool server in front of it.
 * @returns the port of the fake API, the requests it received and a caller.
 */
async function start(allowDecide: boolean): Promise<{ received: Received[]; send: (message: unknown) => void; messages: () => Message[] }> {
  const received: Received[] = []
  const fake = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += String(chunk) })
    request.on('end', () => {
      received.push({ method: request.method ?? 'GET', path: request.url ?? '/', body })
      response.writeHead(request.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' })
      if ((request.url ?? '').startsWith('/approvals') && request.method === 'POST' && !request.url?.includes('/decide')) {
        response.end(JSON.stringify({ approval: { id: 'apr_test', kind: 'send-email', title: 'test', state: 'pending' } }))
        return
      }
      response.end(JSON.stringify({ approvals: [], approval: { id: 'apr_test', state: 'approved' } }))
    })
  })
  server = fake
  await new Promise<void>((resolve) => { fake.listen(0, '127.0.0.1', resolve) })
  const port = (fake.address() as AddressInfo).port
  const started = spawn(process.execPath, [tool], {
    env: {
      ...process.env,
      MNDT_API: `http://127.0.0.1:${port}`,
      MNDT_ACTOR: 'duke@datanalysis.re',
      ...(allowDecide ? { MNDT_APPROVALS_ALLOW_DECIDE: '1' } : {}),
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  child = started
  let output = ''
  started.stdout?.on('data', (chunk) => { output += String(chunk) })
  started.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })}\n`)
  started.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
  await new Promise(resolve => setTimeout(resolve, 800))
  return {
    received,
    send: (message: unknown): void => { started.stdin?.write(`${JSON.stringify(message)}\n`) },
    messages: (): Message[] => output.split('\n').filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line) as Message]
      } catch {
        return []
      }
    }),
  }
}

test('does not offer the decision tool to a mission', async () => {
  const harness = await start(false)
  const names = harness.messages().find(message => message.id === 2)?.result?.tools?.map(tool => tool.name) ?? []
  expect(names).toContain('request_approval')
  expect(names).not.toContain('decide_approval')
})

test('sends a request to the API and reports it as pending', async () => {
  const harness = await start(false)
  harness.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'request_approval', arguments: { kind: 'send-email', title: 'Relance', to: 'client@example.com' } } })
  await new Promise(resolve => setTimeout(resolve, 900))
  const answer = harness.messages().find(message => message.id === 3)?.result?.content?.[0]?.text ?? ''
  expect(answer).toContain('apr_test')
  expect(answer).toContain('nothing was executed')
  const created = harness.received.find(request => request.method === 'POST' && request.path === '/approvals')
  expect(created).toBeDefined()
  expect(created?.body).toContain('send-email')
})

test('refuses an unknown kind before calling the API', async () => {
  const harness = await start(false)
  harness.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'request_approval', arguments: { kind: 'delete-everything', title: 'non' } } })
  await new Promise(resolve => setTimeout(resolve, 700))
  const answer = harness.messages().find(message => message.id === 4)?.result?.content?.[0]?.text ?? ''
  expect(answer).toContain('is not one of')
  expect(harness.received.filter(request => request.method === 'POST').length).toBe(0)
})

test('exposes the decision tool only when the deployment allows it', async () => {
  const harness = await start(true)
  const names = harness.messages().find(message => message.id === 2)?.result?.tools?.map(tool => tool.name) ?? []
  expect(names).toContain('decide_approval')
})
