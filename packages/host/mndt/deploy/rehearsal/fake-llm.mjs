// An OpenAI-compatible stand-in for an LLM route, for the assembled rehearsal:
// chat completions, streamed (SSE, usage in the last chunk) or not. It answers a
// fixed French sentence and logs each call, so the rehearsal can prove that a
// real agent turn (DshTurnRunner, the workflow engine, pi-ai) reached a model.
import { createServer } from 'node:http'

let calls = 0
const TEXT = 'Réponse de répétition : le canal est bien reçu.'
const USAGE = { prompt_tokens: 1200, completion_tokens: 12, total_tokens: 1212 }

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
    console.log(`fake-llm call ${calls}: ${req.method} ${req.url} model=${request.model} stream=${request.stream}`)
    const created = Math.floor(Date.now() / 1000)
    if (request.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const base = { id: `chatcmpl-${calls}`, object: 'chat.completion.chunk', created, model: request.model }
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: TEXT }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: USAGE })}\n\n`)
      res.end('data: [DONE]\n\n')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: `chatcmpl-${calls}`, object: 'chat.completion', created, model: request.model,
      choices: [{ index: 0, message: { role: 'assistant', content: TEXT }, finish_reason: 'stop' }], usage: USAGE,
    }))
  })
}).listen(8000, '0.0.0.0', () => { console.log('fake-llm listening on 8000') })
