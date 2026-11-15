import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const renderer = join(import.meta.dirname, '..', 'deploy', 'connectors', 'render-connectors.py')

/** @param serverName - the name a descriptor declares. @returns the renderer's exit code and error output. */
function render(serverName: string): { status: number | null; stderr: string } {
  const home = mkdtempSync(join(tmpdir(), 'server-names-'))
  mkdirSync(join(home, 'connectors'), { recursive: true })
  mkdirSync(join(home, 'home', 'profiles', 'web'), { recursive: true })
  writeFileSync(join(home, 'home', 'profiles', 'web', 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(home, 'connectors', 'server.json'), JSON.stringify({ serverName, command: ['node', '/opt/mndt-tools/x.mjs'] }))
  const run = spawnSync('python3', [renderer], { env: { ...process.env, MNDT_HOME: home }, encoding: 'utf8' })
  return { status: run.status, stderr: run.stderr }
}

describe('server names', { timeout: 30_000 }, () => {
  it('refuses a name the tool names could not be split back into', () => {
    for (const name of ['approvals__x', 'qonto_']) {
      const { status, stderr } = render(name)
      expect(status, name).not.toBe(0)
      expect(stderr, name).toContain('without `__` nor a final `_`')
    }
  })

  it('accepts a single underscore inside', () => {
    expect(render('workbench_facts').status).toBe(0)
  })
})
