import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../deploy/check-native-deps.mjs', import.meta.url))
const platform = `${process.platform}-${process.arch}`

/** @returns a workspace whose lockfile pins `pinned` and whose store holds `installed`. */
function workspace(pinned: readonly string[], installed: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'native-deps-'))
  const keys = pinned.map(key => `  '${key}':\n    resolution: {integrity: sha512-x}\n`).join('\n')
  writeFileSync(join(root, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\n\npackages:\n\n${keys}\nsnapshots:\n\n`)
  for (const key of installed) mkdirSync(join(root, 'node_modules', '.pnpm', key.replace('/', '+')), { recursive: true })
  return root
}

const run = (root: string) => spawnSync(process.execPath, [script, root], { encoding: 'utf8' })

describe('check-native-deps: a platform package pnpm skipped is named', () => {
  const css = `lightningcss-${platform}-gnu@1.33.0`
  const bundler = `@rolldown/binding-${platform}-gnu@1.1.1`

  it('passes when every pinned package of this platform is installed', () => {
    const answer = run(workspace([css, bundler, 'zod@4.4.3'], [css, bundler]))
    expect(answer.status).toBe(0)
    expect(answer.stdout).toMatch(/2 pinned, all installed/)
  })

  it('fails, naming it, when one was not installed', () => {
    const answer = run(workspace([css, bundler], [bundler]))
    expect(answer.status).toBe(1)
    expect(answer.stderr).toContain(`- lightningcss-${platform}-gnu@1.33.0`)
  })

  it('does not ask for another platform or the other libc', () => {
    const other = process.arch === 'x64' ? 'lightningcss-linux-arm64-gnu@1.33.0' : 'lightningcss-linux-x64-gnu@1.33.0'
    const answer = run(workspace([other, `lightningcss-${platform}-musl@1.33.0`], []))
    expect(answer.status).toBe(0)
  })
})
