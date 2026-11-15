// An OpenAI-compatible stand-in for an LLM route, for the assembled rehearsal:
// chat completions, streamed (SSE, usage in the last chunk) or not. It answers a
// fixed French sentence and logs each call, so the rehearsal can prove that a
// real agent turn (DshTurnRunner, the workflow engine, pi-ai) reached a model.
//
// Each call logs the tools it was offered, tagged by the probe the person's
// message names (or « - »), for the rehearsal to compare with the allow-list.
//
// The tool probe: when the person's message holds « sonde-outils-<tag> », the
// model calls, one per step, the engine's shell (it would leave a witness file
// in the working directory), the facts server (never allowed in a channel), and
// the approvals server (a card), then answers. Every tool result it reads back
// is logged as TOOL-RESULT <tag> <tool>: <text>.
import { createServer } from 'node:http'

let calls = 0
const TEXT = 'Réponse de répétition : le canal est bien reçu.'
const USAGE = { prompt_tokens: 1200, completion_tokens: 12, total_tokens: 1212 }
const PROBE = [
  { name: 'bash', args: { command: 'echo probe > policy-witness.txt', description: 'Witness of the tool probe' } },
  { name: 'mcp__workbench_facts__workbench_facts', args: {} },
  { name: 'mcp__approvals__request_approval', args: { kind: 'publish', title: 'Carte de répétition', target: 'rien' } },
]

/** @param content - an OpenAI message content. @returns its text. */
const textOf = content => (typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '')

/** @param messages - the request's messages. @returns the probe tag the person's message names, or « - ». */
function tagOf(messages) {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const found = /sonde-outils-([a-z]+)/.exec(textOf(message.content))
    if (found) return found[1]
  }
  return '-'
}

/** @param messages - the request's messages. @param tag - the probe. @returns the next probe call, or undefined to answer. */
function nextCall(messages, tag) {
  if (tag === '-') return undefined
  const made = messages.filter(message => message.role === 'tool').length
  const step = PROBE[made]
  return step === undefined ? undefined : { id: `call_${tag}_${made}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }
}

/** @param messages - the request's messages. @param tag - the probe. Logs every tool result, by the tool it answers. */
function logResults(messages, tag) {
  const names = new Map()
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) names.set(call.id, call.function?.name)
    if (message.role === 'tool') {
      const text = textOf(message.content).replace(/\s+/g, ' ').slice(0, 300)
      console.log(`TOOL-RESULT ${tag} ${names.get(message.tool_call_id) ?? '?'}: ${text}`)
    }
  }
}

createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-qwen', object: 'model' }] }))
      return
    }
    calls += 1
    let request = {}
    try { request = JSON.parse(body) } catch { /* not JSON */ }
    const messages = request.messages ?? []
    const tag = tagOf(messages)
    console.log(`fake-llm call ${calls}: ${req.method} ${req.url} model=${request.model} stream=${request.stream}`)
    // The tools this call offered the model, sorted: the rehearsal compares them
    // with the allow-list, exactly.
    const offered = (request.tools ?? []).map(tool => tool.function?.name ?? tool.name).sort()
    console.log(`fake-llm tools ${calls} ${tag}: ${JSON.stringify(offered)}`)
    // Only the last call of a probe carries every result: log them there once.
    const call = nextCall(messages, tag)
    if (call === undefined && tag !== '-') logResults(messages, tag)
    const created = Math.floor(Date.now() / 1000)
    if (request.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const base = { id: `chatcmpl-${calls}`, object: 'chat.completion.chunk', created, model: request.model }
      if (call === undefined) {
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: TEXT }, finish_reason: null }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      } else {
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...call }] }, finish_reason: null }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
      }
      res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: USAGE })}\n\n`)
      res.end('data: [DONE]\n\n')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    const message = call === undefined ? { role: 'assistant', content: TEXT } : { role: 'assistant', content: null, tool_calls: [call] }
    res.end(JSON.stringify({
      id: `chatcmpl-${calls}`, object: 'chat.completion', created, model: request.model,
      choices: [{ index: 0, message, finish_reason: call === undefined ? 'stop' : 'tool_calls' }], usage: USAGE,
    }))
  })
}).listen(8000, '0.0.0.0', () => { console.log('fake-llm listening on 8000') })
