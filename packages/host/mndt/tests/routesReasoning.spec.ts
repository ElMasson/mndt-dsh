import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

describe('the host never asks a reasoning effort', () => {
  /**
   * The only files that may speak of reasoning or effort outside a comment,
   * each for a reason: anything else that names one would bypass the routes'
   * « off » (a kind of call asking « high » by itself, a provider flag such as
   * `enable_thinking` set in a connector or an environment file).
   */
  const EXCEPTIONS: Readonly<Record<string, string>> = {
    'deploy/llm/routes.patch.yml.template': 'declares each Scaleway model\'s levels, « off » sent as « none »',
    'deploy/rehearsal/fake-llm.mjs': 'logs the effort each call sent (rehearse.sh scaleway-reasoning-none)',
    'deploy/rehearsal/rehearse.sh': 'checks those logs (scaleway-reasoning-none)',
    'deploy/rehearsal/expected-checks-rehearse.txt': 'names that check',
  }
  const COMMENT = /^\s*(\/\/|\/\*|\*|#)/
  const SPOKEN = /effort|thinking|reasoning/i

  /** @param text - a file's text. @returns whether a line outside a comment names an effort, a thinking or a reasoning. */
  function namesEffort(text: string): boolean {
    return text.split('\n').some(line => !COMMENT.test(line) && SPOKEN.test(line))
  }

  /** @param bytes - a file. @returns whether it is text: no NUL byte in its first 8 KiB. */
  function isText(bytes: Buffer): boolean {
    return !bytes.subarray(0, 8192).includes(0)
  }

  /** @param root - the package. @returns every text file of src/ and deploy/ that names one, sorted. */
  function filesNamingEffort(root: string): string[] {
    return ['src', 'deploy'].flatMap(dir => readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
      .map(file => `${dir}/${file.split('\\').join('/')}`))
      .filter(file => !file.split('/').some(part => part === '__pycache__' || part === 'node_modules'))
      .filter(file => statSync(join(root, file)).isFile())
      .filter((file) => {
        const bytes = readFileSync(join(root, file))
        return isText(bytes) && namesEffort(bytes.toString('utf8'))
      })
      .sort()
  }

  it('no text file of src/ nor deploy/ names an effort, a thinking or a reasoning outside a comment, but the named exceptions', () => {
    expect(filesNamingEffort(join(import.meta.dirname, '..'))).toEqual(Object.keys(EXCEPTIONS).sort())
  })

  it('the guard bites, through its own predicate: any text file, an environment example or a Dockerfile included; a comment and a binary pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'effort-guard-'))
    try {
      const write = async (file: string, body: string | Buffer) => {
        await mkdir(dirname(join(root, file)), { recursive: true })
        await writeFile(join(root, file), body)
      }
      await write('src/turn.ts', "    reasoningEffort: 'high',\n")
      await write('deploy/llm/llm.env.example', 'VLLM_ENABLE_THINKING=true\n')
      await write('deploy/Dockerfile.workbench', 'ENV CHAT_TEMPLATE_KWARGS=\'{"enable_thinking": true}\'\n')
      await write('deploy/notes.txt', 'reasoning: on\n')
      await write('src/commented.ts', '  // the effort is the route\'s\n  # Its reasoning models REASON BY DEFAULT\n')
      await write('deploy/blob.bin', Buffer.from([0, 1, 2, ...Buffer.from('reasoning_effort high')]))
      await write('deploy/__pycache__/x.pyc', 'reasoning')
      expect(filesNamingEffort(root)).toEqual(['deploy/Dockerfile.workbench', 'deploy/llm/llm.env.example', 'deploy/notes.txt', 'src/turn.ts'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
