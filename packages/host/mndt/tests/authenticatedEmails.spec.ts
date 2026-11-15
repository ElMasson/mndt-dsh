import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const deploy = join(import.meta.dirname, '..', 'deploy')
const script = join(deploy, 'tenant', 'render-authenticated-emails.py')
const owner = 'duke@datanalysis.re'

/** @param grants - the role table. @param previous - an earlier list, if any. @returns the run and the list it leaves. */
type Rendered = { status: number | null; stderr: string; list: string | undefined; output: string }
function render(grants: unknown, previous?: string, who = owner, privileged = false): Rendered {
  const dir = mkdtempSync(join(tmpdir(), 'emails-'))
  const output = join(dir, 'authenticated_emails')
  if (previous !== undefined) writeFileSync(output, previous)
  writeFileSync(join(dir, 'grants.json'), typeof grants === 'string' ? grants : JSON.stringify(grants))
  // Tests run unprivileged: the owner change to the proxy (65532) needs root.
  const env = privileged ? { ...process.env, MNDT_EMAILS_UNPRIVILEGED: '' } : { ...process.env, MNDT_EMAILS_UNPRIVILEGED: '1' }
  const run = spawnSync('python3', [script, join(dir, 'grants.json'), output, 'datanalysis.re,duke-analytics.com', '--owner', who], { encoding: 'utf8', env })
  return { status: run.status, stderr: run.stderr, list: existsSync(output) ? readFileSync(output, 'utf8') : undefined, output }
}

const row = (subject: string, role = 'viewer') => ({ subject, role })

describe('the sign-in list, from the role table', { timeout: 30_000 }, () => {
  it.skipIf(process.getuid?.() === 0)('refuses to run without root, before writing anything: the proxy could not read the list', () => {
    const run = render({ grants: [row(owner, 'owner')] }, 'duke@datanalysis.re\n', owner, true)
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('run as root')
    expect(run.list).toBe('duke@datanalysis.re\n')
  })

  it('validates a name as the API does: trimmed, 80 UTF-16 units, no line separator', () => {
    const named = (name: string) => render({ grants: [{ ...row(owner, 'owner'), name }] }, 'previous\n')
    expect(named(`  ${'a'.repeat(80)}  `).status).toBe(0)
    expect(named('😀'.repeat(41)).status).toBe(1) // 82 UTF-16 units, 41 code points
    expect(named('😀'.repeat(40)).status).toBe(0)
    for (const bad of ['a\u2028b', 'a\u2029b', 'a\nb', '   ']) expect(named(bad).status, JSON.stringify(bad)).toBe(1)
  })

  it('says, on a domain refusal, that every domain must be passed and that the proxy keeps its configuration', () => {
    const run = render({ grants: [row(owner, 'owner'), row('x@other.re')] }, 'duke@datanalysis.re\n')
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('EVERY domain of the team, datanalysis.re included')
    expect(run.stderr).toContain('keeps its previous configuration')
  })

  it('admits every subject, lowercase, once, within the allowed domains, mode 640', () => {
    const run = render({ grants: [row('Duke@Datanalysis.re', 'owner'), row('smarion@datanalysis.re'), row('duke@datanalysis.re', 'admin'), row('stephane@duke-analytics.com', 'operator')] })
    expect(run.status).toBe(0)
    expect(run.list).toBe('duke@datanalysis.re\nsmarion@datanalysis.re\nstephane@duke-analytics.com\n')
    expect(statSync(run.output).mode & 0o777).toBe(0o640)
  })

  it('refuses the whole list, unchanged, for an address outside the domains, a suffix or an injection', () => {
    for (const subject of ['someone@gmail.com', 'x@evil-datanalysis.re', 'x@datanalysis.re.evil.com', '*', 'a@datanalysis.re,b@gmail.com',
      'a@datanalysis.re\nb@gmail.com', '@datanalysis.re', 'duKe@datanalysis.re']) {
      const run = render({ grants: [row(owner, 'owner'), row(subject)] }, 'duke@datanalysis.re\n')
      expect(run.status, JSON.stringify(subject)).toBe(1)
      expect(run.list, JSON.stringify(subject)).toBe('duke@datanalysis.re\n')
      expect(run.stderr).toContain('refused:')
    }
  })

  it('reads the table as the API does: an unknown role or a bad name refuses it all', () => {
    for (const grants of [{ grants: [row(owner, 'owner'), row('smarion@datanalysis.re', 'boss')] },
      { grants: [row(owner, 'owner'), { subject: 'smarion@datanalysis.re', role: 'viewer', name: 'a\nb' }] }]) {
      expect(render(grants, 'duke@datanalysis.re\n').status).toBe(1)
    }
  })

  it('never writes a list without the owner, nor from an unreadable table', () => {
    const missing = render({ grants: [row('smarion@datanalysis.re', 'owner')] }, 'duke@datanalysis.re\n')
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('would lock them out')
    for (const grants of ['{ broken', { other: [] }]) expect(render(grants, 'duke@datanalysis.re\n').status).toBe(1)
  })
})

