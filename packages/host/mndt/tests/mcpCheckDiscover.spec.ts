/**
 * The read-only probe of the newer protocol (`mcp-check.mjs --discover`, and
 * `check-connectors.sh --discover`), to run on an instance after each update:
 * a connector that leaves server/discover unanswered makes the engine wait 60 s
 * at every start before loading its tools. The check fails past 2 s, and never
 * waits longer itself.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

describe('check-connectors.sh --discover', () => {
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
