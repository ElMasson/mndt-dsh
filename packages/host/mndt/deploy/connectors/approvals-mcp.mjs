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
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'

/** A refusal this server writes: its words are served. Any other error's text goes to stderr only. */
class ToolRefusal extends Error {}

/**
 * @param error - what failed under a tool call.
 * @param label - this server's name, for stderr.
 * @returns what the answer may say: the server's own refusal, or a fixed sentence.
 */
function publicMessage(error, label) {
  if (error instanceof ToolRefusal) return error.message
  process.stderr.write(`${label}: a call failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`)
  return 'the call failed'
}

const API = process.env.MNDT_API ?? 'http://127.0.0.1:8795'
const ACTOR = process.env.MNDT_ACTOR ?? 'duke@datanalysis.re'
const ACTOR_FILE = process.env.MNDT_ACTOR_FILE ?? ''
const GATEWAY_SECRET = (() => {
  const path = process.env.MNDT_GATEWAY_SECRET_FILE ?? ''
  if (path === '') return ''
  try { return readFileSync(path, 'utf8').trim() } catch { return '' }
})()
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

/**
 * The run the current call belongs to (a mission, or an agent turn of a
 * mention): the API files a card asked during a turn in that turn's thread.
 * @returns the run id, or an empty string outside a run.
 */
async function runNow() {
  if (ACTOR_FILE === '') return ''
  const raw = await readFile(ACTOR_FILE, 'utf8').catch(() => '')
  try {
    const record = JSON.parse(raw)
    return typeof record.missionId === 'string' ? record.missionId : ''
  } catch {
    return ''
  }
}

const KINDS = ['send-email', 'publish', 'spend', 'delete']

/** @param path - API path. @param init - fetch options. @returns parsed body. */
async function call(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
      'x-forwarded-email': await actorNow(),
      // The API believes this identity only with the gateway's secret (a file outside /state).
      ...(GATEWAY_SECRET === '' ? {} : { 'x-mndt-gateway': GATEWAY_SECRET }),
      ...(await runNow().then(run => (run === '' ? {} : { 'x-mndt-run': run }))),
    },
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text }
  }
  // The product's own refusal (its error, written by the host) is served; any other answer's text is not.
  if (!response.ok && typeof body.error === 'string') throw new ToolRefusal(`API ${response.status}: ${body.error}`)
  if (!response.ok) throw new Error(`API ${response.status}: ${text.slice(0, 300)}`)
  return body
}

