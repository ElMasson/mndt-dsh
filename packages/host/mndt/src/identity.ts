/**
 * Who is calling.
 *
 * The product never trusts a name a caller declares: an identity is either
 * proven by a bearer token the deployment provisioned, or asserted by the
 * authenticating proxy in front of us. Everything else is nobody.
 */
import { readFile } from 'node:fs/promises'

/** One provisioned token and the identity it proves. */
export interface ProvisionedToken {
  /** Email or user id the token belongs to. */
  readonly user: string
}

/** How the deployment proves identities. */
export interface IdentityOptions {
  /** Token to identity. An unknown token proves nothing. */
  readonly tokens?: Readonly<Record<string, ProvisionedToken>>
  /**
   * Header an authenticating proxy already filled, such as `x-forwarded-email`.
   * Set this only when the API is reachable solely through that proxy.
   */
  readonly proxyUserHeader?: string
}

/** The headers the API reads, lowercased. */
export type Headers = Readonly<Record<string, string | undefined>>

/**
 * Resolve one request's identity.
 * @param request - the authorization header and the request headers.
 * @param options - tokens and the optional proxy header name.
 * @returns the identity, or undefined when it proves nothing.
 */
export function identityOf(
  request: { readonly authorization?: string; readonly headers?: Headers },
  options: IdentityOptions,
): string | undefined {
  // A supplied Authorization header means the caller chose the token path: a bad
  // token must never be rescued by a proxy header.
  if (request.authorization !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(request.authorization.trim())
    const token = match?.[1]
    if (token === undefined) return undefined
    return options.tokens?.[token]?.user
  }
  const header = options.proxyUserHeader
  if (header === undefined) return undefined
  const raw = request.headers?.[header.toLowerCase()]
  if (raw === undefined) return undefined
  const identity = raw.trim().toLowerCase()
  return identity === '' ? undefined : identity
}

/**
 * Read a tokens file: `{ "<token>": { "user": "<email>" } }`.
 * @param path - the file.
 * @returns the tokens, or an empty map when the file is absent.
 */
export async function loadTokens(path: string): Promise<Record<string, ProvisionedToken>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return {}
    throw error
  }
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`${path} is not a token table`)
  const tokens: Record<string, ProvisionedToken> = {}
  for (const [token, value] of Object.entries(parsed as Record<string, unknown>)) {
    const user = (value as { user?: unknown }).user
    if (typeof user !== 'string' || user.trim() === '') {
      throw new Error(`${path}: token entry without a user`)
    }
    tokens[token] = { user: user.trim() }
  }
  return tokens
}
