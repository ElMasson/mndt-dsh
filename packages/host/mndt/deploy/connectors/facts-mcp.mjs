#!/usr/bin/env node
/**
 * A minimal MCP server over stdio, mounted to prove the connector path end to end.
 *
 * It exposes one read-only tool that returns the contents of a facts file. It is
 * deliberately small: the point is that a mission reaches a real MCP tool through
 * the mounted server, not that this connector knows a business system.
 */
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const FACTS_FILE = process.env.WORKBENCH_FACTS_FILE ?? '/opt/mndt-tools/facts.md'

/**
 * Read the facts file.
 * @returns its text, or an explicit absence message.
 */
function facts() {
  try {
    return readFileSync(FACTS_FILE, 'utf8').trim()
  } catch (error) {
    return `facts file unavailable: ${error.message}`
  }
}

/** @param id - request id. @param result - JSON result. */
function answer(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

const tools = [{
  name: 'workbench_facts',
  description: 'Read the workbench facts file and return it verbatim.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}]

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return
  }
  const { id, method, params } = message
  if (method === 'initialize') {
    answer(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'workbench-facts', version: '1.0.0' },
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') {
    answer(id, {})
    return
  }
  if (method === 'tools/list') {
    answer(id, { tools })
    return
  }
  if (method === 'tools/call') {
    const name = params?.name
    if (name !== 'workbench_facts') {
      answer(id, { isError: true, content: [{ type: 'text', text: `unknown tool ${String(name)}` }] })
      return
    }
    answer(id, { content: [{ type: 'text', text: facts() }] })
    return
  }
  if (id !== undefined) {
    answer(id, {})
  }
})
