import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const entrypoint = join(import.meta.dirname, '..', 'deploy', 'workbench-entrypoint.sh')

/**
 * Run the entrypoint with a stand-in `node` that plays `dsh web`.
 * @param web - the shell body of the stand-in (its output goes to web.log).
 * @param warnAfter - seconds before the entrypoint says the token is late.
 * @returns the entrypoint's exit code, its output, and the token file.
 */
async function run(web: string, warnAfter: number): Promise<{ code: number | null; output: string; tokenFile: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'entrypoint-'))
  writeFileSync(join(dir, 'node'), `#!/bin/sh\n${web}\n`)
  chmodSync(join(dir, 'node'), 0o755)
  const tokenFile = join(dir, 'web-token')
  return new Promise((resolve) => {
    const child = spawn('sh', [entrypoint], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        DSH_HOME: join(dir, 'home'),
        DSH_MNDT_WEB_TOKEN_FILE: tokenFile,
        DSH_MNDT_TOKEN_WARN_AFTER: String(warnAfter),
        WEB_HOST: '127.0.0.1',
      },
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.on('close', (code) => { resolve({ code, output, tokenFile }) })
  })
}

describe('workbench-entrypoint.sh', { timeout: 30_000 }, () => {
  it('publishes a launch token printed after the warning delay, and says it was late', async () => {
    // A plugin that holds the start (a connector that does not answer) prints the URL late.
    const { code, output, tokenFile } = await run('sleep 3; echo "dsh web: http://127.0.0.1:8080/?token=late_Token-1"; sleep 2', 1)
    expect(code).toBe(0)
    expect(output).toContain('no launch token after 1 s, still waiting')
    expect(output).toMatch(/launch token published after \d+ s/)
    expect(readFileSync(tokenFile, 'utf8')).toBe('late_Token-1')
  })

  it('stops with the web process when it exits before printing a token, with its log', async () => {
    const { code, output, tokenFile } = await run('echo "boot failed: plugin X"; exit 3', 60)
    expect(code).toBe(3)
    expect(output).toContain('the web process exited before printing its launch token')
    expect(output).toContain('boot failed: plugin X')
    expect(existsSync(tokenFile)).toBe(false)
  })
})
