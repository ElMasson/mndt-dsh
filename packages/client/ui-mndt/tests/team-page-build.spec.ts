import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const config = resolve(import.meta.dirname, '../standalone/vite.config.ts')
let out = ''
let files: readonly { readonly name: string; readonly text: string }[] = []

/** @param dir - a directory. @returns every file below it, relative to it. */
async function walk(dir: string, prefix = ''): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(prefix, entry.name)
    if (entry.isDirectory()) found.push(...await walk(join(dir, entry.name), path))
    else found.push(path)
  }
  return found
}

beforeAll(async () => {
  // The page as the image ships it, built apart from lib/ so the test never touches a real build.
  out = await mkdtemp(join(tmpdir(), 'mndt-team-page-'))
  await build({ configFile: config, logLevel: 'silent', build: { outDir: out, emptyOutDir: true } })
  files = await Promise.all((await walk(out)).map(async name => ({
    name,
    text: name.endsWith('.woff2') ? '' : await readFile(join(out, name), 'utf8'),
  })))
}, 120_000)

afterAll(async () => { if (out !== '') await rm(out, { recursive: true, force: true }) })

describe('the standalone team page, as built', () => {
  it('is one page and its hashed files under team-assets/, never the shell\'s /assets', () => {
    expect(files.map(f => f.name)).toContain('index.html')
    for (const file of files.filter(f => f.name !== 'index.html')) expect(file.name.startsWith('team-assets/')).toBe(true)
    const html = files.find(f => f.name === 'index.html')?.text ?? ''
    expect(html).toMatch(/src="\/team-assets\/index-[\w-]+\.js"/u)
  })

  it('carries a policy that keeps every load on its own origin', () => {
    const html = files.find(f => f.name === 'index.html')?.text ?? ''
    const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u.exec(html)?.[1] ?? ''
    expect(policy).toContain("default-src 'self'")
    expect(policy).toContain("script-src 'self'")
    expect(policy).toContain("connect-src 'self'")
    expect(policy).not.toMatch(/https?:|\*/u)
  })

  it('loads nothing from outside: no external script, style, font, image or call', () => {
    const external = new RegExp([
      String.raw`(?:src|href)=["']https?:`,
      String.raw`url\(\s*["']?https?:`,
      String.raw`@import\s+["']?https?:`,
      String.raw`import\(\s*["']https?:`,
      String.raw`from\s*["']https?:`,
      String.raw`fetch\(\s*["']https?:`,
    ].join('|'), 'u')
    for (const file of files) expect(`${file.name}: ${external.exec(file.text)?.[0] ?? 'clean'}`).toBe(`${file.name}: clean`)
  })
})
