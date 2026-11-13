/**
 * install-connectors.sh puts the connectors of a tenant in place and mounts
 * them from the versioned catalog. It runs on the server, so it is tested here
 * in a temporary root rendered by create-tenant.sh, without docker: every
 * catalog connector must end up behind the read-only proxy with the catalog's
 * allow and deny lists, at the tenant's paths, with the copied code and nothing
 * else, and a connector without its secrets must wait instead of being mounted.
 * The check helper (mcp-check.mjs) and the agents' connector top-up are run
 * against a stub server and a real API.
 */
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import yaml from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import { startMndtApi } from '../src/api.ts'

const deploy = join(import.meta.dirname, '..', 'deploy')
const install = join(deploy, 'tenant', 'install-connectors.sh')
const live = (root: string): string => join(root, 'data/mndt/datanalysis/live')
const mode = (path: string): string => (statSync(path).mode & 0o777).toString(8)

/** @returns a root with a rendered tenant and two fake sources, nothing secret yet. */
function tenant(): { root: string; dolibarr: string; swing: string } {
  const root = mkdtempSync(join(tmpdir(), 'connectors-'))
  mkdirSync(join(root, 'etc', 'oauth2-proxy'), { recursive: true })
  writeFileSync(join(root, 'etc', 'oauth2-proxy', 'governance.cfg'), 'client_id = "app-1234"\n')
  writeFileSync(join(root, 'etc', 'oauth2-proxy', 'client_secret'), 'entra-secret')
  execFileSync('bash', [join(deploy, 'create-tenant.sh'), 'datanalysis', 'equipe.datanalysis.re', '--owner', 'duke@datanalysis.re', '--no-docker'],
    { env: { ...process.env, MNDT_ROOT: root } })
  // The sources as they arrive on the server: a Dolibarr checkout holding a
  // .env and a cache that must not travel, and a Swing checkout.
  const dolibarr = mkdtempSync(join(tmpdir(), 'dolibarr-src-'))
  mkdirSync(join(dolibarr, 'src', 'dolibarr_mcp', '__pycache__'), { recursive: true })
  writeFileSync(join(dolibarr, 'src', 'dolibarr_mcp', 'dolibarr_mcp_server.py'), 'print("server")\n')
  writeFileSync(join(dolibarr, 'src', 'dolibarr_mcp', '__init__.py'), '')
  writeFileSync(join(dolibarr, 'src', 'dolibarr_mcp', '.env'), 'DOLIBARR_API_KEY=leak\n')
  writeFileSync(join(dolibarr, 'src', 'dolibarr_mcp', '__pycache__', 'x.pyc'), 'x')
  const swing = mkdtempSync(join(tmpdir(), 'swing-src-'))
  mkdirSync(join(swing, 'mcp', 'clients'), { recursive: true })
  writeFileSync(join(swing, 'mcp', 'swing_mcp.py'), 'print("swing")\n')
  writeFileSync(join(swing, 'mcp', '__init__.py'), '')
  writeFileSync(join(swing, 'mcp', 'clients', 'qonto.py'), 'unused = 1\n')
  writeFileSync(join(swing, '.env'), 'SWING_PASSWORD=leak\n')
  return { root, dolibarr, swing }
}

