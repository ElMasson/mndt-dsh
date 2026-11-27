/**
 * The egress proxy of a member's computer (« Mon ordinateur », 26/11): the
 * public web over HTTP and HTTPS, nothing else; the address it checked is the
 * one it connects to.
 */
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { egressProxy, forwardedHeaders, isPublicAddress, publicTarget, validDenial } from '../deploy/sandbox/egress-proxy.mjs'

const servers: Server[] = []
afterEach(() => { for (const server of servers.splice(0)) server.close() })

async function proxy(denied: string[] = []): Promise<number> {
  const server = egressProxy(denied)
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return (server.address() as AddressInfo).port
}

/** @returns the first line the proxy answers to a raw request. */
async function ask(port: number, raw: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1', () => { socket.write(raw) })
    let data = ''
    socket.on('data', (chunk) => { data += String(chunk); if (data.includes('\r\n')) { socket.destroy(); resolve(data.split('\r\n')[0] ?? '') } })
    socket.on('error', () => { resolve(data.split('\r\n')[0] ?? '') })
    socket.on('close', () => { resolve(data.split('\r\n')[0] ?? '') })
  })
}

describe('which addresses are public', () => {
  it('refuses every private, local, reserved or metadata address, in IPv4 and IPv6 forms', () => {
    for (const denied of ['127.0.0.1', '10.0.3.7', '172.16.0.1', '172.31.255.255', '192.168.1.4', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '224.0.0.1', '255.255.255.255', '192.0.2.10', '198.18.0.1', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
      '::ffff:10.0.0.1', '::ffff:169.254.169.254', '64:ff9b::a00:1', '2001:db8::1', 'not-an-ip',
      // IPv4 carried inside IPv6: compatible (::/96), 6to4, Teredo, local-use NAT64; and discard.
      '::10.0.0.1', '::a9fe:a9fe', '::1.1.1.1', '2002:a00:1::1', '2002:101:101::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2',
      '64:ff9b:1::a00:1', '64:ff9b:1::101:101', '100::1']) {
      expect(isPublicAddress(denied), denied).toBe(false)
    }
    for (const allowed of ['1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '::ffff:1.1.1.1']) {
      expect(isPublicAddress(allowed), allowed).toBe(true)
    }
  })

  it('refuses the instance\'s own address, however public', () => {
    expect(isPublicAddress('51.159.161.149', ['51.159.161.149'])).toBe(false)
  })

  it('refuses what a range of EGRESS_DENY holds (the instance\'s block, the compose\'s networks), in both families and the mapped form', () => {
    const denied = ['51.159.160.0/22', '2001:bc8:1200::/40', '203.0.113.7']
    for (const ip of ['51.159.160.1', '51.159.163.254', '2001:bc8:12ff::1', '::ffff:51.159.161.149']) expect(isPublicAddress(ip, denied), ip).toBe(false)
    for (const ip of ['51.159.164.1', '51.159.159.255', '2001:bc8:1300::1', '1.1.1.1']) expect(isPublicAddress(ip, denied), ip).toBe(true)
    // A /0 refuses its whole family; a /32 one address.
    expect(isPublicAddress('8.8.8.8', ['0.0.0.0/0'])).toBe(false)
    expect(isPublicAddress('2606:4700:4700::1111', ['0.0.0.0/0'])).toBe(true)
    expect(isPublicAddress('51.159.161.150', ['51.159.161.149/32'])).toBe(true)
  })

  it('an item that is neither an address nor a range is invalid', () => {
    for (const ok of ['51.159.161.149', '172.18.0.0/16', '::1', 'fd00::/8', '0.0.0.0/0']) expect(validDenial(ok), ok).toBe(true)
    for (const bad of ['51.159.161', '172.18.0.0/33', 'fd00::/129', '10.0.0.0/8/1', 'equipe.datanalysis.re', '10.0.0.0/x', '']) expect(validDenial(bad), bad).toBe(false)
  })

  it('a name resolving to a private address is refused', async () => {
    expect(await publicTarget('localhost')).toBeUndefined()
    expect(await publicTarget('127.0.0.1')).toBeUndefined()
    expect(await publicTarget('[::1]')).toBeUndefined()
  })
})

describe('the proxy', () => {
  it('refuses to start without the instance\'s own addresses', () => {
    const script = join(import.meta.dirname, '..', 'deploy', 'sandbox', 'egress-proxy.mjs')
    const started = spawnSync(process.execPath, [script], { env: { ...process.env, EGRESS_DENY: ' , ', EGRESS_PORT: '0' }, encoding: 'utf8', timeout: 10_000 })
    expect(started.status).toBe(2)
    expect(started.stderr).toContain('EGRESS_DENY is empty')
    // A typo stops it too: it never opens the address it meant to close.
    const typo = spawnSync(process.execPath, [script], { env: { ...process.env, EGRESS_DENY: '51.159.161.149,172.18.0.0/33', EGRESS_PORT: '0' }, encoding: 'utf8', timeout: 10_000 })
    expect(typo.status).toBe(2)
    expect(typo.stderr).toContain('neither an address nor a range')
  })

  it('is bounded in connections, and never relays the computer\'s proxy headers upstream', () => {
    expect(egressProxy(['51.159.161.149']).maxConnections).toBe(256)
    const sent = forwardedHeaders({ 'proxy-authorization': 'Basic c2VjcmV0', 'proxy-connection': 'keep-alive', connection: 'close', accept: 'text/html', host: 'evil' }, 'example.org')
    expect(sent).toEqual({ accept: 'text/html', host: 'example.org' })
  })

  it('refuses a tunnel to a local address, and to any port but 443', async () => {
    const port = await proxy()
    expect(await ask(port, 'CONNECT 127.0.0.1:443 HTTP/1.1\r\nhost: 127.0.0.1:443\r\n\r\n')).toBe('HTTP/1.1 403 Forbidden')
    expect(await ask(port, 'CONNECT 169.254.169.254:443 HTTP/1.1\r\nhost: x\r\n\r\n')).toBe('HTTP/1.1 403 Forbidden')
    expect(await ask(port, 'CONNECT 1.1.1.1:22 HTTP/1.1\r\nhost: x\r\n\r\n')).toBe('HTTP/1.1 403 Forbidden')
  })

  it('refuses a plain request to a local address, or to any port but 80', async () => {
    const port = await proxy()
    expect(await ask(port, 'GET http://127.0.0.1/ HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n')).toBe('HTTP/1.1 403 Forbidden')
    expect(await ask(port, 'GET http://1.1.1.1:8080/ HTTP/1.1\r\nhost: 1.1.1.1\r\n\r\n')).toBe('HTTP/1.1 403 Forbidden')
    expect(await ask(port, 'GET /relative HTTP/1.1\r\nhost: x\r\n\r\n')).toBe('HTTP/1.1 403 Forbidden')
  })
})
