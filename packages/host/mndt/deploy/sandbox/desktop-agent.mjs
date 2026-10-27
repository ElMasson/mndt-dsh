#!/usr/bin/env node
/**
 * A small desktop, for one person.
 *
 * Xvfb gives a real screen, Chromium renders in it, and this server turns four
 * verbs into xdotool commands: screenshot, click, type, key. It is the
 * computer-use counterpart of the browser agent.
 */
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const PORT = Number(process.env.DESKTOP_PORT ?? 9224)
const TOKEN = process.env.DESKTOP_TOKEN ?? ''
const DISPLAY = process.env.DISPLAY ?? ':99'

/** @param args - xdotool arguments. @returns nothing, throws on failure. */
async function xdo(...args) {
  await run('xdotool', args, { env: { ...process.env, DISPLAY } })
}

/**
 * Run one command.
 * @param body - parsed request.
 * @returns result object.
 */
async function command(body) {
  const op = String(body.op ?? '')
  if (op === 'screenshot') {
    const target = `/tmp/desktop-${Date.now()}.png`
    await run('import', ['-display', DISPLAY, '-window', 'root', target])
    const { stdout } = await run('base64', ['-w', '0', target])
    await run('rm', ['-f', target])
    return { ok: true, png: stdout.trim() }
  }
  if (op === 'click') {
    const x = Number(body.x ?? 0)
    const y = Number(body.y ?? 0)
    await xdo('mousemove', String(Math.round(x)), String(Math.round(y)), 'click', '1')
    return { ok: true }
  }
  if (op === 'type') {
    await xdo('type', '--delay', '40', String(body.text ?? ''))
    return { ok: true }
  }
  if (op === 'key') {
    await xdo('key', String(body.key ?? 'Return'))
    return { ok: true }
  }
  if (op === 'open') {
    const url = String(body.url ?? '').trim()
    if (!/^https?:\/\//.test(url)) throw new Error('url must start with http:// or https://')
    await run('sh', ['-c', `DISPLAY=${DISPLAY} chromium --no-sandbox --kiosk --window-size=1280,800 ${JSON.stringify(url)} >/tmp/chrome.log 2>&1 &`])
    return { ok: true }
  }
  throw new Error(`unknown op ${op}`)
}

const server = createServer((req, res) => {
  const reply = (status, body) => {
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
  }
  if (TOKEN !== '' && req.headers['x-agent-token'] !== TOKEN) {
    reply(403, { error: 'an agent token is required' })
    return
  }
  if (req.method === 'GET' && req.url === '/health') {
    reply(200, { ok: true })
    return
  }
  if (req.method !== 'POST') {
    reply(404, { error: 'unknown path' })
    return
  }
  let raw = ''
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    void (async () => {
      try {
        reply(200, await command(JSON.parse(raw === '' ? '{}' : raw)))
      } catch (error) {
        reply(400, { error: error instanceof Error ? error.message : String(error) })
      }
    })()
  })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`desktop agent: listening on ${PORT}, display ${DISPLAY}`)
})
