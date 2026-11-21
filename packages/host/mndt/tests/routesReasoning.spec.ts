import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { assemble } from '../../../llm/llm-pi-ai/tests/assemble.ts'
import {
  closeMockServers,
  mockServer,
  textEvents,
} from '../../../llm/llm-pi-ai/tests/mock-server.ts'

/**
 * The tenant's LLM routes as render-llm-routes.py writes them, through the real
 * pi-ai adapter, against a fake server that records each request body.
 * Scaleway's reasoning models reason BY DEFAULT when reasoning_effort is absent,
 * and those tokens are billed: a turn that asks no effort must send « none ».
 */
const routes = join(
  import.meta.dirname,
  '..',
  'deploy',
  'llm',
  'render-llm-routes.py',
)

/** @returns the scaleway-genapi provider of the rendered routes. */
function scalewayRoute(): Record<string, unknown> {
  const rendered = execFileSync('python3', [routes, '--print'], {
    env: {
      ...process.env,
      SCW_PROJECT_ID: '11111111-2222-3333-4444-555555555555',
      VLLM_QWEN_BASE_URL: 'http://qwen.invalid/v1',
      VLLM_QWEN_MODEL: 'qwen-test',
    },
    encoding: 'utf8',
  })
  const rows = yaml.load(rendered) as {
    id: string
    config?: { providers?: Record<string, Record<string, unknown>> }
  }[]
  const provider = rows.find(row => row.id === 'llm-pi-ai')?.config
    ?.providers?.['scaleway-genapi']
  if (provider === undefined)
    throw new Error('no scaleway-genapi route in the rendered routes')
  return provider
}

afterEach(async () => {
  await closeMockServers()
  vi.unstubAllEnvs()
})

describe('the reasoning of the Scaleway routes', () => {
  for (const model of ['deepseek-v4.1-flash', 'glm-5.3']) {
    it(`${model}: sends reasoning_effort « none » when no effort is asked, and a declared level when one is`, async () => {
      vi.stubEnv('SCW_GENAPI_KEY', 'test-key')
      const server = await mockServer([
        { events: textEvents },
        { events: textEvents },
      ])
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LlmPiAi, {
        providers: {
          'scaleway-genapi': {
            ...scalewayRoute(),
            baseURL: `${server.url}/v1`,
          },
        },
      })
      await assemble(ctx, { provider: 'scaleway-genapi', model, messages: [] })
      expect(server.requests[0]).toMatchObject({
        model,
        reasoning_effort: 'none',
      })
      await assemble(ctx, {
        provider: 'scaleway-genapi',
        model,
        reasoningEffort: ReasoningEffortId('high'),
        messages: [],
      })
      expect(server.requests[1]).toMatchObject({
        model,
        reasoning_effort: 'high',
      })
    })
  }
})
