/**
 * deploy/lib/install-file.sh: the one rule for every file a tenant script puts
 * where a container reads it (the tools folder, the gateway's code and its
 * connector machinery): written beside, renamed over, never rewritten in place.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const deploy = join(import.meta.dirname, '..', 'deploy')
const LIB = join(deploy, 'lib', 'install-file.sh')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) { chmodSync(dir, 0o755); rmSync(dir, { recursive: true, force: true }) } })

/** @param args - install_file's arguments. @returns its exit and stderr. */
function installFile(...args: string[]): { status: number | null; stderr: string } {
  const run = spawnSync('bash', ['-c', `. ${JSON.stringify(LIB)}; install_file "$@"`, 'install_file', ...args], { encoding: 'utf8' })
  return { status: run.status, stderr: run.stderr }
}

describe('install_file', () => {
  it('renames a new file over the old one: new inode, mode 0644 (or the one asked), no .tmp left', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mndt-install-'))
    dirs.push(dir)
    const src = join(dir, 'src.mjs')
    const dst = join(dir, 'dst.mjs')
    writeFileSync(src, 'new\n')
    writeFileSync(dst, 'old\n')
    chmodSync(dst, 0o600)
    const before = statSync(dst).ino
    expect(installFile(src, dst).status).toBe(0)
    expect(readFileSync(dst, 'utf8')).toBe('new\n')
    expect(statSync(dst).ino).not.toBe(before)
    expect(statSync(dst).mode & 0o777).toBe(0o644)
    expect(statSync(dst).uid).toBe(process.getuid?.())
    expect(installFile(src, dst, '0640').status).toBe(0)
    expect(statSync(dst).mode & 0o777).toBe(0o640)
    expect(readdirSync(dir).filter(name => name.includes('.tmp'))).toEqual([])
  })

  it('a destination it cannot write: exit 1, said, the old file whole, no .tmp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mndt-install-'))
    dirs.push(dir)
    const src = join(dir, 'src.mjs')
    const dst = join(dir, 'dst.mjs')
    writeFileSync(src, 'new\n')
    writeFileSync(dst, 'old\n')
    chmodSync(dir, 0o555)
    const run = installFile(src, dst)
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(`could not install ${dst}: left as it was`)
    expect(readFileSync(dst, 'utf8')).toBe('old\n')
    expect(readdirSync(dir).filter(name => name.includes('.tmp'))).toEqual([])
  })

  it('a missing source: exit 1, the old file whole', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mndt-install-'))
    dirs.push(dir)
    const dst = join(dir, 'dst.mjs')
    writeFileSync(dst, 'old\n')
    expect(installFile(join(dir, 'absent.mjs'), dst).status).toBe(1)
    expect(readFileSync(dst, 'utf8')).toBe('old\n')
    expect(readdirSync(dir).filter(name => name.includes('.tmp'))).toEqual([])
  })
})

describe('the tenant scripts keep the rule', () => {
  it('no plain cp into the tools folder nor beside the gateway, in create-tenant, install-connectors and seed-team', () => {
    const offending: string[] = []
    for (const script of ['create-tenant.sh', 'tenant/install-connectors.sh', 'tenant/seed-team.sh']) {
      // grep exits 1 when a script holds no cp at all: that is the goal, not an error.
      const lines = spawnSync('grep', ['-nE', '(^|[;&|( ]|then |do )cp ', join(deploy, script)], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
        .filter(line => !line.includes('#'))
      // The gateway's folder ($app/gateway) and the tools folder ($tools, $data/tools) are mounted in containers.
      for (const line of lines) if (/\$app\/gateway|\$root\$app\/gateway|\$tools\/\$tool|\$tools\/(approvals|mcp-|office365|facts)|\$data\/tools/.test(line)) offending.push(`${script}: ${line}`)
    }
    expect(offending).toEqual([])
  })
})
