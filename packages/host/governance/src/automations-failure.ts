/**
 * Classifying a workflow run's failure signals.
 *
 * A settled `run.result` only reports the script's own stop reason, and the
 * engine's `agent()` resolves `null` when a child run fails. Both of the real
 * signals are therefore read separately: `workflow/agent-end` for the child's
 * outcome, and the child session's `turn/end` for the reason a turn died.
 *
 * These functions hold the decision so it can be unit-tested without mounting a
 * workflow engine; the gateway only forwards what the events carry.
 */

/** What `workflow/agent-end` reports about one `agent()` call. */
export interface AgentEndSignal {
  /** `completed` when the child turn succeeded. */
  readonly outcome: string
  /** Position of the call inside the script, for the message. */
  readonly seq: number
  /** The call label, when the script named it. */
  readonly label?: unknown
}

/** What a child session's `turn/end` reports about why it stopped. */
export interface TurnEndSignal {
  /** The failed turn's parent session, undefined for a root session. */
  readonly parentSession: string | undefined
  /** The turn end kind: `completed`, `error`, and so on. */
  readonly kind: string
  /** The message the turn failed with, when it failed. */
  readonly message: string | undefined
}

/**
 * Judge one `agent()` completion.
 * @param signal - what the event reports.
 * @returns the failure text, or undefined when the call completed.
 */
export function failureOfAgentEnd(signal: AgentEndSignal): string | undefined {
  if (signal.outcome === 'completed') return undefined
  return `agent() call ${signal.seq} (${JSON.stringify(signal.label)}) ended ${signal.outcome}`
}

/**
 * Judge one child turn end.
 * @param childSessionId - the session the automation created.
 * @param signal - what the event reports.
 * @returns the failure text, or undefined when the turn completed or belongs elsewhere.
 */
export function failureOfTurnEnd(childSessionId: string, signal: TurnEndSignal): string | undefined {
  if (signal.parentSession !== childSessionId) return undefined
  if (signal.kind !== 'error') return undefined
  return `the agent turn failed: ${signal.message ?? 'no message'}`
}
