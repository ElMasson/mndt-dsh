/**
 * Front gateway for the mndt workbench.
 *
 * Three jobs, all needed because the workbench keeps its own launch token, its
 * session cookie belongs to the shell, and its product API is a separate
 * listener:
 *
 * - the shell needs a bootstrap visit carrying `?token=<launch token>`. This
 *   gateway performs that exchange server-side for a person the sign-on proxy
 *   already proved, keeps the resulting shell cookie, and hands the browser a
 *   session cookie of its own. The browser never sees the launch token, and the
 *   session no longer depends on the shell's cookie attributes, which a real
 *   browser refused to replay after a sign-on redirect;
 * - `/mndt-api/*` is routed to the product API, which reads the identity the
 *   sign-on proxy proved from `x-forwarded-email`, so page actions belong to the
 *   person who made them;
 * - a browser with no session and no identity still gets the old token redirect,
 *   which is what the local checks use.
 *
 * Node only, no dependency: it must start inside a bare runtime image.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'

const PORT = Number(process.env.PORT ?? 8080)
const WORKBENCH = process.env.WORKBENCH ?? 'http://host.docker.internal:3111'
const API = process.env.API ?? 'http://host.docker.internal:8795'
const TOKEN_FILE = process.env.TOKEN_FILE ?? '/state/web-token'
const API_PREFIX = '/mndt-api'
const GATEWAY_COOKIE = 'mndt-session'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Sessions this gateway opened, keyed by its own cookie value. */
const sessions = new Map()

let cachedToken = ''
let cachedAt = 0

/**
 * Read the launch token the workbench published, refreshing on file change.
 * @returns the token, or an empty string while the workbench is still starting.
 */
function launchToken() {
  try {
    const stat = statSync(TOKEN_FILE)
    if (stat.mtimeMs !== cachedAt) {
      cachedToken = readFileSync(TOKEN_FILE, 'utf8').trim()
      cachedAt = stat.mtimeMs
    }
  } catch {
    return ''
  }
  return cachedToken
}

/** @param target - base URL. @returns parts used by both request paths. */
function targetOf(target) {
  const url = new URL(target)
  return { host: url.hostname, port: Number(url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : url.port), protocol: url.protocol }
}

/**
 * Parse a Cookie header.
 * @param header - raw header value.
 * @returns cookie name to value.
 */
function cookiesOf(header) {
  const result = new Map()
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    result.set(part.slice(0, index).trim(), part.slice(index + 1).trim())
  }
  return result
}

/** @param value - cookie value. @returns the Set-Cookie header for a session. */
function sessionCookie(value) {
  return `${GATEWAY_COOKIE}=${value}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; SameSite=Lax`
}

/**
 * Forward one request upstream, including the headers a proxy already proved.
 * @param req - incoming request.
 * @param res - outgoing response.
 * @param target - upstream base URL.
 * @param path - upstream path.
 * @param shellCookie - shell session cookie to present upstream, if known.
 */
function forward(req, res, target, path, shellCookie) {
  const parts = targetOf(target)
  // Keep the authority the browser used. The shell signs its session cookie for
  // that authority and refuses a cookie signed for another one, so rewriting the
  // host here would break the session right after sign-in. The proxy already
  // forwarded the public host, and the workbench is told to trust it.
  const headers = { ...req.headers }
  if (typeof req.headers.host === 'string' && req.headers.host !== '') {
    headers['x-forwarded-host'] = req.headers.host
  }
  headers['x-forwarded-proto'] = 'https'
  if (shellCookie !== undefined) headers.cookie = shellCookie
  const upstream = httpRequest({
    protocol: parts.protocol,
    hostname: parts.host,
    port: parts.port,
    method: req.method,
    path,
    headers,
  }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, answer.headers)
    answer.pipe(res)
  })
  upstream.on('error', (error) => {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`gateway: upstream failed: ${error.message}`)
  })
  req.pipe(upstream)
}

/** @param value - header value or undefined. @returns one header string. */
function firstHeader(value) {
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '')
}

/**
 * Exchange the launch token for a shell session, server-side.
 * @param req - incoming request, used to copy the authority the browser used.
 * @param token - launch token.
 * @returns the shell cookie, or an empty string when the exchange failed.
 */
