import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const checks = fileURLToPath(new URL('../deploy/rehearsal/checks.sh', import.meta.url))

/** @returns the line seed_restart_verdict prints and its exit status. */
function verdict(...args: string[]): { line: string; status: number } {
  try {
    const line = execFileSync('bash', ['-c', '. "$0"; seed_restart_verdict "$@"', checks, ...args], { encoding: 'utf8' })
    return { line: line.trim(), status: 0 }
  } catch (error) {
    const failed = error as { stdout: string; status: number }
    return { line: failed.stdout.trim(), status: failed.status }
  }
}

describe('seed-restart: a verdict on what seed-team.sh changed, that can fail', () => {
  it('KO when the descriptor changed and the workbench was not restarted', () => {
    const answer = verdict('aaa absent', 'bbb absent', 'T1', 'T1')
    expect(answer.status).toBe(1)
    expect(answer.line).toBe('KO  seed-restart   seed-team.sh rewrote approvals but did not restart the workbench')
  })

  it('KO too when only the rendered patch changed', () => {
    expect(verdict('aaa ppp', 'aaa qqq', 'T1', 'T1').status).toBe(1)
  })

  it('OK when the descriptor changed and the workbench was restarted', () => {
    const answer = verdict('aaa ppp', 'bbb ppp', 'T1', 'T2')
    expect(answer.status).toBe(0)
    expect(answer.line).toMatch(/^OK  seed-restart   seed-team.sh restarted the workbench/)
  })

  it('OK when nothing changed and nothing was restarted (an update from 9979d2532e)', () => {
    const answer = verdict('aaa ppp', 'aaa ppp', 'T1', 'T1')
    expect(answer.status).toBe(0)
    expect(answer.line).toMatch(/unchanged by seed-team.sh: no restart needed \(none\)$/)
  })
})
