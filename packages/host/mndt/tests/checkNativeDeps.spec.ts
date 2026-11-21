import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../deploy/check-native-deps.mjs', import.meta.url))
const platform = `${process.platform}-${process.arch}`
const suffix = process.platform === 'linux' ? '-gnu' : ''
const css = `lightningcss-${platform}${suffix}@1.33.0`
const bundler = `@rolldown/binding-${platform}${suffix}@1.1.1`

/** How a package is left in the store. */
type Shape = 'whole' | 'empty-folder' | 'manifest-only' | 'peer-suffix'

/** @returns a workspace whose lockfile pins `pinned` and whose store holds `installed`, each in its shape. */
function workspace(pinned: readonly string[], installed: Readonly<Record<string, Shape>>, lock?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'native-deps-'))
  const keys = pinned.map(key => `  '${key}':\n    resolution: {integrity: sha512-x}\n`).join('\n')
  writeFileSync(join(root, 'pnpm-lock.yaml'), lock ?? `lockfileVersion: '9.0'\n\npackages:\n\n${keys}\nsnapshots:\n\n`)
  for (const [key, shape] of Object.entries(installed)) {
    const at = key.lastIndexOf('@')
    const name = key.slice(0, at)
    const folder = join(root, 'node_modules', '.pnpm', `${key.replace('/', '+')}${shape === 'peer-suffix' ? '_peer@1.0.0' : ''}`)
    mkdirSync(folder, { recursive: true })
    if (shape === 'empty-folder') continue
    const dir = join(folder, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: key.slice(at + 1) }))
    writeFileSync(join(dir, 'README.md'), 'readme')
    if (shape !== 'manifest-only') writeFileSync(join(dir, `${name.split('/').pop()}.node`), 'addon')
  }
  return root
}

const run = (root: string) => spawnSync(process.execPath, [script, root], { encoding: 'utf8' })
const both = { [css]: 'whole', [bundler]: 'whole' } as const

describe('check-native-deps: a platform package pnpm skipped is named', () => {
  it('passes when every pinned package of this platform is installed with its payload', () => {
    const answer = run(workspace([css, bundler, 'zod@4.4.3'], both))
    expect(answer.status).toBe(0)
    expect(answer.stdout).toMatch(/2 pinned, all installed with their payload/)
  })

  it('accepts a store folder with a peer-dependency suffix', () => {
    expect(run(workspace([css, bundler], { [css]: 'peer-suffix', [bundler]: 'whole' })).status).toBe(0)
  })

  it('fails, naming it, when one was not installed', () => {
    const answer = run(workspace([css, bundler], { [bundler]: 'whole' }))
    expect(answer.status).toBe(1)
    expect(answer.stderr).toContain(`- ${css}: not installed`)
  })

  it('fails on an empty folder of the right name, and on a manifest without payload', () => {
    const empty = run(workspace([css, bundler], { [css]: 'empty-folder', [bundler]: 'whole' }))
    expect(empty.status).toBe(1)
    expect(empty.stderr).toContain('no package.json (an interrupted download)')
    const manifest = run(workspace([css, bundler], { [css]: 'manifest-only', [bundler]: 'whole' }))
    expect(manifest.status).toBe(1)
    expect(manifest.stderr).toContain('nothing in it but its manifest')
  })

  it('fails when this platform retains no package: a check with nothing to check does not pass', () => {
    const other = process.arch === 'x64' ? 'lightningcss-linux-arm64-gnu@1.33.0' : 'lightningcss-linux-x64-gnu@1.33.0'
    const answer = run(workspace([other, 'zod@4.4.3'], {}))
    expect(answer.status).toBe(1)
    expect(answer.stderr).toContain('no native package pinned for')
  })

  it('fails when a package the build loads is not in the list at all', () => {
    const answer = run(workspace([css], { [css]: 'whole' }))
    expect(answer.status).toBe(1)
    expect(answer.stderr).toContain(`- @rolldown/binding-${platform}${suffix}`)
  })

  it('fails when the lockfile has no section it can read', () => {
    expect(run(workspace([], {}, "lockfileVersion: '9.0'\n\nimporters:\n  .: {}\n")).status).toBe(1)
    expect(run(workspace([], {}, "lockfileVersion: '9.0'\n\npackages:\n\nsnapshots:\n\n")).status).toBe(1)
  })
})
