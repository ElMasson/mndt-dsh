/**
 * Internal platform-profile builders for the local sandbox provider.
 *
 * @module @deepseek-ai/dsh-sandbox-local/profiles
 */

import { existsSync } from 'node:fs'
import { isAbsolute, normalize } from 'node:path'
import { grantArgs as landlockGrantArgs } from '@deepseek-ai/node-addon-system/landlock-run'
import { SandboxUnavailableError, writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/** Names the directories a confined command may read; unset, it reads all of `/` (the default). */
export const READ_ROOTS_ENV = 'DSH_SANDBOX_READ_ROOTS'

/**
 * The read allow-list a deployment sets (`DSH_SANDBOX_READ_ROOTS`, colon-separated
 * absolute directories): a team workbench keeps its secrets, its state and other
 * channels out of an agent's reach. Unset or empty, nothing changes.
 *
 * Fails closed: a relative path, a `..`, `/` itself, or a list left empty once the
 * directories missing on this host are dropped, refuses the command; never a
 * silent fall back to reading `/`.
 * @param env - the environment to read (the process's by default).
 * @returns the readable roots, or undefined when no allow-list is set.
 */
export function readRoots(env: Readonly<Record<string, string | undefined>> = process.env): readonly string[] | undefined {
  const raw = env[READ_ROOTS_ENV]
  if (raw === undefined || raw.trim() === '') return undefined
  const roots: string[] = []
  for (const entry of raw.split(':').map(part => part.trim()).filter(part => part !== '')) {
    if (!isAbsolute(entry) || entry.split('/').includes('..') || normalize(entry) === '/') {
      throw new SandboxUnavailableError('workspace-write', `${READ_ROOTS_ENV} names "${entry}": an absolute directory other than /, without ..`)
    }
    if (existsSync(entry)) roots.push(normalize(entry).replace(/\/+$/, ''))
  }
  if (roots.length === 0) throw new SandboxUnavailableError('workspace-write', `${READ_ROOTS_ENV} names no directory present on this host`)
  return roots
}

/**
 * Build the bwrap profile arguments for one file-effect policy.
 * @param policy - file-effect policy to express as bwrap mounts.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy: SandboxPolicy, roots: readonly string[] | null = readRoots() ?? null): string[] {
  // bwrap here binds all of / read-only: it cannot honour a read allow-list, so it refuses.
  // `null` says « no allow-list » explicitly: an `undefined` would take the default.
  if (roots !== null) {
    throw new SandboxUnavailableError(policy.mode, `${READ_ROOTS_ENV} is set and the bwrap runner does not apply a read allow-list; use Landlock`)
  }
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
  }
  return args
}

/**
 * Build the Landlock launcher grants for one file-effect policy.
 * @param policy - file-effect policy to express as Landlock allow-list grants.
 * @returns launcher grant arguments before the trailing separator and command argv.
 */
export function landlockProfileArgs(policy: SandboxPolicy, roots: readonly string[] | null = readRoots() ?? null): string[] {
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') {
    readWrite.push('/tmp', policy.workspaceRoot)
  }
  return landlockGrantArgs({ readOnly: roots === null ? ['/'] : [...roots], readWrite })
}

/** Quote one path as an SBPL string literal. */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/**
 * Build the sandbox-exec arguments and SBPL profile for one policy. The
 * writable roots come from the shared {@link writableRoots} helper (canonical,
 * deduplicated) so the Seatbelt grant and the in-process fs fence
 * (`@deepseek-ai/dsh-fs-sandbox`) can never drift apart.
 * @param policy - file-effect policy to express as an SBPL profile.
 * @returns sandbox-exec arguments before the trailing separator and command argv.
 */
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`]
  const roots = writableRoots(policy)
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  return ['-p', forms.join(' ')]
}
