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
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { readFileSync, statSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'

const PORT = Number(process.env.PORT ?? 8080)
const WORKBENCH = process.env.WORKBENCH ?? 'http://host.docker.internal:3111'
const API = process.env.API ?? 'http://host.docker.internal:8795'
const TOKEN_FILE = process.env.TOKEN_FILE ?? '/state/web-token'
const SHELLS_URL = (process.env.SHELLS_URL ?? process.env.MNDT_MACHINES_URL ?? '').replace(/\/$/, '')
const MACHINES_TOKEN = process.env.MACHINES_TOKEN ?? ''
const SHELL_TTL_MS = 5 * 60 * 1000
const API_PREFIX = '/mndt-api'
const GATEWAY_COOKIE = 'mndt-session'
// The secret that makes the identity header believable to the API: a file
// outside /state, mounted read-only here and in the workbench. Read once.
const GATEWAY_SECRET_HEADER = 'x-mndt-gateway'
// The sign-on proxy's key (oauth2-proxy `signature_key`, a file outside /state).
// The gateway serves only requests the proxy signed (GAP-Signature): a request
// from anywhere else (a container of the tenant's network, an agent's command)
// is refused before any identity is relayed or any secret added. Without a key,
// nothing is served: closed, not open.
const PROXY_KEY = (() => {
  const path = process.env.PROXY_SIGNATURE_KEY_FILE ?? ''
  if (path === '') return ''
  try { return readFileSync(path, 'utf8').trim() } catch { return '' }
})()
// The headers oauth2-proxy signs, in its order (pkg/upstream/http.go, SignatureHeaders).
const SIGNED_HEADERS = ['content-length', 'content-md5', 'content-type', 'date', 'authorization', 'x-forwarded-user',
  'x-forwarded-email', 'x-forwarded-preferred-user', 'x-forwarded-access-token', 'cookie', 'gap-auth']
// The largest request body the gateway reads to check its signature: 1 MiB, but
// 20 MiB for a document deposit (10 MiB, base64). A declared length above it is
// refused before anything is read.
const MAX_BODY = 1024 * 1024
const MAX_DEPOSIT_BODY = 20 * 1024 * 1024
const DEPOSIT_ROUTE = /^\/mndt-api\/channels\/[^/]+\/files\/?$/
// The sign-on proxy's own cookies (cookie_name "_mndt_<slug>", split as _0, _1 when large).
const SSO_COOKIE_PREFIX = process.env.SSO_COOKIE_PREFIX ?? '_mndt_'
const GATEWAY_SECRET = (() => {
  const path = process.env.GATEWAY_SECRET_FILE ?? ''
  if (path === '') return ''
  try { return readFileSync(path, 'utf8').trim() } catch { return '' }
})()
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Sessions this gateway opened, keyed by its own cookie value. */
const sessions = new Map()
/** Shell targets per identity, so a page load does not ask every time. */
const shells = new Map()

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
function forward(req, res, target, path, shellCookie, extraHeaders = {}) {
  const parts = targetOf(target)
  // Keep the authority the browser used. The shell signs its session cookie for
  // that authority and refuses a cookie signed for another one, so rewriting the
  // host here would break the session right after sign-in. The proxy already
  // forwarded the public host, and the workbench is told to trust it.
  const headers = withoutProxyCredentials({ ...req.headers }, target === API)
  if (typeof req.headers.host === 'string' && req.headers.host !== '') {
    headers['x-forwarded-host'] = req.headers.host
  }
  headers['x-forwarded-proto'] = 'https'
  if (shellCookie !== undefined) headers.cookie = shellCookie
  Object.assign(headers, extraHeaders)
  const upstream = httpRequest({
    protocol: parts.protocol,
    hostname: parts.host,
    port: parts.port,
    method: req.method,
    path,
    headers,
  }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, answer.headers)
    // An upstream answer cut halfway ends the browser's answer, never the gateway.
    answer.on('error', () => { res.destroy() })
    answer.pipe(res)
  })
  upstream.on('error', (error) => {
    // Once headers left, a second writeHead would throw and kill the gateway for
    // everyone: the browser's answer is cut instead.
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`gateway: upstream failed: ${error.message}`)
  })
  // A browser that leaves mid-request (closed tab, lost network) resets its
  // socket: drop the upstream call, and never let the reset reach the process.
  req.on('error', () => { upstream.destroy() })
  res.on('close', () => { if (!res.writableFinished) upstream.destroy() })
  if (req.bufferedBody !== undefined) upstream.end(req.bufferedBody)
  else req.pipe(upstream)
}

/** @param value - header value or undefined. @returns one header string. */
function firstHeader(value) {
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '')
}

/**
 * Ask the machine service for this person's own shell, starting it if needed.
 * @param email - identity the sign-on proxy proved.
 * @returns the shell base URL and its launch token, or undefined when unavailable.
 */
