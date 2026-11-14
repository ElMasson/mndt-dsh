// The sign-on proxy of the rehearsal: oauth2-proxy without Entra. It takes the
// identity the rehearsal's browser declares (x-forwarded-email), signs each
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

/** @param req - incoming request. @returns the headers to relay, signed for a body. */
function relayed(req, body) {
  const headers = { ...req.headers }
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
      res.writeHead(answer.statusCode ?? 502, answer.headers)
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