/** Write the operator's secret files with dummy values, and the Qonto OAuth cache. */
function secrets(root: string): void {
  const connectors = join(live(root), 'connectors')
  writeFileSync(join(connectors, 'office365.env'), 'OFFICE365_TENANT_ID=t\nOFFICE365_CLIENT_ID=c\nOFFICE365_CLIENT_SECRET=s\n')
  writeFileSync(join(connectors, 'dolibarr.env'), 'DOLIBARR_URL=https://erp.example/api/index.php\nDOLIBARR_API_KEY=k\n')
  writeFileSync(join(connectors, 'swing.env'), 'SWING_API_URL=https://swing.example\nSWING_USERNAME=u@datanalysis.re\nSWING_PASSWORD=p\n')
  const version = (JSON.parse(readFileSync(join(deploy, 'connectors', 'runtime', 'qonto.package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies['mcp-remote']
  const hash = createHash('md5').update('https://mcp.qonto.com/mcp').digest('hex')
  mkdirSync(join(live(root), 'mcp-auth', `mcp-remote-${version}`), { recursive: true })
  writeFileSync(join(live(root), 'mcp-auth', `mcp-remote-${version}`, `${hash}_tokens.json`), '{"access_token":"a"}')
}

function run(root: string, dolibarr: string, swing: string): string {
  return execFileSync('bash', [install, 'datanalysis', '--dolibarr-src', dolibarr, '--swing-src', swing, '--no-docker'],
    { env: { ...process.env, MNDT_ROOT: root }, encoding: 'utf8' })
}

interface Row { readonly insert?: readonly { id: string; config: { serverName: string; command: string; args: string[] } }[] }

/** @returns the generated rows of the tenant's composition, by server name. */
function rows(root: string): Map<string, string> {
  const text = readFileSync(join(live(root), 'home/profiles/web/cordis.patch.yml'), 'utf8')
  const parsed = (yaml.load(text) as Row[] | null) ?? []
  return new Map(parsed.flatMap(row => row.insert ?? []).map(row => [row.config.serverName, row.config.args[1]!]))
}

describe('install-connectors.sh', { timeout: 30_000 }, () => {
  it('mounts the five connectors behind the proxy, with the expected allow and deny lists', () => {
    const { root, dolibarr, swing } = tenant()
    secrets(root)
    const out = run(root, dolibarr, swing)
    expect(out).toContain('connecteurs actifs: 5')
    const mounted = rows(root)
    expect([...mounted.keys()].sort()).toEqual(['approvals', 'dolibarr', 'office365', 'qonto', 'swing'])
    const expected: Record<string, [string, string]> = {
      approvals: ['request_approval,list_pending_approvals,read_approval', 'decide_approval'],
      office365: ['mail_recent,mail_search,calendar_upcoming', ''],
      qonto: ['list_*,get_*', 'get_attachment,get_statement,list_statements,list_transaction_attachments'],
      dolibarr: ['get_*,search_*,list_*', 'dolibarr_raw_api'],
      swing: ['list_*,get_*,search_*', 'get_rehydration_prompt'],
    }
    for (const [server, [allow, deny]] of Object.entries(expected)) {
      const script = mounted.get(server)!
      // The env file first, then the lists: a secret file cannot widen them.
      expect(script.indexOf(`. /state/connectors/${server}.env`)).toBeGreaterThan(0)
      expect(script.indexOf(`export MCP_PROXY_ALLOW=${allow.includes('*') ? `'${allow}'` : allow};`)).toBeGreaterThan(script.indexOf('set +a'))
      expect(script).toContain(`export MCP_PROXY_DENY=${deny === '' ? "''" : deny};`)
      expect(script).toContain('exec node /opt/mndt-tools/mcp-proxy.mjs ')
    }
    // Each server runs from the tenant's tools folder, nothing fetched at start.
    expect(mounted.get('qonto')).toContain('exec node /opt/mndt-tools/mcp-proxy.mjs node /opt/mndt-tools/qonto/node_modules/mcp-remote/dist/proxy.js https://mcp.qonto.com/mcp')
    expect(mounted.get('qonto')).toContain('export MCP_REMOTE_CONFIG_DIR=/state/mcp-auth;')
    expect(mounted.get('qonto')).not.toContain('npx')
    expect(mounted.get('dolibarr')).toContain('export PYTHONPATH=/opt/mndt-tools/dolibarr-mcp/src:/opt/mndt-tools/dolibarr-mcp/site;')
    expect(mounted.get('dolibarr')).toContain('cd /opt/mndt-tools/dolibarr-mcp; ')
    expect(mounted.get('dolibarr')).toContain('python3 -m dolibarr_mcp.dolibarr_mcp_server')
    expect(mounted.get('swing')).toContain('export PYTHONPATH=/opt/mndt-tools/swing/src:/opt/mndt-tools/swing/site;')
    expect(mounted.get('swing')).toContain('python3 -m mcp.swing_mcp')
    expect(mounted.get('office365')).toContain('export OFFICE365_MODE=application;')
    expect(mounted.get('office365')).toContain('export OFFICE365_ALLOWED_DOMAINS=datanalysis.re;')
    expect(mounted.get('approvals')).toContain('export MNDT_APPROVALS_ALLOW_DECIDE=0;')
  })

  it('copies the code and the pinned manifests, never a secret nor a cache', () => {
    const { root, dolibarr, swing } = tenant()
    secrets(root)
    run(root, dolibarr, swing)
    const tools = join(live(root), 'tools')
    expect(readdirSync(join(tools, 'dolibarr-mcp/src/dolibarr_mcp')).sort()).toEqual(['__init__.py', 'dolibarr_mcp_server.py'])
    expect(readdirSync(join(tools, 'swing/src/mcp')).sort()).toEqual(['__init__.py', 'swing_mcp.py'])
    expect(readFileSync(join(tools, 'dolibarr-mcp/requirements.txt'), 'utf8')).toMatch(/^mcp==\d/m)
    expect(readFileSync(join(tools, 'swing/requirements.txt'), 'utf8')).toMatch(/^httpx==\d/m)
    const lock = JSON.parse(readFileSync(join(tools, 'qonto/package-lock.json'), 'utf8')) as { packages: Record<string, { version: string } | undefined> }
    expect(lock.packages['node_modules/mcp-remote']?.version).toBe('0.1.29')
    for (const tool of ['mcp-proxy.mjs', 'mcp-check.mjs', 'office365-mcp.mjs', 'approvals-mcp.mjs']) expect(existsSync(join(tools, tool))).toBe(true)
    const leaked = spawnSync('grep', ['-rl', 'leak', tools], { encoding: 'utf8' })
    expect(leaked.status).toBe(1)
    expect(leaked.stdout).toBe('')
  })

  it('leaves a connector without its secrets unmounted, says which names, and mounts it on a rerun', () => {
    const { root, dolibarr, swing } = tenant()
    const first = run(root, dolibarr, swing)
    expect(first).toContain('office365: not mounted, no office365.env')
    expect(first).toContain('qonto: not mounted, no OAuth cache')
    expect(first).toContain('dolibarr: not mounted, no dolibarr.env')
    expect([...rows(root).keys()]).toEqual(['approvals'])
    // A file with an empty value is not a secret in place.
    writeFileSync(join(live(root), 'connectors', 'dolibarr.env'), 'DOLIBARR_URL=https://erp.example\nDOLIBARR_API_KEY=\n')
    const second = run(root, dolibarr, swing)
    expect(second).toContain('dolibarr: not mounted, missing in dolibarr.env: DOLIBARR_API_KEY')
    expect(second).not.toContain('https://erp.example')
    expect(mode(join(live(root), 'connectors', 'dolibarr.env'))).toBe('600')
    secrets(root)
    run(root, dolibarr, swing)
    const third = run(root, dolibarr, swing)
    expect(third).toContain('connecteurs actifs: 5')
    const text = readFileSync(join(live(root), 'home/profiles/web/cordis.patch.yml'), 'utf8')
    expect(text.match(/id: mcp-dolibarr/g)).toHaveLength(1)
    // A rerun without the sources keeps the installed code.
    const kept = execFileSync('bash', [install, 'datanalysis', '--dolibarr-src', '/nonexistent', '--swing-src', '/nonexistent', '--no-docker'],
      { env: { ...process.env, MNDT_ROOT: root }, encoding: 'utf8' })
    expect(kept).toContain('dolibarr: no source in /nonexistent, the installed code is kept')
  })

  it('refuses a tenant that was not created, and a first install without the sources', () => {
    const empty = mkdtempSync(join(tmpdir(), 'connectors-none-'))
    expect(() => execFileSync('bash', [install, 'datanalysis', '--no-docker'], { env: { ...process.env, MNDT_ROOT: empty }, stdio: 'pipe' })).toThrow()
    const { root } = tenant()
    expect(() => execFileSync('bash', [install, 'datanalysis', '--dolibarr-src', '/nonexistent', '--no-docker'], { env: { ...process.env, MNDT_ROOT: root }, stdio: 'pipe' })).toThrow()
  })
})

describe('mcp-check.mjs', { timeout: 30_000 }, () => {
  const stub = `
import { createInterface } from 'node:readline'
const tools = [{ name: 'get_status' }, { name: 'dolibarr_raw_api' }, { name: 'create_invoice' }]
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  const reply = (payload) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...payload }) + '\\n')
  if (m.method === 'initialize') return reply({ result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1' } } })
  if (m.method === 'tools/list') return reply({ result: { tools } })
  if (m.method === 'tools/call') return reply({ result: { content: [{ type: 'text', text: 'SECRET-BUSINESS-DATA' }] } })
})
`
  it('prints the visible tools, the proxy refusal and the size of a real read, never its content', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-check-'))
    writeFileSync(join(directory, 'stub.mjs'), stub)
    const out = execFileSync(process.execPath, [join(deploy, 'connectors', 'mcp-check.mjs'), '--refuse', 'dolibarr_raw_api', '--call', 'get_status', '--',
      process.execPath, join(deploy, 'connectors', 'mcp-proxy.mjs'), process.execPath, join(directory, 'stub.mjs')],
    { env: { ...process.env, MCP_PROXY_ALLOW: 'get_*', MCP_PROXY_DENY: 'dolibarr_raw_api' }, encoding: 'utf8' })
    expect(out).toContain('outils visibles (1) : get_status')
    expect(out).toContain('refus dolibarr_raw_api : ok, refuse par le proxy')
    expect(out).toContain('appel get_status : ok (20 caracteres recus, non affiches)')
    expect(out).not.toContain('SECRET-BUSINESS-DATA')
  })
})

describe('attach-agent-connectors.mjs', { timeout: 30_000 }, () => {
  const owner = 'duke@datanalysis.re'
  const servers: Server[] = []
  afterEach(() => { for (const server of servers.splice(0)) server.close() })

  it('adds the newly mounted connectors to the declared agents, once, removing none', async () => {
    const mounted = ['approvals']
    const service = new WorkbenchService({ store: new MemoryStore() })
    const server = startMndtApi({
      service,
      runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
      identity: { proxyUserHeader: 'x-forwarded-email' },
      grants: { grants: async () => ({ ok: true, grants: [{ subject: owner, role: 'owner' }] }) },
      connectors: async () => mounted.map(name => ({ module: '@deepseek-ai/dsh-mcp-client', server: name, enabled: true })),
      port: 0,
    })
    servers.push(server)
    await new Promise<void>((resolve) => { if (server.listening) resolve(); else server.once('listening', () => { resolve() }) })
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const agentsJson = readFileSync(join(deploy, 'tenant', 'agents.json'), 'utf8')
    const node = (script: string): Promise<string> => new Promise((resolve, reject) => {
      execFile(process.execPath, [script], { env: { ...process.env, MNDT_API_URL: url, MNDT_OWNER: owner, AGENTS_JSON: agentsJson, VLLM_QWEN_MODEL: 'q' } },
        (error, stdout, stderr) => { if (error !== null) reject(new Error(`${error.message}\n${stderr}`)); else resolve(stdout) })
    })
    await node(join(deploy, 'tenant', 'seed-team.mjs'))
    mounted.push('office365', 'qonto', 'dolibarr', 'swing')
    const out = await node(join(deploy, 'connectors', 'attach-agent-connectors.mjs'))
    expect(out).toContain('@assistant: connectors office365, qonto, dolibarr, swing (added office365, qonto, dolibarr, swing)')
    expect(out).toContain('@analyste: connectors qonto, dolibarr (added qonto, dolibarr)')
    expect(out).toContain('@qwen: no connector')
    const again = await node(join(deploy, 'connectors', 'attach-agent-connectors.mjs'))
    expect(again).not.toContain('added')
    const agents = await service.listAgents()
    expect([...agents.find(a => a.handle === 'analyste')!.connectors].sort()).toEqual(['dolibarr', 'qonto'])
  })
})
