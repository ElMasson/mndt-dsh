import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

/** The first line of every sign-in list written: it matches no address. */
const LIST_HEADER = '# generated from grants.json by render-authenticated-emails.py: never edit by hand\n'

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
    // Who may sign in: the role table's addresses only, never a whole domain.
    expect(oauth).toContain('authenticated_emails_file = "/etc/mndt-front/authenticated_emails"')
    expect(oauth).not.toMatch(/^email_domains/m)
    expect(readFileSync(join(root, 'etc/mndt/datanalysis/authenticated_emails'), 'utf8')).toBe(`${LIST_HEADER}duke@datanalysis.re\n`)
    expect(compose).toContain('Host(`equipe.datanalysis.re`)')
    expect(compose).toContain('DSH_MNDT_IDENTITY: duke@datanalysis.re')
    expect(compose).toContain('/data/mndt/datanalysis/live:/state')
    expect(compose).toContain('MNDT_APPROVALS_ALLOW_DECIDE: "0"')
    // The gateway is another container: the API must not listen on its loopback only.
    expect(compose).toContain('DSH_MNDT_HOST: 0.0.0.0')
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

  it('writes the team defaults in the home patch once, beside the LLM routes', () => {
    const root = rootWithEntra()
    create(root, 'datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re')
    const data = join(root, 'data/mndt/datanalysis/live')
    writeFileSync(join(data, 'model.env'), 'SCW_PROJECT_ID=11111111-2222-3333-4444-555555555555\nVLLM_QWEN_MODEL=Qwen/Qwen3.5-35B-A3B\n')
    execFileSync('python3', [join(import.meta.dirname, '..', 'deploy', 'llm', 'render-llm-routes.py'), '--env-file', join(data, 'model.env')], { env: { ...process.env, MNDT_HOME: data } })
    create(root, 'datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re')
    execFileSync('python3', [join(import.meta.dirname, '..', 'deploy', 'llm', 'render-llm-routes.py'), '--env-file', join(data, 'model.env')], { env: { ...process.env, MNDT_HOME: data } })
    const patch = readFileSync(join(data, 'home/cordis.patch.yml'), 'utf8')
    expect(patch.split('# >>> tenant d equipe (create-tenant.sh)').length - 1).toBe(1)
    expect(patch.split('# >>> routes LLM rendues par render-llm-routes').length - 1).toBe(1)
    const rows = load(patch) as { id: string; config?: { preference?: string } & Record<string, unknown>; disabled?: boolean }[]
    expect(rows.find(row => row.id === 'locale')?.config?.preference).toBe('fr')
    expect(rows.find(row => row.id === 'ui-plugin-manager')?.disabled).toBe(true)
    expect(rows.find(row => row.id === 'ui-schedule')?.disabled).toBe(true)
    // No Preview Notice nor Get started prompt at the first arrival (lane B): the
    // notice version must follow the client's, or the notice comes back.
    const copy = readFileSync(join(import.meta.dirname, '..', '..', '..', 'client', 'ui-settings-models', 'src', 'onboarding-copy.ts'), 'utf8')
    const shipped = /WELCOME_NOTICE_VERSION = '([^']+)'/.exec(copy)?.[1]
    expect(shipped).toBeDefined()
    expect((rows.find(row => row.id === 'ui-settings-general')?.config as { welcomeNoticeVersion?: string } | undefined)?.welcomeNoticeVersion).toBe(shipped)
    expect((rows.find(row => row.id === 'ui-settings-models')?.config as { credentialOnboarding?: boolean } | undefined)?.credentialOnboarding).toBe(false)
    // The default workspace lands in the volume: the image has no Documents folder (lane B).
    expect((rows.find(row => row.id === 'workspace-controller')?.config as { documentsDirectory?: string } | undefined)?.documentsDirectory).toBe('/state/home/documents')
    expect(rows.some(row => row.id === 'llm-pi-ai')).toBe(true)
  })

  it('writes its block through the guard: over the `[]` dsh wrote, and refuses a broken file untouched', () => {
    const root = rootWithEntra()
    const data = join(root, 'data/mndt/datanalysis/live')
    const patchPath = join(data, 'home/cordis.patch.yml')
    // The home as the workbench leaves it at first start: comments, then `[]`.
    mkdirSync(join(data, 'home'), { recursive: true })
    writeFileSync(patchPath, '# Your patch layer for this dsh profile.\n[]\n')
    create(root, 'datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re')
    const once = readFileSync(patchPath, 'utf8')
    const rows = load(once) as { id: string }[]
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.map(row => row.id)).toContain('locale')
    create(root, 'datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re')
    expect(readFileSync(patchPath, 'utf8')).toBe(once) // a rerun changes nothing
    expect(readFileSync(join(root, 'opt/mndt/datanalysis/gateway/patchfile.py'), 'utf8')).toContain('def update(')
    // A file that does not parse is left exactly as it was, and the script fails.
    writeFileSync(patchPath, 'foo: [\n')
    expect(() => create(root, 'datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re')).toThrow()
    expect(readFileSync(patchPath, 'utf8')).toBe('foo: [\n')
  })

  it('fingerprints the mounted gateway and entrypoint code, so up -d recreates what changed', () => {
    const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
    const deploy = join(import.meta.dirname, '..', 'deploy')
    const root = rootWithEntra()
    create(root, 'datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re')
    const composePath = join(root, 'opt/mndt/datanalysis/docker-compose.yml')
    const compose = readFileSync(composePath, 'utf8')
    expect(compose).toContain(`MNDT_GATEWAY_CODE: "${sha(join(deploy, 'gateway', 'server.mjs'))}"`)
    // One fingerprint of everything the workbench runs from the tools folder:
    // the four connector tools, the machine connector, then the entrypoint.
    const toolsCode = (dir: string): string => createHash('sha256')
      .update(Buffer.concat([
        ...['approvals-mcp.mjs', 'mcp-proxy.mjs', 'office365-mcp.mjs', 'facts-mcp.mjs'].map(tool => readFileSync(join(dir, 'connectors', tool))),
        readFileSync(join(dir, 'machine-mcp.mjs')), readFileSync(join(dir, 'workbench-entrypoint.sh')),
      ]))
      .digest('hex').slice(0, 16)
    expect(compose).toContain(`MNDT_TOOLS_CODE: "${toolsCode(deploy)}"`)
    // The 13/11 update: only server.mjs changed on disk; the rendered compose must change with it.
    const copy = mkdtempSync(join(tmpdir(), 'deploy-'))
    cpSync(deploy, copy, { recursive: true })
    writeFileSync(join(copy, 'gateway', 'server.mjs'), `${readFileSync(join(deploy, 'gateway', 'server.mjs'), 'utf8')}\n// changed\n`)
    execFileSync('bash', [join(copy, 'create-tenant.sh'), 'datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re', '--no-docker'], { env: { ...process.env, MNDT_ROOT: root } })
    const after = readFileSync(composePath, 'utf8')
    expect(after).not.toBe(compose)
    expect(after).toContain(`MNDT_GATEWAY_CODE: "${sha(join(copy, 'gateway', 'server.mjs'))}"`)
    // A connector tool alone (mcp-proxy.mjs) changes the tools fingerprint, so up -d recreates the workbench.
    writeFileSync(join(copy, 'connectors', 'mcp-proxy.mjs'), `${readFileSync(join(deploy, 'connectors', 'mcp-proxy.mjs'), 'utf8')}\n// changed\n`)
    execFileSync('bash', [join(copy, 'create-tenant.sh'), 'datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re', '--no-docker'], { env: { ...process.env, MNDT_ROOT: root } })
    const third = readFileSync(composePath, 'utf8')
    expect(third).toContain(`MNDT_TOOLS_CODE: "${toolsCode(copy)}"`)
    expect(toolsCode(copy)).not.toBe(toolsCode(deploy))
    // facts-mcp.mjs is in it too: an update now refreshes it, and recreates the workbench when it changed.
    writeFileSync(join(copy, 'connectors', 'facts-mcp.mjs'), `${readFileSync(join(deploy, 'connectors', 'facts-mcp.mjs'), 'utf8')}\n// changed\n`)
    execFileSync('bash', [join(copy, 'create-tenant.sh'), 'datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re', '--no-docker'], { env: { ...process.env, MNDT_ROOT: root } })
    const fourth = readFileSync(composePath, 'utf8')
    expect(fourth).toContain(`MNDT_TOOLS_CODE: "${toolsCode(copy)}"`)
    expect(fourth).not.toBe(third)
    // mcp-check.mjs is copied but not fingerprinted: the workbench never runs it.
    writeFileSync(join(copy, 'connectors', 'mcp-check.mjs'), `${readFileSync(join(deploy, 'connectors', 'mcp-check.mjs'), 'utf8')}\n// changed\n`)
    execFileSync('bash', [join(copy, 'create-tenant.sh'), 'datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re', '--no-docker'], { env: { ...process.env, MNDT_ROOT: root } })
    expect(readFileSync(composePath, 'utf8')).toBe(fourth)
  })

  it('fingerprints the machine connector and the egress proxy too: up -d recreates the workbench, or the proxy alone', () => {
    const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
    const deploy = join(import.meta.dirname, '..', 'deploy')
    const root = rootWithEntra()
    create(root, 'datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re')
    const composePath = join(root, 'opt/mndt/datanalysis/docker-compose.yml')
    const toolsLine = (compose: string): string => compose.split('\n').find(line => line.includes('MNDT_TOOLS_CODE')) ?? ''
    const before = readFileSync(composePath, 'utf8')
    expect(before).toContain(`MNDT_EGRESS_CODE: "${sha(join(deploy, 'sandbox', 'egress-proxy.mjs'))}"`)
    const copy = mkdtempSync(join(tmpdir(), 'deploy-'))
    cpSync(deploy, copy, { recursive: true })
    // The machine connector: an update refreshes it, and recreates the workbench when it changed.
    writeFileSync(join(copy, 'machine-mcp.mjs'), `${readFileSync(join(deploy, 'machine-mcp.mjs'), 'utf8')}\n// changed\n`)
    execFileSync('bash', [join(copy, 'create-tenant.sh'), 'datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re', '--no-docker'], { env: { ...process.env, MNDT_ROOT: root } })
    const machined = readFileSync(composePath, 'utf8')
    expect(toolsLine(machined)).not.toBe(toolsLine(before))
    expect(readFileSync(join(root, 'data/mndt/datanalysis/live/tools/machine-mcp.mjs'), 'utf8')).toContain('// changed')
    // The egress proxy's code has its own fingerprint: up -d recreates the proxy alone.
    writeFileSync(join(copy, 'sandbox', 'egress-proxy.mjs'), `${readFileSync(join(deploy, 'sandbox', 'egress-proxy.mjs'), 'utf8')}\n// changed\n`)
    execFileSync('bash', [join(copy, 'create-tenant.sh'), 'datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re', '--no-docker'], { env: { ...process.env, MNDT_ROOT: root } })
    const egressed = readFileSync(composePath, 'utf8')
    expect(egressed).toContain(`MNDT_EGRESS_CODE: "${sha(join(copy, 'sandbox', 'egress-proxy.mjs'))}"`)
    expect(toolsLine(egressed)).toBe(toolsLine(machined))
    expect(readFileSync(join(root, 'opt/mndt/datanalysis/egress/egress-proxy.mjs'), 'utf8')).toContain('// changed')
  })

  it('renders the computers: a token outside /state, the members\' folders, EGRESS_DENY with this host\'s addresses and Docker\'s pools, the images named', () => {
    const root = rootWithEntra()
    create(root, 'datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re', '--egress-deny', '51.159.161.149', '--pc-image', 'mndt-pc:test', '--machines-image', 'mndt-machines:test')
    const token = join(root, 'etc/mndt/datanalysis/machines_token')
    expect(readFileSync(token, 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/)
    expect((statSync(token).mode & 0o777).toString(8)).toBe('400')
    const compose = readFileSync(join(root, 'opt/mndt/datanalysis/docker-compose.yml'), 'utf8')
    expect(compose).not.toContain(readFileSync(token, 'utf8').trim())
    interface Service {
      image?: string
      networks?: unknown
      environment?: Record<string, string>
      volumes?: string[]
      container_name?: string
      user?: string
      read_only?: boolean
    }
    const rendered = load(compose) as { services: Record<string, Service>; networks: Record<string, { internal?: boolean } | null> }
    const machines = rendered.services.machines
    expect(machines?.image).toBe('mndt-machines:test')
    expect(machines?.environment).toMatchObject({
      MACHINES_PC_ONLY: '1', MNDT_MACHINE_RUNTIME: 'runsc', PC_IMAGE: 'mndt-pc:test', PC_TENANT: 'datanalysis',
      PC_PREFIX: 'mndt-datanalysis-pc-', PC_NET_PREFIX: 'mndt-datanalysis-pcnet-', DOCKER_HOST: 'tcp://docker-guard:2375', MACHINES_HOST: 'machines-api',
    })
    expect(machines?.environment?.MNDT_MACHINE_ALLOW_RUNC).toBeUndefined()
    expect(JSON.stringify(machines?.volumes)).not.toContain('docker.sock')
    // The guard: ours, the machines image's other entrypoint, non-root in the socket's group, read-only, no capability.
    const guard = rendered.services['docker-guard'] as Service & { entrypoint?: string[]; cap_drop?: string[]; security_opt?: string[] }
    expect(guard.image).toBe('mndt-machines:test')
    expect(guard.entrypoint).toEqual(['python3', '/app/docker-guard.py'])
    expect(guard.user).toMatch(/^65534:[1-9][0-9]*$/)
    expect(guard.read_only).toBe(true)
    expect(guard.cap_drop).toEqual(['ALL'])
    expect(guard.environment).toMatchObject({
      MNDT_GUARD_SPACE: 'datanalysis', MNDT_GUARD_PC_IMAGE: 'mndt-pc:test', MNDT_GUARD_PC_PREFIX: 'mndt-datanalysis-pc-',
      MNDT_GUARD_NET_PREFIX: 'mndt-datanalysis-pcnet-', MNDT_GUARD_USERS_ROOT: '/data/mndt/datanalysis/live/users', MNDT_GUARD_EGRESS: 'mndt-datanalysis-egress',
    })
    expect(guard.volumes).toEqual(['/var/run/docker.sock:/var/run/docker.sock'])
    expect(rendered.networks['docker-guard-net']?.internal).toBe(true)
    expect(Object.keys(rendered.services)).not.toContain('docker-proxy')
    expect(rendered.networks.machines?.internal).toBe(true)
    const egress = rendered.services.egress
    expect(egress?.container_name).toBe('mndt-datanalysis-egress')
    expect(egress?.read_only).toBe(true)
    const deny = (egress?.environment?.EGRESS_DENY ?? '').split(',')
    expect(deny).toEqual(expect.arrayContaining([
      '51.159.161.149', '51.159.151.86', '169.254.0.0/16', '100.64.0.0/10',
      'fc00::/7', 'fe80::/10', '::1', '172.16.0.0/12', '192.168.0.0/16', '10.0.0.0/8',
    ]))
    // Only the guard holds the socket.
    for (const [name, service] of Object.entries(rendered.services)) {
      if (name !== 'docker-guard') expect(JSON.stringify(service.volumes ?? [])).not.toContain('docker.sock')
    }
    expect((statSync(join(root, 'data/mndt/datanalysis/live/users')).mode & 0o777).toString(8)).toBe('711')
    // Without --egress-deny, the public address comes from the metadata (Scaleway's conf), or nothing is rendered.
    const metadataRoot = rootWithEntra()
    mkdirSync(join(metadataRoot, 'run'), { recursive: true })
    writeFileSync(join(metadataRoot, 'run', 'scaleway-metadata'), "COMMERCIAL_TYPE=PLAY2-NANO\nPUBLIC_IP_ADDRESS='51.159.161.149'\n")
    create(metadataRoot, 'datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re')
    expect(readFileSync(join(metadataRoot, 'opt/mndt/datanalysis/docker-compose.yml'), 'utf8')).toMatch(/EGRESS_DENY: "51\.159\.161\.149,/)
    const blind = rootWithEntra()
    mkdirSync(join(blind, 'run'), { recursive: true })
    writeFileSync(join(blind, 'run', 'scaleway-metadata'), 'COMMERCIAL_TYPE=PLAY2-NANO\n')
    const tenantScript = join(import.meta.dirname, '..', 'deploy', 'create-tenant.sh')
    const unknown = spawnSync('bash', [tenantScript, 'datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re', '--no-docker'], {
      env: { ...process.env, MNDT_ROOT: blind }, encoding: 'utf8',
    })
    expect(unknown.status).toBe(1)
    expect(unknown.stderr).toContain('public address is unknown')
    expect(existsSync(join(blind, 'opt/mndt/datanalysis/docker-compose.yml'))).toBe(false)
    // A value that is not addresses or ranges is refused before anything is written.
    const script = join(import.meta.dirname, '..', 'deploy', 'create-tenant.sh')
    const args = ['datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re', '--egress-deny', 'x;rm', '--no-docker']
    const refused = spawnSync('bash', [script, ...args], { env: { ...process.env, MNDT_ROOT: root }, encoding: 'utf8' })
    expect(refused.status).not.toBe(0)
  })

  it('replaces each tool atomically: a new file renamed over the old one, mode 0644, no .tmp left', () => {
    const root = rootWithEntra()
    const tools = join(root, 'data/mndt/datanalysis/live/tools')
    const names = ['approvals-mcp.mjs', 'mcp-proxy.mjs', 'office365-mcp.mjs', 'facts-mcp.mjs', 'mcp-check.mjs', 'workbench-entrypoint.sh']
    create(root, 'datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re')
    const first = new Map(names.map(name => [name, statSync(join(tools, name)).ino]))
    // A file left with another mode (an older copy) gets 0644 back.
    chmodSync(join(tools, 'mcp-proxy.mjs'), 0o600)
    create(root, 'datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re')
    for (const name of names) {
      const info = statSync(join(tools, name))
      expect(info.mode & 0o777, name).toBe(0o644)
      // Owner: the user who ran it (root on the server, where it is also set to 0:0 explicitly).
      expect(info.uid, name).toBe(process.getuid?.())
      // Renamed over, never rewritten in place: a reader of the old file keeps a whole file.
      expect(info.ino, name).not.toBe(first.get(name))
    }
    expect(readdirSync(tools).filter(name => name.includes('.tmp'))).toEqual([])
  })

  it('a tool that cannot be installed stops the run, leaves the old file whole and no .tmp', () => {
    const root = rootWithEntra()
    const tools = join(root, 'data/mndt/datanalysis/live/tools')
    create(root, 'datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re')
    const before = readFileSync(join(tools, 'approvals-mcp.mjs'), 'utf8')
    // The folder read-only: the new file cannot be written beside the old one.
    chmodSync(tools, 0o555)
    try {
      expect(() => create(root, 'datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re')).toThrow(/could not install/)
      expect(readFileSync(join(tools, 'approvals-mcp.mjs'), 'utf8')).toBe(before)
      expect(readdirSync(tools).filter(name => name.includes('.tmp'))).toEqual([])
    } finally {
      chmodSync(tools, 0o755)
    }
  })

  it('installs the operator\'s check and the facts server in the tools folder, refreshed on each run', () => {
    const deploy = join(import.meta.dirname, '..', 'deploy')
    const root = rootWithEntra()
    const tools = join(root, 'data/mndt/datanalysis/live/tools')
    create(root, 'datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re')
    for (const tool of ['mcp-check.mjs', 'facts-mcp.mjs', 'approvals-mcp.mjs', 'mcp-proxy.mjs', 'office365-mcp.mjs']) {
      expect(readFileSync(join(tools, tool), 'utf8')).toBe(readFileSync(join(deploy, 'connectors', tool), 'utf8'))
    }
    // A stale copy (left by an earlier version) is replaced by the next run.
    writeFileSync(join(tools, 'mcp-check.mjs'), '// an older mcp-check.mjs\n')
    writeFileSync(join(tools, 'facts-mcp.mjs'), '// an older facts-mcp.mjs\n')
    create(root, 'datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re')
    expect(readFileSync(join(tools, 'mcp-check.mjs'), 'utf8')).toContain('sonde server/discover')
    expect(readFileSync(join(tools, 'facts-mcp.mjs'), 'utf8')).toBe(readFileSync(join(deploy, 'connectors', 'facts-mcp.mjs'), 'utf8'))
  })

  it('refuses a tenant without an owner, a bad slug or a bad domain', () => {
    const root = rootWithEntra()
    for (const args of [['datanalysis', 'equipe.datanalysis.re'], ['Data Nalysis', 'equipe.datanalysis.re', '--owner', 'a@b.c'], ['datanalysis', 'not a domain', '--owner', 'a@b.c']]) {
      expect(() => create(root, ...args)).toThrow()
    }
  })
})
