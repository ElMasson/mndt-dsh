#!/usr/bin/env node
/**
 * The only way out of a member's computer (« Mon ordinateur », 26/11): an HTTP
 * proxy on its internal network that reaches the public web, and nothing else.
 *
 * - HTTP and HTTPS only: CONNECT to port 443, a plain request to port 80.
 * - The proxy resolves the name itself and refuses when any address is not a
 *   public one (private, loopback, link-local and 169.254.169.254, shared,
 *   reserved, multicast, documentation, IPv4-mapped or NAT64 forms of those),
 *   or is one of EGRESS_DENY (the instance's own addresses).
 * - It connects to the address it checked, never resolves twice: a name that
 *   answers a public address then a private one (DNS rebinding) cannot pass.
 * - A refusal answers 403 with one line; it never says more of the network.
 *
 *   EGRESS_PORT=3128 EGRESS_DENY=51.159.161.149 node egress-proxy.mjs
 */
import { createServer, request as httpRequest } from 'node:http'
import { connect, isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { fileURLToPath } from 'node:url'

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

/**
 * @param ip - an address, as resolved.
 * @returns whether the proxy may connect to it: a public address only.
 */
export function isPublicAddress(ip, denied = []) {
  if (denied.includes(ip)) return false
  if (isIP(ip) === 4) return !v4Denied(ip)
  if (isIP(ip) !== 6) return false
  const groups = v6Groups(ip)
  if (groups.length !== 8 || groups.some(group => Number.isNaN(group))) return false
  const [a, b] = groups
  if (groups.every(group => group === 0)) return false // ::
  if (groups.slice(0, 7).every(group => group === 0) && groups[7] === 1) return false // ::1
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
    const upstream = httpRequest({ host: address, port: 80, method: req.method, path: url.pathname + url.search, headers: { ...req.headers, host: url.host } }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(res)
    })
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.pipe(upstream)
  })
  server.on('connect', async (req, socket, head) => {
    const [host, port] = String(req.url ?? '').split(/:(?=\d+$)/)
    if (port !== '443' || host === undefined || host === '') return refuse(socket, true)
    const address = await publicTarget(host, denied)
    if (address === undefined) return refuse(socket, true)
    const upstream = connect(443, address, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  return server
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const denied = (process.env.EGRESS_DENY ?? '').split(',').map(item => item.trim()).filter(item => item !== '')
  egressProxy(denied).listen(Number(process.env.EGRESS_PORT ?? 3128), '0.0.0.0')
}
