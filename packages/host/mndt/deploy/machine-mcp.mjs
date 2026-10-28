#!/usr/bin/env node
/**
 * Machine tools for the agent: the ephemeral browser and desktop of one person.
 *
 * The workbench mounts this server per person, so the identity is the shell's
 * own identity and the machine service keeps the same per person session the
 * morning page uses. The agent drives the machine; the page remains the manual
 * fallback. Nothing here sends mail, buys, or publishes, so the tools are
 * ordinary actions and every call is logged in the session.
 */
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'

const MACHINES = (process.env.MACHINES_URL ?? 'http://machines:8796').replace(/\/$/, '')
const TOKEN = process.env.MACHINES_TOKEN ?? ''
const IDENTITY = process.env.MNDT_IDENTITY ?? process.env.DSH_MNDT_IDENTITY ?? ''
const API = process.env.MNDT_API ?? 'http://127.0.0.1:8795'
const ACTOR_FILE = process.env.MNDT_ACTOR_FILE ?? ''

const sessions = { browser: undefined, desktop: undefined }

/**
 * Who the current call acts for: a running mission publishes its actor, an
 * interactive shell carries its own identity in the environment.
 * @returns the actor, or the empty string when neither is available.
 */
async function actorNow() {
  if (ACTOR_FILE === '') return IDENTITY
  const raw = await readFile(ACTOR_FILE, 'utf8').catch(() => '')
  if (raw.trim() === '') return IDENTITY
  try {
    const record = JSON.parse(raw)
    return typeof record.actor === 'string' && record.actor !== '' ? record.actor : IDENTITY
  } catch {
    return IDENTITY
  }
}

/** @param kind - browser or desktop. @returns the live session, starting one. */
async function session(kind) {
  const actor = await actorNow()
  const cached = sessions[kind]
  if (cached !== undefined && cached.actor === actor) return cached
  sessions[kind] = undefined
  if (TOKEN === '') throw new Error('the machine service token is not configured')
  if (actor === '') throw new Error('the person is not configured')
  const answer = await fetch(`${MACHINES}/${kind}s/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-machine-token': TOKEN },
    body: JSON.stringify({ identity: actor }),
  })
  const body = await answer.json().catch(() => ({}))
  if (!answer.ok || typeof body.host !== 'string') {
    throw new Error(body.error ?? `the machine service refused to start a ${kind}`)
  }
  const live = { actor, host: body.host, token: String(body.token ?? TOKEN), port: kind === 'browser' ? 9223 : 9224 }
  sessions[kind] = live
  return live
}

/**
 * Send one operation to the machine agent.
 * @param kind - browser or desktop.
 * @param body - the operation.
 * @returns the parsed answer.
 */
async function act(kind, body) {
  const live = await session(kind)
  const answer = await fetch(`http://${live.host}:${live.port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-token': live.token },
    body: JSON.stringify(body),
  })
  const payload = await answer.json().catch(() => ({}))
  if (!answer.ok || payload.ok !== true) {
    throw new Error(payload.error ?? `the ${kind} answered ${answer.status}`)
  }
  return payload
}

/** @param payload - machine answer. @returns MCP content blocks. */
function render(payload) {
  const content = []
  if (typeof payload.png === 'string' && payload.png !== '') {
    content.push({ type: 'image', data: payload.png, mimeType: 'image/png' })
  }
  const text = typeof payload.text === 'string' && payload.text !== ''
    ? payload.text
    : typeof payload.url === 'string'
      ? `page ${payload.url}${typeof payload.title === 'string' && payload.title !== '' ? `: ${payload.title}` : ''}`
      : 'ok'
  content.push({ type: 'text', text })
  return { content }
}

/**
 * The actor of this call, from the published mission record or the environment.
 * @returns the actor.
 */
async function currentActor() {
  return (await actorNow()) || IDENTITY
}

/**
 * Ask the product for a human decision before a sensitive machine action.
 * @param kind - spend, publish, delete or send-email.
 * @param title - what the person is deciding.
 * @param detail - what the machine is about to do.
 * @returns the approval id and state.
 */
async function requestApproval(kind, title, detail) {
  const actor = await currentActor()
  if (actor === '') throw new Error('the person is not configured')
  const record = await readFile(ACTOR_FILE, 'utf8').catch(() => '')
  const missionId = record.trim() === '' ? undefined : JSON.parse(record).missionId
  const answer = await fetch(`${API}/approvals`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-email': actor },
    body: JSON.stringify({
      kind,
      title,
      payload: { note: detail, url: '' },
      ...(typeof missionId === 'string' && missionId !== '' ? { missionId } : {}),
    }),
  })
  const body = await answer.json().catch(() => ({}))
  if (!answer.ok || body.approval === undefined) throw new Error(body.error ?? `the product refused the approval (${answer.status})`)
  return body.approval
}

