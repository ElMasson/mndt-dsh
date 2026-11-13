import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const deploy = join(import.meta.dirname, '..', 'deploy')

/**
 * @param live - the live folder of a workbench.
 * @returns the output of enable-facts-connector.sh, without restarting anything.
 */
function enable(live: string): string {
  return execFileSync('bash', [join(deploy, 'enable-facts-connector.sh'), '/nonexistent.tar.gz', '--no-restart'], {
    env: { ...process.env, MNDT_HOME: live, RENDER_SCRIPT: join(deploy, 'connectors', 'render-connectors.py') },
    encoding: 'utf8',
  })
}

describe('enable-facts-connector.sh', { timeout: 30_000 }, () => {
  it('mounts the facts server through the guarded renderer, over the `[]` dsh wrote, once', () => {
    const live = mkdtempSync(join(tmpdir(), 'facts-'))
    mkdirSync(join(live, 'tools'), { recursive: true })
    writeFileSync(join(live, 'tools', 'facts-mcp.mjs'), '// stand-in\n')
    const patch = join(live, 'home', 'profiles', 'web', 'cordis.patch.yml')
    mkdirSync(join(live, 'home', 'profiles', 'web'), { recursive: true })
    // The profile patch as the workbench writes it at first start.
    writeFileSync(patch, '# Your patch layer for this dsh profile.\n[]\n')
    enable(live)
    const once = readFileSync(patch, 'utf8')
    const rows = load(once) as { insert?: { id: string; config: { serverName: string } }[] }[]
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.flatMap(row => row.insert ?? []).map(row => row.config.serverName)).toEqual(['workbench_facts'])
    enable(live)
    expect(readFileSync(patch, 'utf8')).toBe(once) // a rerun changes nothing
    const descriptor = JSON.parse(readFileSync(join(live, 'connectors', 'workbench_facts.json'), 'utf8')) as { command: string[] }
    expect(descriptor.command).toEqual(['node', '/opt/mndt-tools/facts-mcp.mjs'])
  })
})
