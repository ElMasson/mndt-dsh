import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = join(import.meta.dirname, '..', 'deploy', 'create-tenant.sh')

/** @returns a root holding the Entra configuration the script reads. */
function rootWithEntra(): string {
  const root = mkdtempSync(join(tmpdir(), 'tenant-'))
  mkdirSync(join(root, 'etc', 'oauth2-proxy'), { recursive: true })
  writeFileSync(join(root, 'etc', 'oauth2-proxy', 'governance.cfg'), 'client_id = "app-1234"\n')
  writeFileSync(join(root, 'etc', 'oauth2-proxy', 'client_secret'), 'entra-secret')
  return root
}

function create(root: string, ...args: string[]): string {
  return execFileSync('bash', [script, ...args, '--no-docker'], { env: { ...process.env, MNDT_ROOT: root }, encoding: 'utf8' })
}

const mode = (path: string): string => (statSync(path).mode & 0o777).toString(8)

describe('create-tenant.sh', { timeout: 30_000 }, () => {
  it('renders a tenant from its slug and domain, with nothing of another deployment', () => {
    const root = rootWithEntra()
    create(root, 'datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re')
    const oauth = readFileSync(join(root, 'etc/mndt/datanalysis/oauth2.cfg'), 'utf8')
    const compose = readFileSync(join(root, 'opt/mndt/datanalysis/docker-compose.yml'), 'utf8')
    expect(oauth).toContain('redirect_url = "https://equipe.datanalysis.re/oauth2/callback"')
    expect(oauth).toContain('client_id = "app-1234"')
    expect(oauth).toContain('email_domains = ["datanalysis.re"]')
    expect(compose).toContain('Host(`equipe.datanalysis.re`)')
    expect(compose).toContain('DSH_MNDT_IDENTITY: duke@datanalysis.re')
    expect(compose).toContain('/data/mndt/datanalysis/live:/state')
    expect(compose).toContain('MNDT_APPROVALS_ALLOW_DECIDE: "0"')
    for (const text of [oauth, compose]) {
      expect(text).not.toContain('duke-analytics')
      expect(text).not.toMatch(/__[A-Z_]+__/)
    }
    expect(mode(join(root, 'etc/mndt/datanalysis/client_secret'))).toBe('400')
    expect(mode(join(root, 'etc/mndt/datanalysis/cookie_secret'))).toBe('400')
    expect(mode(join(root, 'data/mndt/datanalysis/live/model.env'))).toBe('600')
    // The tenant's role table, owner first, read by the workbench from /state.
    expect(JSON.parse(readFileSync(join(root, 'data/mndt/datanalysis/live/grants.json'), 'utf8'))).toEqual({ grants: [{ subject: 'duke@datanalysis.re', role: 'owner' }] })
    expect(mode(join(root, 'data/mndt/datanalysis/live/grants.json'))).toBe('600')
    expect(compose).toContain('DSH_MNDT_GRANTS_FILE: /state/grants.json')
    // The adapters lane's names, the ones its LLM routes read; the keys stay empty.
    const modelEnv = readFileSync(join(root, 'data/mndt/datanalysis/live/model.env'), 'utf8')
    for (const name of ['SCW_GENAPI_KEY=', 'SCW_PROJECT_ID=', 'VLLM_QWEN_BASE_URL=', 'VLLM_QWEN_MODEL=', 'VLLM_API_KEY=']) expect(modelEnv).toContain(name)
    expect(modelEnv).not.toMatch(/^SCW_GENAPI_KEY=\S/m)
    // The compose starts the workbench from the tools folder.
    expect(readFileSync(join(root, 'data/mndt/datanalysis/live/tools/workbench-entrypoint.sh'), 'utf8')).toContain('apps/cli/lib/bin.js web')
    expect(readFileSync(join(root, 'opt/mndt/datanalysis/gateway/server.mjs'), 'utf8')).not.toBe('')
    expect(JSON.parse(readFileSync(join(root, 'data/mndt/datanalysis/live/state.json'), 'utf8'))).toMatchObject({ version: 1 })
  })

  it('keeps the secrets, the state, the model environment and the role file of an existing tenant', () => {
    const root = rootWithEntra()
    create(root, 'datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re')
    const cookie = readFileSync(join(root, 'etc/mndt/datanalysis/cookie_secret'))
    writeFileSync(join(root, 'data/mndt/datanalysis/live/model.env'), 'SCW_SECRET_KEY=filled\n')
    const team = '{"grants":[{"subject":"duke@datanalysis.re","role":"owner"},{"subject":"a@datanalysis.re","role":"admin"}]}'
    writeFileSync(join(root, 'data/mndt/datanalysis/live/grants.json'), team)
    create(root, 'datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re')
    expect(readFileSync(join(root, 'etc/mndt/datanalysis/cookie_secret'))).toEqual(cookie)
    expect(readFileSync(join(root, 'data/mndt/datanalysis/live/model.env'), 'utf8')).toBe('SCW_SECRET_KEY=filled\n')
    expect(readFileSync(join(root, 'data/mndt/datanalysis/live/grants.json'), 'utf8')).toBe(team) // the team stays
  })

  it('refuses a tenant without an owner, a bad slug or a bad domain', () => {
    const root = rootWithEntra()
    for (const args of [['datanalysis', 'equipe.datanalysis.re'], ['Data Nalysis', 'equipe.datanalysis.re', '--owner', 'a@b.c'], ['datanalysis', 'not a domain', '--owner', 'a@b.c']]) {
      expect(() => create(root, ...args)).toThrow()
    }
  })
})
