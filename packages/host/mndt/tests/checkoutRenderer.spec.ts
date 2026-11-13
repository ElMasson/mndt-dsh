import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const deploy = join(import.meta.dirname, '..', 'deploy')
const owner = 'duke@datanalysis.re'

/** A renderer as an instance installed before the guard: it leaves a trace and appends after `[]`. */
const STALE = `import os
home = os.environ.get('MNDT_HOME', '/data/mndt/live')
open(os.path.join(home, 'STALE-RENDERER-RAN'), 'w').write('yes')
with open(os.path.join(home, 'home/profiles/web/cordis.patch.yml'), 'a') as f:
    f.write('- insert:\\n    - id: mcp-stale\\n      name: "@deepseek-ai/dsh-mcp-client"\\n')
`

/** @returns a PATH whose `docker` answers every call with success, as a running stack would. */
function fakeDocker(): string {
  const bin = mkdtempSync(join(tmpdir(), 'docker-'))
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(bin, 'docker'), 0o755)
  return `${bin}:${process.env.PATH ?? ''}`
}

describe('the checkout renderer, never a stale installed copy', { timeout: 60_000 }, () => {
  it('seed-team.sh refreshes the installed renderer before it mounts approvals', () => {
    const root = mkdtempSync(join(tmpdir(), 'tenant-'))
    mkdirSync(join(root, 'root'), { recursive: true })
    writeFileSync(join(root, 'root', 'secret'), 'entra-secret')
    const env = { ...process.env, MNDT_ROOT: root }
    execFileSync('bash', [join(deploy, 'create-tenant.sh'), 'datanalysis', 'equipe.datanalysis.re', '--owner', owner,
      '--client-id', 'app-1234', '--client-secret-file', '/root/secret', '--no-docker'], { env })
    const live = join(root, 'data/mndt/datanalysis/live')
    const patch = join(live, 'home/profiles/web/cordis.patch.yml')
    // The instance of 13/11: the workbench wrote `[]`, the installed renderer predates the guard.
    mkdirSync(join(live, 'home/profiles/web'), { recursive: true })
    writeFileSync(patch, '# Your patch layer for this dsh profile.\n[]\n')
    const installed = join(root, 'opt/mndt/datanalysis/gateway/render-connectors.py')
    writeFileSync(installed, STALE)
    execFileSync('bash', [join(deploy, 'tenant', 'seed-team.sh'), 'datanalysis', '--owner', owner], { env: { ...env, PATH: fakeDocker() } })
    expect(existsSync(join(live, 'STALE-RENDERER-RAN'))).toBe(false)
    expect(readFileSync(installed, 'utf8')).toBe(readFileSync(join(deploy, 'connectors', 'render-connectors.py'), 'utf8'))
    const rows = load(readFileSync(patch, 'utf8')) as { insert?: { id: string }[] }[]
    expect(rows.flatMap(row => row.insert ?? []).map(row => row.id)).toEqual(['mcp-approvals'])
  })

  it('mount-connector.sh, without RENDER_SCRIPT, renders with the checkout it belongs to', () => {
    const live = mkdtempSync(join(tmpdir(), 'live-'))
    mkdirSync(join(live, 'connectors'), { recursive: true })
    mkdirSync(join(live, 'home/profiles/web'), { recursive: true })
    writeFileSync(join(live, 'home/profiles/web/cordis.patch.yml'), '# dsh\n[]\n')
    const env: Record<string, string | undefined> = { ...process.env, MNDT_HOME: live }
    delete env.RENDER_SCRIPT
    execFileSync('bash', [join(deploy, 'mount-connector.sh'), 'facts', 'node', '/opt/mndt-tools/facts-mcp.mjs', '--no-restart'], { env })
    const rows = load(readFileSync(join(live, 'home/profiles/web/cordis.patch.yml'), 'utf8')) as { insert?: { id: string }[] }[]
    expect(rows.flatMap(row => row.insert ?? []).map(row => row.id)).toEqual(['mcp-facts'])
  })
})
