/**
 * The patch files of a dsh home (cordis.patch.yml) have several writers: dsh
 * creates them with `[]`, the interface edits rows in place, and the deployment
 * scripts each own a block between two markers. On the team instance a renderer
 * appended its block after the `[]` and the workbench stopped starting. Every
 * deployment writer now goes through one guard (deploy/patchfile.py); these
 * tests start from the file dsh really writes and read every result back with
 * the loader dsh really uses.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { loadOverlayPatches } from '../../../boot/app-boot/src/index.ts'
import { initProfile } from '../../../boot/app-boot/src/profile.ts'

const deploy = join(import.meta.dirname, '..', 'deploy')
const mount = join(deploy, 'mount-connector.sh')
const render = join(deploy, 'connectors', 'render-connectors.py')
const routes = join(deploy, 'llm', 'render-llm-routes.py')
const guard = join(deploy, 'patchfile.py')
const llm = { SCW_PROJECT_ID: '00000000-0000-4000-8000-000000000000', VLLM_QWEN_MODEL: 'qwen3.5-35b-a3b' }
const MCP = '@deepseek-ai/dsh-mcp-client'

interface Entry {
  readonly id?: string
  readonly disabled?: boolean
  readonly config?: unknown
  readonly insert?: readonly { id: string; name: string }[]
}

/** A live home whose web profile patch is the file dsh writes at its first start. */
function home(): { live: string; profile: string; homePatch: string } {
  const live = mkdtempSync(join(tmpdir(), 'mndt-patch-'))
  initProfile(join(live, 'home', 'profiles', 'web'), [])
  return { live, profile: join(live, 'home', 'profiles', 'web', 'cordis.patch.yml'), homePatch: join(live, 'home', 'cordis.patch.yml') }
}

const env = (live: string): NodeJS.ProcessEnv => ({ ...process.env, ...llm, MNDT_HOME: live, RENDER_SCRIPT: render })

/** Mount one connector the way seed-team.sh and install-connectors.sh do, without the restart. */
function mountConnector(live: string, server: string): void {
  execFileSync('bash', [mount, server, 'node', `/opt/mndt-tools/${server}.mjs`, '--no-restart'], { env: env(live), stdio: 'pipe' })
}

/** @returns the entries of a patch file, read by the loader dsh boots with. */
const load = (file: string): Entry[] => loadOverlayPatches('dsh', file) as Entry[]
const inserted = (file: string): string[] => load(file).flatMap(entry => entry.insert ?? []).map(row => row.id)
const count = (text: string, needle: string): number => text.split(needle).length - 1

