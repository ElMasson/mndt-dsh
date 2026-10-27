#!/usr/bin/env node
/**
 * Browser control inside one person's sandbox.
 *
 * The container holds a single Chromium and this small server. It speaks five
 * verbs: open a page, click, type, screenshot, close. The product reaches it
 * over the front network with a shared token; nothing else is exposed, and the
 * process dies with the container.
 */
import { createServer } from 'node:http'
import { chromium } from 'playwright-core'

const PORT = Number(process.env.AGENT_PORT ?? 9223)
const TOKEN = process.env.AGENT_TOKEN ?? ''

let browser = null
let page = null

/** @returns the live page, launching Chromium on first use. */
async function currentPage() {
  if (page !== null && !page.isClosed()) return page
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'],
  })
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  return page
}

/** @param selector - CSS selector or text= form. @returns a Playwright locator. */
function locatorOf(target, selector) {
  const raw = String(selector ?? '').trim()
  if (raw === '') throw new Error('selector is required')
  if (raw.startsWith('text=')) return target.getByText(raw.slice(5))
  return target.locator(raw)
}

/**
 * Run one command and return a JSON-safe result.
 * @param body - parsed request body.
 * @returns result object.
 */
async function run(body) {
  const op = String(body.op ?? '')
  if (op === 'close') {
    if (browser !== null) await browser.close()
    browser = null
    page = null
    return { ok: true, closed: true }
  }
  if (op === 'status') return { ok: true, url: page?.url() ?? '', closed: page === null }
  const target = await currentPage()
  if (op === 'goto') {
    const url = String(body.url ?? '').trim()
    if (!/^https?:\/\//.test(url)) throw new Error('url must start with http:// or https://')
    await target.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 })
    return { ok: true, url: target.url(), title: await target.title() }
  }
  if (op === 'click') {
    await locatorOf(target, body.selector).first().click({ timeout: 15_000 })
    await target.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined)
    return { ok: true, url: target.url() }
  }
  if (op === 'fill') {
    await locatorOf(target, body.selector).first().fill(String(body.text ?? ''), { timeout: 15_000 })
    return { ok: true }
  }
  if (op === 'press') {
    await locatorOf(target, body.selector).first().press(String(body.key ?? 'Enter'), { timeout: 15_000 })
    return { ok: true }
  }
  if (op === 'text') {
    const text = body.selector === undefined
      ? await target.evaluate(() => document.body.innerText)
      : await locatorOf(target, body.selector).first().innerText({ timeout: 15_000 })
    return { ok: true, text: String(text).slice(0, 4000) }
  }
  if (op === 'screenshot') {
    const buffer = await target.screenshot({ fullPage: body.full === true })
    return { ok: true, png: buffer.toString('base64'), url: target.url() }
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
        reply(200, await run(JSON.parse(raw === '' ? '{}' : raw)))
      } catch (error) {
        reply(400, { error: error instanceof Error ? error.message : String(error) })
      }
    })()
  })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`browser agent: listening on ${PORT}`)
})
