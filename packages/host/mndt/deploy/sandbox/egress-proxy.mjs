#!/usr/bin/env node
/**
 * The only way out of a member's computer (« Mon ordinateur », 26/11): an HTTP
 * proxy on its internal network that reaches the public web, and nothing else.
 *
 * - HTTP and HTTPS only: CONNECT to port 443, a plain request to port 80.
 * - The proxy resolves the name itself and refuses when any address is not a
 *   public one (private, loopback, link-local and 169.254.169.254, shared,
 *   reserved, multicast, documentation, IPv4-mapped or NAT64 forms of those),
 *   or is named or held by EGRESS_DENY (the instance's public and private
 *   addresses, the compose's Docker networks: addresses or CIDR ranges).
 * - It connects to the address it checked, never resolves twice: a name that
 *   answers a public address then a private one (DNS rebinding) cannot pass.
 * - A refusal answers 403 with one line; it never says more of the network.
 * - Bounded: EGRESS_MAX_CONNECTIONS connections at once (256), an upstream that
 *   does not answer within 10 s is dropped, a tunnel or a request idle for
 *   EGRESS_IDLE_SECONDS (300) is closed. The computer's own proxy headers
 *   (proxy-authorization, proxy-connection) are never relayed upstream.
 * - It refuses to start without EGRESS_DENY, or with an item that is neither an
 *   address nor a range: the instance's own addresses must be named (the
 *   compose names them), never forgotten, and a typo never opens one.
 *
 *   EGRESS_PORT=3128 EGRESS_DENY=51.159.161.149 node egress-proxy.mjs
 */
import { createServer, request as httpRequest } from 'node:http'
import { connect, isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { fileURLToPath } from 'node:url'

const CONNECT_TIMEOUT_MS = 10_000
const IDLE_MS = Number(process.env.EGRESS_IDLE_SECONDS ?? 300) * 1000
const MAX_CONNECTIONS = Number(process.env.EGRESS_MAX_CONNECTIONS ?? 256)
/** Headers meant for this proxy or this hop: never sent upstream. */
const HOP_HEADERS = ['proxy-authorization', 'proxy-connection', 'proxy-authenticate', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade']

const V4_DENIED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]

/** @param ip - a dotted IPv4. @returns it as a number. */
function v4Number(ip) {
  return ip.split('.').reduce((value, part) => (value * 256) + Number(part), 0)
}

/** @param ip - an IPv4. @returns whether it lies in a denied range. */
function v4Denied(ip) {
  const value = v4Number(ip)
  return V4_DENIED.some(([base, bits]) => {
    const size = 2 ** (32 - bits)
    const start = v4Number(base)
    return value >= start && value < start + size
  })
}

/** @param ip - an IPv6. @returns its eight groups, as numbers. */
function v6Groups(ip) {
  let text = ip.toLowerCase().split('%')[0]
  // An embedded IPv4 tail (::ffff:10.0.0.1) becomes two groups.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (tail !== null) {
    const value = v4Number(tail[1])
    text = text.slice(0, -tail[1].length) + `${Math.floor(value / 65536).toString(16)}:${(value % 65536).toString(16)}`
  }
  const [head, rest] = text.split('::')
  const left = head === '' ? [] : head.split(':')
  const right = rest === undefined ? [] : (rest === '' ? [] : rest.split(':'))
  const fill = rest === undefined ? [] : Array(8 - left.length - right.length).fill('0')
  return [...left, ...fill, ...right].map(group => parseInt(group, 16))
}

/** @param ip - an IPv4 or IPv6. @returns it as one number (a bigint), and its width in bits. */
function asBits(ip) {
  if (isIP(ip) === 4) return { value: BigInt(v4Number(ip)), width: 32 }
  return { value: v6Groups(ip).reduce((value, group) => (value << 16n) + BigInt(group), 0n), width: 128 }
}

/**
 * @param entry - one item of EGRESS_DENY: an address or a range (CIDR, « 172.18.0.0/16 »).
 * @returns whether it is well formed: a typo must stop the proxy, never open an address.
 */
export function validDenial(entry) {
  const [base, bits, extra] = entry.split('/')
  if (extra !== undefined || base === undefined || isIP(base) === 0) return false
  if (bits === undefined) return true
  if (!/^\d{1,3}$/.test(bits)) return false
  return Number(bits) <= (isIP(base) === 4 ? 32 : 128)
}

/** @param ip - an address. @param denied - EGRESS_DENY's items. @returns whether one of them names it or holds it. */
function inDenied(ip, denied) {
  const family = isIP(ip)
  return denied.some((entry) => {
    const [base, bits] = entry.split('/')
    if (base === undefined || isIP(base) !== family) return false
    const target = asBits(ip)
    const range = asBits(base)
    const prefix = BigInt(bits === undefined ? target.width : Number(bits))
    const shift = BigInt(target.width) - prefix
    return (target.value >> shift) === (range.value >> shift)
  })
}

/**
 * @param ip - an address, as resolved.
 * @param denied - EGRESS_DENY: the instance's own addresses and the compose's
 * networks, as addresses or ranges (CIDR).
 * @returns whether the proxy may connect to it: a public address only.
 */