/**
 * Read one approval and check it belongs to this person and was approved.
 * @param approvalId - the approval id.
 * @returns the approval.
 */
async function approvedFor(approvalId) {
  const actor = await currentActor()
  const answer = await fetch(`${API}/approvals?state=all`, { headers: { 'x-forwarded-email': actor } })
  const body = await answer.json().catch(() => ({}))
  const found = Array.isArray(body.approvals) ? body.approvals.find(entry => entry.id === approvalId) : undefined
  if (found === undefined) throw new Error(`no approval ${approvalId}`)
  if (found.requestedBy !== actor) throw new Error('this approval was requested by another person')
  if (found.state !== 'approved') throw new Error(`the approval is ${found.state}, not approved`)
  return found
}

/**
 * Wait for a pending decision.
 * @param approvalId - the approval id.
 * @param timeoutSeconds - how long to wait.
 * @returns the decided approval.
 */
async function awaitApproval(approvalId, timeoutSeconds) {
  const actor = await currentActor()
  const deadline = Date.now() + Math.max(5, Math.min(timeoutSeconds, 600)) * 1000
  for (;;) {
    const answer = await fetch(`${API}/approvals?state=all`, { headers: { 'x-forwarded-email': actor } })
    const body = await answer.json().catch(() => ({}))
    const found = Array.isArray(body.approvals) ? body.approvals.find(entry => entry.id === approvalId) : undefined
    if (found === undefined) throw new Error(`no approval ${approvalId}`)
    if (found.state !== 'pending') return found
    if (Date.now() >= deadline) return found
    await new Promise(resolve => setTimeout(resolve, 4000))
  }
}

