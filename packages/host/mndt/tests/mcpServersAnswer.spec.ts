/**
 * The stdio MCP servers this repository ships answer every request. The MCP
 * client of the engine first probes the newer protocol (`server/discover`); a
 * server that leaves it unanswered makes the client wait its whole request
 * timeout (60 s) before the classic handshake, so that server's tools were
 * registered a minute after every start (found by the fifth jump's rehearsal:
 * a turn posted after a restart failed on « outils indisponibles : approvals »).
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'

const deploy = join(import.meta.dirname, '..', 'deploy')
const SERVERS = {
  approvals: join(deploy, 'connectors', 'approvals-mcp.mjs'),
  office365: join(deploy, 'connectors', 'office365-mcp.mjs'),
  machine: join(deploy, 'machine-mcp.mjs'),
  workbench_facts: join(deploy, 'connectors', 'facts-mcp.mjs'),
}

interface Reply { readonly id?: unknown; readonly result?: unknown; readonly error?: { readonly code?: number } }

const children: ReturnType<typeof spawn>[] = []
afterEach(() => { for (const child of children.splice(0)) child.kill() })

/** @param path - a server. @returns a sender, and the replies received with their arrival time. */
function start(path: string) {
  const child = spawn(process.execPath, [path], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, MNDT_API: 'http://127.0.0.1:9' } })
  children.push(child)
  const replies: { reply: Reply; at: number }[] = []
  createInterface({ input: child.stdout! }).on('line', (line) => {
    try { replies.push({ reply: JSON.parse(line) as Reply, at: Date.now() }) } catch { /* not protocol */ }
  })
  const send = (message: object): void => { child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`) }
  const replyTo = async (id: number, within: number): Promise<Reply | undefined> => {
    const until = Date.now() + within
    while (Date.now() < until) {
      const found = replies.find(entry => entry.reply.id === id)
      if (found !== undefined) return found.reply
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    return undefined
  }
  return { send, replyTo, replies }
}

describe.each(Object.entries(SERVERS))('the %s MCP server answers every request', (_name, path) => {
  it('the newer protocol\'s probe gets an error at once, not silence', async () => {
    const server = start(path)
    server.send({ id: 7, method: 'server/discover', params: { _meta: {} } })
    const reply = await server.replyTo(7, 3000)
    expect(reply?.error?.code ?? (reply?.result === undefined ? undefined : 'result')).toBeDefined()
  })

  it('a ping is answered; a notification is not; the classic handshake still works', async () => {
    const server = start(path)
    server.send({ id: 8, method: 'ping' })
    expect((await server.replyTo(8, 3000))?.result).toEqual({})
    server.send({ method: 'notifications/initialized' })
    server.send({ id: 9, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
    expect((await server.replyTo(9, 3000))?.result).toBeDefined()
    server.send({ id: 10, method: 'tools/list', params: {} })
    expect(Array.isArray(((await server.replyTo(10, 3000))?.result as { tools?: unknown } | undefined)?.tools)).toBe(true)
    // Only the three requests were answered: the notification got nothing.
    expect(server.replies.map(entry => entry.reply.id)).toEqual([8, 9, 10])
  })
})

describe('the approvals server behind the read-only proxy', () => {
  it('answers the probe at once through mcp-proxy, as the composition runs it', async () => {
    const child = spawn(process.execPath, [join(deploy, 'connectors', 'mcp-proxy.mjs'), process.execPath, SERVERS.approvals], {
      stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, MCP_PROXY_ALLOW: 'request_approval', MNDT_API: 'http://127.0.0.1:9' },
    })
    children.push(child)
    const lines: Reply[] = []
    createInterface({ input: child.stdout! }).on('line', (line) => { lines.push(JSON.parse(line) as Reply) })
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} })}\n`)
    const started = Date.now()
    while (lines.length === 0 && Date.now() - started < 3000) await new Promise(resolve => setTimeout(resolve, 10))
    expect(lines[0]?.error?.code).toBe(-32601)
  })
})
