/**
 * Front gateway for the mndt workbench.
 *
 * Two jobs, both needed because the workbench keeps its own launch token and its
 * product API is a separate listener:
 *
 * - the shell needs a bootstrap visit carrying `?token=<launch token>`; this
 *   gateway reads that token from a shared file and redirects a browser that
 *   carries no session cookie yet, so a person arriving through single sign-on
 *   lands on the page without ever handling the token;
 * - `/mndt-api/*` is routed to the product API, which reads the identity the
 *   sign-on proxy proved from `x-forwarded-email`, so page actions belong to the
 *   person who made them.
 *
 * Node only, no dependency: it must start inside a bare runtime image.
 */
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'

const PORT = Number(process.env.PORT ?? 8080)
const WORKBENCH = process.env.WORKBENCH ?? 'http://host.docker.internal:3111'
const API = process.env.API ?? 'http://host.docker.internal:8795'
const TOKEN_FILE = process.env.TOKEN_FILE ?? '/state/web-token'
const API_PREFIX = '/mndt-api'

/** Signals that the browser already exchanged the launch token. */
const SESSION_COOKIE = 'dsh-auth-'

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
 * Forward one request upstream, including the headers a proxy already proved.
 * @param req - incoming request.
 * @param res - outgoing response.
 * @param target - upstream base URL.
 * @param path - upstream path.
 */
function forward(req, res, target, path) {
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
  const upstream = httpRequest({
    protocol: parts.protocol,
    hostname: parts.host,
    port: parts.port,
    method: req.method,
    path,
    headers,
  }, (answer) => {
    // The shell marks its session cookie SameSite=Strict. A browser arriving
    // through the sign-on proxy lands on a redirect chain started by Microsoft,
    // and Chrome then refuses to send that cookie back, which turns the session
    // bootstrap into a redirect loop. Lax keeps the cross-site protection that
    // matters here (no cross-site POST, no cross-site subresource) while letting
    // the same-site redirect carry the session.
    const headers = { ...answer.headers }
    const cookies = answer.headers['set-cookie']
    if (cookies !== undefined) {
      headers['set-cookie'] = cookies.map((cookie) =>
        cookie.includes('dsh-auth-') ? cookie.replace(/SameSite=Strict/i, 'SameSite=Lax') : cookie)
    }
    res.writeHead(answer.statusCode ?? 502, headers)
    answer.pipe(res)
  })
  upstream.on('error', (error) => {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`gateway: upstream failed: ${error.message}`)
  })
  req.pipe(upstream)
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://gateway')
  if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
    const rest = url.pathname.slice(API_PREFIX.length) || '/'
    forward(req, res, API, `${rest}${url.search}`)
    return
  }
  const cookie = String(req.headers.cookie ?? '')
  const hasSession = cookie.includes(SESSION_COOKIE)
  const token = launchToken()
  if (!hasSession && token !== '' && url.searchParams.get('token') !== token) {
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
  const parts = targetOf(WORKBENCH)
  const headers = { ...req.headers }
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
