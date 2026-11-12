#!/usr/bin/env node
/**
 * Office365 read-only tools for a turn: mail and calendar, nothing else.
 *
 * Two modes, chosen by OFFICE365_MODE:
 *
 * - `application` (agentic Slack, decision D3): an application permission
 *   (Mail.Read, Calendars.Read) that Exchange restricts to the team's group. The
 *   tools read the mailbox of the person the running turn acts for, that is the
 *   author of the mention, published by the workbench in MNDT_ACTOR_FILE. No
 *   actor, an actor that is not an address, or an address outside
 *   OFFICE365_ALLOWED_DOMAINS: the call is refused. The domain list is a second
 *   lock behind the Exchange restriction, never a replacement for it.
 *   Credentials: OFFICE365_TENANT_ID, OFFICE365_CLIENT_ID and the secret in
 *   OFFICE365_CLIENT_SECRET or the file OFFICE365_CLIENT_SECRET_FILE.
 * - `delegated` (default, the earlier single mailbox): a device-code token
 *   stored by the operator (`mcp-auth/office365.json`, mode 600), refreshed on
 *   demand; OFFICE365_OWNER refuses a human mission by someone else.
 *
 * No send tool exists here on purpose: an email leaves only after a person
 * approves it, outside this connector. The token is never shown to the model.
 * OFFICE365_GRAPH_URL and OFFICE365_LOGIN_URL exist for tests.
 */
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'

const MODE = process.env.OFFICE365_MODE === 'application' ? 'application' : 'delegated'
const TOKEN_FILE = process.env.OFFICE365_TOKEN_FILE ?? '/state/mcp-auth/office365.json'
const ACTOR_FILE = process.env.MNDT_ACTOR_FILE ?? ''
const OWNER = process.env.OFFICE365_OWNER ?? ''
const GRAPH = process.env.OFFICE365_GRAPH_URL ?? 'https://graph.microsoft.com/v1.0'
const LOGIN = process.env.OFFICE365_LOGIN_URL ?? 'https://login.microsoftonline.com'
const DOMAINS = (process.env.OFFICE365_ALLOWED_DOMAINS ?? '')
  .split(',')
  .map(domain => domain.trim().toLowerCase())
  .filter(domain => domain.length > 0)
const ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/

let cached = null

/**
 * Who the current call acts for, read afresh on every call: the workbench
 * publishes the author of the mention for the duration of one turn.
 * @returns the actor, or the empty string.
 */
async function actorNow() {
  if (ACTOR_FILE === '') return ''
  const raw = await readFile(ACTOR_FILE, 'utf8').catch(() => '')
  try {
    const record = JSON.parse(raw)
    return typeof record.actor === 'string' ? record.actor.trim() : ''
  } catch {
    return ''
  }
}

/**
 * Which mailbox this call may read, as a Graph path prefix.
 * @returns `/me` in delegated mode, `/users/<address>` in application mode;
 *   throws a readable refusal otherwise.
 */
async function mailbox() {
  const actor = await actorNow()
  if (MODE === 'delegated') {
    if (OWNER === '' || actor === '' || !actor.includes('@')) return '/me'
    if (actor.toLowerCase() === OWNER.toLowerCase()) return '/me'
    throw new Error(`the mailbox belongs to ${OWNER}; a mission by ${actor} cannot read it`)
  }
  const address = actor.toLowerCase()
  if (address === '') throw new Error('no person is behind this turn, so no mailbox can be read')
  if (!ADDRESS.test(address)) throw new Error(`${actor} is not a mailbox address; only the author of a mention can be read`)
  const domain = address.slice(address.lastIndexOf('@') + 1)
  if (!DOMAINS.includes(domain)) throw new Error(`the mailbox of ${actor} is outside the allowed domains`)
  return `/users/${encodeURIComponent(address)}`
}

/** @returns the application secret, from the environment or its file. */
async function clientSecret() {
  if (process.env.OFFICE365_CLIENT_SECRET) return process.env.OFFICE365_CLIENT_SECRET
  const file = process.env.OFFICE365_CLIENT_SECRET_FILE ?? ''
  if (file === '') throw new Error('the Office365 application secret is not configured')
  return (await readFile(file, 'utf8')).trim()
}

/** @returns an access token valid for the next few minutes. */
async function accessToken() {
  if (cached !== null && cached.expiresAt > Date.now() + 60_000) return cached.token
  let tenant
  let body
  if (MODE === 'application') {
    tenant = process.env.OFFICE365_TENANT_ID ?? ''
    const client = process.env.OFFICE365_CLIENT_ID ?? ''
    if (tenant === '' || client === '') throw new Error('OFFICE365_TENANT_ID and OFFICE365_CLIENT_ID are required')
    body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: client,
      client_secret: await clientSecret(),
      scope: 'https://graph.microsoft.com/.default',
    })
  } else {
    const record = JSON.parse(await readFile(TOKEN_FILE, 'utf8'))
    tenant = process.env.OFFICE365_TENANT_ID ?? record.tenant_id
    body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.OFFICE365_CLIENT_ID ?? record.client_id,
      refresh_token: record.refresh_token,
      scope: 'offline_access Mail.Read Calendars.Read',
    })
  }
  const response = await fetch(`${LOGIN}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!response.ok) throw new Error(`the Office365 token request failed with ${response.status}`)
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
  const token = await accessToken()
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
    description: 'Read the most recent messages of the mailbox of the person who asked (subject, sender, date, preview).',
    inputSchema: {
      type: 'object',
      properties: { count: { type: 'number', description: 'How many messages, 1 to 20' } },
    },
  },
  {
    name: 'mail_search',
    description: 'Search the mailbox of the person who asked for a phrase and return matching messages.',
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
    description: 'Read the upcoming calendar entries of the person who asked, for the next days.',
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
  const box = await mailbox()
  if (name === 'mail_recent') {
    const body = await graph(`${box}/messages`, {
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
    const query = String(args.query ?? '').replace(/["\\]/g, ' ').trim()
    if (query === '') throw new Error('query is required')
    const body = await graph(`${box}/messages`, {
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
    const body = await graph(`${box}/calendarView`, {
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
