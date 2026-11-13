/**
 * Qonto, Dolibarr and Swing expose write tools next to their read tools. Each
 * one is mounted behind the read-only proxy with the allow and deny lists of the
 * versioned catalog. This test runs the proxy over a stub that lists the real
 * tool names of each server and records every call it receives: the visible
 * tools must be the read ones only, and every write call must be refused by the
 * proxy without ever reaching the stub. No network, no credential.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

const deploy = join(import.meta.dirname, '..', 'deploy', 'connectors')
const proxy = join(deploy, 'mcp-proxy.mjs')

interface Preset {
  readonly allow: readonly string[]
  readonly deny: readonly string[]
}

const catalog = JSON.parse(readFileSync(join(deploy, 'catalog.json'), 'utf8')) as Record<string, Preset>

/** The tool names each server publishes today, writes included. */
const servers: Record<string, { reads: readonly string[]; writes: readonly string[] }> = {
  approvals: {
    reads: ['request_approval', 'list_pending_approvals', 'read_approval'],
    // A turn may ask a person, never decide for them.
    writes: ['decide_approval'],
  },
  qonto: {
    reads: [
      'get_authenticated_membership', 'get_client', 'get_client_invoice', 'get_credit_note', 'get_organization',
      'get_payment_link', 'get_qonto_public_pricing', 'get_quote', 'get_subscription',
      'get_supplier_invoice', 'get_transaction', 'list_bank_accounts', 'list_cards', 'list_cash_flow_categories',
      'list_client_invoices', 'list_clients', 'list_credit_notes', 'list_labels', 'list_memberships',
      'list_payment_links', 'list_products', 'list_quotes', 'list_requests',
      'list_supplier_invoices', 'list_teams', 'list_transactions',
    ],
    writes: [
      'approve_request', 'change_card_status', 'create_card', 'create_client_invoice', 'create_transfer_request',
      'create_multi_transfer_request', 'decline_request', 'delete_client', 'mark_client_invoice_as_paid',
      'modify_transaction_cash_flow_category', 'remove_transaction_attachment', 'request_attachment_upload',
      'send_client_invoice', 'send_quote', 'update_card', 'update_client', 'upload_attachment',
      // Read-only, but they hand out presigned download URLs: kept out on purpose.
      'get_attachment', 'get_statement', 'list_statements', 'list_transaction_attachments',
    ],
  },
  dolibarr: {
    reads: [
      'get_contact_by_id', 'get_contacts', 'get_customer_by_id', 'get_customers', 'get_invoice_by_id', 'get_invoices',
      'get_order_by_id', 'get_orders', 'get_product_by_id', 'get_products', 'get_project_by_id', 'get_projects',
      'get_status', 'get_user_by_id', 'get_users', 'list_entities', 'search_customers', 'search_products_by_label',
      'search_products_by_ref', 'search_projects',
    ],
    writes: [
      'dolibarr_raw_api', 'add_invoice_line', 'create_invoice', 'create_invoice_draft', 'create_supplier_invoice',
      'delete_invoice', 'pay_customer_invoice', 'pay_salary', 'pay_supplier_invoice', 'set_entity',
      'set_invoice_project', 'update_customer', 'upload_document', 'validate_invoice', 'validate_supplier_invoice',
    ],
  },
  swing: {
    reads: [
      'get_current_state', 'get_recent_decisions', 'get_session', 'get_task_detail', 'get_timeline', 'get_wiki_page',
      'list_my_tasks', 'list_projects', 'list_sessions', 'list_sprints', 'search_wiki',
    ],
    writes: [
      'add_comment', 'claim_task', 'close_sprint', 'create_task', 'create_wiki_page', 'invite_user', 'mark_step',
      'move_task', 'record_decision', 'update_status', 'update_task', 'update_wiki_page',
      // A prompt that tells the reader to resume work: not a read the turn needs.
      'get_rehydration_prompt',
    ],
  },
}

/** A stdio MCP server listing TOOLS and appending every call it receives to CALLS. */
const stub = `
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const tools = process.env.STUB_TOOLS.split(',').map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }))
const handle = (message) => {
  const reply = (payload) => ({ jsonrpc: '2.0', id: message.id, ...payload })
  if (message.method === 'initialize') return reply({ result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1' } } })
  if (message.method === 'tools/list') return reply({ result: { tools } })
  if (message.method === 'tools/call') {
    appendFileSync(process.env.STUB_CALLS, message.params.name + '\\n')
    return reply({ result: { content: [{ type: 'text', text: 'stub reached ' + message.params.name }] } })
  }
}
createInterface({ input: process.stdin }).on('line', (line) => {
  // A lax parser, like Python's json module: NaN is accepted.
  const message = JSON.parse(line.replace(/NaN/g, 'null'))
  const out = Array.isArray(message) ? message.map(handle) : handle(message)
  process.stdout.write(JSON.stringify(out) + '\\n')
})
`