describe('the patch-file guard', { timeout: 30_000 }, () => {
  test('the file dsh creates is three comment lines and an empty array', () => {
    const { profile } = home()
    expect(readFileSync(profile, 'utf8')).toMatch(/^(#.*\n){3}\[\]\n$/)
    expect(load(profile)).toEqual([])
  })

  test('mount-connector on the dsh template leaves one valid array holding the connector', () => {
    const { live, profile } = home()
    const header = readFileSync(profile, 'utf8').split('\n').slice(0, 3)
    mountConnector(live, 'approvals')
    const text = readFileSync(profile, 'utf8')
    expect(inserted(profile)).toEqual(['mcp-approvals'])
    expect(text.split('\n').slice(0, 3)).toEqual(header)
    expect(text).not.toMatch(/^\[\s*\]/m)
  })

  test('mount, LLM routes, mount again: one block of each, valid at every step', () => {
    const { live, profile, homePatch } = home()
    // The home patch in the same starting state as the profile patch.
    writeFileSync(homePatch, readFileSync(profile, 'utf8'))
    mountConnector(live, 'approvals')
    expect(inserted(profile)).toEqual(['mcp-approvals'])
    execFileSync('python3', [routes], { env: env(live) })
    expect(load(homePatch).map(entry => entry.id)).toEqual(['llm-pi-ai', 'agent-default-model'])
    mountConnector(live, 'facts')
    execFileSync('python3', [routes], { env: env(live) })
    expect(inserted(profile)).toEqual(['mcp-approvals', 'mcp-facts'])
    expect(load(homePatch).map(entry => entry.id)).toEqual(['llm-pi-ai', 'agent-default-model'])
    const connectors = readFileSync(profile, 'utf8')
    expect(count(connectors, '# >>> connecteurs montes')).toBe(1)
    expect(count(connectors, '# <<< connecteurs montes')).toBe(1)
    const llmText = readFileSync(homePatch, 'utf8')
    expect(count(llmText, '# >>> routes LLM')).toBe(1)
    expect(count(llmText, '# <<< routes LLM')).toBe(1)
    // Two writers in one file: each keeps the other's block.
    writeFileSync(homePatch, readFileSync(profile, 'utf8'))
    execFileSync('python3', [routes], { env: env(live) })
    expect(inserted(homePatch)).toEqual(['mcp-approvals', 'mcp-facts'])
    expect(load(homePatch).filter(entry => entry.id === 'llm-pi-ai')).toHaveLength(1)
  })

  test('the file found on the team instance, `[]` then a block, is repaired', () => {
    const { live, profile } = home()
    writeFileSync(profile, [
      readFileSync(profile, 'utf8').trimEnd(),
      '# >>> connecteurs montes par mount-connector',
      '- insert:',
      '    - id: mcp-approvals',
      `      name: '${MCP}'`,
      '      config: {serverName: approvals, transport: stdio, command: sh, args: ["-lc", "exec true"]}',
      '# <<< connecteurs montes par mount-connector',
      '',
    ].join('\n'))
    expect(() => load(profile)).toThrow(/failed to parse overlay/)
    mountConnector(live, 'approvals')
    expect(inserted(profile)).toEqual(['mcp-approvals'])
    expect(count(readFileSync(profile, 'utf8'), 'id: mcp-approvals')).toBe(1)
  })

  test('the rows the interface writes survive, wherever they landed, with their `!!js`', () => {
    const { live, profile } = home()
    mountConnector(live, 'approvals')
    // The interface appends after the last row; its comment-preserving writer
    // may leave the closing marker below the new row, so both places are tried.
    const text = readFileSync(profile, 'utf8')
    const inside = text.replace('# <<< connecteurs', [
      '- id: ui-settings-general',
      '  config:',
      '    theme: dark',
      '    home: !!js process.env.HOME',
      '# <<< connecteurs',
    ].join('\n'))
    writeFileSync(profile, `${inside}- id: locale\n  config: {preference: en}\n- id: ui-schedule\n  disabled: true\n`)
    mountConnector(live, 'facts')
    const entries = load(profile)
    expect(inserted(profile)).toEqual(['mcp-approvals', 'mcp-facts'])
    expect(entries.find(entry => entry.id === 'ui-settings-general')?.config).toMatchObject({ theme: 'dark' })
    expect(entries.find(entry => entry.id === 'locale')?.config).toEqual({ preference: 'en' })
    expect(entries.find(entry => entry.id === 'ui-schedule')?.disabled).toBe(true)
    const after = readFileSync(profile, 'utf8')
    expect(after).toContain('    home: !!js process.env.HOME\n')
    expect(count(after, '# >>> connecteurs montes')).toBe(1)
  })

  test('a flow array is rewritten row by row, a foreign insert list is kept', () => {
    const { live, profile } = home()
    writeFileSync(profile, '# mine\n[{id: a, config: {v: !!js "1 + 1"}}, {insert: [{id: other, name: ./plugin.js}]}]\n')
    mountConnector(live, 'approvals')
    expect(load(profile).map(entry => entry.id)).toEqual(['a', undefined, undefined])
    expect(inserted(profile)).toEqual(['other', 'mcp-approvals'])
    expect(readFileSync(profile, 'utf8')).toContain('- {id: a, config: {v: !!js "1 + 1"}}\n')
  })

  test('removing the last connector leaves an array, not comments alone', () => {
    const { live, profile } = home()
    mountConnector(live, 'approvals')
    execFileSync('rm', [join(live, 'connectors', 'approvals.json')])
    execFileSync('python3', [render], { env: env(live) })
    expect(load(profile)).toEqual([])
    expect(readFileSync(profile, 'utf8')).toMatch(/^(#.*\n){3}\[\]\n$/)
  })

  test('a file that does not parse is refused and left byte for byte', () => {
    const { live, profile, homePatch } = home()
    const broken = '- id: ui-settings-general\n  config: {theme: dark\n- id: other\n'
    for (const file of [profile, homePatch]) writeFileSync(file, broken)
    const mounted = spawnSync('bash', [mount, 'approvals', 'node', 'x.mjs', '--no-restart'], { env: env(live), encoding: 'utf8' })
    expect(mounted.status).not.toBe(0)
    expect(mounted.stderr).toContain('refus')
    expect(mounted.stderr).toContain('ne se parse pas')
    const routed = spawnSync('python3', [routes], { env: env(live), encoding: 'utf8' })
    expect(routed.status).not.toBe(0)
    expect(routed.stderr).toContain('ne se parse pas')
    for (const file of [profile, homePatch]) expect(readFileSync(file, 'utf8')).toBe(broken)
    // No temporary file is left beside either patch.
    expect(readdirSync(join(live, 'home')).sort()).toEqual(['cordis.patch.yml', 'profiles'])
    expect(readdirSync(join(live, 'home', 'profiles', 'web')).filter(name => name.includes('.tmp'))).toEqual([])
  })

  test('a file that is not an array of mappings is refused, as dsh refuses it', () => {
    const { live, profile } = home()
    for (const content of ['id: not-a-list\n', '- just a string\n', '- id: twice\n  id: twice\n']) {
      writeFileSync(profile, content)
      expect(spawnSync('python3', [render], { env: env(live) }).status).not.toBe(0)
      expect(readFileSync(profile, 'utf8')).toBe(content)
    }
  })

  test('the command a shell script calls: its block between its markers, rerun without duplicates', () => {
    const { homePatch, live } = home()
    mkdirSync(join(live, 'home'), { recursive: true })
    writeFileSync(homePatch, '# header\n[]\n')
    const begin = '# >>> tenant d equipe (create-tenant.sh)'
    const end = '# <<< tenant d equipe (create-tenant.sh)'
    const block = '# Interface en francais.\n- id: locale\n  config:\n    preference: fr\n- id: ui-schedule\n  disabled: true\n'
    const call = (input: string, ...more: string[]): void => {
      execFileSync('python3', [guard, homePatch, '--begin', begin, '--end', end, ...more], { input, stdio: ['pipe', 'pipe', 'pipe'] })
    }
    call(block)
    execFileSync('python3', [routes], { env: env(live) })
    call(block)
    expect(load(homePatch).map(entry => entry.id)).toEqual(['locale', 'ui-schedule', 'llm-pi-ai', 'agent-default-model'])
    const text = readFileSync(homePatch, 'utf8')
    expect(text.startsWith('# header\n# >>> tenant d equipe')).toBe(true)
    expect(count(text, '# Interface en francais.')).toBe(1)
    // A row the block no longer writes is retired by naming its id.
    call('- id: locale\n  config: {preference: fr}\n', '--ids', 'ui-schedule')
    expect(load(homePatch).map(entry => entry.id)).toEqual(['locale', 'llm-pi-ai', 'agent-default-model'])
    expect(execFileSync('python3', [guard, homePatch, '--check'], { encoding: 'utf8' })).toContain('3 entree(s)')
    // A block that is not a list of mappings never reaches the file.
    const before = readFileSync(homePatch, 'utf8')
    expect(count(before, '# Interface en francais.')).toBe(0)
    const refused = spawnSync('python3', [guard, homePatch, '--begin', begin, '--end', end], { input: 'id: locale\n', encoding: 'utf8' })
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('refus')
    expect(readFileSync(homePatch, 'utf8')).toBe(before)
  })
})