const tools = [
  {
    name: 'machine_browser_open',
    description: 'Ouvre une adresse dans le navigateur ephemeres de la personne et rend la capture.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'adresse complete, https://...' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'machine_browser_click',
    description: 'Clique dans le navigateur sur un selecteur CSS, puis rend le texte de la page.',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'selecteur CSS, par exemple form button' } },
      required: ['selector'],
      additionalProperties: false,
    },
  },
  {
    name: 'machine_browser_type',
    description: 'Remplit un champ du navigateur designe par un selecteur CSS.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'selecteur CSS du champ' },
        text: { type: 'string', description: 'texte a saisir' },
      },
      required: ['selector', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'machine_browser_read',
    description: 'Rend le texte lisible de la page courante du navigateur.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'machine_browser_screenshot',
    description: 'Rend une capture de la page courante du navigateur.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'machine_desktop_open',
    description: 'Ouvre une adresse dans le bureau ephemeres et rend la capture de l ecran.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'adresse a ouvrir, https://...' },
        wait_ms: { type: 'number', description: 'attente en millisecondes avant la capture, 10000 par defaut' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'machine_desktop_click',
    description: 'Clique aux coordonnees donnees dans le bureau, puis rend une capture.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'abscisse en pixels' },
        y: { type: 'number', description: 'ordonnee en pixels' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'machine_desktop_type',
    description: 'Saisit du texte au clavier dans le bureau, puis rend une capture.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'texte a taper' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'machine_desktop_key',
    description: 'Appuie sur une touche du bureau, par exemple Return, Tab, Escape.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'nom de la touche' } },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'machine_desktop_screenshot',
    description: 'Rend une capture de l ecran du bureau.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'machine_close',
    description: 'Ferme la session navigateur et la session bureau de la personne.',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string', enum: ['browser', 'desktop', 'both'], description: 'ce qu il faut fermer' } },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'machine_request_approval',
    description: 'Demande une decision humaine avant une action sensible sur la machine (soumettre un formulaire, payer, publier, supprimer). Rend l identifiant de la demande.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['spend', 'publish', 'delete', 'send-email'], description: 'nature de l action sensible' },
        title: { type: 'string', description: 'ce que la personne doit decider, en une phrase' },
        detail: { type: 'string', description: 'ce que la machine va faire exactement' },
      },
      required: ['kind', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'machine_await_approval',
    description: 'Attend la decision humaine sur une demande d approbation, puis rend son etat.',
    inputSchema: {
      type: 'object',
      properties: {
        approval_id: { type: 'string', description: 'identifiant rendu par machine_request_approval' },
        timeout_seconds: { type: 'number', description: 'attente maximale, 120 secondes par defaut' },
      },
      required: ['approval_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'machine_browser_submit',
    description: 'Valide une action sensible dans le navigateur : clic sur le bouton ou le lien donne, uniquement apres une approbation humaine accordee.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'selecteur CSS du bouton ou du lien qui engage l action' },
        approval_id: { type: 'string', description: 'approbation accordee par la personne' },
      },
      required: ['selector', 'approval_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'machine_desktop_submit',
    description: 'Valide une action sensible sur le bureau : clic aux coordonnees donnees, uniquement apres une approbation humaine accordee.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'abscisse en pixels' },
        y: { type: 'number', description: 'ordonnee en pixels' },
        approval_id: { type: 'string', description: 'approbation accordee par la personne' },
      },
      required: ['x', 'y', 'approval_id'],
      additionalProperties: false,
    },
  },
]

/** @param name - tool name. @param args - tool arguments. @returns MCP result. */
async function call(name, args) {
  switch (name) {
    case 'machine_browser_open':
      return render(await act('browser', { op: 'goto', url: String(args.url ?? '') }))
    case 'machine_browser_click': {
      await act('browser', { op: 'click', selector: String(args.selector ?? '') })
      return render(await act('browser', { op: 'text' }))
    }
    case 'machine_browser_type': {
      await act('browser', { op: 'fill', selector: String(args.selector ?? ''), text: String(args.text ?? '') })
      return render(await act('browser', { op: 'screenshot' }))
    }
    case 'machine_browser_read':
      return render(await act('browser', { op: 'text' }))
    case 'machine_browser_screenshot':
      return render(await act('browser', { op: 'screenshot' }))
    case 'machine_desktop_open': {
      await act('desktop', { op: 'open', url: String(args.url ?? '') })
      await new Promise(resolve => setTimeout(resolve, Number(args.wait_ms ?? 10000)))
      return render(await act('desktop', { op: 'screenshot' }))
    }
    case 'machine_desktop_click': {
      await act('desktop', { op: 'click', x: Number(args.x ?? 0), y: Number(args.y ?? 0) })
      return render(await act('desktop', { op: 'screenshot' }))
    }
    case 'machine_desktop_type': {
      await act('desktop', { op: 'type', text: String(args.text ?? '') })
      return render(await act('desktop', { op: 'screenshot' }))
    }
    case 'machine_desktop_key': {
      await act('desktop', { op: 'key', key: String(args.key ?? '') })
      return render(await act('desktop', { op: 'screenshot' }))
    }
    case 'machine_desktop_screenshot':
      return render(await act('desktop', { op: 'screenshot' }))
    case 'machine_request_approval': {
      const approval = await requestApproval(String(args.kind ?? 'spend'), String(args.title ?? ''), String(args.detail ?? ''))
      return { content: [{ type: 'text', text: `approbation ${approval.id} : ${approval.state}` }] }
    }
    case 'machine_await_approval': {
      const decided = await awaitApproval(String(args.approval_id ?? ''), Number(args.timeout_seconds ?? 120))
      return { content: [{ type: 'text', text: `approbation ${decided.id} : ${decided.state}` }] }
    }
    case 'machine_browser_submit': {
      await approvedFor(String(args.approval_id ?? ''))
      await act('browser', { op: 'click', selector: String(args.selector ?? '') })
      return render(await act('browser', { op: 'text' }))
    }
    case 'machine_desktop_submit': {
      await approvedFor(String(args.approval_id ?? ''))
      await act('desktop', { op: 'click', x: Number(args.x ?? 0), y: Number(args.y ?? 0) })
      return render(await act('desktop', { op: 'screenshot' }))
    }
    case 'machine_close': {
      const which = String(args.target ?? 'both')
      if (which !== 'desktop') await act('browser', { op: 'stop' }).catch(() => undefined)
      if (which !== 'browser') await act('desktop', { op: 'stop' }).catch(() => undefined)
      sessions.browser = undefined
      sessions.desktop = undefined
      return { content: [{ type: 'text', text: 'sessions fermees' }] }
    }
    default:
      throw new Error(`unknown tool ${name}`)
  }
}

/** @param id - request id. @param result - json result. */
function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

/** @param id - request id. @param code - error code. @param message - error text. */
function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

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
  const id = message.id
  if (message.method === 'initialize') {
    send(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'machine', version: '1.0.0' } })
    return
  }
  if (message.method === 'tools/list') {
    send(id, { tools })
    return
  }
  if (message.method === 'tools/call') {
    const name = message.params?.name
    const args = message.params?.arguments ?? {}
    void call(name, args)
      .then(result => send(id, result))
      .catch(error => fail(id, -32000, error instanceof Error ? error.message : String(error)))
    return
  }
  if (message.method === 'ping') send(id, {})
})
