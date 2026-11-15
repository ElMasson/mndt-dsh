// The assembled lot 1, driven like a person, after rehearse.sh started it:
// the real page in Chromium through the real gateway, the shell's WebSocket, a
// real agent turn (@qwen, seeded by seed-team.sh, on the fake LLM), a viewer's
// refusal, then abrupt WebSocket endings; the gateway must never restart.
//   node drive.mjs <playwright module> <project> <shots dir>
import { execFileSync } from 'node:child_process'
import { connect } from 'node:net'

const [playwrightModule, project, shots] = process.argv.slice(2)
const { chromium } = await import(playwrightModule)
const BASE = 'http://127.0.0.1:18080'
const OWNER = 'duke@datanalysis.re'
const SECOND = 'smarion@datanalysis.re'
const results = []
const check = (step, ok, note) => { results.push({ step, ok }); console.log(`${ok ? 'OK ' : 'KO '} ${step.padEnd(14)} ${note}`) }
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const started = (service) => docker('inspect', '-f', '{{.State.StartedAt}} restarts={{.RestartCount}}', `${project}-${service}`)
const logs = (service) => execFileSync('docker', ['logs', `${project}-${service}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const gatewayBefore = started('gateway')
const browser = await chromium.launch()
const owner = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-email': OWNER }, locale: 'en-US' })
const page = await owner.newPage()
const sockets = []
page.on('websocket', (ws) => {
  const entry = { url: ws.url(), frames: 0, closed: false }
  sockets.push(entry)
  ws.on('framereceived', () => { entry.frames += 1 })
  ws.on('close', () => { entry.closed = true })
})
const pageErrors = []
page.on('pageerror', (error) => { pageErrors.push(String(error)) })
// The team page, at / for everyone the proxy admitted (the standalone page, no shell).
const team = await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 90000 })
await sleep(4000)
const teamTitle = await page.title()
const teamLang = await page.evaluate(() => document.documentElement.lang)
await page.screenshot({ path: `${shots}/team.png` })
check('team-page', team?.ok() === true && /Équipe/.test(teamTitle) && teamLang.startsWith('fr'), `status ${team?.status()}, title « ${teamTitle} », lang « ${teamLang} »`)
check('team-no-mux', !sockets.some(s => /remote\.mux/.test(s.url)), `${sockets.length} WebSocket(s) on the team page`)
// The owner's DSH, under /dsh/ (the « Mode avancé »).
const landing = await page.goto(`${BASE}/dsh/`, { waitUntil: 'domcontentloaded', timeout: 90000 })
await sleep(10000)
const title = await page.title()
const lang = await page.evaluate(() => document.documentElement.lang)
const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').trim()
await page.screenshot({ path: `${shots}/landing.png` })
check('page', landing?.ok() === true && title !== '', `status ${landing?.status()}, title « ${title} », lang « ${lang} », page errors ${pageErrors.length}${pageErrors.length ? ': ' + pageErrors[0].slice(0, 120) : ''}`)
check('landing-text', true, `« ${text.slice(0, 220)} »`)
check('no-modal', !/Preview Notice|Get started/.test(text), 'neither « Preview Notice » nor « Get started » on the first arrival')
check('french', lang.startsWith('fr'), `document lang « ${lang} » with an English browser`)
check('shell-ws', sockets.some(s => s.frames > 0), `${sockets.length} WebSocket(s): ${sockets.map(s => `${new URL(s.url).pathname} frames=${s.frames}${s.closed ? ' closed' : ''}`).join(', ') || 'none'}`)

// A mission answers once it has run (several model calls): it gets three minutes.
const api = async (method, path, body, context = owner, timeout = 30000) => {
  const answer = await context.request.fetch(`${BASE}/mndt-api${path}`, { method, timeout, ...(body === undefined ? {} : { data: body }) })
  return { status: answer.status(), body: await answer.json().catch(() => ({})) }
}
const agents = (await api('GET', '/agents')).body.agents ?? []
check('seeded', ['assistant', 'analyste', 'qwen'].every(h => agents.some(a => a.handle === h)), `agents: ${agents.map(a => `@${a.handle} ${a.provider}/${a.model} [${a.connectors.join(',')}]`).join(' | ')}`)
const qwen = agents.find(a => a.handle === 'qwen')
const channel = (await api('POST', '/channels', { title: 'Répétition assemblée' })).body.channel
check('channel', channel?.name === 'repetition-assemblee', `created #${channel?.name}`)
if (qwen !== undefined && channel !== undefined) {
  await api('POST', `/channels/${channel.id}/agents`, { add: [qwen.id] })
  const asked = (await api('POST', `/channels/${channel.id}/messages`, { text: '@qwen bonjour' })).body.message
  let turn
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const messages = (await api('GET', `/channels/${channel.id}/messages`)).body.messages ?? []
    turn = messages.find(m => m.id === asked.id)?.turns?.[0]
    if (turn !== undefined && !['queued', 'running'].includes(turn.status)) break
    await sleep(2000)
  }
  const messages = (await api('GET', `/channels/${channel.id}/messages`)).body.messages ?? []
  const reply = messages.find(m => m.replyTo === asked.id)
  check('agent-turn', turn?.status === 'done' && reply !== undefined, `status ${turn?.status}, eur ${turn?.eur}, tokens ${JSON.stringify(turn?.tokens)}, session ${turn?.sessionId}, reason ${turn?.reason ?? '-'}, reply « ${(reply?.text ?? '').slice(0, 80)} »`)
}
// The allow-lists. A channel turn of @qwen (no connector): the approvals
// server's open tools and nothing else, though workbench_facts is mounted. A
// mission of the owner on a team instance: every MCP tool, never the engine's.
// A tool more or a tool less fails.
const APPROVALS = ['mcp__approvals__list_pending_approvals', 'mcp__approvals__read_approval', 'mcp__approvals__request_approval']
const EXPECTED = { '-': APPROVALS, tour: APPROVALS, mission: [...APPROVALS, 'mcp__workbench_facts__workbench_facts'].sort() }
const witness = () => docker('exec', `${project}-workbench`, 'sh', '-c', 'find /state /tmp -name policy-witness.txt 2>/dev/null | head -3')

/** @param text - a message asking for the probe. @returns the turn of that message, once settled. */
async function probeTurn(text) {
  const asked = (await api('POST', `/channels/${channel.id}/messages`, { text })).body.message
  let turn
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const messages = (await api('GET', `/channels/${channel.id}/messages`)).body.messages ?? []
    turn = messages.find(m => m.id === asked.id)?.turns?.[0]
    if (turn !== undefined && !['queued', 'running'].includes(turn.status)) break
    await sleep(2000)
  }
  return turn
}