const tools = [
  {
    name: 'request_approval',
    description: 'Ask a person to approve a sensitive action. Executes nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: KINDS },
        title: { type: 'string', description: 'One line to decide on' },
        to: { type: 'string', description: 'send-email: recipient' },
        subject: { type: 'string', description: 'send-email: subject' },
        body: { type: 'string', description: 'send-email: draft' },
        amount: { type: 'number', description: 'spend: amount' },
        target: { type: 'string', description: 'publish/delete: what' },
      },
      required: ['kind', 'title'],
    },
  },
  {
    name: 'propose_agent',
    description: 'Propose a new agent, as a card an owner or admin approves. Creates nothing: approval creates exactly this.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        handle: { type: 'string', description: 'a-z, 0-9, dashes; 2-32' },
        provider: { type: 'string', description: 'From GET /models' },
        model: { type: 'string', description: 'From GET /models' },
        instructions: { type: 'string', description: '≤ 2 000 chars: « ## Rôle », « ## Objectif », « ## Ne décide pas » (what it leaves to a person: sending, paying, deciding for the team)' },
        connectors: { type: 'array', items: { type: 'string' } },
        eurPerMonth: { type: 'number', description: 'Monthly ceiling, € (default 5; above 5, owner only)' },
        title: { type: 'string' },
      },
      required: ['name', 'handle', 'provider', 'model'],
    },
  },
  {
    name: 'propose_context',
    description: 'Propose this channel\'s new context (facts, never orders), as a card an owner or admin approves. Changes nothing: approval writes it if unchanged since baseVersion.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '≤ 4 000 chars; empty erases' },
        baseVersion: { type: 'number', description: 'The version in your instructions (0: none)' },
      },
      required: ['text', 'baseVersion'],
    },
  },
  {
    name: 'propose_schedule',
    description: 'Propose a recurring task you will run, as a card an owner or admin approves. Runs nothing: approval schedules exactly this, here.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '≤ 80 chars, one line' },
        instructions: { type: 'string', description: 'What to do each run, ≤ 4 000 chars' },
        cadence: { type: 'object', description: '{ every: day|week|month, days: [1-7] (week), monthDay: 1-28 (month), at: HH:MM } or { cron }; at most hourly' },
        eurPerRun: { type: 'number', description: 'Cost bound per run, € (0.01-5, default 0.5)' },
      },
      required: ['title', 'instructions', 'cadence'],
    },
  },
  {
    name: 'ask_peers',
    description: 'Ask one or two agents of this channel for advice when blocked. Then end your turn in one sentence: you are run again with their advices.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        tried: { type: 'string' },
        blocker: { type: 'string' },
        options: { type: 'array', items: { type: 'string' } },
        need: { type: 'string', enum: ['fact', 'opinion', 'check', 'choice'] },
        peers: { type: 'array', items: { type: 'string' }, description: 'Agent ids from your instructions' },
      },
      required: ['task', 'tried', 'blocker', 'options', 'need', 'peers'],
    },
  },
  {
    name: 'list_pending_approvals',
    description: 'List the decisions waiting for a person.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_approval',
    description: 'Read one approval and its decision.',
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
    if (!KINDS.includes(String(args.kind))) throw new ToolRefusal(`kind ${String(args.kind)} is not one of ${KINDS.join(', ')}`)
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
  if (name === 'propose_agent') {
    const proposal = {}
    for (const key of ['name', 'handle', 'provider', 'model', 'instructions', 'connectors', 'eurPerMonth']) {
      if (args[key] !== undefined) proposal[key] = args[key]
    }
    const body = await call('/approvals', {
      method: 'POST',
      body: JSON.stringify({ kind: 'propose_agent', ...(args.title === undefined ? {} : { title: args.title }), payload: {}, proposal }),
    })
    return `pending approval ${body.approval.id} (propose_agent): ${body.approval.title}. An owner or an admin must approve it; no agent was created.`
  }
  if (name === 'propose_context') {
    const body = await call('/approvals', {
      method: 'POST',
      body: JSON.stringify({ kind: 'propose_context', payload: {}, contextProposal: { text: args.text, baseVersion: args.baseVersion } }),
    })
    return `pending approval ${body.approval.id} (propose_context): ${body.approval.title}. An owner or an admin must approve it; the context did not change.`
  }
  if (name === 'propose_schedule') {
    const schedule = {}
    for (const key of ['title', 'instructions', 'cadence', 'eurPerRun']) {
      if (args[key] !== undefined) schedule[key] = args[key]
    }
    const body = await call('/approvals', {
      method: 'POST',
      body: JSON.stringify({ kind: 'propose_schedule', payload: {}, schedule }),
    })
    return `pending approval ${body.approval.id} (propose_schedule): ${body.approval.title}. An owner or an admin must approve it; nothing is scheduled yet.`
  }
  if (name === 'ask_peers') {
    const body = await call('/help', {
      method: 'POST',
      body: JSON.stringify({ task: args.task, tried: args.tried, blocker: args.blocker, options: args.options, need: args.need, peers: args.peers }),
    })
    return `help request recorded (${body.help.peers} peer(s)). End your turn now, in one sentence: you will be run again with their advices.`
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
  throw new ToolRefusal(`unknown tool ${name}`)
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
  // A message without an id is a notification: never answered, whatever its method.
  if (message.id === undefined || message.id === null) return
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
      error => reply({ result: { isError: true, content: [{ type: 'text', text: `approvals: ${publicMessage(error, 'approvals')}` }] } }),
    )
    return
  }
  if (message.method === 'ping') {
    reply({ result: {} })
    return
  }
  // Any other request is answered, never left pending: the MCP client first
  // probes the newer protocol (server/discover) and, left unanswered, waits its
  // whole request timeout (60 s) before the classic handshake, so the tools
  // arrived a minute after start.
  reply({ error: { code: -32601, message: `approvals: method not found: ${String(message.method).slice(0, 64)}` } })
})