describe('create-tenant.sh and the proxy', { timeout: 60_000 }, () => {
  /** @returns a root where create-tenant.sh can render the tenant. */
  function rootWithEntra(): string {
    const root = mkdtempSync(join(tmpdir(), 'tenant-'))
    mkdirSync(join(root, 'etc', 'oauth2-proxy'), { recursive: true })
    writeFileSync(join(root, 'etc', 'oauth2-proxy', 'governance.cfg'), 'client_id = "app-1234"\n')
    writeFileSync(join(root, 'etc', 'oauth2-proxy', 'client_secret'), 'entra-secret')
    return root
  }
  const create = (root: string, ...extra: string[]) => spawnSync('bash', [join(deploy, 'create-tenant.sh'), 'datanalysis', 'equipe.datanalysis.re',
    '--owner', owner, ...extra, '--no-docker'], { env: { ...process.env, MNDT_ROOT: root }, encoding: 'utf8' })
  const proxyConf = (root: string) => /MNDT_PROXY_CONF: "([0-9a-f]+)"/.exec(readFileSync(join(root, 'opt/mndt/datanalysis/docker-compose.yml'), 'utf8'))?.[1]

  it('on a rerun of an existing tenant, recreates the proxy when its configuration changed, and only then', () => {
    const root = rootWithEntra()
    expect(create(root).status).toBe(0)
    const first = proxyConf(root)
    expect(first).toMatch(/^[0-9a-f]{16}$/)
    expect(create(root).status).toBe(0)
    expect(proxyConf(root)).toBe(first)
    // A tenant from before this change: its compose has no MNDT_PROXY_CONF at all and its
    // configuration names domains; the rerun rewrites both, so `up -d` recreates the proxy once.
    const cfg = join(root, 'etc/mndt/datanalysis/oauth2.cfg')
    writeFileSync(cfg, 'email_domains = ["datanalysis.re"]\n')
    const compose = join(root, 'opt/mndt/datanalysis/docker-compose.yml')
    writeFileSync(compose, readFileSync(compose, 'utf8').replace(/ *MNDT_PROXY_CONF: "[0-9a-f]+"\n/, ''))
    expect(proxyConf(root)).toBeUndefined()
    expect(create(root).status).toBe(0)
    expect(readFileSync(cfg, 'utf8')).toContain('authenticated_emails_file')
    expect(proxyConf(root)).toBe(first)
  })

  it('recreates the proxy when only the list changed, and writes the list 640', () => {
    const root = rootWithEntra()
    expect(create(root).status).toBe(0)
    const first = proxyConf(root)
    const grants = join(root, 'data/mndt/datanalysis/live/grants.json')
    writeFileSync(grants, JSON.stringify({ grants: [row(owner, 'owner'), row('smarion@datanalysis.re')] }))
    expect(create(root).status).toBe(0)
    expect(readFileSync(join(root, 'etc/mndt/datanalysis/authenticated_emails'), 'utf8')).toBe('duke@datanalysis.re\nsmarion@datanalysis.re\n')
    expect(proxyConf(root)).not.toBe(first)
    expect(statSync(join(root, 'etc/mndt/datanalysis/authenticated_emails')).mode & 0o777).toBe(0o640)
  })

  it('writes nothing of the proxy when a step before it fails (a patch that does not parse)', () => {
    const root = rootWithEntra()
    expect(create(root).status).toBe(0)
    const cfg = join(root, 'etc/mndt/datanalysis/oauth2.cfg')
    const list = join(root, 'etc/mndt/datanalysis/authenticated_emails')
    const compose = join(root, 'opt/mndt/datanalysis/docker-compose.yml')
    writeFileSync(cfg, 'previous configuration\n')
    const before = [readFileSync(list, 'utf8'), readFileSync(compose, 'utf8')]
    writeFileSync(join(root, 'data/mndt/datanalysis/live/grants.json'), JSON.stringify({ grants: [row(owner, 'owner'), row('smarion@datanalysis.re')] }))
    writeFileSync(join(root, 'data/mndt/datanalysis/live/home/cordis.patch.yml'), '- id: [unclosed\n')
    const failed = create(root)
    expect(failed.status).not.toBe(0)
    expect(readFileSync(cfg, 'utf8')).toBe('previous configuration\n')
    expect([readFileSync(list, 'utf8'), readFileSync(compose, 'utf8')]).toEqual(before)
    expect(existsSync(`${cfg}.new`)).toBe(false)
  })

  it('leaves the configuration as it was when the list is refused', () => {
    const root = rootWithEntra()
    expect(create(root).status).toBe(0)
    const cfg = join(root, 'etc/mndt/datanalysis/oauth2.cfg')
    writeFileSync(cfg, 'previous configuration\n')
    writeFileSync(join(root, 'data/mndt/datanalysis/live/grants.json'), JSON.stringify({ grants: [row(owner, 'owner'), row('x@gmail.com')] }))
    const refused = create(root)
    expect(refused.status).not.toBe(0)
    expect(readFileSync(cfg, 'utf8')).toBe('previous configuration\n')
  })
})
