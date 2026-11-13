import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import { startMndtApi } from '../src/api.ts'

const deploy = join(import.meta.dirname, '..', 'deploy')
const owner = 'duke@datanalysis.re'
const servers: Server[] = []
afterEach(() => { for (const server of servers.splice(0)) server.close() })

/** @returns the URL of a real API, the owner proven by x-forwarded-email as behind the gateway. */
async function realApi(mounted: readonly string[] = ['approvals']): Promise<{ url: string; service: WorkbenchService }> {
  const service = new WorkbenchService({ store: new MemoryStore() })
  const server = startMndtApi({
    service,
    runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
    identity: { proxyUserHeader: 'x-forwarded-email' },
    grants: { grants: async () => ({ ok: true, grants: [{ subject: owner, role: 'owner' }] }) },
    // As the workbench does: the API knows which MCP servers are mounted.
    connectors: async () => mounted.map(server => ({ module: '@deepseek-ai/dsh-mcp-client', server, enabled: true })),
    port: 0,
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    if (server.listening) resolve()
    else server.once('listening', () => { resolve() })
  })
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, service }
}

/** @param env - the seed environment. @returns what the seed printed. */
async function seed(env: Record<string, string>): Promise<string> {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [join(deploy, 'tenant', 'seed-team.mjs')], { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(`${error.message}\n${stderr}`))
      else resolve(stdout)
    })
  })
}

const agentsJson = readFileSync(join(deploy, 'tenant', 'agents.json'), 'utf8')

