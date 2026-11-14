import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const deploy = join(import.meta.dirname, '..', 'deploy')
const owner = 'duke@datanalysis.re'

/**
 * A tenant as step 13 leaves it: rendered, approvals already mounted (no restart of ours).
 * @returns its root.
 */
function updatedTenant(): string {
  const root = mkdtempSync(join(tmpdir(), 'tenant-'))
  mkdirSync(join(root, 'root'), { recursive: true })
  writeFileSync(join(root, 'root', 'secret'), 'entra-secret')
  execFileSync('bash', [join(deploy, 'create-tenant.sh'), 'datanalysis', 'equipe.datanalysis.re', '--owner', owner,
    '--client-id', 'app-1234', '--client-secret-file', '/root/secret', '--no-docker'], { env: { ...process.env, MNDT_ROOT: root } })
  writeFileSync(join(root, 'data/mndt/datanalysis/live/connectors/approvals.json'), '{"serverName":"approvals"}\n')
  return root
}

/**
 * A `docker` whose API health probe is refused `refusals` times (ECONNREFUSED right after up -d),
 * and which records the seed when it runs.
 * @returns the PATH to use and the folder where calls are recorded.
 */
function fakeDocker(refusals: number): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'docker-'))
  writeFileSync(join(dir, 'docker'), `#!/bin/sh
case "$*" in
  *"8795/health"*)
    n=$(cat "${dir}/probes" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${dir}/probes"
    [ "$n" -gt ${refusals} ] || { echo "TypeError: fetch failed ECONNREFUSED" >&2; exit 1; } ;;
  *"--input-type=module"*) cat > /dev/null; echo seeded > "${dir}/seeded" ;;
esac
exit 0
`)
  chmodSync(join(dir, 'docker'), 0o755)
  return { path: `${dir}:${process.env.PATH ?? ''}`, dir }
}

describe('seed-team.sh waits for the API', { timeout: 60_000 }, () => {
  it('right after up -d, retries a refused API until it answers, then seeds', () => {
    const root = updatedTenant()
    const docker = fakeDocker(2)
    const output = execFileSync('bash', [join(deploy, 'tenant', 'seed-team.sh'), 'datanalysis', '--owner', owner],
      { env: { ...process.env, MNDT_ROOT: root, PATH: docker.path }, encoding: 'utf8' })
    expect(readFileSync(join(docker.dir, 'probes'), 'utf8').trim()).toBe('3')
    expect(output).toContain('the workbench API answers')
    expect(existsSync(join(docker.dir, 'seeded'))).toBe(true)
  })

  it('stops at the deadline with a message that says where to look, and never seeds', () => {
    const root = updatedTenant()
    const docker = fakeDocker(1000)
    let message = ''
    try {
      execFileSync('bash', [join(deploy, 'tenant', 'seed-team.sh'), 'datanalysis', '--owner', owner],
        { env: { ...process.env, MNDT_ROOT: root, PATH: docker.path, MNDT_API_WAIT_SECONDS: '4' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      message = String((error as { stderr?: string }).stderr)
    }
    expect(message).toContain('the workbench API did not answer within 4 s')
    expect(message).toContain('logs workbench')
    expect(existsSync(join(docker.dir, 'seeded'))).toBe(false)
  })
})
