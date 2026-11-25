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

// The coordinated turns of the drive (#84, #85): the model recognises the role
// a prompt gives it and answers in kind. The verifier gets a remark, so the turn
// goes through a correction; the correction differs from the draft
// (replaced: true); the synthesis is a synthesis. Any other call gets TEXT.
const VERDICT = '{"ok": false, "issues": ["ajoute la date du point"]}'
const CORRECTED = 'Point du trimestre, au 23/11 : le canal est bien reçu, date ajoutée.'
const SYNTHESIS = 'Synthèse de répétition : les deux parts concordent (@assistant et @qwen).'

/** @param content - an OpenAI message content. @returns its text. */
const textOf = content => (typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '')

/** @param asked - a prompt. @returns the handle it gives the model (« Tu es @… »), or ''. */
const handleOf = asked => /Tu es @([a-z0-9-]+)/.exec(asked)?.[1] ?? ''
// A council of the drive: a vote that decides (assistant and analyste for HT,
// qwen for TTC), or, when the question carries « conseil-egalite », three
// different choices (a tie).
const VOTE = { assistant: 1, analyste: 1, qwen: 2 }
const TIE = { assistant: 1, analyste: 2, qwen: 3 }
// « conseil-illisible »: one member answers outside the options (not counted), the two others tie.
const UNREADABLE = { assistant: 1, analyste: 2, qwen: 'illisible' }
/**
 * @param asked - a council prompt.
 * @returns this member's choice. An agent the fake does not know answers no
 * valid choice, and says so in the log: a vote never passes by a default.
 */
const choiceOf = (asked) => {
  const table = asked.includes('conseil-illisible') ? UNREADABLE : asked.includes('conseil-egalite') ? TIE : VOTE
  const choice = table[handleOf(asked)]
  if (choice === undefined) console.log(`fake-llm council-unknown-handle ${handleOf(asked) || '-'}`)
  return choice ?? 'inconnu'
}

/** @param messages - the request's messages. @returns what the model answers, by the role the prompt gives it. */
function answerOf(messages) {
  const asked = messages.filter(message => message.role === 'user').map(message => textOf(message.content)).join('\n')
  // The council's chair frames; the members take positions, then critique.
  if (asked.includes("président d'un conseil")) {
    const tie = asked.includes('conseil-egalite') ? ' (conseil-egalite)' : asked.includes('conseil-illisible') ? ' (conseil-illisible)' : ''
    const slow = asked.includes('sonde-lente') ? ' (sonde-lente)' : ''
    return JSON.stringify({ question: `HT ou TTC${tie}${slow} ?`, options: ['HT', 'TTC'] })
  }
  if (asked.includes('Voici les positions des autres membres')) return `Critique de répétition.\n${JSON.stringify({ about: [], choice: choiceOf(asked) })}`
  if (asked.includes('Prends position seul')) return `Position de répétition.\n${JSON.stringify({ choice: choiceOf(asked) })}`
  // A help: the reading of the advices escalates (the drive answers it), a peer advises.
  if (asked.includes('Voici les avis reçus')) {
    return 'Je retiens l’avis A, sans certitude.\n{"retained": "A", "why": "répétition", "verdict": "escalate", "question": "La facture de répétition est-elle HT ?"}'
  }
  if (asked.includes('te demande ton avis')) return 'Avis de répétition : la facture est HT.'
  if (asked.includes('jamais à exécuter') && asked.includes('Réponse de @')) return VERDICT
  if (asked.includes('Remarques de @')) return CORRECTED
  if (asked.includes('chargé de la synthèse')) return SYNTHESIS
  return TEXT
}

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

/**
 * The help probe: when the message that mentions the agent holds
 * « sonde-entraide », the agent asks two peers of the channel (their ids are in
 * its prompt), once; « sonde-lente » makes the peers answer only after a long
 * while (the drive restarts the workbench meanwhile).
 * @param messages - the request's messages.
 * @returns the ask_peers call, or undefined.
 */
function helpCall(messages) {
  const asked = messages.filter(message => message.role === 'user').map(message => textOf(message.content)).join('\n')
  const mention = asked.split('Message qui te mentionne').at(1) ?? ''
  if (!mention.includes('sonde-entraide') || asked.includes('Voici les avis reçus')) return undefined
  if (messages.some(message => message.role === 'tool')) return undefined
  const line = asked.split('\n').find(row => row.startsWith('Autres agents de ce canal')) ?? ''
  const peers = [...line.matchAll(/id (agt_[a-z0-9]+)/g)].map(m => m[1]).slice(0, 2)
  const slow = mention.includes('sonde-lente') ? ' sonde-lente' : ''
  const args = { task: `Le point du trimestre${slow}`, tried: 'La facture de répétition', blocker: 'HT ou TTC ?', options: ['HT', 'TTC'], need: 'fact', peers }
  return { id: 'call_help_0', type: 'function', function: { name: 'mcp__approvals__ask_peers', arguments: JSON.stringify(args) } }
}

