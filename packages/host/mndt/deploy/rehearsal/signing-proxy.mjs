// The sign-on proxy of the rehearsal: oauth2-proxy without Entra. It takes the
// identity the rehearsal's browser declares (x-forwarded-email) and keeps it in
// a session cookie, as oauth2-proxy keeps the person's session: a browser does
// not send a page's extra headers on a WebSocket handshake, the cookie does.
// It signs each
// request it relays with the tenant's proxy key exactly as oauth2-proxy does
// (GAP-Signature, hmacauth sha256), and relays it to the gateway on the ingress
// network, WebSocket upgrades included. Nothing else reaches the gateway.
//   PROXY_SIGNATURE_KEY_FILE=<key file> UPSTREAM=http://gateway-ingress:8080 node signing-proxy.mjs
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'

const KEY = readFileSync(process.env.PROXY_SIGNATURE_KEY_FILE ?? '/run/secrets/mndt-proxy-signature', 'utf8').trim()
const UPSTREAM = new URL(process.env.UPSTREAM ?? 'http://gateway-ingress:8080')
const SIGNED = ['content-length', 'content-md5', 'content-type', 'date', 'authorization', 'x-forwarded-user',
  'x-forwarded-email', 'x-forwarded-preferred-user', 'x-forwarded-access-token', 'cookie', 'gap-auth']

/** @param method - method. @param url - raw path and query. @param headers - outgoing headers. @param body - body. @returns the signature. */
function sign(method, url, headers, body) {
  const q = url.indexOf('?')
  const raw = q === -1 ? url : url.slice(0, q)
  let path = raw
  try { path = decodeURIComponent(raw) } catch { /* kept raw */ }
  const target = q === -1 ? path : `${path}?${url.slice(q + 1)}`
  const value = name => (Array.isArray(headers[name]) ? headers[name].join(',') : headers[name] ?? '')
  const text = `${method}\n${SIGNED.map(name => `${value(name)}\n`).join('')}${target}\n`
  return `sha256 ${createHmac('sha256', KEY).update(text).update(body).digest('base64')}`
}

/** The rehearsal's session cookie; the gateway strips every _mndt_ cookie, as it strips the real one. */
const SESSION = '_mndt_rehearsal_sso'

/** @param req - incoming request. @returns the identity it declares, or the one its session cookie holds. */
function identityOf(req) {
  const declared = req.headers['x-forwarded-email']
  if (typeof declared === 'string' && declared !== '') return declared
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === SESSION) return decodeURIComponent(rest.join('='))
  }
  return ''
}

/** @param req - incoming request. @returns the session cookie to set, when the request declared an identity. */
function sessionCookieOf(req) {
  const declared = req.headers['x-forwarded-email']
  return typeof declared === 'string' && declared !== '' ? `${SESSION}=${encodeURIComponent(declared)}; Path=/; HttpOnly; SameSite=Lax` : undefined
}

/** @param req - incoming request. @returns the headers to relay, signed for a body. */
function relayed(req, body) {
  const headers = { ...req.headers }
  const email = identityOf(req)
  if (email === '') delete headers['x-forwarded-email']
  else headers['x-forwarded-email'] = email
  delete headers['gap-signature']
  headers['gap-auth'] = ''
  if (body.length > 0) headers['content-length'] = String(body.length)
  headers['gap-signature'] = sign(req.method ?? 'GET', req.url ?? '/', headers, body)
  return headers
}

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => { chunks.push(chunk) })
  req.on('error', () => undefined)
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const upstream = httpRequest({ hostname: UPSTREAM.hostname, port: UPSTREAM.port, method: req.method, path: req.url, headers: relayed(req, body) }, (answer) => {
      const session = sessionCookieOf(req)
      const headers = { ...answer.headers }
      if (session !== undefined) headers['set-cookie'] = [...(headers['set-cookie'] ?? []), session]
      res.writeHead(answer.statusCode ?? 502, headers)
      answer.on('error', () => { res.destroy() })
      answer.pipe(res)
    })
    upstream.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('signing proxy: gateway unreachable') } else res.destroy() })
    upstream.end(body)
  })
})

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => undefined)
  const upstream = httpRequest({ hostname: UPSTREAM.hostname, port: UPSTREAM.port, method: req.method, path: req.url, headers: relayed(req, Buffer.alloc(0)) })
  upstream.on('upgrade', (answer, upstreamSocket, upstreamHead) => {
    upstreamSocket.on('error', () => { socket.destroy() })
    socket.on('error', () => { upstreamSocket.destroy() })
    const lines = [`HTTP/1.1 ${answer.statusCode} ${answer.statusMessage}`]
    for (let index = 0; index < answer.rawHeaders.length; index += 2) lines.push(`${answer.rawHeaders[index]}: ${answer.rawHeaders[index + 1]}`)
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (upstreamHead.length > 0) socket.write(upstreamHead)
    if (head.length > 0) upstreamSocket.write(head)
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
    upstreamSocket.on('close', () => { socket.destroy() })
    socket.on('close', () => { upstreamSocket.destroy() })
  })
  upstream.on('response', (answer) => {
    if (!socket.destroyed) socket.end(`HTTP/1.1 ${answer.statusCode ?? 502} ${answer.statusMessage ?? ''}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
  })
  upstream.on('error', () => { socket.destroy() })
  upstream.end()
})

server.listen(8080, '0.0.0.0', () => { console.log(`signing proxy: listening on 8080, relaying to ${UPSTREAM.href}`) })
