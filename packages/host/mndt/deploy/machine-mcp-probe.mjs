#!/usr/bin/env node
/** One-shot probe: start the machine MCP server, list its tools, open a page. */
import { spawn } from 'node:child_process'

const child = spawn(process.execPath, [process.argv[2] ?? '/state/connectors/machine-mcp.mjs'], { stdio: ['pipe', 'pipe', 'inherit'] })
const answers = new Map()
let buffer = ''
child.stdout.on('data', (chunk) => {
  buffer += String(chunk)
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line !== '') {
      const message = JSON.parse(line)
      answers.set(message.id, message)
      const result = message.result ?? message.error
      const preview = JSON.stringify(result).slice(0, 260)
      console.log(`reponse ${message.id}: ${preview}`)
    }
    index = buffer.indexOf('\n')
  }
})

const send = (id, method, params) => {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
}

send(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1' } })
setTimeout(() => {
  send(2, 'tools/list', {})
  send(3, 'tools/call', { name: 'machine_browser_open', arguments: { url: 'https://example.com' } })
}, 400)
setTimeout(() => {
  send(4, 'tools/call', { name: 'machine_browser_read', arguments: {} })
  send(5, 'tools/call', { name: 'machine_close', arguments: { target: 'browser' } })
}, 12000)
setTimeout(() => {
  child.kill()
  process.exit(answers.has(5) ? 0 : 1)
}, 25000)
