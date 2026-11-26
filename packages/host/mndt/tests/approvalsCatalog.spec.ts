/**
 * An agent proposing an agent sees the connectors mounted in its space
 * (Stéphane's test at the 7th jump: « @assistant propose-moi un agent Veille »
 * asked for a web search connector that does not exist, and the card was
 * refused). propose_agent's schema names them as its connectors' only values; the
 * API's refusal names them too (conversation.host.spec.ts).
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'

const APPROVALS = join(import.meta.dirname, '..', 'deploy', 'connectors', 'approvals-mcp.mjs')
const children: ChildProcess[] = []
const servers: Server[] = []
afterEach(() => {
  for (const child of children.splice(0)) child.kill()
  for (const server of servers.splice(0)) server.close()
})

/** A tool as listed. */
interface Listed {
  readonly name: string
  readonly description: string
  readonly inputSchema: { readonly properties: Record<string, unknown> }
}

/** @param api - the API's address. @returns the tools the server lists. */
async function listed(api: string): Promise<Listed[]> {
  const env = { ...process.env, MNDT_API: api, MNDT_ACTOR: 'duke@datanalysis.re' }
  const child = spawn(process.execPath, [APPROVALS], { stdio: ['pipe', 'pipe', 'ignore'], env })
  children.push(child)
  const reply = new Promise<string>((resolve) => {
    createInterface({ input: child.stdout }).on('line', (line) => { if (line.includes('"tools"')) resolve(line) })
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`)
  return (JSON.parse(await reply) as { result: { tools: Listed[] } }).result.tools
}

describe('propose_agent names the connectors mounted in its space', () => {
  it('from the API: as the only values of its connectors (the schema says it shortest)', async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      const connectors = [
        { module: 'm', server: 'office365', enabled: true },
        { module: 'm', server: 'qonto', enabled: false },
        { module: 'm', server: 'attio', enabled: true },
      ]
      response.end(JSON.stringify(request.url === '/connectors' ? { connectors } : {}))
    })
    servers.push(server)
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    const tools = await listed(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
    const propose = tools.find(tool => tool.name === 'propose_agent')
    expect(propose?.inputSchema.properties.connectors).toEqual({ type: 'array', items: { type: 'string', enum: ['office365', 'attio'] } })
  })

  it('without an answer from the API: the tools as written, listed at once', async () => {
    const started = Date.now()
    const tools = await listed('http://127.0.0.1:9')
    expect(Date.now() - started).toBeLessThan(3000)
    const connectors = tools.find(tool => tool.name === 'propose_agent')?.inputSchema.properties.connectors
    expect(connectors).toEqual({ type: 'array', items: { type: 'string' } })
  })
})
