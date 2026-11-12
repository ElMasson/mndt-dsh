/**
 * The deployment scripts of the adapters lane write the workbench composition:
 * the connector rows (render-connectors.py, from the catalog) and the LLM routes
 * (render-llm-routes.py). They run on the server, so they are tested here on a
 * temporary home: the rows must wrap every catalog connector in the read-only
 * proxy with lists a secret file cannot widen, rerenders must not pile up, and
 * the LLM routes must be accepted by the pi-ai schema and priced, without a key
 * in sight.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, test } from 'vitest'
import { assertServiceable, Config } from '../../../llm/llm-pi-ai/src/config.ts'

const deploy = join(import.meta.dirname, '..', 'deploy')
const render = join(deploy, 'connectors', 'render-connectors.py')
const routes = join(deploy, 'llm', 'render-llm-routes.py')
const catalog = JSON.parse(readFileSync(join(deploy, 'connectors', 'catalog.json'), 'utf8')) as Record<string, Record<string, unknown>>
const servers = Object.keys(catalog).filter(name => !name.startsWith('_'))

interface Row { readonly id?: string; readonly insert?: readonly { id: string; config: { serverName: string; args: string[] } }[] }

/** A temporary live home with one descriptor per catalog entry. */
function home(): { live: string; patch: string } {
  const live = mkdtempSync(join(tmpdir(), 'mndt-live-'))
  mkdirSync(join(live, 'connectors'))
  mkdirSync(join(live, 'home', 'profiles', 'web'), { recursive: true })
  const patch = join(live, 'home', 'profiles', 'web', 'cordis.patch.yml')
  writeFileSync(patch, '- id: own-row\n  config: {kept: true}\n')
  for (const name of servers) {
    writeFileSync(join(live, 'connectors', `${name}.json`), JSON.stringify({ serverName: name, ...catalog[name] }))
  }
  return { live, patch }
}

const run = (live: string): string => execFileSync('python3', [render], { env: { ...process.env, MNDT_HOME: live }, encoding: 'utf8' })

