/**
 * Internal platform-profile builders for the local sandbox provider.
 *
 * @module @deepseek-ai/dsh-sandbox-local/profiles
 */

import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { grantArgs as landlockGrantArgs } from '@deepseek-ai/node-addon-system/landlock-run'
import { SandboxUnavailableError, writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/** Names what a confined command may read; unset, it reads all of `/` (the default). */
export const READ_ROOTS_ENV = 'DSH_SANDBOX_READ_ROOTS'

/**
 * What a read allow-list may never open, whatever a root's spelling or a link
 * leads to: the instance's state and secrets (`/state`, `/data`, `/run`,
 * `/root`) and the other processes (`/proc`: their environment holds the
 * model keys). A root inside one of them, or above one of them, is refused.
 */
export const NEVER_READABLE: readonly string[] = ['/state', '/data', '/run', '/root', '/proc']

/** @param root - a resolved path. @param guarded - a guarded one. @returns whether either holds the other. */
function overlaps(root: string, guarded: string): boolean {
  return root === guarded || root.startsWith(`${guarded}/`) || guarded.startsWith(`${root}/`)
}

/**
 * The read allow-list a deployment sets (`DSH_SANDBOX_READ_ROOTS`, colon-separated
 * absolute paths, directories or single files such as `/dev/null`): a team
 * workbench keeps its secrets, its state and other channels out of an agent's
 * reach. Unset, nothing changes: the default reads `/`.
 *
 * Fails closed, never a silent fall back to reading `/`:
 * - set but blank: refused (a value meant to restrict that restricts nothing);
 * - a relative path or a `..`;
 * - a root that resolves (links followed, as the launcher follows them) to `/`,
 *   or that overlaps a path of NEVER_READABLE;
 * - a list left empty once the paths missing on this host are dropped.
 * @param env - the environment to read (the process's by default).
 * @returns the readable roots, resolved, or undefined when no allow-list is set.
 */
export function readRoots(env: Readonly<Record<string, string | undefined>> = process.env): readonly string[] | undefined {
  const raw = env[READ_ROOTS_ENV]
  if (raw === undefined) return undefined
  if (raw.trim() === '') {
    throw new SandboxUnavailableError('workspace-write', `${READ_ROOTS_ENV} is set but blank: unset it to read /, or name what may be read`)
  }
  const roots: string[] = []
  for (const entry of raw.split(':').map(part => part.trim()).filter(part => part !== '')) {
    if (!isAbsolute(entry) || entry.split('/').includes('..')) {
      throw new SandboxUnavailableError('workspace-write', `${READ_ROOTS_ENV} names "${entry}": an absolute path without ..`)
    }
    if (!existsSync(entry)) continue
    // The launcher follows a link: the root is what it leads to.
    const resolved = realpathSync(entry)
    if (resolved === '/' || NEVER_READABLE.some(guarded => overlaps(resolved, guarded))) {
      throw new SandboxUnavailableError('workspace-write', `${READ_ROOTS_ENV} names "${entry}" (${resolved}): / and ${NEVER_READABLE.join(', ')} are never readable`)
    }
    if (!roots.includes(resolved)) roots.push(resolved)
  }
  if (roots.length === 0) throw new SandboxUnavailableError('workspace-write', `${READ_ROOTS_ENV} names nothing present on this host`)
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
 * @param roots - the read allow-list, or `null` for none (reads `/`, writes the shared `/tmp`).
 * @param privateTemp - with a read allow-list under workspace-write, the run's
 *   own temp directory, granted instead of `/tmp`; required in that case.
 * @returns launcher grant arguments before the trailing separator and command argv.
 */
export function landlockProfileArgs(
  policy: SandboxPolicy,
  roots: readonly string[] | null = readRoots() ?? null,
  privateTemp?: string,
): string[] {
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') {
    if (roots === null) {
      readWrite.push('/tmp', policy.workspaceRoot)
    } else {
      // Under a read allow-list the shared /tmp is never granted: what one
      // confined run leaves there would be readable by the next one, whoever
      // started it. The run gets its own directory (TMPDIR) instead.
      if (privateTemp === undefined) {
        throw new SandboxUnavailableError(policy.mode, `${READ_ROOTS_ENV} is set and no private temp directory was provided`)
      }
      readWrite.push(privateTemp, policy.workspaceRoot)
    }
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
