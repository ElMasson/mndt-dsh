/**
 * Declare the agents of a tenant through its API, as its owner; idempotent.
 *
 *   MNDT_API_URL=http://workbench:8795 MNDT_OWNER=<email> AGENTS_JSON='<agents.json>' node seed-team.mjs
 *   ... CEILING='<handle>=<euros>' node seed-team.mjs     # set one agent's monthly ceiling
 *
 * The API reads the owner from x-forwarded-email (the workbench trusts it on
 * its private network, as it trusts the sign-on proxy). An agent already
 * declared is left as it is; a ${VAR} model is read from the environment, and
 * an agent whose model stays empty is skipped and said so. Nothing here
 * touches the ceiling check: CEILING only uses the owner's right to set one.
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

const declared = (await call('/agents')).agents ?? []
const byHandle = new Map(declared.map(agent => [agent.handle, agent]))

if (process.env.CEILING !== undefined && process.env.CEILING !== '') {
  const [handle, euros] = process.env.CEILING.split('=')
  const agent = byHandle.get(handle ?? '')
  const eurPerMonth = Number(euros)
  if (agent === undefined) throw new Error(`no agent @${handle}`)
  if (!Number.isFinite(eurPerMonth) || eurPerMonth <= 0) throw new Error('the ceiling is a positive number of euros')
  const { agent: updated } = await call(`/agents/${agent.id}`, { eurPerMonth })
  console.log(`@${updated.handle}: ceiling ${updated.eurPerMonth} euros a month (spent ${agent.eurThisMonth ?? 0})`)
  process.exit(0)
}

const wanted = JSON.parse(process.env.AGENTS_JSON ?? '{"agents":[]}').agents ?? []
// The API refuses an agent naming a connector the workbench has not mounted:
// each agent gets the ones mounted now, and the others are said, to add once
// mounted (POST /agents/:id { connectors }).
const mounted = new Set(((await call('/connectors')).connectors ?? []).filter(c => c.enabled).map(c => c.server))
for (const draft of wanted) {
  const model = String(draft.model).replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => process.env[name] ?? '')
  if (byHandle.has(draft.handle)) {
    console.log(`@${draft.handle}: already declared, left as it is`)
    continue
  }
  if (model.trim() === '') {
    console.log(`@${draft.handle}: skipped, its model ${draft.model} is not set in model.env`)
    continue
  }
  const connectors = (draft.connectors ?? []).filter(server => mounted.has(server))
  const waiting = (draft.connectors ?? []).filter(server => !mounted.has(server))
  const { agent } = await call('/agents', { ...draft, model, connectors })
  console.log(`@${agent.handle}: declared on ${agent.provider}/${agent.model}, ceiling ${agent.eurPerMonth} euros a month` +
    (waiting.length === 0 ? '' : `; connectors not mounted yet: ${waiting.join(', ')}`))
}
