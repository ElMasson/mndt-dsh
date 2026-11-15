/**
 * Requests as the sign-on proxy relays them: signed with oauth2-proxy's
 * GAP-Signature (hmacauth, sha256), the only requests the gateway serves.
 * The algorithm is the one proven against oauth2-proxy v7.15.5: method, the
 * signed headers (values joined by a comma, empty line when absent), the
 * decoded path with the raw query, each on its own line, then the body.
 */
import { createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const PROXY_KEY = 'proxy-signature-key-for-tests'
const SIGNED = ['content-length', 'content-md5', 'content-type', 'date', 'authorization', 'x-forwarded-user',
  'x-forwarded-email', 'x-forwarded-preferred-user', 'x-forwarded-access-token', 'cookie', 'gap-auth']

/** @returns a file holding the proxy key, as the gateway container mounts it. */
export function proxyKeyFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'proxy-key-')), 'mndt-proxy-signature')
  writeFileSync(path, `${PROXY_KEY}\n`)
  return path
}

/**
 * @param method - HTTP method.
 * @param url - path and query as sent.
 * @param headers - the request headers, lower-case names.
 * @param body - the body bytes.
 * @param key - the signing key.
 * @returns the GAP-Signature value.
 */
export function gapSignature(
  method: string,
  url: string,
  headers: Readonly<Record<string, string>>,
  body: Buffer = Buffer.alloc(0),
  key = PROXY_KEY,
): string {
  const q = url.indexOf('?')
  const rawPath = q === -1 ? url : url.slice(0, q)
  let path = rawPath
  try { path = decodeURIComponent(rawPath) } catch { /* kept raw */ }
  const target = q === -1 ? path : `${path}?${url.slice(q + 1)}`
  const text = `${method}\n${SIGNED.map(name => `${headers[name] ?? ''}\n`).join('')}${target}\n`
  return `sha256 ${createHmac('sha256', key).update(text).update(body).digest('base64')}`
}

/**
 * Fetch through the gateway as the proxy would relay it. Every signed header is
 * set explicitly (fetch would otherwise add content-type and content-length).
 * @param base - the gateway's base URL.
 * @param path - path and query.
 * @param init - method, headers (lower-case) and a string body.
 * @returns the response.
 */
export function proxyFetch(
  base: string,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; key?: string } = {},
): Promise<Response> {
  const method = init.method ?? 'GET'
  const body = init.body === undefined ? undefined : Buffer.from(init.body)
  const headers: Record<string, string> = { ...(init.headers ?? {}) }
  if (body !== undefined) {
    headers['content-type'] ??= 'application/json'
    headers['content-length'] = String(body.length)
  }
  headers['gap-signature'] = gapSignature(method, path, headers, body, init.key)
  // Never followed here: a browser comes back through the proxy, which signs the next request anew.
  return fetch(`${base}${path}`, { method, headers, redirect: 'manual', ...(body === undefined ? {} : { body }) })
}
