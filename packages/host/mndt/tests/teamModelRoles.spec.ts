import { describe, expect, it } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import type { Message, PriceGrid } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import type { MissionRunner } from '../src/api.ts'
import { parseModelRoles } from '../src/model-roles.ts'
import type { ModelRolesRead } from '../src/model-roles.ts'
import { TurnScheduler } from '../src/turns.ts'
import type { TurnEngine, TurnInput, TurnOutput } from '../src/turns.ts'

const owner = 'duke@datanalysis.re'
const PRICES: PriceGrid = {
  'route-a/*': { input: 1, output: 2 },
  'route-b/*': { input: 3, output: 4 },
  'route-j/*': { input: 10, output: 20 },
}
const noMissions: MissionRunner = { run: async () => ({ title: 't', markdown: 'm', sources: [] }) }

/** Records the model each call was played on; answers by role. */
class RecordingEngine implements TurnEngine {
  readonly seen: TurnInput[] = []
  async run(input: TurnInput): Promise<TurnOutput> {
    this.seen.push(input)
    const text = input.turnId.endsWith('-v') ? '{"ok": true}' : 'brouillon'
    return { text, tokens: { input: 1_000_000, output: 0 } }
  }
}

/** @param policy - a roles.json, or a reader. */
function bench(policy: string | (() => Promise<ModelRolesRead>)) {
  const service = new WorkbenchService({ store: new MemoryStore() })
  const engine = new RecordingEngine()
  const modelRoles = typeof policy === 'string' ? async () => parseModelRoles(policy, {}, PRICES) : policy
  const turns = new TurnScheduler({ service, engine, prices: PRICES, dataDir: '/data/mndt', modelRoles })
  const api = createMndtApi({
    service, runner: noMissions, turns,
    identity: { tokens: { owner: { user: owner } } },
    grants: { grants: async () => ({ ok: true, grants: [{ subject: owner, role: 'owner' }] }) },
  })
  const call = async (method: string, path: string, body?: unknown) => {
    const answer = await api({ method, path, authorization: 'Bearer owner', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return answer.body as Record<string, unknown>
  }
  const agent = async (handle: string, provider: string) =>
    ((await call('POST', '/agents', { handle, name: handle, provider, model: 'm', eurPerMonth: 5 })).agent as { id: string }).id
  const ask = async (channel: string, text: string) => {
    const posted = (await call('POST', `/channels/${channel}/messages`, { text })).message as { id: string }
    await turns.settled()
    return ((await service.messages(channel)) as readonly Message[]).find(m => m.id === posted.id)
  }
  return { service, engine, call, agent, ask }
}

/** @returns an author on route-a, a verifier on route-b, coordinated in one channel. */
async function authorVerifier(b: ReturnType<typeof bench>) {
  const author = await b.agent('auteur', 'route-a')
  const verifier = await b.agent('verif', 'route-b')
  const channel = ((await b.call('POST', '/channels', { name: 'equipe', agents: [author, verifier] })).channel as { id: string }).id
  await b.call('POST', `/channels/${channel}/coordination`, { mode: 'author-verifier', author, verifier })
  return { author, verifier, channel }
}

const JUGEMENT = '{"routes": {"jugement": "route-j/juge"}, "roles": {"verifier": "jugement"}}'

describe('the models by role: the step is played on its role\'s model, the agent keeps its identity', () => {
  it('the verifier plays on the « jugement » route, the author on its own model; each step says its model and is priced for it', async () => {
    const b = bench(JUGEMENT)
    const { author, verifier, channel } = await authorVerifier(b)
    const asked = await ask(b, channel)
    expect(b.engine.seen.map(input => [input.turnId.endsWith('-v') ? 'v' : 'a', input.agent.handle, `${input.agent.provider}/${input.agent.model}`]))
      .toEqual([['a', 'auteur', 'route-a/m'], ['v', 'verif', 'route-j/juge']])
    const steps = asked?.turns?.[0]?.steps
    expect(steps?.map(step => [step.role, step.agentId, step.model])).toEqual([
      ['author', author, 'route-a/m'],
      ['verifier', verifier, 'route-j/juge'],
    ])
    // A million input tokens: 1 € on route-a, 10 € on route-j (the verifier's own route-b would say 3 €).
    expect(steps?.map(step => step.eur)).toEqual([1, 10])
  })

  it('same-model after resolution: a verifier resolving to the author\'s model keeps its own agent\'s', async () => {
    const b = bench('{"routes": {"jugement": "route-a/m"}, "roles": {"verifier": "jugement"}}')
    const { channel } = await authorVerifier(b)
    const asked = await ask(b, channel)
    expect(asked?.turns?.[0]?.steps?.map(step => step.model)).toEqual(['route-a/m', 'route-b/m'])
  })

  it('without a policy, every step plays on its agent\'s model, as before', async () => {
    const b = bench(async () => parseModelRoles(undefined, {}, PRICES))
    const { channel } = await authorVerifier(b)
    const asked = await ask(b, channel)
    expect(asked?.turns?.[0]?.steps?.map(step => step.model)).toEqual(['route-a/m', 'route-b/m'])
  })

  it('a single turn says the model it was played on', async () => {
    const b = bench(JUGEMENT)
    const solo = await b.agent('solo', 'route-b')
    const channel = ((await b.call('POST', '/channels', { name: 'seul', agents: [solo] })).channel as { id: string }).id
    const asked = await b.ask(channel, '@solo bonjour')
    expect(asked?.turns?.[0]?.model).toBe('route-b/m')
  })

  it('a policy that cannot be read refuses the turn with its reason, and no model is called', async () => {
    const b = bench(async () => ({ ok: false, reason: 'roles.json : rôle inconnu « x »' }))
    const solo = await b.agent('solo', 'route-b')
    const channel = ((await b.call('POST', '/channels', { name: 'seul', agents: [solo] })).channel as { id: string }).id
    const asked = await b.ask(channel, '@solo bonjour')
    expect(b.engine.seen).toHaveLength(0)
    expect(JSON.stringify(asked?.turns?.[0])).toContain('la politique des modèles de l’espace ne se lit pas : roles.json : rôle inconnu « x »')
  })
})

/** @returns the channel's first turn, @auteur asked. */
async function ask(b: ReturnType<typeof bench>, channel: string) {
  return b.ask(channel, '@auteur fais le point')
}