function openShellSession(req, token) {
  return new Promise((resolve) => {
    const parts = targetOf(WORKBENCH)
    const headers = {}
    for (const name of ['host', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-email', 'x-forwarded-user']) {
      const value = req.headers[name]
      if (value !== undefined) headers[name] = value
    }
    if (headers.host === undefined && typeof req.headers.host === 'string') headers.host = req.headers.host
    const exchange = httpRequest({
      protocol: parts.protocol,
      hostname: parts.host,
      port: parts.port,
      method: 'GET',
      path: `/?token=${encodeURIComponent(token)}`,
      headers,
    }, (answer) => {
      const raw = answer.headers['set-cookie']
      const list = raw === undefined ? [] : raw
      const shell = list.find(cookie => cookie.includes('dsh-auth-'))
      answer.resume()
      resolve(shell === undefined ? '' : shell.split(';')[0])
    })
    exchange.on('error', () => { resolve('') })
    exchange.end()
  })
}

/** @param cookie - shell cookie. @param email - identity the proxy proved. */
function rememberSession(cookie, email) {
  const id = randomUUID()
  sessions.set(id, { cookie, email, at: Date.now() })
  return id
}

/** @param id - gateway session id. @returns the live session, or undefined. */
function liveSession(id) {
  const found = sessions.get(id)
  if (found === undefined) return undefined
  if (Date.now() - found.at > SESSION_TTL_MS) {
    sessions.delete(id)
    return undefined
  }
  return found
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://gateway')
  if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
    const rest = url.pathname.slice(API_PREFIX.length) || '/'
    forward(req, res, API, `${rest}${url.search}`)
    return
  }
  const cookies = cookiesOf(req.headers.cookie)
  const email = firstHeader(req.headers['x-forwarded-email'])
  const token = launchToken()
  const existing = cookies.get(GATEWAY_COOKIE)
  const session = existing === undefined ? undefined : liveSession(existing)
  if (session !== undefined && (email === '' || session.email === email)) {
    forward(req, res, WORKBENCH, `${url.pathname}${url.search}`, session.cookie)
    return
  }
  if (email !== '' && token !== '') {
    void openShellSession(req, token).then((shellCookie) => {
      if (shellCookie === '') {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('gateway: the workbench did not open a session')
        return
      }
      const id = rememberSession(shellCookie, email)
      res.writeHead(302, {
        location: url.pathname,
        'set-cookie': sessionCookie(id),
        'cache-control': 'no-store',
      })
      res.end()
    })
    return
  }
  if (token !== '' && url.searchParams.get('token') !== token) {
    res.writeHead(302, { location: `/?token=${encodeURIComponent(token)}` })
    res.end()
    return
  }
  forward(req, res, WORKBENCH, `${url.pathname}${url.search}`)
})

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://gateway')
  if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
    socket.destroy()
    return
  }
  const cookies = cookiesOf(req.headers.cookie)
  const existing = cookies.get(GATEWAY_COOKIE)
  const session = existing === undefined ? undefined : liveSession(existing)
  const parts = targetOf(WORKBENCH)
  const headers = { ...req.headers }
  if (session !== undefined) headers.cookie = session.cookie
  if (typeof req.headers.host === 'string' && req.headers.host !== '') {
    headers['x-forwarded-host'] = req.headers.host
  }
  const upstream = httpRequest({
    protocol: parts.protocol,
    hostname: parts.host,
    port: parts.port,
    method: req.method,
    path: `${url.pathname}${url.search}`,
    headers,
  })
  upstream.on('upgrade', (answer, upstreamSocket, upstreamHead) => {
    const lines = [`HTTP/1.1 101 Switching Protocols`]
    for (let index = 0; index < answer.rawHeaders.length; index += 2) {
      lines.push(`${answer.rawHeaders[index]}: ${answer.rawHeaders[index + 1]}`)
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (upstreamHead.length > 0) socket.write(upstreamHead)
    if (head.length > 0) upstreamSocket.write(head)
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
  })
  upstream.on('error', () => { socket.destroy() })
  upstream.end()
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`mndt gateway: listening on ${PORT}, workbench ${WORKBENCH}, api ${API}`)
})

process.on('SIGTERM', () => { server.close(() => { process.exit(0) }) })