describe('seeding a tenant', { timeout: 30_000 }, () => {
  it('declares the three lot 1 agents through the API, once, each on its own model', async () => {
    const { url, service } = await realApi()
    const env = { MNDT_API_URL: url, MNDT_OWNER: owner, AGENTS_JSON: agentsJson, VLLM_QWEN_MODEL: 'qwen3.5-35b-a3b' }
    await seed(env)
    const agents = await service.listAgents()
    expect(agents.map(a => [a.handle, `${a.provider}/${a.model}`, a.eurPerMonth])).toEqual([
      ['assistant', 'scaleway-genapi/deepseek-v4.1-flash', 5],
      ['analyste', 'scaleway-genapi/glm-5.3', 5],
      ['qwen', 'vllm-qwen/qwen3.5-35b-a3b', 5],
    ])
    expect(agents.every(a => a.createdBy === owner)).toBe(true)
    const again = await seed(env)
    expect(again).toContain('already declared')
    expect(await service.listAgents()).toHaveLength(3)
  })

  it('declares each agent with the connectors mounted now, and says which wait', async () => {
    const { url, service } = await realApi(['approvals', 'qonto'])
    const printed = await seed({ MNDT_API_URL: url, MNDT_OWNER: owner, AGENTS_JSON: agentsJson, VLLM_QWEN_MODEL: 'q' })
    const agents = await service.listAgents()
    expect(agents.find(a => a.handle === 'assistant')?.connectors).toEqual(['qonto'])
    expect(agents.find(a => a.handle === 'analyste')?.connectors).toEqual(['qonto'])
    expect(printed).toContain('@assistant: declared on scaleway-genapi/deepseek-v4.1-flash, ceiling 5 euros a month; connectors not mounted yet: office365, dolibarr, swing')
    expect(printed).toContain('@analyste: declared on scaleway-genapi/glm-5.3, ceiling 5 euros a month; connectors not mounted yet: dolibarr')
  })

  it('skips an agent whose model is not set, never declares it with a guess', async () => {
    const { url, service } = await realApi()
    const printed = await seed({ MNDT_API_URL: url, MNDT_OWNER: owner, AGENTS_JSON: agentsJson, VLLM_QWEN_MODEL: '' })
    expect(printed).toContain('@qwen: skipped')
    expect((await service.listAgents()).map(a => a.handle)).toEqual(['assistant', 'analyste'])
  })

  it('sets one agent ceiling as the owner, for step R-12, without touching the check', async () => {
    const { url, service } = await realApi()
    const env = { MNDT_API_URL: url, MNDT_OWNER: owner, AGENTS_JSON: agentsJson, VLLM_QWEN_MODEL: 'q' }
    await seed(env)
    await seed({ ...env, CEILING: 'assistant=0.000001' })
    expect((await service.listAgents()).find(a => a.handle === 'assistant')?.eurPerMonth).toBe(0.000001)
    await seed({ ...env, CEILING: 'assistant=5' })
    expect((await service.listAgents()).find(a => a.handle === 'assistant')?.eurPerMonth).toBe(5)
    await expect(seed({ ...env, CEILING: 'personne=1' })).rejects.toThrow(/no agent @personne/)
  })

  it('seed-team.sh restarts the workbench after mounting approvals, then seeds in the gateway', () => {
    const root = mkdtempSync(join(tmpdir(), 'seedsh-'))
    mkdirSync(join(root, 'etc', 'oauth2-proxy'), { recursive: true })
    writeFileSync(join(root, 'etc', 'oauth2-proxy', 'governance.cfg'), 'client_id = "app-1"\n')
    writeFileSync(join(root, 'etc', 'oauth2-proxy', 'client_secret'), 's')
    execFileSync('bash', [join(deploy, 'create-tenant.sh'), 'datanalysis', 'equipe.datanalysis.re', '--owner', owner, '--no-docker'], {
      env: { ...process.env, MNDT_ROOT: root },
    })
    const data = join(root, 'data/mndt/datanalysis/live')
    writeFileSync(join(data, 'model.env'), 'VLLM_QWEN_MODEL=Qwen/Qwen3.5-35B-A3B\n')
    // A docker that records each call; its exec answers like a healthy gateway.
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const log = join(root, 'docker.log')
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\necho "$*" >> ${log}\ncat > /dev/null\nexit 0\n`, { mode: 0o755 })
    execFileSync('bash', [join(deploy, 'tenant', 'seed-team.sh'), 'datanalysis', '--owner', owner], {
      env: { ...process.env, MNDT_ROOT: root, PATH: `${bin}:${process.env.PATH ?? ''}` },
    })
    const calls = readFileSync(log, 'utf8').trim().split('\n')
    const compose = `compose -f ${join(root, 'opt/mndt/datanalysis/docker-compose.yml')}`
    expect(existsSync(join(data, 'connectors', 'approvals.json'))).toBe(true)
    expect(calls[0]).toBe(`${compose} restart workbench`) // never up -d: it would not reload
    expect(calls[1]).toContain(`${compose} exec -T gateway node -e`)
    expect(calls.at(-1)).toContain('-e VLLM_QWEN_MODEL=Qwen/Qwen3.5-35B-A3B')
    expect(calls.at(-1)).toContain('gateway node --input-type=module -')
  })

  it('mounts the approvals connector at the tenant paths, decide_approval denied', () => {
    const root = mkdtempSync(join(tmpdir(), 'seed-'))
    mkdirSync(join(root, 'etc', 'oauth2-proxy'), { recursive: true })
    writeFileSync(join(root, 'etc', 'oauth2-proxy', 'governance.cfg'), 'client_id = "app-1"\n')
    writeFileSync(join(root, 'etc', 'oauth2-proxy', 'client_secret'), 's')
    execFileSync('bash', [join(deploy, 'create-tenant.sh'), 'datanalysis', 'equipe.datanalysis.re', '--owner', owner, '--no-docker'], {
      env: { ...process.env, MNDT_ROOT: root },
    })
    const app = join(root, 'opt/mndt/datanalysis')
    const data = join(root, 'data/mndt/datanalysis/live')
    for (const tool of ['approvals-mcp.mjs', 'mcp-proxy.mjs', 'office365-mcp.mjs']) expect(existsSync(join(data, 'tools', tool))).toBe(true)
    // The same call seed-team.sh makes, at the tenant paths of a rendered root.
    execFileSync('bash', [join(deploy, 'mount-connector.sh'), 'approvals', '--preset', '--no-restart'], {
      env: {
        ...process.env,
        MNDT_HOME: data,
        MNDT_FRONT: app,
        RENDER_SCRIPT: join(app, 'gateway', 'render-connectors.py'),
        CONNECTOR_CATALOG: join(app, 'gateway', 'catalog.json'),
      },
    })
    const descriptor = JSON.parse(readFileSync(join(data, 'connectors', 'approvals.json'), 'utf8')) as { deny?: string[] }
    expect(descriptor.deny).toContain('decide_approval')
    const patch = readFileSync(join(data, 'home/profiles/web/cordis.patch.yml'), 'utf8')
    expect(patch).toContain('approvals')
    expect(patch).not.toContain('/data/mndt/live')
  })
})
