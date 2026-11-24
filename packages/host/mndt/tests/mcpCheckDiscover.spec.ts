/**
 * The read-only probe of the newer protocol (`mcp-check.mjs --discover`, and
 * `check-connectors.sh --discover`), to run on an instance after each update:
 * a connector that leaves server/discover unanswered makes the engine wait 60 s
 * at every start before loading its tools. The check fails past 2 s, and never
 * waits longer itself.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const deploy = join(import.meta.dirname, '..', 'deploy')
const CHECK = join(deploy, 'connectors', 'mcp-check.mjs')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** @param answersProbe - whether the fake server answers server/discover. @returns its path. */
function fakeServer(answersProbe: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'mndt-check-'))
  dirs.push(dir)
  const path = join(dir, 'server.mjs')
  writeFileSync(path, [
    "import { createInterface } from 'node:readline'",
    "const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')",
    "createInterface({ input: process.stdin }).on('line', (line) => {",
    '  const m = JSON.parse(line)',
    "  if (m.method === 'initialize') out({ id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } })",
    "  else if (m.method === 'tools/list') out({ id: m.id, result: { tools: [{ name: 'list_things', inputSchema: { type: 'object' } }] } })",
    `  else if (m.method === 'server/discover' && ${String(answersProbe)}) out({ id: m.id, error: { code: -32601, message: 'method not found' } })`,
    '})',
  ].join('\n'))
  return path
}

/** @param args - mcp-check's arguments. @returns its exit, output and duration. */
function check(args: string[]): { status: number | null; out: string; ms: number } {
  const started = Date.now()
  const run = spawnSync(process.execPath, [CHECK, ...args], { encoding: 'utf8', timeout: 30_000 })
  return { status: run.status, out: run.stdout, ms: Date.now() - started }
}

describe('mcp-check --discover', () => {
  it('a connector that answers the probe: ok, with its answer time', () => {
    const run = check(['--discover', '--', process.execPath, fakeServer(true)])
    expect(run.status).toBe(0)
    expect(run.out).toMatch(/sonde server\/discover : ok, reponse en \d+ ms \(erreur -32601\)/)
    expect(run.out).toContain('outils visibles (1) : list_things')
  })

  it('a connector that leaves it unanswered: fails, said, after 2 s at most, the rest still checked', () => {
    const run = check(['--discover', '--', process.execPath, fakeServer(false)])
    expect(run.status).toBe(1)
    expect(run.out).toContain('sonde server/discover : ECHEC, pas de reponse en 2 s')
    expect(run.out).toContain('outils visibles (1) : list_things')
    expect(run.ms).toBeLessThan(10_000)
  })

  it('without --discover, nothing changes: no probe, the same connector passes', () => {
    const run = check(['--', process.execPath, fakeServer(false)])
    expect(run.status).toBe(0)
    expect(run.out).not.toContain('server/discover')
  })
})

describe('mcp-check --discover never prints the connector\'s stderr', () => {
  it('initialize failing: a fixed line, not the server\'s last words (they can carry a secret); without --discover they stay shown', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mndt-check-'))
    dirs.push(dir)
    const path = join(dir, 'failing.mjs')
    writeFileSync(path, [
      "import { createInterface } from 'node:readline'",
      "process.stderr.write('token=SECRET-42 refused\\n')",
      "createInterface({ input: process.stdin }).on('line', (line) => {",
      '  const m = JSON.parse(line)',
      "  if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'auth failed' } }) + '\\n')",
      '})',
    ].join('\n'))
    const probed = check(['--discover', '--', process.execPath, path])
    expect(probed.status).toBe(1)
    expect(probed.out).toContain('echec : initialize a echoue, voir le journal du workbench')
    expect(probed.out).not.toContain('SECRET-42')
    const plain = check(['--', process.execPath, path])
    expect(plain.out).toContain('SECRET-42')
  })
})

