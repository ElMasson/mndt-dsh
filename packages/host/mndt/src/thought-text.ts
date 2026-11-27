/**
 * A model's reasoning, removed from the text a run serves.
 *
 * A vLLM server running a reasoning template with no reasoning parser leaves
 * the model's thought in the answer itself: a `<think>…</think>` block, or —
 * when the template opens the block in the prompt — a thought followed by an
 * orphan `</think>` (seen on the instance, 27/11: « @qwen bonjour » answered
 * twice, the tag shown in the thread). This is format plumbing, like
 * `strip_thinking()` on the Tellus side: the tags are the template's, not a
 * judgment on the text.
 */

const BLOCK = /<think>[\s\S]*?<\/think>/g
const CLOSE = '</think>'
const OPEN = '<think>'

/**
 * @param text - the text a run settled with.
 * @returns the text without its reasoning: every `<think>…</think>` block
 * removed; after an orphan `</think>`, only what follows the last one; and an
 * unclosed `<think>` (a thought cut off by the output cap) dropped to the end.
 * What is left is trimmed at its start; an answer that was all reasoning comes
 * back empty, which the runner refuses (« the agent returned no text »), never
 * served as an answer.
 */
export function withoutThought(text: string): string {
  if (!text.includes(CLOSE) && !text.includes(OPEN)) return text
  let kept = text.replace(BLOCK, '')
  const close = kept.lastIndexOf(CLOSE)
  if (close >= 0) kept = kept.slice(close + CLOSE.length)
  const open = kept.indexOf(OPEN)
  if (open >= 0) kept = kept.slice(0, open)
  return kept.replace(/^\s+/, '')
}
