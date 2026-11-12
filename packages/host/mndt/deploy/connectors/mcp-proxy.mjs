#!/usr/bin/env node
/**
 * Read-only MCP proxy.
 *
 * Some connectors expose write tools next to read tools (Attio: create-record,
 * delete-comment, ...; Dolibarr: dolibarr_raw_api, create_invoice, ...). A mission
 * should be able to read a system without being able to change it. This proxy
 * spawns the real server, forwards the protocol, and removes every tool that is
 * not on the allow list or that is on the deny list: a call to a removed tool is
 * answered with an error and never reaches the server.
 *
 *   MCP_PROXY_ALLOW="search-records,list-records,get-*" \
 *   MCP_PROXY_DENY="dolibarr_raw_api" node mcp-proxy.mjs npx -y mcp-remote <url>
 *
 * Patterns end with `*` for a prefix match, otherwise they match exactly. The
 * deny list wins over the allow list, so a broad `get_*` cannot let a named
 * write through.
 *
 * Every message is re-serialized from what this proxy parsed, never forwarded as
 * raw text: a line the proxy cannot parse is refused, and the server never sees a
 * message the proxy has not checked. Without that, a line that JavaScript refuses
 * but a laxer parser accepts (`NaN` in Python, for instance) would reach the
 * server unfiltered.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const [command, ...args] = process.argv.slice(2)
if (command === undefined) {
  process.stderr.write('mcp-proxy: a command is required after the proxy name\n')
  process.exit(2)
}

/** @param value - a comma-separated pattern list. @returns the patterns. */
function patterns(value) {
  return (value ?? '')
    .split(',')
    .map(pattern => pattern.trim())
    .filter(pattern => pattern.length > 0)
}

const allow = patterns(process.env.MCP_PROXY_ALLOW)
const deny = patterns(process.env.MCP_PROXY_DENY)

/** @param name - tool name. @param list - patterns. @returns whether a pattern matches. */
function matches(name, list) {
  return list.some(pattern => pattern.endsWith('*')
    ? name.startsWith(pattern.slice(0, -1))
    : name === pattern)
}

/** @param name - tool name. @returns whether the mission may call it. */
function allowed(name) {
  if (typeof name !== 'string' || name === '') return false
  if (allow.length === 0) return false
  if (matches(name, deny)) return false
  return matches(name, allow)
}

const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], env: process.env })
child.on('exit', (code) => { process.exit(code ?? 0) })
child.on('error', (error) => {
  process.stderr.write(`mcp-proxy: child failed: ${error.message}\n`)
  process.exit(1)
})

/** @param message - one server message. @returns it, with its tool list filtered. */
function filterOutgoing(message) {
  if (message === null || typeof message !== 'object' || message.result === undefined) return message
  const result = message.result
  if (result === null || typeof result !== 'object' || !Array.isArray(result.tools)) return message
  return { ...message, result: { ...result, tools: result.tools.filter(tool => allowed(tool?.name)) } }
}

const lines = createInterface({ input: child.stdout })
lines.on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    // Server noise on stdout is not protocol: dropping it keeps the client's
    // parser out of trouble and cannot widen what the mission sees.
    process.stderr.write(`mcp-proxy: dropped a non-JSON line from the server\n`)
    return
  }
  const filtered = Array.isArray(message) ? message.map(filterOutgoing) : filterOutgoing(message)
  process.stdout.write(`${JSON.stringify(filtered)}\n`)
})

/** @param id - request id. @param name - tool name. @returns the refusal answered in place of the server. */
function refusal(id, name) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      isError: true,
      content: [{ type: 'text', text: `mcp-proxy: tool ${String(name)} is outside the read-only allow list` }],
    },
  }
}

/**
 * @param message - one client message.
 * @returns the message to forward, or a refusal to answer locally.
 */
function screen(message) {
  if (message !== null && typeof message === 'object' && message.method === 'tools/call') {
    const name = message.params?.name
    if (!allowed(name)) return { refused: refusal(message.id, name) }
  }
  return { forward: message }
}

const incoming = createInterface({ input: process.stdin })
incoming.on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'mcp-proxy: parse error' } })}\n`)
    return
  }
  if (Array.isArray(message)) {
    // A JSON-RPC batch: screen each element, answer the refused ones here and
    // forward only the rest.
    const forward = []
    for (const item of message) {
      const decision = screen(item)
      if (decision.refused !== undefined) process.stdout.write(`${JSON.stringify(decision.refused)}\n`)
      else forward.push(decision.forward)
    }
    if (forward.length > 0) child.stdin.write(`${JSON.stringify(forward)}\n`)
    return
  }
  const decision = screen(message)
  if (decision.refused !== undefined) {
    process.stdout.write(`${JSON.stringify(decision.refused)}\n`)
    return
  }
  child.stdin.write(`${JSON.stringify(decision.forward)}\n`)
})
