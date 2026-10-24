#!/usr/bin/env node
/**
 * Read-only MCP proxy.
 *
 * Some connectors expose write tools next to read tools (Attio: create-record,
 * delete-comment, ...). A mission should be able to read a system without being
 * able to change it. This proxy spawns the real server, forwards the protocol,
 * and removes every tool that is not on the allow list: a call to a removed tool
 * is answered with an error and never reaches the server.
 *
 *   MCP_PROXY_ALLOW="search-records,list-records,get-*" node mcp-proxy.mjs npx -y mcp-remote <url>
 *
 * Patterns end with `*` for a prefix match, otherwise they match exactly.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const [command, ...args] = process.argv.slice(2)
if (command === undefined) {
  process.stderr.write('mcp-proxy: a command is required after the proxy name\n')
  process.exit(2)
}

const allow = (process.env.MCP_PROXY_ALLOW ?? '')
  .split(',')
  .map(pattern => pattern.trim())
  .filter(pattern => pattern.length > 0)

/** @param name - tool name. @returns whether the mission may call it. */
function allowed(name) {
  if (allow.length === 0) return false
  return allow.some(pattern => pattern.endsWith('*')
    ? name.startsWith(pattern.slice(0, -1))
    : name === pattern)
}

const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], env: process.env })
child.on('exit', (code) => { process.exit(code ?? 0) })
child.on('error', (error) => {
  process.stderr.write(`mcp-proxy: child failed: ${error.message}\n`)
  process.exit(1)
})

const lines = createInterface({ input: child.stdout })
lines.on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    process.stdout.write(`${text}\n`)
    return
  }
  if (message.id !== undefined && message.result !== undefined) {
    const result = message.result
    if (Array.isArray(result.tools)) {
      const kept = result.tools.filter(tool => allowed(String(tool.name)))
      process.stdout.write(`${JSON.stringify({ ...message, result: { ...result, tools: kept } })}\n`)
      return
    }
  }
  process.stdout.write(`${JSON.stringify(message)}\n`)
})

const incoming = createInterface({ input: process.stdin })
incoming.on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    child.stdin.write(`${text}\n`)
    return
  }
  if (message.method === 'tools/call') {
    const name = message.params?.name
    if (!allowed(String(name))) {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          isError: true,
          content: [{ type: 'text', text: `mcp-proxy: tool ${String(name)} is outside the read-only allow list` }],
        },
      })}\n`)
      return
    }
  }
  child.stdin.write(`${text}\n`)
})
