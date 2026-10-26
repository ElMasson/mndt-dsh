#!/usr/bin/env node
/**
 * Office365 read-only tools for a mission: mail and calendar, nothing else.
 *
 * The connection is a device-code token stored by the operator on the server
 * (`mcp-auth/office365.json`, mode 600). This server refreshes the access token
 * on demand and never exposes the token itself to the model.
 *
 * Environment: OFFICE365_TOKEN_FILE (default /state/mcp-auth/office365.json),
 * OFFICE365_CLIENT_ID and OFFICE365_TENANT_ID override the stored values.
 * No send tool exists here on purpose: an email leaves only after a person
 * approves it, outside this connector.
 */
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'

const TOKEN_FILE = process.env.OFFICE365_TOKEN_FILE ?? '/state/mcp-auth/office365.json'
const GRAPH = 'https://graph.microsoft.com/v1.0'

let cached = null

/** @returns the stored tokens, read once per process start. */
async function stored() {
  const raw = await readFile(TOKEN_FILE, 'utf8')
  return JSON.parse(raw)
}

/**
 * @param record - stored tokens.
 * @returns an access token valid for the next few minutes.
 */
async function accessToken(record) {
  if (cached !== null && cached.expiresAt > Date.now() + 60_000) return cached.token
  const tenant = process.env.OFFICE365_TENANT_ID ?? record.tenant_id
  const client = process.env.OFFICE365_CLIENT_ID ?? record.client_id
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: client,
    refresh_token: record.refresh_token,
    scope: 'offline_access Mail.Read Calendars.Read',
  })
  const response = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!response.ok) throw new Error(`the Office365 token refresh failed with ${response.status}`)
  const answer = await response.json()
  cached = { token: answer.access_token, expiresAt: Date.now() + Number(answer.expires_in ?? 3600) * 1000 }
  return cached.token
}

/**
 * @param path - Graph path.
 * @param params - query parameters.
 * @returns the parsed body.
 */
async function graph(path, params) {
  const record = await stored()
  const token = await accessToken(record)
  const url = `${GRAPH}${path}?${new URLSearchParams(params).toString()}`
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  const text = await response.text()
  if (!response.ok) throw new Error(`Graph ${response.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

/** @param date - ISO string. @returns a short readable date. */
function short(date) {
  if (typeof date !== 'string') return '?'
  return date.replace('T', ' ').slice(0, 16)
}

const tools = [
  {
    name: 'mail_recent',
    description: 'Read the most recent messages of the duke mailbox (subject, sender, date, preview).',
    inputSchema: {
      type: 'object',
      properties: { count: { type: 'number', description: 'How many messages, 1 to 20' } },
    },
  },
  {
    name: 'mail_search',
    description: 'Search the mailbox for a phrase and return matching messages.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to search for' },
        count: { type: 'number', description: 'How many results, 1 to 20' },
      },
      required: ['query'],
    },
  },
  {
    name: 'calendar_upcoming',
    description: 'Read the upcoming calendar entries for the next days.',
    inputSchema: {
      type: 'object',
      properties: { days: { type: 'number', description: 'Horizon in days, 1 to 30' } },
    },
  },
]

/** @param args - tool arguments. @returns a bounded count. */
function countOf(args, fallback) {
  const value = Number(args.count ?? fallback)
  return Number.isFinite(value) ? Math.min(20, Math.max(1, Math.round(value))) : fallback
}

/** @param name - tool name. @param args - arguments. @returns text for the model. */
async function run(name, args) {
  if (name === 'mail_recent') {
    const body = await graph('/me/messages', {
      $top: String(countOf(args, 5)),
      $orderby: 'receivedDateTime desc',
      $select: 'subject,from,receivedDateTime,bodyPreview',
    })
    const rows = body.value ?? []
    if (rows.length === 0) return 'The mailbox is empty.'
    return rows
      .map(row => `- ${short(row.receivedDateTime)} | ${row.from?.emailAddress?.address ?? '?'} | ${row.subject ?? '(sans objet)'}\n  ${(row.bodyPreview ?? '').replace(/\s+/g, ' ').slice(0, 220)}`)
      .join('\n')
  }
  if (name === 'mail_search') {
    const query = String(args.query ?? '').trim()
    if (query === '') throw new Error('query is required')
    const body = await graph('/me/messages', {
      $search: `"${query}"`,
      $top: String(countOf(args, 5)),
      $select: 'subject,from,receivedDateTime,bodyPreview',
    })
    const rows = body.value ?? []
    if (rows.length === 0) return `No message matches "${query}".`
    return rows
      .map(row => `- ${short(row.receivedDateTime)} | ${row.from?.emailAddress?.address ?? '?'} | ${row.subject ?? '(sans objet)'}`)
      .join('\n')
  }
  if (name === 'calendar_upcoming') {
    const days = Math.min(30, Math.max(1, Math.round(Number(args.days ?? 7))))
    const start = new Date().toISOString()
    const end = new Date(Date.now() + days * 86_400_000).toISOString()
    const body = await graph('/me/calendarView', {
      startDateTime: start,
      endDateTime: end,
      $orderby: 'start/dateTime',
      $top: '20',
      $select: 'subject,start,end,location,organizer',
    })
    const rows = body.value ?? []
    if (rows.length === 0) return `No calendar entry in the next ${days} days.`
    return rows
      .map(row => `- ${short(row.start?.dateTime)} to ${short(row.end?.dateTime)} | ${row.subject ?? '(sans objet)'} | ${row.location?.displayName ?? ''}`)
      .join('\n')
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
    reply({ result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'office365', version: '1.0.0' } } })
    return
  }
  if (message.method === 'tools/list') {
    reply({ result: { tools } })
    return
  }
  if (message.method === 'tools/call') {
    void run(message.params?.name, message.params?.arguments ?? {}).then(
      text => reply({ result: { content: [{ type: 'text', text }] } }),
      error => reply({ result: { isError: true, content: [{ type: 'text', text: `office365: ${error.message}` }] } }),
    )
  }
})
