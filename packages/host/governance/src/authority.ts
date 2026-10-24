/**
 * The central governance authority.
 *
 * It exists because a per-machine grant table is owned by the machine: whoever
 * can write the file can grant themselves anything. Here the caller proves an
 * identity with a bearer token, the authority maps that token to a user, and the
 * rules decide. Nothing about that decision is taken from the request body.
 *
 * The handler is a pure function of its request so the whole authority is
 * testable without binding a port. `startAuthority` is the thin HTTP adapter.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { asRole } from '@deepseek-ai/dsh-client-ui-governance/src/rbac.ts'
import {
  GovernanceController,
  MemoryRbacStorage,
  type RbacStorage,
} from '@deepseek-ai/dsh-client-ui-governance/src/governance.ts'
import type { RbacSnapshot } from '@deepseek-ai/dsh-client-ui-governance/src/rbac.ts'

/** One authenticated identity of the team. */
export interface AuthorityToken {
  /** The user id this token proves. */
  readonly user: string
}

/** What the authority needs to serve. */
export interface AuthorityOptions {
  /** Token to identity. A token absent from this map proves nothing. */
  readonly tokens: Readonly<Record<string, AuthorityToken>>
  /** Where the table lives. */
  readonly storage?: RbacStorage
  /** Append-only audit log path; omitted means no audit file is written. */
  readonly auditPath?: string
  /** Clock seam, so tests do not depend on wall time. */
  readonly now?: () => Date
  /**
   * Header name carrying an identity already proven by an authenticating proxy
   * (for example `x-auth-request-email` from oauth2-proxy).
   *
   * Only set this when the authority is reachable *solely* through that proxy:
   * anything able to send the header would otherwise assert any identity. Left
   * undefined, the bearer token is the only way in.
   */
  readonly proxyUserHeader?: string
}

/** One request, as the handler sees it. */
export interface AuthorityRequest {
  readonly method: string
  readonly path: string
  /** The `Authorization` header, verbatim. */
  readonly authorization?: string
  /** The request headers, lowercased, when the caller can provide them. */
  readonly headers?: Readonly<Record<string, string | undefined>>
  /** Raw JSON body for mutations. */
  readonly body?: string
}

/** One response. */
export interface AuthorityResponse {
  readonly status: number
  readonly body: unknown
}

/** One audit line. */
interface AuditLine {
  readonly at: string
  readonly user: string
  readonly action: string
  readonly subject?: string
  readonly allowed: boolean
  readonly reason: string
}

/**
 * Build the authority handler.
 * @param options - tokens, storage, audit destination, clock.
 * @returns a handler from one request to one response.
 */
