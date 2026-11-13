/**
 * Give the declared agents the connectors they ask for, among those mounted now.
 *
 *   MNDT_API_URL=http://workbench:8795 MNDT_OWNER=<email> AGENTS_JSON='<agents.json>' node attach-agent-connectors.mjs
 *
 * seed-team.mjs declares each agent with the connectors mounted at that time
 * and leaves a declared agent alone. Once install-connectors.sh has mounted
 * more, this adds the missing ones to each agent of agents.json, as the owner
 * through the API, and never removes one (an owner's own choice stays).
 * Idempotent: an agent that already has them is left as it is.
 */
const api = (process.env.MNDT_API_URL ?? '').replace(/\/$/, '')
const owner = process.env.MNDT_OWNER ?? ''
if (api === '' || owner === '') {
  console.error('MNDT_API_URL and MNDT_OWNER are required')
  process.exit(1)
}

/** @param path - API path. @param body - JSON body, for a POST. @returns the parsed answer. */
async function call(path, body) {
  const answer = await fetch(`${api}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-email': owner },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const parsed = await answer.json().catch(() => ({}))
  if (!answer.ok) throw new Error(`${path}: ${answer.status} ${parsed.error ?? ''}`.trim())
  return parsed
}

const wanted = JSON.parse(process.env.AGENTS_JSON ?? '{"agents":[]}').agents ?? []
const declared = new Map(((await call('/agents')).agents ?? []).map(agent => [agent.handle, agent]))
const mounted = new Set(((await call('/connectors')).connectors ?? []).filter(c => c.enabled).map(c => c.server))
for (const draft of wanted) {
  const agent = declared.get(draft.handle)
  if (agent === undefined) {
    console.log(`@${draft.handle}: not declared, run seed-team.sh first`)
    continue
  }
  const current = agent.connectors ?? []
  const asked = draft.connectors ?? []
  const adding = asked.filter(server => mounted.has(server) && !current.includes(server))
  const waiting = asked.filter(server => !mounted.has(server))
  if (adding.length > 0) await call(`/agents/${agent.id}`, { connectors: [...current, ...adding] })
  const now = [...current, ...adding]
  console.log(`@${draft.handle}: ${now.length === 0 ? 'no connector' : `connectors ${now.join(', ')}`}` +
    (adding.length === 0 ? '' : ` (added ${adding.join(', ')})`) +
    (waiting.length === 0 ? '' : `; not mounted yet: ${waiting.join(', ')}`))
}
