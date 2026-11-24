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
    // « method not found », never an empty result that could pass for a successful probe.
    expect(reply?.error?.code).toBe(-32601)
    expect(reply?.result).toBeUndefined()
  })

  it('a message without an id (a notification) gets nothing, even a ping or a tools/list', async () => {
    const server = start(path)
    server.send({ method: 'ping' })
    server.send({ method: 'tools/list', params: {} })
    server.send({ method: 'server/discover', params: {} })
    server.send({ id: null, method: 'ping' })
    server.send({ id: 11, method: 'ping' })
    expect((await server.replyTo(11, 3000))?.result).toEqual({})
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(server.replies.map(entry => entry.reply.id)).toEqual([11])
  })

  it('the method named in the error is bounded to 64 characters', async () => {
    const server = start(path)
    server.send({ id: 12, method: `x${'y'.repeat(500)}` })
    const reply = await server.replyTo(12, 3000) as { error?: { message?: string } } | undefined
    expect(reply?.error?.message?.length).toBeLessThan(140)
    expect(reply?.error?.message).toContain(`x${'y'.repeat(63)}`)
    expect(reply?.error?.message).not.toContain('y'.repeat(64))
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

describe('the read-only proxy answers the probe itself', () => {
  /** A third-party server that answers the classic handshake only, and leaves every other request pending. */

  it('a mute third-party server behind the proxy is ready for the engine\'s client in under 2 s', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'mndt-mute-'))
    const MUTE = join(dir, 'mute-mcp.mjs')
    writeFileSync(MUTE, [
      "import { createInterface } from 'node:readline'",
      "const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')",
      "createInterface({ input: process.stdin }).on('line', (line) => {",
      '  const m = JSON.parse(line)',
      "  if (m.method === 'initialize') out({ id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mute', version: '1' } } })",
      "  if (m.method === 'tools/list') out({ id: m.id, result: { tools: [{ name: 'list_things', inputSchema: { type: 'object' } }] } })",
      '})',
    ].join('\n'))
    // The engine's own client, from the package that uses it (@modelcontextprotocol/client 2.2.0).
    const { createRequire } = await import('node:module')
    const { pathToFileURL } = await import('node:url')
    const sdk = createRequire(join(import.meta.dirname, '..', '..', '..', 'mcp', 'mcp-client', 'package.json'))
    const { Client } = await import(pathToFileURL(sdk.resolve('@modelcontextprotocol/client')).href) as { Client: new (info: object, options: object) => { connect(t: unknown): Promise<void>; listTools(): Promise<{ tools: { name: string }[] }>; close(): Promise<void> } }
    const { StdioClientTransport } = await import(pathToFileURL(sdk.resolve('@modelcontextprotocol/client/stdio')).href) as { StdioClientTransport: new (options: object) => unknown }
    const connectTo = async (args: string[]) => {
      // As the engine creates it (mcp-client/src/connection.ts): « auto » negotiation is what sends the server/discover probe.
      const client = new Client({ name: 'probe', version: '0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
      const started = Date.now()
      await client.connect(new StdioClientTransport({ command: process.execPath, args, env: { ...process.env, MCP_PROXY_ALLOW: 'list_things' } as Record<string, string>, stderr: 'ignore' }))
      const listed = (await client.listTools()).tools.map(tool => tool.name)
      const ms = Date.now() - started
      // Closing is not timed: the proxy does not pass its end of input on, so
      // the client waits for the child before ending it (shutdown only).
      await client.close()
      return { listed, ms }
    }
    // The same server alone does not answer the probe: it is the proxy that answers.
    try {
      const behind = await connectTo([join(deploy, 'connectors', 'mcp-proxy.mjs'), process.execPath, MUTE])
      expect(behind.listed).toEqual(['list_things'])
      expect(behind.ms).toBeLessThan(2000)
      // The same server alone does not answer the probe: it is the proxy that answers.
      const alone = start(MUTE)
      alone.send({ id: 1, method: 'server/discover', params: {} })
      expect(await alone.replyTo(1, 1000)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20000)

  it('only the probe is answered by the proxy; a probe without id is dropped; other methods reach the server', async () => {
    const child = spawn(process.execPath, [join(deploy, 'connectors', 'mcp-proxy.mjs'), process.execPath, SERVERS.approvals], {
      stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, MCP_PROXY_ALLOW: 'request_approval', MNDT_API: 'http://127.0.0.1:9' },
    })
    children.push(child)
    const lines: { id?: unknown; error?: { message?: string }; result?: unknown }[] = []
    createInterface({ input: child.stdout! }).on('line', (line) => { lines.push(JSON.parse(line) as { id?: unknown }) })
    const send = (m: object): void => {
      const framed = Array.isArray(m) ? m.map((item: object) => ({ jsonrpc: '2.0', ...item })) : { jsonrpc: '2.0', ...m }
      child.stdin!.write(`${JSON.stringify(framed)}\n`)
    }
    send({ method: 'server/discover', params: {} })
    send({ id: 2, method: 'server/discover', params: {} })
    send({ id: 3, method: 'resources/list', params: {} })
    // A batch: the probe in it is answered by the proxy too (the servers here do not take batches).
    send([{ id: 4, method: 'server/discover' }])
    const started = Date.now()
    while (lines.length < 3 && Date.now() - started < 3000) await new Promise(resolve => setTimeout(resolve, 10))
    const byId = new Map(lines.map(line => [line.id, line]))
    expect(byId.get(2)?.error?.message).toBe('mcp-proxy: method not found: server/discover')
    expect(byId.get(4)?.error?.message).toBe('mcp-proxy: method not found: server/discover')
    // Relayed: the server's own answers.
    expect(byId.get(3)?.error?.message).toContain('approvals: method not found')
    expect(lines.some(line => line.id === undefined || line.id === null)).toBe(false)
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