async function shellFor(email) {
  const known = shells.get(email)
  if (known !== undefined && Date.now() - known.at < SHELL_TTL_MS) return known
  try {
    const answer = await fetch(`${SHELLS_URL}/shells/ensure?identity=${encodeURIComponent(email)}`, {
      headers: { 'x-machine-token': MACHINES_TOKEN },
    })
    const body = await answer.json()
    if (!answer.ok || body.ok !== true) return undefined
    const found = { base: `http://${body.host}:3111`, token: String(body.token ?? ''), at: Date.now() }
    shells.set(email, found)
    return found
  } catch {
    return undefined
  }
}

/**
 * Exchange the launch token for a shell session, server-side.
 * @param req - incoming request, used to copy the authority the browser used.
 * @param base - shell base URL.
 * @param token - launch token.
 * @returns the shell cookie, or an empty string when the exchange failed.
 */
function openShellSession(req, base, token) {
  return new Promise((resolve) => {
    const parts = targetOf(base)
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

/**
 * @param cookie - shell cookie.
 * @param email - identity the proxy proved.
 * @param base - shell base URL this session belongs to.
 * @returns the gateway session id.
 */
function rememberSession(cookie, email, base) {
  const id = randomUUID()
  sessions.set(id, { cookie, email, base, at: Date.now() })
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

/**
 * The headers the workbench must never see: the proxy's signature and its own
 * header, and the person's sign-on cookie (an agent in the workbench reads all).
 * The API needs no cookie at all.
 * @param headers - the headers about to be relayed (changed in place).
 * @param toApi - whether they go to the product API.
 * @returns the same headers.
 */
function withoutProxyCredentials(headers, toApi) {
  delete headers['gap-signature']
  delete headers['gap-auth']
  if (toApi) {
    delete headers.cookie
    return headers
  }
  if (typeof headers.cookie === 'string') {
    const kept = headers.cookie.split(';').map(part => part.trim()).filter(part => part !== '' && !part.startsWith(SSO_COOKIE_PREFIX))
    if (kept.length === 0) delete headers.cookie
    else headers.cookie = kept.join('; ')
  }
  return headers
}

/**
 * @param req - incoming request.
 * @returns the largest body this request may carry.
 */
function bodyLimit(req) {
  const path = (req.url ?? '/').split('?')[0]
  return req.method === 'POST' && DEPOSIT_ROUTE.test(path) ? MAX_DEPOSIT_BODY : MAX_BODY
}

/**
 * The string oauth2-proxy signs (hmacauth StringToSign): method, each signed
 * header (values joined by a comma, empty when absent), the DECODED path with
 * the raw query, each on its own line. Proven against oauth2-proxy v7.15.5.
 * @param req - incoming request.
 * @returns the text to sign, before the body.
 */
function stringToSign(req) {
  const raw = req.url ?? '/'
  const q = raw.indexOf('?')
  const rawPath = q === -1 ? raw : raw.slice(0, q)
  let path
  try { path = decodeURIComponent(rawPath) } catch { path = rawPath }
  const target = q === -1 ? path : `${path}?${raw.slice(q + 1)}`
  return `${req.method}\n${SIGNED_HEADERS.map(name => `${(req.headersDistinct[name] ?? []).join(',')}\n`).join('')}${target}\n`
}

/**
 * @param req - incoming request.
 * @param body - its whole body (empty for none).
 * @returns whether the sign-on proxy signed exactly this request.
 */
function signedByProxy(req, body) {
  if (PROXY_KEY === '') return false
  const presented = firstHeader(req.headers['gap-signature'])
  const expected = `sha256 ${createHmac('sha256', PROXY_KEY).update(stringToSign(req)).update(body).digest('base64')}`
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Read a request body, at most bodyLimit(req) bytes.
 * @param req - incoming request.
 * @returns the body, or undefined when it is too large or the browser left.
 */
function readBody(req) {
  const limit = bodyLimit(req)
  return new Promise((resolve) => {
    if (Number(req.headers['content-length'] ?? 0) > limit) { resolve(undefined); return }
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { resolve(undefined); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks)) })
    req.on('error', () => { resolve(undefined) })
  })
}

const server = createServer((req, res) => {
  void (async () => {
    const body = await readBody(req)
    if (body === undefined) {
      if (!res.headersSent && !res.destroyed) { res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' }); res.end('gateway: request too large') }
      return
    }
    if (!signedByProxy(req, body)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('gateway: this request does not come from the sign-on proxy')
      return
    }
    req.bufferedBody = body
    serve(req, res)
  })()
})

/**
 * Serve one request the sign-on proxy signed.
 * @param req - incoming request, its body already read.
 * @param res - outgoing response.
 */
function serve(req, res) {
  // A browser never speaks for the gateway.
  delete req.headers[GATEWAY_SECRET_HEADER]
  const url = new URL(req.url ?? '/', 'http://gateway')
  if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
    const rest = url.pathname.slice(API_PREFIX.length) || '/'
    // Only the approvals connector, inside the workbench, names the agent run a
    // card belongs to: a browser that sends it could file a card in the thread
    // of another channel's turn.
    delete req.headers['x-mndt-run']
    // Only this gateway vouches for the identity header: the API believes it on this secret alone.
    forward(req, res, API, `${rest}${url.search}`, undefined, GATEWAY_SECRET === '' ? {} : { [GATEWAY_SECRET_HEADER]: GATEWAY_SECRET })
    return
  }
  const cookies = cookiesOf(req.headers.cookie)
  const email = firstHeader(req.headers['x-forwarded-email'])
  const token = launchToken()
  const existing = cookies.get(GATEWAY_COOKIE)
  const session = existing === undefined ? undefined : liveSession(existing)
  // A person proven by the sign-on proxy gets their own shell when the machine
  // service is configured. Otherwise the shared workbench keeps serving the
  // local checks, which carry no identity.
  const perPerson = email !== '' && SHELLS_URL !== ''
  if (session !== undefined && (email === '' || session.email === email)) {
    forward(req, res, session.base ?? WORKBENCH, `${url.pathname}${url.search}`, session.cookie)
    return
  }
  if (perPerson) {
    void shellFor(email).then(async (found) => {
      if (found === undefined) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('gateway: no shell is available for this person')
        return
      }
      let base = found.base
      let shellCookie = await openShellSession(req, base, found.token)
      // A restarted shell rotates its launch token: drop the cached one and ask
      // once more before reporting a failure.
      if (shellCookie === '') {
        shells.delete(email)
        const fresh = await shellFor(email)
        if (fresh !== undefined) {
          base = fresh.base
          shellCookie = await openShellSession(req, base, fresh.token)
        }
      }
      if (shellCookie === '') {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('gateway: the shell did not open a session')
        return
      }
      const id = rememberSession(shellCookie, email, base)
      res.writeHead(302, {
        location: url.pathname,
        'set-cookie': sessionCookie(id),
        'cache-control': 'no-store',
      })
      res.end()
    })
    return
  }
  if (email !== '' && token !== '') {
    void openShellSession(req, WORKBENCH, token).then((shellCookie) => {
      if (shellCookie === '') {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('gateway: the workbench did not open a session')
        return
      }
      const id = rememberSession(shellCookie, email, WORKBENCH)
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
}

server.on('upgrade', (req, socket, head) => {
  delete req.headers[GATEWAY_SECRET_HEADER]
  socket.on('error', () => undefined)
  if (!signedByProxy(req, Buffer.alloc(0))) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
    return
  }
  const url = new URL(req.url ?? '/', 'http://gateway')
  if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
    socket.destroy()
    return
  }
  const cookies = cookiesOf(req.headers.cookie)
  const existing = cookies.get(GATEWAY_COOKIE)
  const session = existing === undefined ? undefined : liveSession(existing)
  const parts = targetOf(session?.base ?? WORKBENCH)
  const headers = withoutProxyCredentials({ ...req.headers }, false)
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
  // A WebSocket lives long and ends abruptly (closed tab, sleeping laptop,
  // mobile network, a proxy recycling its connections): every socket of it has
  // an error handler, and one side closing closes the other. An unhandled reset
  // here used to kill the gateway for every person at once.
  socket.on('error', () => { upstream.destroy() })
  upstream.on('upgrade', (answer, upstreamSocket, upstreamHead) => {
    upstreamSocket.on('error', () => { socket.destroy() })
    socket.on('error', () => { upstreamSocket.destroy() })
    upstreamSocket.on('close', () => { socket.destroy() })
    socket.on('close', () => { upstreamSocket.destroy() })
    if (socket.destroyed) {
      upstreamSocket.destroy()
      return
    }
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
  // The upstream answered without switching protocols (refused, not found):
  // say so to the browser instead of leaving its socket hanging.
  upstream.on('response', (answer) => {
    answer.resume()
    if (!socket.destroyed) socket.end(`HTTP/1.1 ${answer.statusCode ?? 502} ${answer.statusMessage ?? ''}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
  })
  upstream.on('error', () => { socket.destroy() })
  upstream.end()
})

// Listen only where the sign-on proxy reaches us: the address of LISTEN_ALIAS, a
// name that resolves on the proxy's network only. The tenant's network (the
// workbench, its agents) then finds no gateway port at all.
const listenHost = await (async () => {
  const alias = process.env.LISTEN_ALIAS ?? ''
  if (alias === '') return process.env.LISTEN_HOST ?? '0.0.0.0'
  try {
    return (await lookup(alias, { family: 4 })).address
  } catch (error) {
    console.error(`mndt gateway: cannot resolve LISTEN_ALIAS ${alias}: ${error.message}`)
    process.exit(1)
  }
})()
server.listen(PORT, listenHost, () => {
  console.log(`mndt gateway: listening on ${listenHost}:${PORT}, workbench ${WORKBENCH}, api ${API}`)
  if (PROXY_KEY === '') console.warn('mndt gateway: no PROXY_SIGNATURE_KEY_FILE: every request is refused')
  if (GATEWAY_SECRET === '') console.warn('mndt gateway: no GATEWAY_SECRET_FILE: the API will refuse every identity this gateway relays')
})

process.on('SIGTERM', () => { server.close(() => { process.exit(0) }) })