/** @param log - the fake LLM's log. @param tag - the probe. @returns each probed tool's result, by tool name. */
const resultsOf = (log, tag) => new Map([...log.matchAll(new RegExp(`TOOL-RESULT ${tag} (\\S+): ([^\\n]*)`, 'g'))].map(m => [m[1], m[2]]))
const REFUSED = /not open to the agents of the team|not allowed in this channel|unknown tool|not found|UNKNOWN_TOOL/i

if (qwen !== undefined && channel !== undefined) {
  // (b, c) the channel turn calls the shell, the facts server, the approvals.
  const turn = await probeTurn('@qwen sonde-outils-tour')
  const tour = resultsOf(logs('fakellm'), 'tour')
  check('probe-turn', turn?.status === 'done' && tour.size === 3, `status ${turn?.status}, reason ${turn?.reason ?? '-'}, ${tour.size} tool result(s)`)
  check('turn-no-bash', REFUSED.test(tour.get('bash') ?? '') && witness() === '', `bash « ${tour.get('bash') ?? 'no result'} », witness « ${witness() || 'absent'} »`)
  check('turn-no-facts', REFUSED.test(tour.get('mcp__workbench_facts__workbench_facts') ?? ''), `facts « ${tour.get('mcp__workbench_facts__workbench_facts') ?? 'no result'} »`)
  const cards = ((await api('GET', '/approvals')).body.approvals ?? []).filter(card => card.title === 'Carte de répétition')
  check('turn-card', cards.some(card => card.channelId === channel.id) && !REFUSED.test(tour.get('mcp__approvals__request_approval') ?? ''),
    `${cards.length} card(s), in this channel: ${cards.filter(card => card.channelId === channel.id).length}, tool « ${(tour.get('mcp__approvals__request_approval') ?? 'no result').slice(0, 80)} »`)
}

// (d) a mission of the owner: MCP tools only; a member cannot start one.
const mission = await api('POST', '/missions', { kind: 'custom', prompt: 'sonde-outils-mission' }, owner, 180000)
  .catch(error => ({ status: 0, body: { error: String(error).split('\n')[0] } }))
const run = resultsOf(logs('fakellm'), 'mission')
check('mission-run', mission.status === 201 && run.size === 3, `${mission.status} ${mission.body.status ?? mission.body.error ?? ''}, ${run.size} tool result(s)`)
check('mission-no-bash', REFUSED.test(run.get('bash') ?? '') && witness() === '', `bash « ${run.get('bash') ?? 'no result'} », witness « ${witness() || 'absent'} »`)
check('mission-facts', /Faits de repetition/.test(run.get('mcp__workbench_facts__workbench_facts') ?? ''), `facts « ${run.get('mcp__workbench_facts__workbench_facts') ?? 'no result'} »`)

