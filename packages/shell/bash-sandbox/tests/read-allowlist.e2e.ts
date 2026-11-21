import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { launcherPath } from '@deepseek-ai/node-addon-system/landlock-run'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { ShellExecRequest } from '@deepseek-ai/dsh-shell'

/**
 * The read allow-list of a team tenant (DSH_SANDBOX_READ_ROOTS) through the REAL
 * executor path, in ONE process and ONE provider: the SandboxBashExecutor
 * resolves each call, sandbox-local confines it, the landlock-run launcher
 * filters the final environment. Two sessions (two channel turns, or the owner's
 * session and a turn) and a call without a session (a workflow script) must not
 * read each other's private temp, and a credential a caller adds to a command's
 * environment (spec.env) must not reach it.
 */
const probe = spawnSync(launcherPath(), ['--probe'], { timeout: 5_000, encoding: 'utf8' })
const landlockUsable = probe.status === 0
// The launcher must speak the environment allow-list (a launcher built before it refuses the flag).
const filters = spawnSync(launcherPath(), ['--ro', '/', '--keep-env', 'PATH', '--', 'true'], { timeout: 5_000 }).status === 0

let ctx: Context | undefined
const tempDirs: string[] = []
const previous = process.env.DSH_SANDBOX_READ_ROOTS

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (previous === undefined) delete process.env.DSH_SANDBOX_READ_ROOTS
  else process.env.DSH_SANDBOX_READ_ROOTS = previous
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

// In the rehearsal (inside the image) a skip would prove nothing: DSH_REQUIRE_LANDLOCK=1
// turns it into a failure.
const required = process.env.DSH_REQUIRE_LANDLOCK === '1'
describe.runIf(required && !(landlockUsable && filters))('bash-sandbox: the read allow-list is required here', () => {
  it('has a Landlock kernel and a launcher that filters the environment', () => {
    expect({ landlockUsable, filters, probe: probe.stdout?.trim() })
      .toEqual({ landlockUsable: true, filters: true, probe: expect.any(String) })
  })
})

describe.skipIf(!landlockUsable || !filters)('bash-sandbox: the read allow-list through the real executor', () => {
  it('runs the launcher of this build: an unknown flag refused, the environment flags accepted', () => {
    expect(spawnSync(launcherPath(), ['--bogus', '--', 'true'], { encoding: 'utf8' }).status).toBe(125)
    expect(spawnSync(launcherPath(), ['--ro', '/', '--keep-env', 'PATH', '--keep-env-prefix', 'LC_', '--set-env', 'A=1', '--', 'true']).status).toBe(0)
  })

  it('keeps sessions and workflow calls apart, and a caller-added credential out of the command', async () => {
    process.env.DSH_SANDBOX_READ_ROOTS = '/usr:/lib:/lib64:/bin:/sbin:/etc:/dev/null:/dev/urandom'
    const workspace = await mkdtemp(join(homedir(), 'dsh-allowlist-e2e-'))
    tempDirs.push(workspace)
    ctx = new Context()
    await ctx.plugin(LocalSandboxProvider, {})
    ;(ctx.sandbox as LocalSandboxProvider).internals = { probeBwrap: () => false }
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SandboxBashExecutor, { cwd: workspace, timeoutMs: 30_000 })
    const bash = ctx.shell as SandboxBashExecutor
    // The private directories that exist before this provider made any: not counted.
    const before = new Set(readdirSync(tmpdir()).filter(name => name.startsWith('dsh-run-')))
    const run = async (command: string, sessionId?: string, env?: Record<string, string>) => {
      const request: ShellExecRequest = {
        command,
        ...(env === undefined ? {} : { env }),
        sandboxPolicy: { mode: 'workspace-write', workspaceRoot: workspace, ...(sessionId === undefined ? {} : { sessionId: sessionId as never }) },
      } as ShellExecRequest
      return (await bash.execute(bash.resolve(request))).result()
    }

    // A caller-added credential (spec.env) under an ordinary name, and the environment as a whole.
    const turnA = await run('echo "cred=${X_CRED:-absent} preload=${LD_PRELOAD:-absent} bashenv=${BASH_ENV:-absent} nodepath=${NODE_PATH:-absent}"; env | cut -d= -f1 | sort | tr "\\n" " "; echo; echo canary-a > "$TMPDIR/note"; printf "dir=%s" "$TMPDIR"',
      'turn-channel-a', { X_CRED: 'CANARY_SECRET_spec_env', LD_PRELOAD: '/tmp/evil.so', BASH_ENV: '/tmp/evil.sh', NODE_PATH: '/tmp/evil', NO_COLOR: '1' })
    expect(turnA.exitCode, turnA.stderr.text).toBe(0)
    expect(turnA.stdout.text).toContain('cred=absent preload=absent bashenv=absent nodepath=absent')
    expect(turnA.stdout.text).not.toContain('CANARY_SECRET_spec_env')
    const names = turnA.stdout.text.split('\n')[1]?.trim().split(' ') ?? []
    // Printed for the rehearsal: the names a confined command really sees.
    console.log(`ENV-NAMES ${names.join(' ')}`)
    // A kept prefix (DSH_) must never bring a credential-shaped name.
    for (const name of names) expect(name, name).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD/i)
    for (const name of names) expect(['GIT_PAGER', 'HOME', 'NODE_VERSION', 'NODE_OPTIONS', 'NO_COLOR', 'PAGER', 'PATH', 'PWD', 'SHLVL', '_', 'TEMP', 'TERM', 'TMP', 'TMPDIR', 'LANG', 'LANGUAGE', 'TZ', 'USER', 'LOGNAME', 'SHELL'].includes(name) || /^(LC_|DSH_)/.test(name), name).toBe(true)
    const dirA = /dir=(\S+)/.exec(turnA.stdout.text)?.[1] ?? ''
    expect(existsSync(join(dirA, 'note'))).toBe(true)

    // Another channel's turn, the owner's session, and a workflow script read nothing of it.
    for (const sessionId of ['turn-channel-b', 'owner-dsh-session', undefined]) {
      const peek = await run(`cat "${dirA}/note" && echo READ-NOTE; ls "${dirA}" && echo LISTED; printf "dir=%s" "$TMPDIR"`, sessionId)
      expect(peek.stdout.text, String(sessionId)).not.toContain('canary-a')
      expect(peek.stdout.text, String(sessionId)).not.toMatch(/READ-NOTE|LISTED/)
      expect(/dir=(\S+)/.exec(peek.stdout.text)?.[1], String(sessionId)).not.toBe(dirA)
    }
    // Two workflow calls never share a directory.
    const first = await run('printf "dir=%s" "$TMPDIR"')
    const second = await run('printf "dir=%s" "$TMPDIR"')
    expect(/dir=(\S+)/.exec(first.stdout.text)?.[1]).not.toBe(/dir=(\S+)/.exec(second.stdout.text)?.[1])
    // Calls without a session in a loop: their directories stay bounded.
    for (let call = 0; call < 40; call++) await run('true')
    const runs = readdirSync(tmpdir()).filter(name => name.startsWith('dsh-run-') && !before.has(name)).length
    console.log(`DSH-RUN-DIRS ${runs} after 42 calls without a session and 4 sessions`)
    expect(runs).toBeLessThanOrEqual(32 + 4)
  })
})
