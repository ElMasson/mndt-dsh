#!/usr/bin/env node
/**
 * Approval tools for a mission.
 *
 * A mission may ask a person to decide something sensitive (send an email,
 * publish, spend, delete) and then report the pending decision. It may not
 * decide its own request: the decision tool is only exposed when the deployment
 * explicitly allows it, which the server side does not.
 *
 * Environment: MNDT_API (product API base), MNDT_ACTOR (fallback identity),
 * MNDT_ACTOR_FILE (record a running mission publishes per call).
 */
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'

const API = process.env.MNDT_API ?? 'http://127.0.0.1:8795'
const ACTOR = process.env.MNDT_ACTOR ?? 'duke@datanalysis.re'
const ACTOR_FILE = process.env.MNDT_ACTOR_FILE ?? ''
const MAY_DECIDE = process.env.MNDT_APPROVALS_ALLOW_DECIDE === '1'

/**
 * Who the current call acts for: the running mission publishes its actor, an
 * interactive call falls back to the configured person.
 * @returns the actor, or the configured identity.
 */
async function actorNow() {
  if (ACTOR_FILE === '') return ACTOR
  const raw = await readFile(ACTOR_FILE, 'utf8').catch(() => '')
  try {
    const record = JSON.parse(raw)
    if (typeof record.actor === 'string' && record.actor !== '') return record.actor
  } catch {
    return ACTOR
  }
  return ACTOR
}

const KINDS = ['send-email', 'publish', 'spend', 'delete']

/** @param path - API path. @param init - fetch options. @returns parsed body. */
async function call(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}), 'x-forwarded-email': await actorNow() },
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text }
  }
  if (!response.ok) throw new Error(`API ${response.status}: ${body.error ?? text}`)
  return body
}

const tools = [
  {
    name: 'request_approval',
    description: 'Ask a person to approve a sensitive action. Nothing is executed by this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: KINDS, description: 'What would be done once approved' },
        title: { type: 'string', description: 'One line a person reads to decide' },
        to: { type: 'string', description: 'Recipient, for a send-email approval' },
        subject: { type: 'string', description: 'Subject, for a send-email approval' },
        body: { type: 'string', description: 'Draft body, for a send-email approval' },
        amount: { type: 'number', description: 'Amount, for a spend approval' },
        target: { type: 'string', description: 'What would be published or deleted' },
      },
      required: ['kind', 'title'],
    },
  },
  {
    name: 'list_pending_approvals',
    description: 'List the decisions currently waiting for a person.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_approval',
    description: 'Read one approval and its decision, if any.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
]
if (MAY_DECIDE) {
  tools.push({
    name: 'decide_approval',
    description: 'Decide an approval. Only exposed when the deployment allows it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        decision: { type: 'string', enum: ['approved', 'rejected'] },
        reason: { type: 'string' },
      },
      required: ['id', 'decision'],
    },
  })
}

/** @param name - tool name. @param args - tool arguments. @returns text answer. */
async function run(name, args) {
  if (name === 'request_approval') {
    if (!KINDS.includes(String(args.kind))) throw new Error(`kind ${String(args.kind)} is not one of ${KINDS.join(', ')}`)
    const payload = {}
    for (const key of ['to', 'subject', 'body', 'amount', 'target']) {
      if (args[key] !== undefined) payload[key] = args[key]
    }
    const body = await call('/approvals', {
      method: 'POST',
      body: JSON.stringify({ kind: args.kind, title: args.title, payload }),
    })
    return `pending approval ${body.approval.id} (${body.approval.kind}): ${body.approval.title}. A person must decide it; nothing was executed.`
  }
  if (name === 'list_pending_approvals') {
    const body = await call('/approvals?state=pending')
    if (body.approvals.length === 0) return 'No decision is waiting.'
    return body.approvals.map(row => `${row.id} ${row.kind} ${row.title} (asked by ${row.requestedBy})`).join('\n')
  }
  if (name === 'read_approval') {
    const body = await call('/approvals?state=all')
    const row = body.approvals.find(item => item.id === args.id)
    if (row === undefined) return `No approval ${String(args.id)}.`
    return JSON.stringify(row)
  }
  if (name === 'decide_approval' && MAY_DECIDE) {
    const body = await call(`/approvals/${encodeURIComponent(String(args.id))}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decision: args.decision, ...(args.reason === undefined ? {} : { reason: args.reason }) }),
    })
    return `approval ${body.approval.id} is now ${body.approval.state}`
  }
  throw new Error(`unknown tool ${name}`)
}

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const reply = (payload) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...payload })}\n`)
  if (message.method === 'initialize') {
    reply({ result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'approvals', version: '1.0.0' } } })
    return
  }
  if (message.method === 'tools/list') {
    reply({ result: { tools } })
    return
  }
  if (message.method === 'tools/call') {
    void run(message.params?.name, message.params?.arguments ?? {}).then(
      text => reply({ result: { content: [{ type: 'text', text }] } }),
      error => reply({ result: { isError: true, content: [{ type: 'text', text: `approvals: ${error.message}` }] } }),
    )
  }
})