// (a) every call of every run offered exactly its allow-list.
const llm = logs('fakellm')
check('llm-called', /fake-llm call \d+/.test(llm), `${(llm.match(/fake-llm call \d+:[^\n]*/g) ?? []).slice(-1).join('') || 'no call'}`)
const offeredLines = [...llm.matchAll(/fake-llm tools \d+ (\S+): (\[[^\n]*\])/g)].map(match => ({ tag: match[1], tools: JSON.parse(match[2]) }))
const unexpected = offeredLines.filter(line => JSON.stringify(line.tools) !== JSON.stringify(EXPECTED[line.tag] ?? []))
// The exact lines, for the record: what each call was offered, what each probed tool answered.
for (const line of llm.match(/fake-llm tools \d+ [^\n]*|TOOL-RESULT [^\n]*/g) ?? []) console.log(`    ${line}`)
check('turn-tools', offeredLines.some(line => line.tag === 'tour') && offeredLines.some(line => line.tag === 'mission') && unexpected.length === 0,
  unexpected.length === 0 ? `${offeredLines.length} calls, each offered exactly its allow-list` : `${unexpected[0].tag} offered ${JSON.stringify(unexpected[0].tools)}`)

const viewer = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-email': SECOND } })
const viewerTeam = await (await viewer.newPage()).goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
const refused = await api('POST', '/channels', { title: 'Interdit' }, viewer)
check('viewer-403', refused.status === 403, `${refused.status}: ${refused.body.error}`)
const memberMission = await api('POST', '/missions', { kind: 'custom', prompt: 'sonde-outils-membre' }, viewer)
check('member-no-mission', memberMission.status === 404, `POST /missions by ${SECOND}: ${memberMission.status}`)
// A member has the team page, nothing of the shell: neither /dsh/ nor its WebSocket.
const viewerShell = await viewer.request.fetch(`${BASE}/dsh/`, { maxRedirects: 0 })
const viewerApi = await viewer.request.fetch(`${BASE}/api/session`, { maxRedirects: 0 })
const viewerMux = await new Promise((resolve) => {
  const socket = connect(18080, '127.0.0.1')
  socket.on('error', () => { resolve('error') })
  socket.once('connect', () => {
    socket.write(`GET /api/remote.mux HTTP/1.1\r\nhost: 127.0.0.1:18080\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nx-forwarded-email: ${SECOND}\r\n\r\n`)
  })
  socket.once('data', (chunk) => { resolve(String(chunk).split('\r\n')[0] ?? ''); socket.destroy() })
})
check('viewer-team', viewerTeam?.ok() === true, `the team page: ${viewerTeam?.status()}`)
check('viewer-no-shell', viewerShell.status() === 404 && viewerApi.status() === 404 && /404/.test(String(viewerMux)), `/dsh/ ${viewerShell.status()}, /api/session ${viewerApi.status()}, remote.mux « ${viewerMux} »`)

// Abrupt endings: pages closed with their WebSockets open, raw upgrades reset (TCP RST).
for (let index = 0; index < 4; index += 1) {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-email': OWNER } })
  await (await context.newPage()).goto(`${BASE}/dsh/`, { waitUntil: 'domcontentloaded' })
  await sleep(2500)
  await context.close()
}
for (let index = 0; index < 4; index += 1) {
  const socket = connect(18080, '127.0.0.1')
  socket.on('error', () => undefined)
  await new Promise((resolve) => { socket.once('connect', resolve) })
  socket.write('GET /ws HTTP/1.1\r\nhost: 127.0.0.1:18080\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n')
  await sleep(300)
  socket.resetAndDestroy()
}
await browser.close()
await sleep(2000)
const gatewayAfter = started('gateway')
const unhandled = (logs('gateway').match(/Unhandled 'error' event/g) ?? []).length
check('gateway-alive', gatewayBefore === gatewayAfter && unhandled === 0, `before « ${gatewayBefore} », after « ${gatewayAfter} », unhandled errors ${unhandled}`)
const health = await fetch(`${BASE}/mndt-api/health`).then(r => r.status, () => 0)
check('still-serves', health === 200, `health ${health}`)
console.log(`\n${results.filter(r => r.ok).length} OK, ${results.filter(r => !r.ok).length} KO`)
process.exit(results.some(r => !r.ok) ? 1 : 0)
