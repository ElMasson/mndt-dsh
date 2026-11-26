/**
 * The egress proxy of a member's computer (« Mon ordinateur », 26/11): the
 * public web over HTTP and HTTPS, nothing else; the address it checked is the
 * one it connects to.
 */
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { egressProxy, isPublicAddress, publicTarget } from '../deploy/sandbox/egress-proxy.mjs'

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
      '::ffff:10.0.0.1', '::ffff:169.254.169.254', '64:ff9b::a00:1', '2001:db8::1', 'not-an-ip']) {
      expect(isPublicAddress(denied), denied).toBe(false)
    }
    for (const allowed of ['1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '::ffff:1.1.1.1']) {
      expect(isPublicAddress(allowed), allowed).toBe(true)
    }
  })

  it('refuses the instance\'s own address, however public', () => {
    expect(isPublicAddress('51.159.161.149', ['51.159.161.149'])).toBe(false)
  })

  it('a name resolving to a private address is refused', async () => {
    expect(await publicTarget('localhost')).toBeUndefined()
    expect(await publicTarget('127.0.0.1')).toBeUndefined()
    expect(await publicTarget('[::1]')).toBeUndefined()
  })
})

describe('the proxy', () => {
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
