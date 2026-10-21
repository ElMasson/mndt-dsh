/**
 * The workstation side of the central authority.
 *
 * In team mode, a workstation must not decide a grant: it asks the authority,
 * which knows who is calling from the token. This client is that conversation,
 * kept small on purpose: three calls, one place, so a refusal cannot be
 * mistaken for a network hiccup.
 */

/** What a call to the authority resolved to. */
export interface AuthorityOutcome {
  /** Whether the authority accepted. */
  readonly ok: boolean
  /** Why, in words the page can show as-is. */
  readonly reason: string
  /** The HTTP status, for diagnostics. */
  readonly status: number
}

/** One grant row as the authority sends it. */
export interface AuthorityGrant {
  /** Who holds the grant. */
  readonly subject: string
  /** The role name. */
  readonly role: string
  /** Optional narrowing to one resource. */
  readonly scope?: string
}

/** What the client needs. */
export interface AuthorityClientOptions {
  /** Base URL, without a trailing slash. */
  readonly baseUrl: string
  /** Bearer token proving this workstation's identity. */
  readonly token: string
  /** Fetch seam, so the client is testable without a network. */
  readonly fetch?: typeof globalThis.fetch
  /** Per-call timeout in milliseconds; defaults to 10 seconds. */
  readonly timeoutMs?: number
}

/** Reads and mutates the team table over HTTPS. */
export class AuthorityClient {
  readonly #options: AuthorityClientOptions

  /** @param options - base URL, token, and transport seam. */
  constructor(options: AuthorityClientOptions) {
    this.#options = options
  }

  /**
   * Read the team table.
   * @returns the grants, or an outcome explaining the refusal.
   */
  async snapshot(): Promise<
    | { readonly ok: true; readonly grants: AuthorityGrant[] }
    | { readonly ok: false; readonly reason: string; readonly status: number }
  > {
    const response = await this.#call('GET', '/governance/snapshot')
    if (!response.ok) return { ok: false, reason: response.reason, status: response.status }
    const body = response.body
    const grants = Array.isArray((body as { grants?: unknown }).grants)
      ? ((body as { grants: AuthorityGrant[] }).grants)
      : []
    return { ok: true, grants }
  }

  /**
   * Ask the authority to record a grant.
   * @param subject - who receives it.
   * @param role - the role name.
   * @param scope - optional narrowing.
   * @returns the outcome.
   */
  async grant(subject: string, role: string, scope?: string): Promise<AuthorityOutcome> {
    return this.#call('POST', '/governance/grant', {
      subject,
      role,
      ...(scope === undefined ? {} : { scope }),
    })
  }

  /**
   * Ask the authority to remove a grant.
   * @param subject - whose grant to remove.
   * @param scope - undefined targets the global grant only.
   * @returns the outcome.
   */
  async revoke(subject: string, scope?: string): Promise<AuthorityOutcome> {
    return this.#call('POST', '/governance/revoke', {
      subject,
      ...(scope === undefined ? {} : { scope }),
    })
  }

  /** @param method - HTTP method. @param path - route. @param body - optional JSON body. */
  async #call(method: string, path: string, body?: unknown): Promise<AuthorityOutcome & { body?: unknown }> {
    const fetchImpl = this.#options.fetch ?? globalThis.fetch
    const timeout = this.#options.timeoutMs ?? 10_000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const response = await fetchImpl(`${this.#options.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#options.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      })
      const parsed: unknown = await response.json().catch(() => ({}))
      const reason = typeof (parsed as { reason?: unknown }).reason === 'string'
        ? (parsed as { reason: string }).reason
        : typeof (parsed as { error?: unknown }).error === 'string'
          ? (parsed as { error: string }).error
          : `authority answered ${response.status}`
      return {
        ok: response.ok,
        reason,
        status: response.status,
        body: parsed,
      }
    } catch (error) {
      const reason = error instanceof Error && error.name === 'AbortError'
        ? `authority did not answer within ${timeout} ms`
        : `authority unreachable: ${error instanceof Error ? error.message : String(error)}`
      return { ok: false, reason, status: 0 }
    } finally {
      clearTimeout(timer)
    }
  }
}
