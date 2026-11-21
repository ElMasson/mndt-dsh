import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'

/**
 * A port the system just gave and released, for a child server to bind. Unlike
 * a random pick in a shared range, two test files running at once never draw
 * the same one, so a readiness probe never reaches another file's server.
 * @returns the port.
 */
export async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  return port
}
