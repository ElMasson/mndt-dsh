/**
 * The read-only connector proxy is the only thing between a mission and a CRM
 * write. It deserves a test that does not need the network: a stub server
 * exposes one read tool and one write tool, and the proxy must show only the
 * first and refuse a call to the second.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

const proxy = join(import.meta.dirname, '..', 'deploy', 'connectors', 'mcp-proxy.mjs')

/** A minimal MCP server over stdio: two tools, one of them a write. */
const stub = `
import { createInterface } from 'node:readline'
const lines = createInterface({ input: process.stdin })
const tools = [
  { name: 'search-records', description: 'read', inputSchema: { type: 'object', properties: {} } },
  { name: 'create-record', description: 'write', inputSchema: { type: 'object', properties: {} } },
]
lines.on('line', (line) => {
  const message = JSON.parse(line)
  const reply = (payload) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...payload }) + '\\n')
  if (message.method === 'initialize') return reply({ result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1' } } })
  if (message.method === 'tools/list') return reply({ result: { tools } })
  if (message.method === 'tools/call') return reply({ result: { content: [{ type: 'text', text: 'stub reached ' + message.params.name }] } })
})
`

interface Message {
  readonly id?: number
  readonly result?: {
    readonly tools?: readonly { readonly name: string }[]
    readonly isError?: boolean
    readonly content?: readonly { readonly text?: string }[]
  }
}

let child: ReturnType<typeof spawn> | undefined

afterEach(() => {
  child?.kill()
  child = undefined
})

/**
 * Start the proxy over a stub server.
 * @param allow - the allow list handed to the proxy.
 * @returns the messages the proxy answered, collected by sending a script.
 */
async function probe(allow: string): Promise<{ tools: string[]; writeError: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-proxy-'))
  const stubPath = join(directory, 'stub.mjs')
  writeFileSync(stubPath, stub)
  const started = spawn(process.execPath, [proxy, process.execPath, stubPath], {
    env: { ...process.env, MCP_PROXY_ALLOW: allow },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  child = started
  let output = ''
  started.stdout?.on('data', (chunk) => { output += String(chunk) })
  const send = (message: unknown): void => { started.stdin?.write(`${JSON.stringify(message)}\n`) }
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create-record', arguments: {} } })
  await new Promise(resolve => setTimeout(resolve, 2500))
  const messages = output.split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as Message]
    } catch {
      return []
    }
  })
  const listed = messages.find(message => message.id === 2)?.result?.tools?.map(tool => tool.name) ?? []
  const blocked = messages.find(message => message.id === 3)?.result?.content?.[0]?.text ?? ''
  return { tools: listed, writeError: blocked }
}

test('keeps read tools and hides write tools from the list', async () => {
  const result = await probe('search-records')
  expect(result.tools).toEqual(['search-records'])
})

test('refuses a write call before it reaches the server', async () => {
  const result = await probe('search-records')
  expect(result.writeError).toContain('outside the read-only allow list')
  expect(result.writeError).not.toContain('stub reached')
})

test('exposes nothing when no allow list is configured', async () => {
  const result = await probe('')
  expect(result.tools).toEqual([])
})
