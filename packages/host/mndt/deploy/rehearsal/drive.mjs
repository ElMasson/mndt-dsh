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
const landing = await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 90000 })
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

const api = async (method, path, body, context = owner) => {
  const answer = await context.request.fetch(`${BASE}/mndt-api${path}`, { method, ...(body === undefined ? {} : { data: body }) })
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
const llm = logs('fakellm')
check('llm-called', /fake-llm call \d+/.test(llm), `${(llm.match(/fake-llm call \d+:[^\n]*/g) ?? []).slice(-1).join('') || 'no call'}`)

const viewer = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-email': SECOND } })
await (await viewer.newPage()).goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
const refused = await api('POST', '/channels', { title: 'Interdit' }, viewer)
check('viewer-403', refused.status === 403, `${refused.status}: ${refused.body.error}`)

// Abrupt endings: pages closed with their WebSockets open, raw upgrades reset (TCP RST).
for (let index = 0; index < 4; index += 1) {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-email': OWNER } })
  await (await context.newPage()).goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
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