describe('connector rows', () => {
  test('the catalog names the servers the core references', () => {
    expect(servers.sort()).toEqual(['dolibarr', 'office365', 'qonto', 'swing'])
  })

  test('every catalog connector runs behind the proxy, lists exported after the env file', () => {
    const { live, patch } = home()
    run(live)
    const rows = (yaml.load(readFileSync(patch, 'utf8')) as Row[]).flatMap(row => row.insert ?? [])
    expect(rows.map(row => row.config.serverName).sort()).toEqual(servers.sort())
    for (const row of rows) {
      const script = row.config.args[1]!
      const sourced = script.indexOf('set -a;')
      const allow = script.indexOf('export MCP_PROXY_ALLOW=')
      expect(sourced).toBeGreaterThanOrEqual(0)
      expect(allow).toBeGreaterThan(sourced)
      expect(script).toContain('exec node /opt/mndt-tools/mcp-proxy.mjs ')
    }
    const dolibarr = rows.find(row => row.config.serverName === 'dolibarr')!.config.args[1]!
    expect(dolibarr).toContain('export MCP_PROXY_DENY=dolibarr_raw_api;')
  })

  test('a rerender keeps the own rows and does not pile up markers', () => {
    const { live, patch } = home()
    run(live)
    run(live)
    const text = readFileSync(patch, 'utf8')
    expect(text.match(/>>> connecteurs montes/g)).toHaveLength(1)
    expect(text.match(/<<< connecteurs montes/g)).toHaveLength(1)
    expect(text).toContain('- id: own-row')
    expect(text.match(/id: mcp-qonto/g)).toHaveLength(1)
  })

  test('a descriptor cannot set the proxy lists through env, nor inject shell', () => {
    const { live } = home()
    writeFileSync(join(live, 'connectors', 'evil.json'), JSON.stringify({ serverName: 'evil', command: ['true'], env: { MCP_PROXY_ALLOW: '*' }, allow: ['get_*'] }))
    expect(spawnSync('python3', [render], { env: { ...process.env, MNDT_HOME: live } }).status).not.toBe(0)
    writeFileSync(join(live, 'connectors', 'evil.json'), JSON.stringify({ serverName: 'evil', command: ['echo', '$(id); rm -rf /'] }))
    run(live)
    const text = readFileSync(join(live, 'home', 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    expect(text).toContain("'$(id); rm -rf /'")
  })
})

describe('LLM routes', () => {
  const env = {
    ...process.env,
    SCW_PROJECT_ID: '00000000-0000-4000-8000-000000000000',
    VLLM_QWEN_MODEL: 'qwen3.5-35b-a3b',
  }
  const prices = JSON.parse(readFileSync(join(deploy, 'llm', 'prices.json'), 'utf8')) as { models: Record<string, unknown> }

  /** @returns the rendered rows of the home patch. */
  function rendered(): { rows: { id: string; config: Record<string, unknown> }[]; text: string } {
    const live = mkdtempSync(join(tmpdir(), 'mndt-llm-'))
    mkdirSync(join(live, 'home'))
    writeFileSync(join(live, 'home', 'cordis.patch.yml'), '- id: own-row\n  config: {kept: true}\n')
    execFileSync('python3', [routes], { env: { ...env, MNDT_HOME: live } })
    execFileSync('python3', [routes], { env: { ...env, MNDT_HOME: live } })
    const text = readFileSync(join(live, 'home', 'cordis.patch.yml'), 'utf8')
    return { rows: yaml.load(text) as { id: string; config: Record<string, unknown> }[], text }
  }

  test('the routes pass the pi-ai schema and serviceability check', () => {
    const { rows } = rendered()
    const section = rows.find(row => row.id === 'llm-pi-ai')!.config
    // The pair the settings seam runs: the schema first, then serviceability.
    const parsed = Config(section) as unknown as { providers: { get: () => unknown } }
    expect(() => { assertServiceable({ providers: parsed.providers.get() } as never) }).not.toThrow()
    const providers = section.providers as Record<string, { baseURL: string; apiKeyEnv: string }>
    expect(Object.keys(providers).sort()).toEqual(['scaleway-genapi', 'vllm-qwen'])
    expect(providers['vllm-qwen']!.baseURL).toBe('http://51.159.151.86:8000/v1')
    expect(providers['scaleway-genapi']!.apiKeyEnv).toBe('SCW_GENAPI_KEY')
  })

  test('a rerender replaces the block and keeps the other rows', () => {
    const { rows, text } = rendered()
    expect(rows.filter(row => row.id === 'llm-pi-ai')).toHaveLength(1)
    expect(text).toContain('- id: own-row')
  })

  test('every declared model has a line in the price grid; glm-5.3 stays to be provided', () => {
    const { rows } = rendered()
    const providers = rows.find(row => row.id === 'llm-pi-ai')!.config.providers as Record<string, { models: { id: string }[] }>
    for (const [provider, profile] of Object.entries(providers)) {
      for (const model of profile.models) {
        expect(`${provider}/${model.id}` in prices.models || `${provider}/*` in prices.models).toBe(true)
      }
    }
    expect(prices.models['scaleway-genapi/glm-5.3']).toBeNull()
    expect(prices.models['scaleway-genapi/deepseek-v4.1-flash']).toEqual({ input: 0.6, cacheRead: 0.12, output: 1.8 })
    expect(prices.models['vllm-qwen/*']).toEqual({ input: 0, cacheRead: 0, output: 0 })
  })

  test('refuses to render without the project id or with a value that changes the YAML', () => {
    const missing = spawnSync('python3', [routes, '--print'], { env: { ...process.env, VLLM_QWEN_MODEL: 'q' }, encoding: 'utf8' })
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('SCW_PROJECT_ID manquant')
    const injected = spawnSync('python3', [routes, '--print'], { env: { ...env, VLLM_QWEN_MODEL: "q'}\n- id: evil" }, encoding: 'utf8' })
    expect(injected.status).toBe(1)
  })

  test('no key in the versioned files', () => {
    for (const file of ['routes.patch.yml.template', 'prices.json', 'llm.env.example']) {
      const text = readFileSync(join(deploy, 'llm', file), 'utf8')
      expect(text).not.toMatch(/SCW_GENAPI_KEY=\S/)
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
    }
  })
})
