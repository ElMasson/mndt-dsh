#!/usr/bin/env node
/**
 * Check one mounted connector the way the workbench runs it, without a model.
 *
 *   node mcp-check.mjs [--refuse <tool>] [--call <tool>] [--actor <email> --actor-file <path>] -- <command...>
 *
 * Starts the command (the connector's own `sh -lc` row, proxy included), sends
 * initialize then tools/list, and prints the visible tool names. --refuse asks
 * for a tool the proxy must refuse: the call is answered by the proxy and never
 * reaches the server. --call makes one real read and prints only its size or
 * its error, never its content. --actor writes the person a turn would act for
 * into --actor-file first (Office 365 in application mode reads that mailbox).
 *
 * Nothing secret is printed: the env file is sourced by the command itself.
 * Exit 0 when every step passed, 1 otherwise.
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const argv = process.argv.slice(2)
const separator = argv.indexOf('--')
const options = separator < 0 ? [] : argv.slice(0, separator)
const command = separator < 0 ? argv : argv.slice(separator + 1)
/** @param name - option name. @returns its value, or ''. */
const option = (name) => {
  const at = options.indexOf(name)
  return at < 0 ? '' : (options[at + 1] ?? '')
}
const refuse = option('--refuse')
const call = option('--call')
const actor = option('--actor')
const actorFile = option('--actor-file')
const timeoutMs = Number(process.env.MCP_CHECK_TIMEOUT_MS ?? 90_000)

if (command.length === 0) {
  process.stderr.write('usage: mcp-check.mjs [--refuse <tool>] [--call <tool>] [--actor <email> --actor-file <f>] -- <command...>\n')
  process.exit(2)
}
if (actor !== '' && actorFile !== '') writeFileSync(actorFile, JSON.stringify({ actor }), { mode: 0o600 })

const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
let stderr = ''
child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-2000) })
const pending = new Map()
createInterface({ input: child.stdout }).on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  const resolve = pending.get(message?.id)
  if (resolve !== undefined) { pending.delete(message.id); resolve(message) }
})
let ended = false
child.on('exit', () => {
  ended = true
  for (const resolve of pending.values()) resolve({ error: { message: 'the connector exited' } })
  pending.clear()
})

let next = 1
/** @param method - JSON-RPC method. @param params - its params. @returns the answer. */
function request(method, params) {
  const id = next++
  return new Promise((resolve) => {
    if (ended) { resolve({ error: { message: 'the connector exited' } }); return }
    pending.set(id, resolve)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

/** @param answer - a tools/call answer. @returns its text, joined. */
const textOf = (answer) => (answer.result?.content ?? []).map(part => part?.text ?? '').join(' ')

const timer = setTimeout(() => {
  console.log(`echec : pas de reponse en ${Math.round(timeoutMs / 1000)} s`)
  if (stderr.trim() !== '') console.log(`  dernier message du serveur : ${stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`)
  child.kill()
  process.exit(1)
}, timeoutMs)

let ok = true
const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-check', version: '1' } })
if (init.error !== undefined || init.result === undefined) {
  console.log(`echec : initialize : ${init.error?.message ?? 'pas de resultat'}`)
  if (stderr.trim() !== '') console.log(`  dernier message du serveur : ${stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`)
  process.exit(1)
}
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
const listed = await request('tools/list', {})
const names = (listed.result?.tools ?? []).map(tool => tool.name).sort()
if (listed.error !== undefined || names.length === 0) {
  console.log(`echec : tools/list : ${listed.error?.message ?? 'aucun outil visible'}`)
  ok = false
} else {
  console.log(`outils visibles (${names.length}) : ${names.join(', ')}`)
}
if (refuse !== '') {
  const answer = await request('tools/call', { name: refuse, arguments: {} })
  const refused = answer.result?.isError === true && textOf(answer).includes('outside the read-only allow list')
  console.log(refused ? `refus ${refuse} : ok, refuse par le proxy` : `refus ${refuse} : ECHEC, l'appel n'a pas ete refuse`)
  ok &&= refused
}
if (call !== '') {
  const answer = await request('tools/call', { name: call, arguments: {} })
  // Some servers answer a failed upstream call as a normal result whose text is
  // a JSON object with an `error` key (Dolibarr does): that is a failure too,
  // and only its error fields are printed.
  let reported
  try {
    const parsed = JSON.parse(textOf(answer))
    if (parsed !== null && typeof parsed === 'object' && 'error' in parsed) {
      reported = ['error', 'status', 'message', 'details'].map(key => parsed[key]).filter(value => value !== undefined).map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')
    }
  } catch { /* not JSON: a plain answer */ }
  if (answer.error !== undefined || answer.result?.isError === true || reported !== undefined) {
    console.log(`appel ${call} : erreur : ${(reported ?? answer.error?.message ?? textOf(answer)).slice(0, 300)}`)
    ok = false
  } else {
    console.log(`appel ${call} : ok (${textOf(answer).length} caracteres recus, non affiches)`)
  }
}
clearTimeout(timer)
child.stdin.end()
child.kill()
process.exit(ok ? 0 : 1)
