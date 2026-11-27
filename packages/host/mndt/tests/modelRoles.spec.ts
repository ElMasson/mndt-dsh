import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePrices } from '../src/core/index.ts'
import { NO_MODEL_ROLES, parseModelRoles, readModelRoles, resolveModel, stepRole } from '../src/model-roles.ts'

const deploy = join(import.meta.dirname, '..', 'deploy', 'llm')
const prices = parsePrices(readFileSync(join(deploy, 'prices.json'), 'utf8'))
const defaultPolicy = readFileSync(join(deploy, 'roles.json'), 'utf8')
const env = { VLLM_QWEN_MODEL: 'qwen-test' }
const analyste = { provider: 'scaleway-genapi', model: 'glm-5.3' }
const assistant = { provider: 'scaleway-genapi', model: 'deepseek-v4.1-flash' }

/** @param text - a roles.json. @returns its policy, or throws with the refusal. */
function policyOf(text: string, environment: Readonly<Record<string, string | undefined>> = env) {
  const read = parseModelRoles(text, environment, prices)
  if (!read.ok) throw new Error(read.reason)
  return read
}

describe('the space\'s models by role (roles.json)', () => {
  it('the default policy: volume on Qwen, jugement on GLM, the author and the reading of advice on their agent', () => {
    const { policy, unavailable } = policyOf(defaultPolicy)
    expect(unavailable).toEqual([])
    for (const role of ['worker', 'peer', 'scheduled', 'mission'] as const) {
      expect(resolveModel(policy, role, assistant)).toEqual({ provider: 'vllm-qwen', model: 'qwen-test', route: 'volume' })
    }
    for (const role of ['verifier', 'synthesis', 'council', 'briefing'] as const) {
      expect(resolveModel(policy, role, assistant)).toEqual({ provider: 'scaleway-genapi', model: 'glm-5.3', route: 'jugement' })
    }
    for (const role of ['author', 'helpReading', 'councilMember'] as const) {
      expect(resolveModel(policy, role, assistant)).toEqual(assistant)
    }
  })

  it('no file, no policy: every role keeps its agent\'s model, as before', () => {
    const read = parseModelRoles(undefined, env, prices)
    expect(read).toEqual({ ok: true, policy: NO_MODEL_ROLES, unavailable: [] })
    expect(resolveModel(NO_MODEL_ROLES, 'verifier', analyste)).toEqual(analyste)
  })

  it('a route whose variable is empty is unavailable: its roles keep their agent\'s model, and it is said', () => {
    const { policy, unavailable } = policyOf(defaultPolicy, { VLLM_QWEN_MODEL: '' })
    expect(unavailable).toEqual(['volume'])
    expect(resolveModel(policy, 'worker', assistant)).toEqual(assistant)
    expect(resolveModel(policy, 'verifier', assistant).route).toBe('jugement')
  })

  it('refuses the whole file, in a sentence, never a silent fallback', () => {
    const refused = (text: string): string => {
      const read = parseModelRoles(text, env, prices)
      return read.ok ? 'accepted' : read.reason
    }
    expect(refused('{')).toContain('JSON')
    expect(refused('[]')).toContain('objet')
    expect(refused('{"rutes": {}}')).toContain('clé inconnue rutes')
    expect(refused('{"routes": {"x y": "a/b"}}')).toContain('nom de route invalide')
    expect(refused('{"routes": {"agent": "scaleway-genapi/glm-5.3"}}')).toContain('nom de route invalide')
    expect(refused('{"routes": {"r": "glm-5.3"}}')).toContain('fournisseur/modèle')
    expect(refused('{"routes": {"r": "mistral/mistral-large"}}')).toContain('n’a pas de prix')
    expect(refused('{"roles": {"redacteur": "agent"}}')).toContain('rôle inconnu')
    expect(refused('{"roles": {"verifier": "jugement"}}')).toContain('route inconnue « jugement »')
    expect(refused('{"routes": {"j": "scaleway-genapi/glm-5.3"}, "roles": {"author": "j"}}')).toContain('author: "agent"')
    // A comment key and the key PR 2 reads are accepted.
    expect(refused('{"_comment": "x", "onUnreachable": {}}')).toBe('accepted')
  })

  it('gives every step suffix of turns.ts its role, and throws on one no step uses', () => {
    expect(['', 'r'].map(stepRole)).toEqual(['author', 'author'])
    expect(stepRole('v')).toBe('verifier')
    expect(stepRole('s')).toBe('synthesis')
    expect(['cf', 'cs'].map(stepRole)).toEqual(['council', 'council'])
    expect(['cpa', 'ccd'].map(stepRole)).toEqual(['councilMember', 'councilMember'])
    expect(['w1', 'w12'].map(stepRole)).toEqual(['worker', 'worker'])
    expect(['hr1'].map(stepRole)).toEqual(['helpReading'])
    expect(['h1a', 'h2b'].map(stepRole)).toEqual(['peer', 'peer'])
    for (const unknown of ['x', 'w', 'cpe', 'h1', 'vv']) expect(() => stepRole(unknown)).toThrow()
  })

  it('is read at each call, warns once per unavailable route, and says when the file cannot be read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'roles-'))
    try {
      const file = join(dir, 'roles.json')
      const warned: string[] = []
      const warn = (line: string): void => { warned.push(line) }
      expect(await readModelRoles(file, env, prices, warn)).toEqual({ ok: true, policy: NO_MODEL_ROLES, unavailable: [] })
      await writeFile(file, defaultPolicy)
      const read = await readModelRoles(file, { VLLM_QWEN_MODEL: '' }, prices, warn)
      expect(read.ok).toBe(true)
      await readModelRoles(file, { VLLM_QWEN_MODEL: '' }, prices, warn)
      expect(warned.filter(line => line.includes('« volume »'))).toHaveLength(1)
      await writeFile(file, '{"roles": {"verifier": "nulle-part"}}')
      expect(await readModelRoles(file, env, prices, warn)).toMatchObject({ ok: false })
      expect(await readModelRoles(dir, env, prices, warn)).toEqual({ ok: false, reason: 'roles.json ne se lit pas' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
