#!/usr/bin/env node
// After `pnpm install`, every native package the lockfile pins for this
// platform must be on disk. pnpm treats a platform package as optional: when
// its download fails (a slow registry, a timeout), the install still succeeds
// and the build breaks much later on an unrelated-looking error (on 21/11:
// « Cannot find module '../lightningcss.linux-x64-gnu.node' » in the host
// bundle, after 25 minutes). This says which package is missing, at once.
//
// Usage: node check-native-deps.mjs [workspace root] (default: the current directory)
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] ?? process.cwd()
const platform = `${process.platform}-${process.arch}`
const libc = process.platform === 'linux'
  ? (process.report?.getReport?.().header?.glibcVersionRuntime === undefined ? 'musl' : 'gnu')
  : undefined

const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
const packages = lock.slice(lock.indexOf('\npackages:\n'), lock.indexOf('\nsnapshots:\n'))
// A package key: two spaces, the name and the version, optionally quoted.
const keys = [...packages.matchAll(/^ {2}'?((?:@[^/\s']+\/)?[^@\s']+)@([^':\s]+)'?:$/gm)]

const wanted = keys.filter(([, name]) => {
  if (!name.includes(platform)) return false
  // A libc-specific package of the other libc is not for this machine.
  if (libc === 'gnu' && name.endsWith('-musl')) return false
  if (libc === 'musl' && name.endsWith('-gnu')) return false
  return true
})

const store = join(root, 'node_modules', '.pnpm')
const missing = wanted
  .map(([, name, version]) => ({ name, version, dir: join(store, `${name.replace('/', '+')}@${version}`) }))
  .filter(entry => !existsSync(entry.dir))

if (missing.length > 0) {
  console.error(`native packages pinned for ${platform}${libc === undefined ? '' : ` (${libc})`} but not installed (a failed download pnpm let pass):`)
  for (const entry of missing) console.error(`  - ${entry.name}@${entry.version}`)
  process.exit(1)
}
console.log(`native packages for ${platform}${libc === undefined ? '' : ` (${libc})`}: ${wanted.length} pinned, all installed`)
