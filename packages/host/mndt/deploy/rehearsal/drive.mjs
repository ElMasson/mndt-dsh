// The assembled lot 1, driven like a person, after rehearse.sh started it:
// the real page in Chromium through the real gateway, the shell's WebSocket, a
// real agent turn (@qwen, seeded by seed-team.sh, on the fake LLM), a viewer's
// refusal, then abrupt WebSocket endings; the gateway must never restart.
//   node drive.mjs <playwright module> <project> <shots dir>
import { execFileSync } from 'node:child_process'
import { connect } from 'node:net'
import { readFileSync, unlinkSync } from 'node:fs'

const [playwrightModule, project, shots] = process.argv.slice(2)
const { chromium } = await import(playwrightModule)
const BASE = 'http://127.0.0.1:18080'
const OWNER = 'duke@datanalysis.re'
const SECOND = 'smarion@datanalysis.re'
const ADMIN = 'jadmin@datanalysis.re'
const OPERATOR = 'operateur@datanalysis.re'
const results = []
const check = (step, ok, note) => { results.push({ step, ok }); console.log(`${ok ? 'OK ' : 'KO '} ${step.padEnd(14)} ${note}`) }
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const started = (service) => docker('inspect', '-f', '{{.State.StartedAt}} restarts={{.RestartCount}}', `${project}-${service}`)
// What happened since this drive started: an update rehearsal keeps the fake
// model and the state of the version before it, whose calls and missions are not
// this version's to judge.
const DRIVE_START = new Date().toISOString()
const logs = (service) => execFileSync('docker', ['logs', '--since', DRIVE_START, `${project}-${service}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const gatewayBefore = started('gateway')
// The workbench, likewise: Docker restarts it if dsh web falls (unless-stopped),
// and a fall during a turn must not pass for a quiet run. The drive restarts
// nothing itself; step 8 (grants-checks) does, and runs after it.
const workbenchBefore = started('workbench')
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
// The card tools a turn is offered: exactly the approvals server's « allow » in
// the catalog this tenant was deployed with (MNDT_REHEARSAL_CATALOG), so the
// same harness judges every version (three tools before #82, four after). And
// that list must stay within the card tools this harness knows: a catalog that
// opened another tool fails, rather than being taken as the expectation.
const KNOWN_CARD_TOOLS = ['ask_peers', 'list_pending_approvals', 'propose_agent', 'propose_context', 'propose_schedule', 'read_approval', 'request_approval']
const catalogPath = process.env.MNDT_REHEARSAL_CATALOG
let deployedAllow = []
try { deployedAllow = JSON.parse(readFileSync(catalogPath ?? '', 'utf8')).approvals?.allow ?? [] } catch { deployedAllow = [] }
const unknownCardTools = deployedAllow.filter(tool => !KNOWN_CARD_TOOLS.includes(tool))
check('turn-tools-catalog', deployedAllow.length > 0, `${catalogPath ?? 'no MNDT_REHEARSAL_CATALOG'}: approvals allow ${JSON.stringify(deployedAllow)}`)
if (unknownCardTools.length > 0) check('turn-tools-unknown', false, `the deployed catalog opens card tools this harness does not know: ${JSON.stringify(unknownCardTools)}`)
const APPROVALS = deployedAllow.filter(tool => KNOWN_CARD_TOOLS.includes(tool)).map(tool => `mcp__approvals__${tool}`).sort()
// The machine connector (« Mon ordinateur », eighth jump), in computer mode: its
// 16 tools, exactly, offered to the owner's mission when the deployed catalog
// mounts it; never to a channel turn without that connector.
const MACHINE_TOOLS = ['await_approval', 'browser_click', 'browser_open', 'browser_read', 'browser_screenshot', 'browser_submit', 'browser_type', 'close',
  'desktop_click', 'desktop_key', 'desktop_open', 'desktop_screenshot', 'desktop_submit', 'desktop_type', 'request_approval', 'terminal_run']
  .map(tool => `mcp__machine__machine_${tool}`)
let deployedMachine = false
try { deployedMachine = JSON.parse(readFileSync(catalogPath ?? '', 'utf8')).machine !== undefined } catch { deployedMachine = false }
const EXPECTED = {
  '-': APPROVALS, tour: APPROVALS,
  mission: [...APPROVALS, 'mcp__workbench_facts__workbench_facts', ...(deployedMachine ? MACHINE_TOOLS : [])].sort(),
}
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

/** @param tag - a « sonde-marque-<tag> » probe. @returns the last call of that probe: its skill blocks and the tools it was offered. */
const markerOf = (tag) => {
  const found = [...logs('fakellm').matchAll(new RegExp(`fake-llm marker \\d+ ${tag}: skills=(\\d+) tools=(\\[[^\\n]*\\])`, 'g'))].at(-1)
  return found === undefined ? undefined : { skills: Number(found[1]), tools: JSON.parse(found[2]) }
}

// (#127) a skill attached to @qwen reaches its prompt, opens no tool, and
// leaves @qwen with the skill when it leaves the library.
if (qwen !== undefined && channel !== undefined) {
  const made = await api('POST', '/skills', { markdown: '---\nname: Répétition compétence\ndescription: sonde du saut\nallowed-tools: Bash\n---\nVérifier la facture avant de répondre.' })
  const slug = made.body.skill?.slug
  const attached = slug === undefined ? undefined : await api('POST', `/agents/${qwen.id}`, { skills: [slug] })
  const skillTurn = await probeTurn('@qwen sonde-marque-competence')
  const marker = markerOf('competence')
  const removed = slug === undefined ? undefined : await api('POST', `/skills/${slug}/delete`)
  const after = ((await api('GET', '/agents')).body.agents ?? []).find(a => a.id === qwen.id)
  check('skill-in-prompt', made.status === 201 && JSON.stringify(made.body.ignoredFields) === '["allowed-tools"]'
    && attached?.status === 200 && skillTurn?.status === 'done' && marker?.skills === 1 && JSON.stringify(marker.tools) === JSON.stringify(APPROVALS)
    && removed?.status === 200 && (removed.body.removedFrom ?? []).includes(qwen.id) && (after?.skills ?? []).length === 0,
  `skill ${made.status} ${slug ?? '-'} ignored ${JSON.stringify(made.body.ignoredFields)}, attached ${attached?.status}, turn ${skillTurn?.status} « ${skillTurn?.reason ?? '-'} », `
    + `skill blocks ${marker?.skills ?? 'no call'}, tools ${marker === undefined ? '-' : JSON.stringify(marker.tools) === JSON.stringify(APPROVALS) ? 'the card tools exactly' : JSON.stringify(marker.tools)}, `
    + `removed ${removed?.status} from ${JSON.stringify(removed?.body.removedFrom)}, @qwen skills after ${JSON.stringify(after?.skills ?? [])}`)
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
// An admin who is not the owner: neither a mission nor an automation run.
const adminContext = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-email': ADMIN } })
await (await adminContext.newPage()).goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
const adminRun = await api('POST', '/automations/auto_briefing/run', {}, adminContext)
const adminMission = await api('POST', '/missions', { kind: 'custom', prompt: 'sonde-outils-admin' }, adminContext)
check('admin-no-mission', adminRun.status === 404 && adminMission.status === 404, `POST /automations/auto_briefing/run ${adminRun.status}, POST /missions ${adminMission.status} by ${ADMIN} (admin, not owner)`)
// The scheduler's first pass on a team instance: auto_briefing, enabled by the
// deployment and by no owner, is switched off with its reason; it ran nothing.
const registry = (await api('GET', '/automations')).body.items ?? []
const briefingItem = registry.find(item => item.id === 'auto_briefing')
const missionsBefore = ((await api('GET', '/missions')).body.missions ?? []).filter(mission => mission.kind === 'briefing' && mission.createdAt >= DRIVE_START).length
// After an update from an installed instance, the owner may have run the old
// briefing by hand (rehearse-update phase A2): its outcome is that run's
// (« done »), and the automation stays switched off. Either way it must be off,
// and nothing may have run during this drive.
const allMissions = (await api('GET', '/missions')).body.missions ?? []
const earlierRun = briefingItem?.lastMissionId !== undefined
  && allMissions.some(mission => mission.id === briefingItem.lastMissionId && mission.createdAt < DRIVE_START)
check('scheduler-first-pass', briefingItem?.enabled === false && (/owner/.test(briefingItem?.lastOutcome ?? '') || earlierRun) && missionsBefore === 0,
  `auto_briefing enabled ${briefingItem?.enabled}, « ${briefingItem?.lastOutcome ?? '-'} »${earlierRun ? ' (a run before this drive)' : ''}, briefing missions before any run: ${missionsBefore}`)
// A briefing the owner runs is theirs and private: neither a member nor the admin reads it.
const briefing = await api('POST', '/automations/auto_briefing/run', {}, owner, 180000)
  .catch(error => ({ status: 0, body: { error: String(error).split('\n')[0] } }))
const readsOf = async context => ({
  missions: ((await api('GET', '/missions', undefined, context)).body.missions ?? []).length,
  briefs: ((await api('GET', '/briefs', undefined, context)).body.briefs ?? []).length,
})
const ownerReads = await readsOf(owner)
const viewerReads = await readsOf(viewer)
const adminReads = await readsOf(adminContext)
check('briefing-private', briefing.status === 200 && ownerReads.missions > 0 && viewerReads.missions + viewerReads.briefs + adminReads.missions + adminReads.briefs === 0,
  `run ${briefing.status} ${briefing.body.error ?? ''}; owner reads ${ownerReads.missions} mission(s) ${ownerReads.briefs} brief(s); ${SECOND} ${JSON.stringify(viewerReads)}; ${ADMIN} ${JSON.stringify(adminReads)}`)
// The admin reads the journal, finds the owner's brief there, and tries to approve it.
const ownerBriefs = (await api('GET', '/briefs')).body.briefs ?? []
const journal = await api('GET', '/journal', undefined, adminContext)
const leakedIds = ownerBriefs.filter(brief => JSON.stringify(journal.body.entries ?? []).includes(brief.missionId ?? brief.id)).length
const approve = ownerBriefs[0] === undefined ? { status: 0 } : await api('POST', `/briefs/${ownerBriefs[0].id}/approve`, {}, adminContext)
check('admin-no-owner-brief', ownerBriefs.length > 0 && leakedIds === 0 && approve.status === 404,
  `journal ${journal.status}: ${leakedIds} of the owner's ${ownerBriefs.length} brief(s) named; approve by ${ADMIN}: ${approve.status}`)
// The briefing just run is published in the owner's lane (#154), never in another's.
const laneOf = async context => ((await api('GET', '/channels', undefined, context)).body.channels ?? []).find(c => c.kind === 'solo')
const ownerLane = await laneOf(owner)
const laneBriefs = ownerLane === undefined ? [] : ((await api('GET', `/channels/${ownerLane.id}/messages`)).body.messages ?? [])
  .filter(m => m.author?.kind === 'system' && m.mission?.kind === 'briefing')
const viewerLane = await laneOf(viewer)
// The viewer's own lane is read (200): an empty list from a refused read proves nothing.
const viewerRead = viewerLane === undefined ? { status: 0, body: {} } : await api('GET', `/channels/${viewerLane.id}/messages`, undefined, viewer)
const viewerSees = (viewerRead.body.messages ?? []).filter(m => m.mission !== undefined)
const ownerLaneByViewer = ownerLane === undefined ? 0 : (await api('GET', `/channels/${ownerLane.id}/messages`, undefined, viewer)).status
check('briefing-in-lane', laneBriefs.length > 0 && typeof laneBriefs.at(-1)?.text === 'string' && laneBriefs.at(-1).text !== ''
  && ['done', 'failed'].includes(laneBriefs.at(-1)?.mission?.status) && viewerRead.status === 200 && viewerSees.length === 0 && ownerLaneByViewer === 404,
  `owner's lane: ${laneBriefs.length} briefing message(s), last ${laneBriefs.at(-1)?.mission?.status ?? '-'} « ${laneBriefs.at(-1)?.mission?.title ?? '-'} »; ${SECOND}'s lane read ${viewerRead.status}: ${viewerSees.length}; the owner's lane read by ${SECOND}: ${ownerLaneByViewer}`)

// (#153) A card asked in an operator's lane (no decider among its members)
// rises to the owner, who decides it without reading the lane.
const operatorContext = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-email': OPERATOR } })
const settle = async (context, channelId, messageId) => {
  let turn
  for (let attempt = 0; attempt < 90; attempt += 1) {
    turn = ((await api('GET', `/channels/${channelId}/messages`, undefined, context)).body.messages ?? []).find(m => m.id === messageId)?.turns?.[0]
    if (turn !== undefined && !['queued', 'running'].includes(turn.status)) return turn
    await sleep(2000)
  }
  return turn
}
const operatorLane = await laneOf(operatorContext)
let rose
let ownerQueue = { status: 0, body: {} }
let decided = 0
let laneRead = 0
let roseTurn
if (operatorLane !== undefined && qwen !== undefined) {
  await api('POST', `/channels/${operatorLane.id}/agents`, { add: [qwen.id] }, operatorContext)
  const asked = (await api('POST', `/channels/${operatorLane.id}/messages`, { text: '@qwen sonde-outils-lane' }, operatorContext)).body.message
  roseTurn = asked === undefined ? undefined : await settle(operatorContext, operatorLane.id, asked.id)
  ownerQueue = await api('GET', '/approvals?state=pending&mine=1')
  rose = (ownerQueue.body.approvals ?? []).find(card => card.channelId === operatorLane.id)
  laneRead = (await api('GET', `/channels/${operatorLane.id}/messages`)).status
  decided = rose === undefined ? 0 : (await api('POST', `/approvals/${rose.id}/decide`, { decision: 'rejected', reason: 'répétition' })).status
}
// Both reads answer 200: an empty list from a refused read proves nothing.
const ownerAll = await api('GET', '/approvals?state=all')
const viewerAll = await api('GET', '/approvals?state=all', undefined, viewer)
const viewerCards = (viewerAll.body.approvals ?? []).filter(card => card.channelId === operatorLane?.id)
check('lane-card-rises', ownerQueue.status === 200 && ownerAll.status === 200 && viewerAll.status === 200
  && rose !== undefined && rose.canDecide === true && rose.origin?.kind === 'lane' && laneRead === 404 && decided === 200 && viewerCards.length === 0,
  `turn in ${OPERATOR}'s lane ${roseTurn?.status ?? '-'}; the owner's « À traiter » (${ownerQueue.status}): ${rose === undefined ? 'no card' : `« ${rose.title} », canDecide ${rose.canDecide}, origin ${JSON.stringify(rose.origin)}`}; the lane read by the owner: ${laneRead}; decided ${decided}; /approvals?state=all owner ${ownerAll.status}, ${SECOND} ${viewerAll.status}: ${viewerCards.length} seen by ${SECOND}`)

// (#157) A turn whose provider fails serves the host's sentence and its kind,
// never the provider's words; those reach the operator's log.
let failedTurn
if (channel !== undefined && qwen !== undefined) {
  const asked = (await api('POST', `/channels/${channel.id}/messages`, { text: '@qwen sonde-panne' })).body.message
  failedTurn = asked === undefined ? undefined : await settle(owner, channel.id, asked.id)
}
// The failure did happen: the fake provider says it answered the probe with its 400.
const providerFailed = (docker('logs', `${project}-fakellm`).match(/provider failure \(sonde-panne\)/g) ?? []).length
// Every surface a member or the owner reads, each read with its status: a refused
// read proves nothing.
// Each surface with the status each reader must get: the owner reads them all;
// the viewer is not a member of the channel (404) and does not hold
// rights.write (the journal, 403); the rest it reads, filtered (200). A status
// other than the one declared fails the check: a refused read proves nothing.
const surfaces = channel === undefined ? [] : [
  { path: `/channels/${channel.id}/messages`, owner: 200, viewer: 404 },
  { path: '/state', owner: 200, viewer: 200 },
  { path: '/events', owner: 200, viewer: 200 },
  { path: '/journal', owner: 200, viewer: 403 },
  { path: '/approvals?state=all', owner: 200, viewer: 200 },
  { path: '/search?q=panne', owner: 200, viewer: 200 },
  { path: '/missions', owner: 200, viewer: 200 },
  { path: '/briefs', owner: 200, viewer: 200 },
]
const reads = []
for (const surface of surfaces) for (const [who, context, expected] of [['owner', owner, surface.owner], ['viewer', viewer, surface.viewer]]) {
  const read = await api('GET', surface.path, undefined, context)
  reads.push({ path: surface.path, who, status: read.status, expected, raw: /PANNE-SONDE|10\.9\.9\.9/.test(JSON.stringify(read.body)) })
}
const leaked = reads.filter(read => read.raw)
const misread = reads.filter(read => read.status !== read.expected)
// The provider's words reach the operator's log, and only it: the workbench's
// web.log (DSH_MNDT_WEB_LOG, /run/mndt-launch/web.log by default; a restart
// starts it anew, and this check runs before the drive's restarts).
const operatorLog = (() => {
  try { return docker('exec', `${project}-workbench`, 'sh', '-c', 'cat "${DSH_MNDT_WEB_LOG:-/run/mndt-launch/web.log}" 2>/dev/null || true') } catch { return '' }
})()
// Tied to this very turn: a line left by an earlier run, in a volume that
// persists, must not pass for this failure.
const loggedRaw = failedTurn?.id !== undefined
  && new RegExp(`turn ${failedTurn.id.replace(/[^A-Za-z0-9_]/g, '\\$&')} of @qwen failed: .*PANNE-SONDE`).test(operatorLog)
check('no-raw-failure', providerFailed > 0 && failedTurn?.status === 'failed' && typeof failedTurn.reasonKind === 'string'
  && surfaces.length > 0 && misread.length === 0 && leaked.length === 0 && loggedRaw,
  `provider failure answered ${providerFailed} time(s); turn ${failedTurn?.status ?? '-'}, reasonKind ${failedTurn?.reasonKind ?? '-'}, « ${failedTurn?.reason ?? '-'} »; ${reads.length} reads, ${misread.length === 0 ? 'every status as declared' : `unexpected: ${misread.map(read => `${read.who} ${read.path} ${read.status} (declared ${read.expected})`).join(', ')}`}; the provider's words served ${leaked.length === 0 ? 'nowhere' : `in ${leaked.map(read => `${read.who} ${read.path}`).join(', ')}`}; in the operator's log: ${loggedRaw ? 'yes' : 'no'}`)

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
// The coordination modes of a channel (#84, #85), end to end in the image. Both
// routes answer from the fake model here (the rehearsal's copy of the routes),
// with the price grid of the instance: a turn costs something.
const byHandle = handle => agents.find(a => a.handle === handle)
const [assistant, analyste] = [byHandle('assistant'), byHandle('analyste')]
/** @param channelId - a channel. @param text - a message. @returns the turn it starts, once settled. */
async function turnIn(channelId, text) {
  const asked = (await api('POST', `/channels/${channelId}/messages`, { text })).body.message
  let turn
  for (let attempt = 0; attempt < 120; attempt += 1) {
    turn = ((await api('GET', `/channels/${channelId}/messages`)).body.messages ?? []).find(m => m.id === asked?.id)?.turns?.[0]
    if (turn !== undefined && !['queued', 'running'].includes(turn.status)) break
    await sleep(2000)
  }
  return turn
}
if (assistant !== undefined && analyste !== undefined && qwen !== undefined) {
  const room = (await api('POST', '/channels', { name: 'coordination', agents: [assistant.id, analyste.id, qwen.id], members: [] })).body.channel
  // The channel's context (#109, #110): each kind of prompt below reads it between its own mark.
  const contexted = await api('POST', `/channels/${room.id}/context`, { text: 'Contexte de répétition : les montants sont HT.', version: 0 })
  // « Auteur puis vérificateur »: @assistant writes, @analyste (another model) checks.
  const pair = await api('POST', `/channels/${room.id}/coordination`, { mode: 'author-verifier', author: assistant.id, verifier: analyste.id })
  const checked = await turnIn(room.id, '@assistant fais le point du trimestre')
  const steps = checked?.steps ?? []
  const revision = steps.find(step => step.role === 'revision')
  check('coord-author-verifier', pair.status === 200 && checked?.status === 'done' && steps.length <= 3
    && steps.some(step => step.role === 'verifier' && step.verdict === 'issues') && revision?.replaced === true,
  `status ${checked?.status}, steps ${steps.map(step => `${step.role}${step.verdict ? `:${step.verdict}` : ''}${step.replaced === undefined ? '' : `:replaced=${step.replaced}`}`).join(' ')}, reason ${checked?.reason ?? '-'}`)
  // « En parallèle puis synthèse »: @assistant and @qwen answer, @analyste assembles.
  const bound = 1
  const fanout = await api('POST', `/channels/${room.id}/coordination`, { mode: 'parallel-synthesis', workers: [assistant.id, qwen.id], synthesizer: analyste.id, maxEurPerTurn: bound })
  const together = await turnIn(room.id, '@analyste fais la synthèse du trimestre')
  const parts = (together?.steps ?? []).filter(step => step.role === 'worker' && typeof step.text === 'string')
  check('coord-parallel', fanout.status === 200 && together?.status === 'done' && parts.length === 2
    && (together?.steps ?? []).some(step => step.role === 'synthesis' && step.verdict === undefined)
    && typeof together?.eur === 'number' && together.eur > 0 && together.eur <= bound,
  `status ${together?.status}, ${parts.length} part(s), steps ${(together?.steps ?? []).map(step => step.role).join(' ')}, eur ${together?.eur} (bound ${bound} €)`)
  // The bound held once: a bound one worker fits under and the next does not.
  // Its reservation (prompt + 8192 output tokens at glm-5.3's 5.5 €/M, about
  // 0.05 €) passes 0.03 €, @assistant's (deepseek, about 0.02 €) does not.
  const tight = 0.03
  const capped = await api('POST', `/channels/${room.id}/coordination`, { mode: 'parallel-synthesis', workers: [assistant.id, analyste.id], synthesizer: qwen.id, maxEurPerTurn: tight })
  const held = await turnIn(room.id, '@qwen fais la synthèse du trimestre')
  const heldSteps = held?.steps ?? []
  const done = heldSteps.filter(step => step.role === 'worker' && typeof step.text === 'string')
  const stopped = heldSteps.find(step => step.role === 'worker' && step.verdict === 'skipped')
  // The worker stopped is the one whose reservation would pass the bound,
  // @analyste, and the part kept is @assistant's: the bound stops the right step.
  check('coord-bound', capped.status === 200 && done.length === 1 && done[0].agentId === assistant.id
    && stopped?.agentId === analyste.id && /borne/.test(stopped?.notes?.[0] ?? '')
    && typeof held?.eur === 'number' && held.eur > 0 && held.eur <= tight,
  `status ${held?.status}, steps ${heldSteps.map(step => `${step.role}${step.verdict ? `:${step.verdict}` : ''}@${agents.find(a => a.id === step.agentId)?.handle ?? step.agentId}`).join(' ')}, « ${stopped?.notes?.[0] ?? '-'} », eur ${held?.eur} (bound ${tight} €)`)
  const contexts = [...logs('fakellm').matchAll(/fake-llm context \d+: (\w+) (ok|ko|-)/g)].map(m => [m[1], m[2]])
  const bounded = kind => contexts.some(([k, v]) => k === kind && v === 'ok')
  check('context-injected', contexted.status === 200 && bounded('turn') && bounded('verifier') && bounded('synthesis') && !contexts.some(([, v]) => v === 'ko'),
    `context ${contexted.status}; ${['turn', 'verifier', 'synthesis'].map(k => `${k} ${bounded(k) ? 'bounded' : 'MISSING'}`).join(', ')}, ${contexts.filter(([, v]) => v === 'ko').length} unbounded`)

  /** @param channelId - a channel. @param messageId - a message. @returns its first turn, as served. */
  const turnOf = async (channelId, messageId) =>
    ((await api('GET', `/channels/${channelId}/messages`)).body.messages ?? []).find(m => m.id === messageId)?.turns?.[0]
  /** @param probe - what to wait for. @returns its value once truthy, or the last one after a minute. */
  const until = async (probe) => {
    let value
    for (let attempt = 0; attempt < 60; attempt += 1) {
      value = await probe()
      if (value) return value
      await sleep(1000)
    }
    return value
  }
  const escalations = async () => (await api('GET', '/escalations')).body.escalations ?? []
  // What the « À traiter » queue serves names no agent, model nor price while it waits.
  const NAMING = /@[a-z]|agt_|deepseek|glm|qwen|scaleway|vllm|€/i
  /** @returns each seeded agent's served eurThisMonth, and the space's unattributed sum. */
  const counters = async () => {
    const body = (await api('GET', '/agents')).body
    return { ...Object.fromEntries((body.agents ?? []).map(a => [a.handle, a.eurThisMonth])), space: body.eurUnattributedThisMonth }
  }
  // A counter missing on either side is not « unchanged »: it fails, never passes by undefined === undefined.
  const same = (a, b, keys) => keys.every(k => typeof a[k] === 'number' && typeof b[k] === 'number' && a[k] === b[k])
  /** @param turn - a served turn. @returns whether its help or council carries any identity, model or cost per call. */
  // The help's and the council's own totals are served on purpose: only what is per call counts here.
  const names = turn => JSON.stringify({ help: turn?.help && { ...turn.help, eur: undefined }, council: turn?.council && { ...turn.council, eur: undefined } })
    .match(/"agentId"|"model"|"tokens"|"eur":/) !== null

  // Peer help (#113): @qwen asks @assistant and @analyste, reads them, escalates; the
  // question waiting, nobody is named; a person answers, they are.
  const helpRoom = (await api('POST', '/channels', { name: 'entraide', agents: [assistant.id, analyste.id, qwen.id], members: [] })).body.channel
  const helpBefore = await counters()
  const helped = await turnIn(helpRoom.id, '@qwen sonde-entraide le point du trimestre ?')
  const help = helped?.help
  const waiting = (await escalations()).find(e => e.turnId === helped?.id)
  const helpWaiting = await counters()
  check('help-escalated-anonymous', helped?.status === 'done' && help?.state === 'done' && help.reading?.verdict === 'escalate'
    && help.advices.length === 2 && help.peerIds.length === 0 && !names(helped)
    && typeof help.escalation?.messageId === 'string' && waiting?.kind === 'help'
    && !NAMING.test(`${waiting.question} ${waiting.summary}`) && same(helpBefore, helpWaiting, ['assistant', 'analyste', 'space']),
  `turn ${helped?.status}, help ${help?.state}, verdict ${help?.reading?.verdict}, ${help?.advices.length ?? 0} advice(s), peers served ${help?.peerIds.length ?? '-'}, named ${names(helped)}, listed ${waiting?.kind ?? 'no'} « ${waiting?.summary ?? ''} », peers' counters ${same(helpBefore, helpWaiting, ['assistant', 'analyste'])  ? 'unchanged' : 'MOVED'}, space ${helpBefore.space}→${helpWaiting.space}`)
  const answer = help?.escalation?.messageId === undefined ? undefined
    : (await api('POST', `/channels/${helpRoom.id}/messages`, { text: 'Oui, elle est HT.', replyTo: help.escalation.messageId })).body.message
  const relaunched = answer === undefined ? undefined
    : await until(async () => { const t = await turnOf(helpRoom.id, answer.id); return t !== undefined && !['queued', 'running'].includes(t.status) ? t : undefined })
  const revealed = (await turnOf(helpRoom.id, (await api('GET', `/channels/${helpRoom.id}/messages`)).body.messages?.find(m => m.turns?.[0]?.help !== undefined)?.id))?.help
  check('help-revealed', revealed?.escalation?.answeredAt !== undefined && revealed.advices.every(a => [assistant.id, analyste.id].includes(a.agentId))
    && relaunched?.agentId === qwen.id && !(await escalations()).some(e => e.turnId === helped?.id),
  `answered ${revealed?.escalation?.answeredAt !== undefined}, advices by ${revealed?.advices.map(a => agents.find(x => x.id === a.agentId)?.handle ?? '?').join(' ')}, @qwen relaunched ${relaunched?.status ?? 'no'}`)

  // « Conseil » (#119): a vote that decides, then a tie that escalates and a person who answers.
  const councilRoom = (await api('POST', '/channels', { name: 'conseil', agents: [qwen.id, assistant.id, analyste.id], members: [] })).body.channel
  const convened = await api('POST', `/channels/${councilRoom.id}/coordination`, { mode: 'council', members: [qwen.id, assistant.id, analyste.id] })
  const voted = await turnIn(councilRoom.id, '@qwen conseil-vote HT ou TTC ?')
  const unknownHandles = (logs('fakellm').match(/fake-llm council-unknown-handle/g) ?? []).length
  check('council-vote', convened.status === 200 && voted?.status === 'done' && voted.council?.decision?.kind === 'vote' && voted.council.decision.chosen === 1
    && JSON.stringify(voted.council.decision.tally) === JSON.stringify({ 1: 2, 2: 1 }) && voted.council.dissent.length === 1 && unknownHandles === 0
    && voted.council.options.at(-1) === 'aucune de ces options' && voted.council.positions.length === 3 && voted.council.positions.every(p => p.agentId !== undefined),
  `coordination ${convened.status}, turn ${voted?.status}, decision ${JSON.stringify(voted?.council?.decision ?? null)}, dissent ${voted?.council?.dissent.length ?? '-'}, ${voted?.council?.positions.length ?? 0} position(s), unknown handles ${unknownHandles}`)
  // Every call the fake model receives: none may follow a person's answer to a council.
  const framings = () => (logs('fakellm').match(/fake-llm call \d+:/g) ?? []).length
  const tieBefore = await counters()
  const tied = await turnIn(councilRoom.id, '@qwen conseil-egalite HT ou TTC ?')
  const tiedListed = (await escalations()).find(e => e.turnId === tied?.id)
  const tieWaiting = await counters()
  check('council-tie-escalated', tied?.council?.decision?.kind === 'vote' && tied.council.decision.chosen === undefined
    && typeof tied.council.escalation?.messageId === 'string' && !names(tied) && tied.council.framing !== undefined && tied.council.critiques.length === 3
    && tiedListed?.kind === 'council' && !NAMING.test(`${tiedListed.question} ${tiedListed.summary}`)
    && same(tieBefore, tieWaiting, ['qwen', 'assistant', 'analyste', 'space']),
  `decision ${JSON.stringify(tied?.council?.decision ?? null)}, escalation ${tied?.council?.escalation?.messageId ?? 'none'}, named ${names(tied)} (framing, positions, critiques), listed ${tiedListed?.kind ?? 'no'}, counters ${same(tieBefore, tieWaiting, ['qwen', 'assistant', 'analyste', 'space']) ? 'unchanged' : 'MOVED'}`)
  const callsBefore = framings()
  if (tied?.council?.escalation?.messageId !== undefined) {
    await api('POST', `/channels/${councilRoom.id}/messages`, { text: 'HT.', replyTo: tied.council.escalation.messageId })
  }
  const answered = await until(async () => { const t = await turnOf(councilRoom.id, (await api('GET', `/channels/${councilRoom.id}/messages`)).body.messages?.find(m => m.turns?.[0]?.id === tied?.id)?.id); return t?.council?.escalation?.answeredAt === undefined ? undefined : t })
  await sleep(3000)
  check('council-answered', answered?.council?.positions.every(p => p.agentId !== undefined) === true && framings() === callsBefore,
    `answered ${answered?.council?.escalation?.answeredAt ?? 'no'}, named ${answered?.council?.positions.filter(p => p.agentId !== undefined).length ?? '-'}, calls after the answer ${framings() - callsBefore}`)
  const councilTools = [...logs('fakellm').matchAll(/fake-llm council-tools \d+ (\w+): (\d+)/g)].map(m => [m[1], Number(m[2])])
  check('council-no-tools', councilTools.length >= 14 && councilTools.every(([, n]) => n === 0)
    && ['framing', 'position', 'critique'].every(kind => councilTools.some(([k]) => k === kind)),
  `${councilTools.length} council call(s): ${['framing', 'position', 'critique'].map(k => `${k} ${councilTools.filter(([x]) => x === k).length}`).join(', ')}, offered a tool ${councilTools.filter(([, n]) => n > 0).length}`)

  // Deleted while its question waits: the answer of the deletion route names nobody either.
  const helpToDelete = await turnIn(helpRoom.id, '@qwen sonde-entraide un autre point ?')
  const helpDeleteMessage = ((await api('GET', `/channels/${helpRoom.id}/messages`)).body.messages ?? []).find(m => m.turns?.[0]?.id === helpToDelete?.id)
  const helpDeleted = helpDeleteMessage === undefined ? undefined
    : (await api('POST', `/channels/${helpRoom.id}/messages/${helpDeleteMessage.id}/delete`)).body.message
  const unreadable = await turnIn(councilRoom.id, '@qwen conseil-illisible HT ou TTC ?')
  const councilDeleteMessage = ((await api('GET', `/channels/${councilRoom.id}/messages`)).body.messages ?? []).find(m => m.turns?.[0]?.id === unreadable?.id)
  const councilDeleted = councilDeleteMessage === undefined ? undefined
    : (await api('POST', `/channels/${councilRoom.id}/messages/${councilDeleteMessage.id}/delete`)).body.message
  const slotSkips = councilDeleted?.turns?.[0]?.council?.skipped.filter(s => s.slot !== undefined) ?? []
  // A deleted request withdraws its question from « À traiter ».
  const stillListed = (await escalations()).filter(e => [helpToDelete?.id, unreadable?.id].includes(e.turnId)).length
  check('deleted-anonymous', stillListed === 0 && helpToDelete?.help?.escalation !== undefined && helpDeleted?.deletedAt !== undefined && !names(helpDeleted.turns?.[0])
    && helpDeleted.turns?.[0]?.help?.peerIds.length === 0
    && unreadable?.council?.escalation !== undefined && councilDeleted?.deletedAt !== undefined && !names(councilDeleted.turns?.[0])
    && slotSkips.length === 1 && slotSkips.every(s => s.reason === 'avis non obtenu'),
  `still listed ${stillListed}; help deleted ${helpDeleted?.deletedAt !== undefined}, named ${names(helpDeleted?.turns?.[0])}; council deleted ${councilDeleted?.deletedAt !== undefined}, named ${names(councilDeleted?.turns?.[0])}, slot skips ${slotSkips.map(s => `« ${s.reason} »`).join(' ') || 'none'}`)
} else {
  check('coord-author-verifier', false, 'the seeded agents @assistant, @analyste and @qwen are not all there')
}
await browser.close()
await sleep(2000)

const gatewayAfter = started('gateway')
const unhandled = (logs('gateway').match(/Unhandled 'error' event/g) ?? []).length
check('gateway-alive', gatewayBefore === gatewayAfter && unhandled === 0, `before « ${gatewayBefore} », after « ${gatewayAfter} », unhandled errors ${unhandled}`)
const workbenchAfter = started('workbench')
check('workbench-alive', workbenchBefore === workbenchAfter, `before « ${workbenchBefore} », after « ${workbenchAfter} »`)
const health = await fetch(`${BASE}/mndt-api/health`).then(r => r.status, () => 0)
check('still-serves', health === 200, `health ${health}`)

// A help left open by a restart (#115, #116): the guide's count (§13.4) reads 1,
// the workbench restarts, its start closes the help and cancels the turn, the
// count reads 0. Last, since it restarts the workbench (after workbench-alive).
const asOwner = async (method, path, body) => {
  const answer = await fetch(`${BASE}/mndt-api${path}`, {
    method, headers: { 'x-forwarded-email': OWNER, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch(() => undefined)
  return { status: answer?.status ?? 0, body: answer === undefined ? {} : await answer.json().catch(() => ({})) }
}
/** The filter of the guide's §13.4 count, copied as is (« jq '<this>' …/state.json »). */
const GUIDE_COUNT = '[.messages[]?.turns[]? | select((.help != null and .help.state != "done") or (.council != null and .council.state != "done"))] | length'
/** @returns the guide's count of helps and councils not done, run with jq on a copy of state.json, removed after. */
const openCount = () => {
  const copy = `/tmp/${project}-state-${Date.now()}.json`
  docker('cp', `${project}-workbench:/state/state.json`, copy)
  try {
    // The command of the guide's §13.4, as written there.
    return execFileSync('jq', [GUIDE_COUNT, copy], { encoding: 'utf8' }).trim()
  } finally {
    unlinkSync(copy)
  }
}
const entraide = ((await asOwner('GET', '/channels')).body.channels ?? []).find(c => c.name === 'entraide')
const slow = entraide === undefined ? undefined : (await asOwner('POST', `/channels/${entraide.id}/messages`, { text: '@qwen sonde-entraide sonde-lente encore ?' })).body.message
let advising
for (let attempt = 0; attempt < 60 && slow !== undefined; attempt += 1) {
  advising = ((await asOwner('GET', `/channels/${entraide.id}/messages`)).body.messages ?? []).find(m => m.id === slow.id)?.turns?.[0]
  if (advising?.help?.state === 'advising') break
  await sleep(1000)
}
const before = advising?.help?.state === 'advising' ? openCount() : 'no help open'
docker('restart', `${project}-workbench`)
let back = 0
for (let attempt = 0; attempt < 90 && back !== 200; attempt += 1) {
  await sleep(2000)
  back = (await asOwner('GET', '/me')).status
}
const after = back === 200 ? openCount() : 'no API'
const closed = slow === undefined ? undefined : ((await asOwner('GET', `/channels/${entraide.id}/messages`)).body.messages ?? []).find(m => m.id === slow.id)?.turns?.[0]
check('restart-closes', before === '1' && after === '0' && closed?.status === 'cancelled' && closed.reason === 'interrompu par un redémarrage'
  && closed.help?.state === 'done' && closed.help.skipped.some(s => s.reason === 'avis non obtenu : redémarrage')
  && closed.help.advices.every(a => a.agentId === undefined) && closed.help.peerIds.length === 0,
`count before ${before}, after ${after}, turn ${closed?.status} « ${closed?.reason ?? '-'} », help ${closed?.help?.state ?? '-'}, API back ${back}`)

// The same for a council left open (#119): turns run one at a time, so the
// help and the council are left open one after the other.
const conseil = ((await asOwner('GET', '/channels')).body.channels ?? []).find(c => c.name === 'conseil')
const slowCouncil = conseil === undefined ? undefined : (await asOwner('POST', `/channels/${conseil.id}/messages`, { text: '@qwen sonde-lente HT ou TTC ?' })).body.message
let deliberating
for (let attempt = 0; attempt < 60 && slowCouncil !== undefined; attempt += 1) {
  deliberating = ((await asOwner('GET', `/channels/${conseil.id}/messages`)).body.messages ?? []).find(m => m.id === slowCouncil.id)?.turns?.[0]
  if (deliberating?.council?.state === 'deliberating' && deliberating.council.options.length > 0) break
  await sleep(1000)
}
const councilBefore = deliberating?.council?.state === 'deliberating' ? openCount() : 'no council open'
docker('restart', `${project}-workbench`)
let councilBack = 0
for (let attempt = 0; attempt < 90 && councilBack !== 200; attempt += 1) {
  await sleep(2000)
  councilBack = (await asOwner('GET', '/me')).status
}
// When /me answered again: the start of the delay tools-after-restart measures.
const apiBackAt = Date.now()
// (#126) a turn posted as soon as the API answers after a restart gets the
// card tools, all of them: it waits for the servers instead of running bare.
// The browser is closed by now: the probe goes through fetch, as the restarts do.
let restarted
if (councilBack === 200 && channel !== undefined && qwen !== undefined) {
  const asked = (await asOwner('POST', `/channels/${channel.id}/messages`, { text: '@qwen sonde-marque-redemarrage' })).body.message
  for (let attempt = 0; attempt < 90 && asked !== undefined; attempt += 1) {
    restarted = ((await asOwner('GET', `/channels/${channel.id}/messages`)).body.messages ?? []).find(m => m.id === asked.id)?.turns?.[0]
    if (restarted !== undefined && !['queued', 'running'].includes(restarted.status)) break
    await sleep(2000)
  }
}
const restartedMarker = markerOf('redemarrage')
// The turn starts once its servers are ready (it waits for them before the
// queue, #126): from /me answering to that start is how long the approvals
// took to register after the restart. Under 10 s (it was ~60 s before #132).
const readyMs = restarted?.startedAt === undefined ? undefined : Date.parse(restarted.startedAt) - apiBackAt
check('tools-after-restart', restarted?.status === 'done' && JSON.stringify(restartedMarker?.tools) === JSON.stringify(APPROVALS) && restarted.toolsUnavailable === undefined
  && readyMs !== undefined && readyMs < 10_000,
  `API back ${councilBack}, approvals ready ${readyMs === undefined ? '-' : `${(readyMs / 1000).toFixed(1)} s`} after /me (bound 10 s), turn ${restarted?.status ?? '-'} « ${restarted?.reason ?? '-'} », tools ${restartedMarker === undefined ? 'no call' : JSON.stringify(restartedMarker.tools) === JSON.stringify(APPROVALS) ? `the ${APPROVALS.length} card tools` : JSON.stringify(restartedMarker.tools)}, unavailable ${JSON.stringify(restarted?.toolsUnavailable ?? [])}`)
const councilAfter = councilBack === 200 ? openCount() : 'no API'
const closedCouncil = slowCouncil === undefined ? undefined
  : ((await asOwner('GET', `/channels/${conseil.id}/messages`)).body.messages ?? []).find(m => m.id === slowCouncil.id)?.turns?.[0]
check('restart-closes-council', councilBefore === '1' && councilAfter === '0' && closedCouncil?.status === 'cancelled'
  && closedCouncil.council?.state === 'done' && closedCouncil.council.decision === undefined
  && closedCouncil.council.skipped.some(s => s.reason === 'avis non obtenu : redémarrage')
  && closedCouncil.council.positions.every(p => p.agentId === undefined),
`count before ${councilBefore}, after ${councilAfter}, turn ${closedCouncil?.status}, council ${closedCouncil?.council?.state ?? '-'}, API back ${councilBack}`)
// The scheduler starts an automation by itself (« dernière : 2026-11-15 », 26/11:
// no check proved it; scheduler-first-pass only shows the switch-off at start).
// The owner sets the briefing to the current minute of the instance's zone and
// enables it; a pass (every 30 s) must start it (lastFiredDate today, lastFiredAt
// after the check began: lastMissionId is written only once the run is over),
// and the scheduler's last pass (schedulerAt) must be fresh. The briefing's time
// and switch are put back as they were found, whatever happens.
{
  const began = Date.now()
  const listed = (await asOwner('GET', '/automations')).body
  const zone = listed.timeZone ?? 'UTC'
  const passAge = listed.schedulerAt === undefined ? Infinity : began - Date.parse(listed.schedulerAt)
  const before = (listed.items ?? []).find(item => item.id === 'auto_briefing')
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(began)).map(part => [part.type, part.value]))
  const today = `${parts.year}-${parts.month}-${parts.day}`
  const startedHere = item => item?.lastFiredDate === today && Date.parse(item.lastFiredAt ?? '') >= began - 1000
  let after
  try {
    await asOwner('POST', '/schedule', { at: `${parts.hour}:${parts.minute}` })
    await asOwner('POST', '/automations/auto_briefing/toggle', { enabled: true })
    for (let waited = 0; waited < 100_000 && !startedHere(after); waited += 5000) {
      await sleep(5000)
      after = ((await asOwner('GET', '/automations')).body.items ?? []).find(item => item.id === 'auto_briefing')
    }
  } finally {
    if (before?.at !== undefined) await asOwner('POST', '/schedule', { at: before.at })
    await asOwner('POST', '/automations/auto_briefing/toggle', { enabled: before?.enabled === true })
  }
  check('scheduler-fires', startedHere(after) && passAge < 120_000,
    `set to ${parts.hour}:${parts.minute} (${zone}): lastFiredDate ${after?.lastFiredDate ?? '-'}, lastFiredAt ${after?.lastFiredAt ?? '-'}, last pass ${Number.isFinite(passAge) ? `${Math.round(passAge / 1000)} s ago` : 'never served'}; put back to ${before?.at ?? '-'}, ${before?.enabled === true ? 'enabled' : 'suspended'}`)
}
// The prefix cache (26/11, « @qwen bonjou »: 10 613 input tokens, cacheRead 0):
// two different turns of one agent in one channel whose static block did not
// change (everything before the history: the preamble, the rules, the agent,
// its role and skills, the channel's context; compared by a keyed fingerprint
// the fake model draws) share that whole block — every one of them, and at
// least three, or the check proves nothing. A mark drawn at random in the block
// changes it at each turn: no pair qualifies, and the check fails. A pair whose
// block changed (a context or a skill edited between two turns, which the
// rehearsal does) is not counted. Every call offers its tools in the host's
// order (toolOrder). Two agents share the space's preamble; no prompt opens
// with the date line. From the fake model's prompt-prefix lines.
{
  const lines = [...logs('fakellm').matchAll(/fake-llm prompt-prefix @(\S+) #(\S+): length=(\d+) common=(\S+) static=(\S+) staticSame=(\S+) tools=(\d+) toolsSorted=(\w+) preamble=(\w+) dateFirst=(\w+)/g)]
    .map(m => ({
      who: m[1], length: Number(m[3]), common: m[4] === '-' ? undefined : Number(m[4]),
      staticEnd: m[5] === '-' ? undefined : Number(m[5]), staticSame: m[6] === 'true',
      tools: Number(m[7]), toolsSorted: m[8] === 'true', preamble: m[9], dateFirst: m[10] === 'true',
    }))
  // A call whose first message differs from that agent's previous one (another
  // turn, not a step of a tool loop), with the same static block as before.
  const pairs = lines.filter(line => line.common !== undefined && line.common < line.length && line.staticEnd !== undefined && line.staticSame)
  const broken = pairs.filter(line => (line.common ?? 0) < (line.staticEnd ?? Infinity))
  const unsorted = lines.filter(line => !line.toolsSorted).length
  const withTools = lines.filter(line => line.tools > 0).length
  const agentsByPreamble = new Map()
  for (const line of lines) agentsByPreamble.set(line.preamble, new Set([...(agentsByPreamble.get(line.preamble) ?? []), line.who]))
  const shared = Math.max(0, ...[...agentsByPreamble.values()].map(agents => agents.size))
  const datedFirst = lines.filter(line => line.dateFirst).length
  check('prompt-cache-prefix', pairs.length >= 3 && broken.length === 0 && withTools > 0 && unsorted === 0 && shared >= 2 && datedFirst === 0,
    `${lines.length} calls; ${pairs.length} pairs of turns of one agent with an unchanged static block (≥ 3), ${broken.length} not sharing all of it (0); ${withTools} calls with tools, ${unsorted} not in the host's order (0); agents sharing the preamble ${shared} (≥ 2); prompts opening with the date ${datedFirst} (0)`)
}
console.log(`\nTOTAL ok=${results.filter(r => r.ok).length} ko=${results.filter(r => !r.ok).length}`)
process.exit(results.some(r => !r.ok) ? 1 : 0)
