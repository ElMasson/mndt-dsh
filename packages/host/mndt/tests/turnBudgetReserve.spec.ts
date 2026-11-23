import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { RESERVED_OUTPUT_TOKENS, RESERVED_TOOL_RESULT_TOKENS } from '../src/turns.ts'

/**
 * The cost bound of a coordinated turn reserves, for each model message, an
 * output cap and the size of a tool result. Both are numbers set elsewhere: the
 * routes' maxTokens (sent as max_completion_tokens) and the base bundle's
 * spill-policy. These tests fail when either moves without mndt following.
 */
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

describe('the reserve of a bounded step agrees with the configuration it relies on', () => {
  it('every routed model declares an output cap, no larger than the reserve', () => {
    const routes = load(read('../deploy/llm/routes.patch.yml.template')) as {
      config?: { providers?: Record<string, { models?: { id: string; maxTokens?: unknown }[] }> }
    }[]
    const providers = routes.flatMap(entry => Object.entries(entry.config?.providers ?? {}))
    const models = providers.flatMap(([provider, profile]) => (profile.models ?? []).map(model => ({ provider, ...model })))
    expect(models.length).toBeGreaterThan(0)
    for (const model of models) {
      expect(typeof model.maxTokens, `${model.provider}/${model.id} declares no maxTokens`).toBe('number')
      expect(model.maxTokens as number, `${model.provider}/${model.id}`).toBeLessThanOrEqual(RESERVED_OUTPUT_TOKENS)
    }
  })

  it('the base bundle keeps a tool result inline up to the reserved size', () => {
    // Read as text: the bundle carries cordis tags (!!js) a plain YAML parser refuses.
    const base = read('../../../bundle/base/cordis.patch.yml')
    const entries = base.split(/\n(?=\s*- id: )/)
    const found = entries.filter(entry => /^\s*- id: spill-policy\s*$/m.test(entry))
    expect(found, 'spill-policy is not mounted by the base bundle').toHaveLength(1)
    const size = /^\s*maxInlineTokens:\s*(\d+)\s*$/m.exec(found[0] ?? '')?.[1]
    expect(Number(size)).toBe(RESERVED_TOOL_RESULT_TOKENS)
  })
})