export function isPublicAddress(ip, denied = []) {
  if (isIP(ip) !== 0 && inDenied(ip, denied)) return false
  if (isIP(ip) === 4) return !v4Denied(ip)
  if (isIP(ip) !== 6) return false
  const groups = v6Groups(ip)
  if (groups.length !== 8 || groups.some(group => Number.isNaN(group))) return false
  const [a, b] = groups
  // ::/96: ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d, all refused.
  if (groups.slice(0, 6).every(group => group === 0)) return false
  if (a === 0x2002) return false // 2002::/16, 6to4: an IPv4 inside, refused whole
  if (a === 0x2001 && b === 0x0000) return false // 2001::/32, Teredo: an obfuscated IPv4 inside
  if (a === 0x0100 && groups.slice(1, 4).every(group => group === 0)) return false // 100::/64, discard
  if (a === 0x64 && b === 0xff9b && groups[2] === 1) return false // 64:ff9b:1::/48, local-use NAT64
  if ((a & 0xfe00) === 0xfc00) return false // fc00::/7, unique local
  if ((a & 0xffc0) === 0xfe80) return false // fe80::/10, link-local
  if ((a & 0xff00) === 0xff00) return false // multicast
  if (a === 0x2001 && b === 0x0db8) return false // documentation
  const embedded = `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`
  // ::ffff:a.b.c.d (mapped) and 64:ff9b::a.b.c.d (NAT64): the IPv4 inside decides.
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) return isPublicAddress(embedded, denied)
  if (a === 0x64 && b === 0xff9b && groups.slice(2, 6).every(group => group === 0)) return isPublicAddress(embedded, denied)
  return true
}

/**
 * @param host - a name or an address.
 * @param denied - the instance's own addresses.
 * @returns the public address to connect to, or undefined when any of its addresses is not public.
 */
export async function publicTarget(host, denied = []) {
  const name = host.replace(/^\[|\]$/g, '')
  const addresses = isIP(name) !== 0 ? [{ address: name }] : await lookup(name, { all: true }).catch(() => [])
  if (addresses.length === 0) return undefined
  if (!addresses.every(entry => isPublicAddress(entry.address, denied))) return undefined
  return addresses[0].address
}

/**
 * @param headers - a plain request's headers, from the computer.
 * @param host - the target's host.
 * @returns what is sent upstream: its headers without this proxy's or this hop's.
 */
export function forwardedHeaders(headers, host) {
  const forwarded = { ...headers, host }
  for (const name of HOP_HEADERS) delete forwarded[name]
  return forwarded
}

/**
 * @param denied - the instance's own addresses.
 * @returns the proxy server (not yet listening).
 */
export function egressProxy(denied = []) {
  const refuse = (socketOrResponse, isSocket) => {
    if (isSocket) {
      socketOrResponse.end('HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nonly the public web is reachable\n')
    } else {
      socketOrResponse.writeHead(403, { 'content-type': 'text/plain' })
      socketOrResponse.end('only the public web is reachable\n')
    }
  }
  const server = createServer(async (req, res) => {
    // A plain HTTP request, absolute form: port 80 only.
    let url
    try { url = new URL(req.url ?? '') } catch { return refuse(res, false) }
    if (url.protocol !== 'http:' || (url.port !== '' && url.port !== '80')) return refuse(res, false)
    const address = await publicTarget(url.hostname, denied)
    if (address === undefined) return refuse(res, false)
    const headers = forwardedHeaders(req.headers, url.host)
    const upstream = httpRequest({ host: address, port: 80, method: req.method, path: url.pathname + url.search, headers, timeout: CONNECT_TIMEOUT_MS }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(res)
    })
    upstream.on('timeout', () => { upstream.destroy(new Error('upstream timeout')) })
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.socket.setTimeout(IDLE_MS, () => { upstream.destroy(); req.socket.destroy() })
    req.pipe(upstream)
  })
  server.on('connect', async (req, socket, head) => {
    const [host, port] = String(req.url ?? '').split(/:(?=\d+$)/)
    if (port !== '443' || host === undefined || host === '') return refuse(socket, true)
    const address = await publicTarget(host, denied)
    if (address === undefined) return refuse(socket, true)
    const upstream = connect(443, address, () => {
      clearTimeout(connecting)
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    // No answer within 10 s: dropped. Then idle for EGRESS_IDLE_SECONDS: closed.
    const connecting = setTimeout(() => { upstream.destroy(); socket.destroy() }, CONNECT_TIMEOUT_MS)
    const close = () => { clearTimeout(connecting); upstream.destroy(); socket.destroy() }
    upstream.setTimeout(IDLE_MS, close)
    socket.setTimeout(IDLE_MS, close)
    upstream.on('error', close)
    socket.on('error', close)
    upstream.on('close', close)
    socket.on('close', close)
  })
  server.maxConnections = MAX_CONNECTIONS
  return server
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const denied = (process.env.EGRESS_DENY ?? '').split(',').map(item => item.trim()).filter(item => item !== '')
  const invalid = denied.filter(entry => !validDenial(entry))
  if (invalid.length > 0) {
    process.stderr.write(`egress-proxy: EGRESS_DENY holds ${invalid.length} item(s) that are neither an address nor a range (CIDR); refusing to start\n`)
    process.exit(2)
  }
  if (denied.length === 0) {
    process.stderr.write('egress-proxy: EGRESS_DENY is empty: name the instance\'s own addresses; refusing to start\n')
    process.exit(2)
  }
  egressProxy(denied).listen(Number(process.env.EGRESS_PORT ?? 3128), '0.0.0.0')
}