export function createAuthority(options: AuthorityOptions): (request: AuthorityRequest) => Promise<AuthorityResponse> {
  const controller = new GovernanceController(options.storage ?? new MemoryRbacStorage())
  const clock = options.now ?? (() => new Date())
  const ready = controller.load()

  const audit = async (line: AuditLine): Promise<void> => {
    if (options.auditPath === undefined) return
    await mkdir(dirname(options.auditPath), { recursive: true })
    await appendFile(options.auditPath, `${JSON.stringify(line)}\n`, 'utf8')
  }

  /**
   * Map the bearer token to its identity.
   * @param authorization - the header value.
   * @returns the user id, or undefined when the token proves nothing.
   */
  const authenticate = (authorization?: string): string | undefined => {
    if (authorization === undefined) return undefined
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
    if (match === null) return undefined
    const token = match[1]
    if (token === undefined) return undefined
    return options.tokens[token]?.user
  }

  /**
   * The identity an authenticating proxy already proved, when this deployment
   * trusts one. Off by default: without `proxyUserHeader` the header is ignored
   * entirely and a bearer token remains the only way in.
   * @param request - the request, whose headers the caller supplied.
   * @returns the lowercased email, or undefined when it proves nothing.
   */
  const identityFromProxy = (request: AuthorityRequest): string | undefined => {
    const header = options.proxyUserHeader
    if (header === undefined) return undefined
    const raw = request.headers?.[header.toLowerCase()]
    if (raw === undefined) return undefined
    const identity = raw.trim().toLowerCase()
    return identity === '' ? undefined : identity
  }

  /** @param body - raw JSON. @returns the parsed object, or undefined. */
  const parse = (body?: string): Record<string, unknown> | undefined => {
    if (body === undefined || body.trim() === '') return undefined
    try {
      const parsed: unknown = JSON.parse(body)
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  }

  return async function handle(request: AuthorityRequest): Promise<AuthorityResponse> {
    await ready

    if (request.path === '/health') {
      return { status: 200, body: { ok: true } }
    }

    // A supplied Authorization header means the caller chose the token path: a
    // bad token must never be rescued by the proxy header. Without one, the
    // proxy identity applies when this deployment trusts it.
    const user = request.authorization === undefined
      ? identityFromProxy(request)
      : authenticate(request.authorization)
    if (user === undefined) {
      return { status: 401, body: { error: 'a bearer token is required' } }
    }

    // A person who just signed in lands here: answer with who they are and what
    // they can see, instead of a bare 404 from an API root.
    if (request.method === 'GET' && request.path === '/') {
      const snapshot: RbacSnapshot = controller.snapshot()
      return { status: 200, body: { service: 'dsh governance authority', you: user, ...snapshot } }
    }

    if (request.method === 'GET' && request.path === '/governance/snapshot') {
      const snapshot: RbacSnapshot = controller.snapshot()
      return { status: 200, body: snapshot }
    }

    if (request.method === 'POST' && request.path === '/governance/bootstrap') {
      const decision = await controller.bootstrapOwner(user)
      await audit({
        at: clock().toISOString(),
        user,
        action: 'bootstrap',
        allowed: decision.allowed,
        reason: decision.reason,
      })
      return decision.allowed
        ? { status: 200, body: decision }
        : { status: 403, body: decision }
    }

    if (request.method === 'POST' && request.path === '/governance/grant') {
      const body = parse(request.body)
      const subject = typeof body?.subject === 'string' ? body.subject : ''
      const roleName = typeof body?.role === 'string' ? body.role : ''
      const scope = typeof body?.scope === 'string' ? body.scope : undefined
      const role = asRole(roleName)
      if (subject.trim() === '' || role === undefined) {
        return { status: 400, body: { error: 'subject and a known role are required' } }
      }
      const decision = await controller.setGrant(user, {
        subject,
        role,
        ...(scope === undefined ? {} : { scope }),
      })
      await audit({
        at: clock().toISOString(),
        user,
        action: 'grant',
        subject,
        allowed: decision.allowed,
        reason: decision.reason,
      })
      return decision.allowed
        ? { status: 200, body: decision }
        : { status: 403, body: decision }
    }

    if (request.method === 'POST' && request.path === '/governance/revoke') {
      const body = parse(request.body)
      const subject = typeof body?.subject === 'string' ? body.subject : ''
      const scope = typeof body?.scope === 'string' ? body.scope : undefined
      if (subject.trim() === '') {
        return { status: 400, body: { error: 'subject is required' } }
      }
      const decision = await controller.removeGrant(user, subject, scope)
      await audit({
        at: clock().toISOString(),
        user,
        action: 'revoke',
        subject,
        allowed: decision.allowed,
        reason: decision.reason,
      })
      return decision.allowed
        ? { status: 200, body: decision }
        : { status: 403, body: decision }
    }

    return { status: 404, body: { error: `no route for ${request.method} ${request.path}` } }
  }
}

/** What the HTTP adapter binds. */
export interface AuthorityListenOptions extends AuthorityOptions {
  /** Interface to bind. Defaults to loopback, which is the safe default. */
  readonly host?: string
  /** Port to bind. */
  readonly port: number
  /** TLS material, when this process terminates TLS itself. */
  readonly tls?: { readonly key: string; readonly cert: string }
}

/** @param request - the incoming request. @returns its body as text. */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Start the authority over HTTP.
 *
 * It binds loopback unless told otherwise: exposing a grant authority on the
 * network is a deployment decision, never a default.
 * @param options - tokens, storage, audit, clock, and the bind address.
 * @returns the listening server.
 */
export function startAuthority(options: AuthorityListenOptions): Server {
  const handle = createAuthority(options)
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const body = request.method === 'POST' ? await readBody(request) : undefined
      const result = await handle({
        method: request.method ?? 'GET',
        path: new URL(request.url ?? '/', 'http://localhost').pathname,
        ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([name, value]) => [name, Array.isArray(value) ? value[0] : value]),
        ),
        ...(body === undefined ? {} : { body }),
      })
      response.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(result.body))
    })()
  }).listen(options.port, options.host ?? '127.0.0.1')
}
