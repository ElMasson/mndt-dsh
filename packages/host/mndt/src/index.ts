/**
 * The mndt workbench host plugin.
 *
 * It owns the product service, the identity it trusts, the grant table it asks,
 * and the network face a page talks to. The API starts only when the deployment
 * gives it a port, so mounting this plugin in an ordinary workstation costs
 * nothing.
 */
import { JsonFileStore } from '@deepseek-ai/dsh-mndt-core'
import { WorkbenchService } from '@deepseek-ai/dsh-mndt-core'
import type { Grant } from '@deepseek-ai/dsh-client-ui-governance/src/rbac.ts'
import { asRole } from '@deepseek-ai/dsh-client-ui-governance/src/rbac.ts'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the agents service and the Loader entries this plugin reads.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { startMndtApi } from './api.ts'
import type { ConnectorInfo, MndtApiOptions } from './api.ts'
import { loadTokens } from './identity.ts'
import type { ProvisionedToken } from './identity.ts'
import type { GrantSource } from './policy.ts'
import { DshMissionRunner } from './runner.ts'

/** How the deployment configures the plugin. */
export interface MndtConfig {
  /** Port for the product API. Absent means no network face. */
  readonly port?: number
  /** Bind address; loopback by default. */
  readonly host?: string
  /** Where the product state lives. */
  readonly statePath?: string
  /** Token table proving machine identities. */
  readonly tokensFile?: string
  /** Header an authenticating proxy fills; set only behind that proxy. */
  readonly proxyUserHeader?: string
  /** The team authority, when this deployment is in team mode. */
  readonly authority?: { readonly baseUrl: string; readonly token: string }
  /** Solo mode: this identity holds owner, and nobody else can write. */
  readonly localOwner?: string
}

/** Required services. */
export const inject = ['agents', 'loader']

/** Plugin name. */
export const name = 'duke'

/**
 * Ask the team authority for its grant table.
 * @param options - base URL and a token that may read it.
 * @returns a grant source.
 */
export function authorityGrants(options: { baseUrl: string; token: string }): GrantSource {
  return {
    async grants() {
      try {
        const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/governance/snapshot`, {
          headers: { authorization: `Bearer ${options.token}` },
        })
        if (!response.ok) return { ok: false, reason: `authority answered ${response.status}` }
        const body: unknown = await response.json()
        const rows = (body as { grants?: unknown }).grants
        if (!Array.isArray(rows)) return { ok: false, reason: 'authority answered without a grant table' }
        const grants: Grant[] = []
        for (const row of rows) {
          const subject = (row as { subject?: unknown }).subject
          const role = asRole((row as { role?: unknown }).role)
          if (typeof subject !== 'string' || role === undefined) continue
          const scope = (row as { scope?: unknown }).scope
          grants.push({ subject, role, ...(typeof scope === 'string' ? { scope } : {}) })
        }
        return { ok: true, grants }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

/**
 * Solo mode: one named owner, and nobody else writes.
 * @param owner - the identity that owns this workstation.
 * @returns a grant source.
 */
export function localGrants(owner: string | undefined): GrantSource {
  return {
    async grants() {
      if (owner === undefined || owner.trim() === '') {
        return { ok: false, reason: 'this host runs in solo mode and no local owner is configured' }
      }
      return { ok: true, grants: [{ subject: owner.trim().toLowerCase(), role: 'owner' }] }
    },
  }
}

/**
 * Mount the plugin.
 * @param ctx - the host context.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config: MndtConfig = {}): void {
  const statePath = config.statePath ?? process.env.DSH_DUKE_STATE ?? 'duke-state.json'
  const service = new WorkbenchService({ store: new JsonFileStore(statePath) })
  const tokensFile = config.tokensFile ?? process.env.DSH_DUKE_TOKENS_FILE
  const proxyUserHeader = config.proxyUserHeader ?? process.env.DSH_DUKE_PROXY_USER_HEADER
  const authorityBase = process.env.DSH_DUKE_AUTHORITY ?? config.authority?.baseUrl
  const authorityToken = process.env.DSH_DUKE_AUTHORITY_TOKEN ?? config.authority?.token
  const grants = authorityBase !== undefined && authorityBase !== '' && authorityToken !== undefined
    ? authorityGrants({ baseUrl: authorityBase, token: authorityToken })
    : localGrants(config.localOwner ?? process.env.DSH_DUKE_LOCAL_OWNER)

  const connectors = async (): Promise<readonly ConnectorInfo[]> => {
    const rows: ConnectorInfo[] = []
    for (const entry of ctx.loader.entries()) {
      if (entry.options.group !== undefined) continue
      const module = entry.options.name
      if (!module.includes('mcp-client')) continue
      const entryConfig: unknown = entry.options.config
      const server = typeof entryConfig === 'object' && entryConfig !== null && 'serverName' in entryConfig
        && typeof (entryConfig as { serverName?: unknown }).serverName === 'string'
        ? (entryConfig as { serverName: string }).serverName
        : module
      rows.push({ module, server, enabled: entry.disabled !== true })
    }
    return rows.sort((a, b) => a.server.localeCompare(b.server))
  }

  const port = config.port ?? (process.env.DSH_DUKE_PORT === undefined ? undefined : Number(process.env.DSH_DUKE_PORT))
  if (port === undefined || !Number.isFinite(port)) return
  if (tokensFile === undefined && proxyUserHeader === undefined && grants === undefined) return

  let tokens: Record<string, ProvisionedToken> = {}
  // Loading the token table is asynchronous, so the server starts once it is
  // known: an API that accepts every token for its first second is worse than an
  // API that answers 503 for that second.
  const ready = (tokensFile === undefined ? Promise.resolve({}) : loadTokens(tokensFile))
    .then((loaded) => {
      tokens = loaded
      const options: MndtApiOptions = {
        service,
        runner: new DshMissionRunner(ctx),
        identity: { tokens, ...(proxyUserHeader === undefined ? {} : { proxyUserHeader }) },
        grants,
        connectors,
      }
      return startMndtApi({ ...options, port, ...(config.host === undefined ? {} : { host: config.host }) })
    })
    .catch((error: unknown) => {
      ctx.logger?.error?.(`mndt: the product API did not start: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    })

  ctx.effect(() => {
    let server: { close(callback?: (error?: Error) => void): void } | undefined
    void ready.then((started) => { server = started })
    return () => { server?.close() }
  }, 'mndt: product API')
}
