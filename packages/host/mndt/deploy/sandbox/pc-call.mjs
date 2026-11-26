#!/usr/bin/env node
/**
 * One action on this computer's own agents, run by the sidecar through
 * `docker exec`: the kind in argv (browser or desktop), the operation as JSON on
 * stdin, the agent's JSON answer on stdout. The agents listen on the loopback
 * only, so nothing outside the computer reaches them but through this.
 */
const kind = process.argv[2]
const port = kind === 'browser' ? Number(process.env.AGENT_PORT ?? 9223) : kind === 'desktop' ? Number(process.env.DESKTOP_PORT ?? 9224) : 0
const token = kind === 'browser' ? process.env.AGENT_TOKEN ?? '' : process.env.DESKTOP_TOKEN ?? ''

/** @returns stdin, whole. */
async function input() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  return raw === '' ? '{}' : raw
}

/** @param body - what to print. @param code - the exit code. */
function done(body, code) {
  process.stdout.write(`${JSON.stringify(body)}\n`)
  process.exitCode = code
}

if (port === 0) {
  done({ ok: false, error: 'unknown kind' }, 2)
} else {
  const body = await input()
  // The agent may still be starting: a few tries, then the answer as it is.
  let last = { ok: false, error: 'the agent did not answer' }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const answer = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-token': token },
        body,
      })
      const payload = await answer.json().catch(() => ({ ok: false, error: 'the agent answered no JSON' }))
      last = { ...payload, status: answer.status }
      break
    } catch {
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  done(last, last.ok === true ? 0 : 1)
}
