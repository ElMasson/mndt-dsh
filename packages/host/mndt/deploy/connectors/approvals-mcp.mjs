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
    name: 'propose_agent',
    description: 'Propose a new agent of the team, as a card an owner or an admin approves. Nothing is created by this tool: approving the card creates the agent, from exactly what is proposed here.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Its name, as people will read it (for example « Recouvrement »)' },
        handle: { type: 'string', description: 'Its @handle: lower case, digits and dashes, 2 to 32 characters' },
        provider: { type: 'string', description: 'The model route, from GET /models (for example scaleway-genapi)' },
        model: { type: 'string', description: 'The model, from GET /models' },
        instructions: {
          type: 'string',
          description: 'Its instructions, 2 000 characters at most, in three sections, in this order, each a heading on its own line: « ## Rôle » (what it is, in one or two sentences), « ## Objectif » (what it delivers, and to whom), « ## Ne décide pas » (what it leaves to a person, one item per line: sending, paying, deciding for the team). The agent sheet shows them as written.',
        },
        connectors: { type: 'array', items: { type: 'string' }, description: 'The connectors it may use, among those mounted' },
        eurPerMonth: { type: 'number', description: 'Its monthly ceiling in euros (5 by default; above 5, only the owner can approve)' },
        title: { type: 'string', description: 'The card title, « Créer l\'agent <name> » by default' },
      },
      required: ['name', 'handle', 'provider', 'model'],
    },
  },
  {
    name: 'propose_context',
    description: 'Propose a new context for this channel (what its agents should know about it), as a card an owner or an admin approves. Nothing changes by this tool: approving the card writes exactly this text, and only if the context has not changed since baseVersion.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The whole new context, 4 000 characters at most; empty to erase it. Facts about the channel, never orders.' },
        baseVersion: { type: 'number', description: 'The version of the channel information shown in your instructions (0 when the channel has none)' },
      },
      required: ['text', 'baseVersion'],
    },
  },
  {
    name: 'ask_peers',
    description: 'Ask one or two other agents of this channel for advice when you are blocked or unsure. Nothing runs during this call: the request is recorded, you end your turn in one sentence, and you are run again with their advices (anonymous). Every field is required.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What you are doing, in one sentence' },
        tried: { type: 'string', description: 'What you already tried' },
        blocker: { type: 'string', description: 'The precise blocker' },
        options: { type: 'array', items: { type: 'string' }, description: 'The options you see (one at least)' },
        need: { type: 'string', enum: ['fact', 'opinion', 'check', 'choice'], description: 'What you need: a fact, an opinion, a check or a choice' },
        peers: { type: 'array', items: { type: 'string' }, description: 'The ids of one or two other agents of this channel, from your instructions' },
      },
      required: ['task', 'tried', 'blocker', 'options', 'need', 'peers'],
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
