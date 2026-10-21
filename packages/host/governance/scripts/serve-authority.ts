/**
 * Start the governance authority from the environment.
 *
 * Run it with: `pnpm exec tsx packages/host/governance/scripts/serve-authority.ts`
 *
 * Environment:
 * - `DSH_GOVERNANCE_TOKENS_FILE` JSON file mapping token to `{ "user": "..." }`.
 * - `DSH_GOVERNANCE_PORT` port to bind (default 8787).
 * - `DSH_GOVERNANCE_HOST` interface to bind (default 127.0.0.1; set it to
 *   `0.0.0.0` only behind a reverse proxy you control, never directly).
 * - `DSH_GOVERNANCE_STATE` state file (default `~/.dsh/governance/rbac.json`).
 * - `DSH_GOVERNANCE_AUDIT` audit JSONL file (default `~/.dsh/governance/audit.jsonl`).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { startAuthority, type AuthorityToken } from '../src/authority.ts'
import { JsonFileRbacStorage, defaultStatePath } from '../src/storage.ts'

/** @param value - environment value. @param fallback - default. @returns the value or the default. */
function or(value: string | undefined, fallback: string): string {
  return value === undefined || value === '' ? fallback : value
}

/** @returns the parsed token map. @throws when the file is missing or is not a token map. */
function readTokens(): Record<string, AuthorityToken> {
  const path = process.env.DSH_GOVERNANCE_TOKENS_FILE
  if (path === undefined || path === '') {
    throw new Error('DSH_GOVERNANCE_TOKENS_FILE must point at the token file')
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${path} does not contain a token map`)
  }
  return parsed as Record<string, AuthorityToken>
}

const tokens = readTokens()
const port = Number(or(process.env.DSH_GOVERNANCE_PORT, '8787'))
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`DSH_GOVERNANCE_PORT must be a positive integer, received ${String(process.env.DSH_GOVERNANCE_PORT)}`)
}
const auditPath = or(process.env.DSH_GOVERNANCE_AUDIT, join(homedir(), '.dsh', 'governance', 'audit.jsonl'))
const statePath = or(process.env.DSH_GOVERNANCE_STATE, defaultStatePath())
const host = or(process.env.DSH_GOVERNANCE_HOST, '127.0.0.1')

const server = startAuthority({
  tokens,
  storage: new JsonFileRbacStorage(statePath),
  auditPath,
  port,
  host,
})

server.on('listening', () => {
  process.stdout.write(`governance authority listening on http://${host}:${port}\n`)
  process.stdout.write(`state: ${statePath}\n`)
  process.stdout.write(`audit: ${auditPath}\n`)
  process.stdout.write(`tokens: ${Object.keys(tokens).length} provisioned\n`)
})
