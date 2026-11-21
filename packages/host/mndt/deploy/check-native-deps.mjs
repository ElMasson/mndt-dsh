#!/usr/bin/env node
// After `pnpm install`, every native package the lockfile pins for this
// platform must be on disk, with its payload. pnpm treats a platform package
// as optional: when its download fails (a slow registry, a timeout), the
// install still succeeds and the build breaks much later on an
// unrelated-looking error (on 21/11: « Cannot find module
// '../lightningcss.linux-x64-gnu.node' » in the host bundle, after 25
// minutes). This says which package is missing, at once.
//
// It fails closed: a lockfile it cannot read, no native package found for
// this platform, or a known one missing from the list, are failures too: a
// check that finds nothing to check must not pass.
//
// Usage: node check-native-deps.mjs [workspace root] (default: the current directory)
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] ?? process.cwd()
const platform = `${process.platform}-${process.arch}`
const libc = process.platform === 'linux'
  ? (process.report?.getReport?.().header?.glibcVersionRuntime === undefined ? 'musl' : 'gnu')
  : undefined
const where = `${platform}${libc === undefined ? '' : ` (${libc})`}`
const fail = (lines) => { for (const line of lines) console.error(line); process.exit(1) }

const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
const start = lock.indexOf('\npackages:\n')
const end = lock.indexOf('\nsnapshots:\n')
if (start < 0 || end < 0 || end < start) fail([`pnpm-lock.yaml has no « packages: » section followed by « snapshots: »: this check cannot read it`])
// A package key: two spaces, the name and the version, optionally quoted.
const keys = [...lock.slice(start, end).matchAll(/^ {2}'?((?:@[^/\s']+\/)?[^@\s']+)@([^':\s]+)'?:$/gm)]
if (keys.length === 0) fail([`pnpm-lock.yaml lists no package in a form this check reads: it cannot check anything`])

const suffix = libc === undefined ? '' : `-${libc}`
const wanted = keys.filter(([, name]) => {
  if (!name.includes(platform)) return false
  // A libc-specific package of the other libc is not for this machine.
  if (libc === 'gnu' && name.endsWith('-musl')) return false
  if (libc === 'musl' && name.endsWith('-gnu')) return false
  return true
})
if (wanted.length === 0) fail([`no native package pinned for ${where}: the lockfile or this check does not match this machine`])
// The packages the build is known to load: their absence from the list is a failure.
const known = [`lightningcss-${platform}${suffix}`, `@rolldown/binding-${platform}${suffix}`]
const absent = known.filter(name => !wanted.some(([, pinned]) => pinned === name))
if (absent.length > 0) fail([`the lockfile pins none of these for ${where}, which the build loads:`, ...absent.map(name => `  - ${name}`)])

const store = join(root, 'node_modules', '.pnpm')
const entries = existsSync(store) ? readdirSync(store) : []
/** @returns why the package is not usable, or undefined when its payload is on disk. */
function problem(name, version) {
  const base = `${name.replace('/', '+')}@${version}`
  // The store folder, possibly with a peer-dependency suffix (« _… »), never another version.
  const folder = entries.find(entry => entry === base || entry.startsWith(`${base}_`))
  if (folder === undefined) return 'not installed'
  const dir = join(store, folder, 'node_modules', name)
  const manifest = join(dir, 'package.json')
  if (!existsSync(manifest)) return 'its folder has no package.json (an interrupted download)'
  let declared
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
    const bins = typeof parsed.bin === 'string' ? [parsed.bin] : Object.values(parsed.bin ?? {})
    declared = [...(typeof parsed.main === 'string' ? [parsed.main] : []), ...bins]
  } catch {
    return 'its package.json cannot be read'
  }
  const lost = declared.filter(file => !existsSync(join(dir, file)))
  if (lost.length > 0) return `declared but absent: ${lost.join(', ')}`
  // Platform packages carry their payload in many shapes (a .node addon, a
  // binary at the top or under bin/, a shared library under lib/): ask for at
  // least one file beyond the manifest and the notices, at any depth.
  return payload(dir, 3) ? undefined : 'nothing in it but its manifest (an interrupted download)'
}

/** @returns whether `dir` holds a file other than package.json, README* or LICENSE*, down to `depth` levels. */
function payload(dir, depth) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (depth > 1 && entry.name !== 'node_modules' && payload(join(dir, entry.name), depth - 1)) return true
    } else if (entry.name !== 'package.json' && !/^(readme|license|licence|changelog)/i.test(entry.name)) {
      return true
    }
  }
  return false
}

const broken = wanted
  .map(([, name, version]) => ({ name, version, why: problem(name, version) }))
  .filter(entry => entry.why !== undefined)
if (broken.length > 0) {
  fail([`native packages pinned for ${where} but not usable (a failed download pnpm let pass):`,
    ...broken.map(entry => `  - ${entry.name}@${entry.version}: ${entry.why}`)])
}
console.log(`native packages for ${where}: ${wanted.length} pinned, all installed with their payload`)