/**
 * @param asked - a prompt.
 * @returns where the channel's context stands in it, for the drive: « ok » when
 * its block opens and closes on the same mark, « ko » when it is there but not
 * so bounded, « - » when absent; and which prompt this is.
 */
function contextOf(asked) {
  const kind = asked.includes('vérificateur dans le canal') ? 'verifier'
    : asked.includes('chargé de la synthèse') ? 'synthesis'
      : asked.includes('Messages récents du canal') ? 'turn' : 'other'
  if (!asked.includes('Informations du canal #')) return `${kind} -`
  const bounded = /Informations du canal #[a-z0-9-]+ \(version \d+\) \[([0-9a-f]+)\][^\n]*\n[\s\S]*?\nFin des informations du canal \[\1\]\./.test(asked)
  return `${kind} ${bounded ? 'ok' : 'ko'}`
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
    // The tools a council's framing, position or critique was offered: none, ever.
    const prompted = messages.filter(message => message.role === 'user').map(message => textOf(message.content)).join('\n')
    const councilKind = prompted.includes("président d'un conseil") ? 'framing'
      : prompted.includes('Voici les positions des autres membres') ? 'critique'
        : prompted.includes('Prends position seul') ? 'position' : undefined
    if (councilKind !== undefined) console.log(`fake-llm council-tools ${calls} ${councilKind}: ${offered.length}`)
    // The reasoning effort each call sent, by kind of call (rehearse.sh
    // scaleway-reasoning-none): a Scaleway model reasons by default, billed,
    // unless the request says « none ».
    const kind = councilKind !== undefined ? `council-${councilKind}`
      : prompted.includes("chargé de trancher pour un conseil") ? 'council-synthesis'
        : prompted.includes(', vérificateur dans le canal #') ? 'verifier'
          : prompted.includes('est bloqué et te demande ton avis') ? 'help-peer'
            : prompted.includes("Tu as demandé de l'aide sur :") ? 'help-reading'
              : prompted.includes(', chargé de la synthèse dans le canal #') ? 'synthesis'
                : prompted.includes('Tu travailles pour Duke Analytics.') ? 'mission'
                  : 'turn'
    console.log(`fake-llm effort ${calls} ${request.model} ${kind} ${request.reasoning_effort ?? '-'}`)
    // Only the last call of a probe carries every result: log them there once.
    const call = nextCall(messages, tag) ?? helpCall(messages)
    if (call === undefined && tag !== '-') logResults(messages, tag)
    const answer = answerOf(messages)
    const userText = messages.filter(message => message.role === 'user').map(message => textOf(message.content)).join('\n')
    console.log(`fake-llm context ${calls}: ${contextOf(userText)}`)
    // A briefing on a space without facts server: its prompt must say so (rehearse.sh briefing-without-facts).
    if (userText.includes('workbench_facts (non monté sur cet espace)')) console.log(`fake-llm no-facts-note ${calls}`)
    // « sonde-marque-<mot> » in the message that mentions the agent (not in the
    // history): the drive reads what that very call was offered, and how many
    // skill blocks its prompt carried. No tool call follows (tag « - »).
    const marked = /sonde-marque-([a-z]+)/.exec(userText.split('Message qui te mentionne').at(1) ?? '')
    if (marked) console.log(`fake-llm marker ${calls} ${marked[1]}: skills=${(userText.match(/Compétence « /g) ?? []).length} tools=${JSON.stringify(offered)}`)
    // « sonde-lente »: a peer's advice comes only after a long while, so the drive
    // can restart the workbench while a help is open.
    const slow = (userText.includes('te demande ton avis') || userText.includes('Prends position seul')) && userText.includes('sonde-lente')
    const respond = () => {
      const created = Math.floor(Date.now() / 1000)
      if (request.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        const base = { id: `chatcmpl-${calls}`, object: 'chat.completion.chunk', created, model: request.model }
        if (call === undefined) {
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }] })}\n\n`)
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
      const message = call === undefined ? { role: 'assistant', content: answer } : { role: 'assistant', content: null, tool_calls: [call] }
      res.end(JSON.stringify({
        id: `chatcmpl-${calls}`, object: 'chat.completion', created, model: request.model,
        choices: [{ index: 0, message, finish_reason: call === undefined ? 'stop' : 'tool_calls' }], usage: USAGE,
      }))
    }
    if (slow) {
      setTimeout(respond, 150_000)
      return
    }
    respond()
  })
}).listen(8000, '0.0.0.0', () => { console.log('fake-llm listening on 8000') })
