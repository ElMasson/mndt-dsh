import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const entrypoint = fileURLToPath(new URL('../deploy/workbench-entrypoint.sh', import.meta.url))

/** Runs the entrypoint with a fake `node` that prints a launch URL and exits. @returns the folder. */
function start(previous: string | undefined, mode = 0o640): string {
  const dir = mkdtempSync(join(tmpdir(), 'entrypoint-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'node'), '#!/bin/sh\necho "dsh web: http://127.0.0.1:3111/?token=NEWTOKEN123"\necho "mndt: this start says something"\nsleep 1\n')
  chmodSync(join(bin, 'node'), 0o755)
  const log = join(dir, 'web.log')
  if (previous !== undefined) { writeFileSync(log, previous); chmodSync(log, mode) }
  execFileSync('sh', [entrypoint], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      DSH_HOME: join(dir, 'home'),
      DSH_MNDT_WEB_LOG: log,
      DSH_MNDT_WEB_TOKEN_FILE: join(dir, 'web-token'),
      WEB_HOST: '127.0.0.1',
    },
    stdio: 'pipe',
  })
  return dir
}

describe('the workbench entrypoint keeps the previous log, without its tokens', () => {
  it('moves the previous log to web.log.1 with its tokens replaced, keeps its warnings and its mode', () => {
    const dir = start('dsh web: http://x/?token=OLDTOKEN456\nmndt: the role file, row 3, is set aside and grants nothing\n', 0o640)
    const kept = readFileSync(join(dir, 'web.log.1'), 'utf8')
    expect(kept).toContain('mndt: the role file, row 3, is set aside and grants nothing')
    expect(kept).toContain('token=…')
    expect(kept).not.toContain('OLDTOKEN456')
    expect(statSync(join(dir, 'web.log.1')).mode & 0o777).toBe(0o640)
    // The new log is this start's alone, and its token is the one published.
    const now = readFileSync(join(dir, 'web.log'), 'utf8')
    expect(now).toContain('NEWTOKEN123')
    expect(now).not.toContain('OLDTOKEN456')
    expect(readFileSync(join(dir, 'web-token'), 'utf8')).toBe('NEWTOKEN123')
  })

  it('keeps one previous log only: a second start replaces it', () => {
    const dir = start('mndt: first start\n')
    const again = join(dir, 'web.log')
    writeFileSync(again, 'mndt: second start\n')
    execFileSync('sh', [entrypoint], {
      env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, DSH_HOME: join(dir, 'home'), DSH_MNDT_WEB_LOG: again, DSH_MNDT_WEB_TOKEN_FILE: join(dir, 'web-token'), WEB_HOST: '127.0.0.1' },
      stdio: 'pipe',
    })
    const kept = readFileSync(join(dir, 'web.log.1'), 'utf8')
    expect(kept).toContain('mndt: second start')
    expect(kept).not.toContain('mndt: first start')
    expect(existsSync(join(dir, 'web.log.2'))).toBe(false)
  })

  it('a first start, with no previous log, leaves no web.log.1', () => {
    const dir = start(undefined)
    expect(existsSync(join(dir, 'web.log.1'))).toBe(false)
    expect(existsSync(join(dir, 'web.log.1.tmp'))).toBe(false)
  })
})