interface Message {
  readonly id?: number | null
  readonly error?: { readonly code: number }
  readonly result?: {
    readonly tools?: readonly { readonly name: string }[]
    readonly isError?: boolean
    readonly content?: readonly { readonly text?: string }[]
  }
}

const children: ReturnType<typeof spawn>[] = []
afterEach(() => {
  for (const child of children.splice(0)) child.kill()
})

/**
 * Run the proxy with a catalog preset over a stub, send raw lines, collect answers.
 * @returns the answers by id and the tool names the stub actually received.
 */
async function session(server: string, lines: readonly string[]): Promise<{ answers: Message[]; reached: string[] }> {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-readonly-'))
  const stubPath = join(directory, 'stub.mjs')
  const calls = join(directory, 'calls.txt')
  writeFileSync(stubPath, stub)
  const preset = catalog[server]!
  const { reads, writes } = servers[server]!
  const child = spawn(process.execPath, [proxy, process.execPath, stubPath], {
    env: {
      ...process.env,
      MCP_PROXY_ALLOW: preset.allow.join(','),
      MCP_PROXY_DENY: preset.deny.join(','),
      STUB_TOOLS: [...reads, ...writes].join(','),
      STUB_CALLS: calls,
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  children.push(child)
  let output = ''
  child.stdout?.on('data', (chunk) => { output += String(chunk) })
  for (const line of lines) child.stdin?.write(`${line}\n`)
  const parse = (): Message[] => output.split('\n').filter(Boolean).flatMap((line) => {
    const parsed = JSON.parse(line) as Message | Message[]
    return Array.isArray(parsed) ? parsed : [parsed]
  })
  // Wait for one answer per request sent (a batch counts its elements), with a
  // generous bound for a loaded machine; then a short grace for the call log.
  const expected = lines.reduce((total, line) => {
    try {
      const parsed = JSON.parse(line) as unknown
      return total + (Array.isArray(parsed) ? parsed.length : 1)
    } catch {
      return total + 1
    }
  }, 0)
  for (let waited = 0; waited < 15_000 && parse().length < expected; waited += 50) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  await new Promise(resolve => setTimeout(resolve, 200))
  const answers = parse()
  const reached = existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : []
  return { answers, reached }
}

const call = (id: number, name: string): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } })

describe.each(Object.keys(servers))('%s behind the read-only proxy', (server) => {
  const { reads, writes } = servers[server]!

  test('lists exactly the read tools', async () => {
    const { answers } = await session(server, [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })])
    const listed = answers.find(answer => answer.id === 1)?.result?.tools?.map(tool => tool.name) ?? []
    expect([...listed].sort()).toEqual([...reads].sort())
  })

  test('refuses every write tool before it reaches the server', async () => {
    const lines = writes.map((name, index) => call(100 + index, name))
    const { answers, reached } = await session(server, lines)
    expect(reached).toEqual([])
    for (const [index] of writes.entries()) {
      const answer = answers.find(item => item.id === 100 + index)
      expect(answer?.result?.isError).toBe(true)
      expect(answer?.result?.content?.[0]?.text).toContain('outside the read-only allow list')
    }
  })

  test('lets a read tool through', async () => {
    const { reached } = await session(server, [call(7, reads[0]!)])
    expect(reached).toEqual([reads[0]])
  })
})

describe('proxy bypass attempts', () => {
  test('a batch cannot smuggle a write next to a read', async () => {
    const batch = JSON.stringify([JSON.parse(call(1, 'get_invoices')), JSON.parse(call(2, 'dolibarr_raw_api'))])
    const { answers, reached } = await session('dolibarr', [batch])
    expect(reached).toEqual(['get_invoices'])
    expect(answers.find(answer => answer.id === 2)?.result?.isError).toBe(true)
  })

  test('a line only a lax parser accepts never reaches the server', async () => {
    const line = '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"dolibarr_raw_api","arguments":{"x":NaN}}}'
    const { answers, reached } = await session('dolibarr', [line])
    expect(reached).toEqual([])
    expect(answers.some(answer => answer.error?.code === -32700)).toBe(true)
  })

  test('the deny list wins over a matching allow prefix', async () => {
    const { reached } = await session('qonto', ['get_attachment', 'get_statement', 'list_statements', 'list_transaction_attachments'].map((name, index) => call(4 + index, name)))
    expect(reached).toEqual([])
  })
})