describe('check-connectors.sh --discover', () => {
  it('sends the probe and the tool list only: no refused call, no actor file, no live read', () => {
    const root = mkdtempSync(join(tmpdir(), 'mndt-tenant-'))
    dirs.push(root)
    const app = join(root, 'opt', 'mndt', 'acme')
    const data = join(root, 'data', 'mndt', 'acme', 'live')
    mkdirSync(join(app, 'gateway'), { recursive: true })
    mkdirSync(join(data, 'connectors'), { recursive: true })
    writeFileSync(join(app, 'docker-compose.yml'), 'services:\n  workbench:\n    environment:\n      DSH_MNDT_IDENTITY: duke@datanalysis.re\n')
    copyFileSync(join(deploy, 'connectors', 'render-connectors.py'), join(app, 'gateway', 'render-connectors.py'))
    copyFileSync(join(deploy, 'patchfile.py'), join(app, 'gateway', 'patchfile.py'))
    const server = fakeServer(true)
    for (const name of ['office365', 'qonto', 'approvals']) {
      writeFileSync(join(data, 'connectors', `${name}.json`), JSON.stringify({ serverName: name, command: [process.execPath, server] }))
    }
    const argsLog = join(root, 'args.log')
    const shim = join(root, 'exec-shim.sh')
    writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${argsLog}\nargs=()\nfor a in "$@"; do [ "$a" = /opt/mndt-tools/mcp-check.mjs ] && a=${CHECK}; args+=("$a"); done\nexec "\${args[@]}"\n`)
    chmodSync(shim, 0o755)
    const run = spawnSync('bash', [join(deploy, 'tenant', 'check-connectors.sh'), 'acme', '--live', '--discover'], {
      encoding: 'utf8', timeout: 30_000, env: { ...process.env, MNDT_ROOT: root, MNDT_CHECK_EXEC: shim },
    })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('all checks passed')
    const calls = readFileSync(argsLog, 'utf8').trim().split('\n')
    expect(calls).toHaveLength(3)
    for (const line of calls) {
      expect(line).toContain('--discover')
      expect(line).not.toMatch(/--refuse|--actor|--call/)
    }
    expect(existsSync('/tmp/mcp-check-actor.json') && statSync('/tmp/mcp-check-actor.json').mtimeMs > Date.now() - 30_000).toBe(false)
  })

  it('passes --discover to the check of every mounted connector', () => {
    const root = mkdtempSync(join(tmpdir(), 'mndt-tenant-'))
    dirs.push(root)
    const app = join(root, 'opt', 'mndt', 'acme')
    const data = join(root, 'data', 'mndt', 'acme', 'live')
    mkdirSync(join(app, 'gateway'), { recursive: true })
    mkdirSync(join(data, 'connectors'), { recursive: true })
    writeFileSync(join(app, 'docker-compose.yml'), 'services:\n  workbench:\n    environment:\n      DSH_MNDT_IDENTITY: duke@datanalysis.re\n')
    copyFileSync(join(deploy, 'connectors', 'render-connectors.py'), join(app, 'gateway', 'render-connectors.py'))
    copyFileSync(join(deploy, 'patchfile.py'), join(app, 'gateway', 'patchfile.py'))
    const server = fakeServer(false)
    writeFileSync(join(data, 'connectors', 'fake.json'), JSON.stringify({ serverName: 'fake', command: [process.execPath, server] }))
    // The exec prefix stands in for « docker compose exec »: the check installed
    // at /opt/mndt-tools inside the container is this repository's one here.
    const shim = join(root, 'exec-shim.sh')
    writeFileSync(shim, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [ "$a" = /opt/mndt-tools/mcp-check.mjs ] && a=${CHECK}; args+=("$a"); done\nexec "\${args[@]}"\n`)
    chmodSync(shim, 0o755)
    const run = spawnSync('bash', [join(deploy, 'tenant', 'check-connectors.sh'), 'acme', '--discover'], {
      encoding: 'utf8', timeout: 30_000, env: { ...process.env, MNDT_ROOT: root, MNDT_CHECK_EXEC: shim },
    })
    expect(run.stdout).toContain('== fake')
    expect(run.stdout).toContain('sonde server/discover : ECHEC')
    expect(run.stdout).toContain('some checks failed')
    expect(run.status).toBe(1)
  })
})

describe('mcp-check refuses --discover mixed with a call or a write', () => {
  it.each([
    [['--refuse', 'send_mail'], '--refuse'],
    [['--call', 'get_status'], '--call'],
    [['--actor', 'duke@datanalysis.re', '--actor-file', 'ACTOR'], '--actor, --actor-file'],
  ])('with %j: exit 2, said, the connector never started and no file written', (extra, named) => {
    const dir = mkdtempSync(join(tmpdir(), 'mndt-mixed-'))
    dirs.push(dir)
    const started = join(dir, 'started')
    const server = join(dir, 'server.mjs')
    writeFileSync(server, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(started)}, 'x')\n`)
    const actorFile = join(dir, 'actor.json')
    const args = (extra as string[]).map(a => (a === 'ACTOR' ? actorFile : a))
    const run = spawnSync(process.execPath, [CHECK, '--discover', ...args, '--', process.execPath, server], { encoding: 'utf8', timeout: 30_000 })
    expect(run.status).toBe(2)
    expect(run.stderr).toContain(`--discover runs alone, without ${named}: nothing was sent`)
    expect(existsSync(started)).toBe(false)
    expect(existsSync(actorFile)).toBe(false)
  })

  it('the same options without --discover still work as before', () => {
    // The fake server does not answer tools/call: the check's own timeout ends it (1 s here).
    const run = spawnSync(process.execPath, [CHECK, '--refuse', 'send_mail', '--', process.execPath, fakeServer(true)], {
      encoding: 'utf8', timeout: 30_000, env: { ...process.env, MCP_CHECK_TIMEOUT_MS: '1000' },
    })
    expect(run.status).toBe(1)
    expect(run.stderr).not.toContain('--discover runs alone')
    expect(run.stdout).toContain('outils visibles (1) : list_things')
  })
})
