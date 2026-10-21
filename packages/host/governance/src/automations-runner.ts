/**
 * Executing one automation, once.
 *
 * The sequencing is the whole contract: create the agent that will own the run,
 * start the workflow with that agent as parent, await the result, dispose the
 * agent on every path. This file knows nothing about DSH types so the sequencing
 * can be tested without spawning anything; the Host supplies the two closures.
 */

/** The handle an execution owns, and must release. */
export interface AutomationAgentHandle {
  /** Releases the agent and its children. */
  readonly dispose: () => Promise<void>
}

/** What the runner is given about the automation. */
export interface AutomationRunTarget {
  /** Stable identity, for diagnostics. */
  readonly id: string
  /** The owner, so an execution can be attributed. */
  readonly owner: string
  /** The prompt to run. */
  readonly prompt: string
}

/** The two operations a Host must provide. */
export interface AutomationRunDeps {
  /** Creates the agent that will parent the workflow. */
  readonly createAgent: (target: AutomationRunTarget) => Promise<AutomationAgentHandle>
  /** Starts the workflow with that agent and awaits its settled value. */
  readonly startWorkflow: (handle: AutomationAgentHandle, prompt: string) => Promise<unknown>
}

/** What one execution settled to. */
export interface AutomationRunOutcome {
  /** Whether the workflow ran to completion. */
  readonly ok: boolean
  /** The materialized result, on success. */
  readonly result?: unknown
  /** Why it failed, on failure. */
  readonly reason?: string
}

/** @param value - a candidate value. @returns whether it is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * A workflow settles to a result object carrying `stopReason`; a resolved
 * promise therefore does not mean the run succeeded. An error stop carries no
 * value and would otherwise be reported as a successful execution.
 * @param result - the settled workflow value.
 * @returns the failure reason, or undefined when the run completed.
 */
function failureOf(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined
  const stopReason = result['stopReason']
  if (stopReason === undefined || stopReason === 'completed') return undefined
  const error = result['error']
  if (typeof error === 'string' && error !== '') return error
  return `the workflow stopped with ${String(stopReason)}`
}

/**
 * Run one automation.
 * @param deps - creation and workflow-start closures.
 * @param target - the automation to run.
 * @returns the outcome; a failure is reported, never thrown.
 */
export async function executeAutomation(
  deps: AutomationRunDeps,
  target: AutomationRunTarget,
): Promise<AutomationRunOutcome> {
  let handle: AutomationAgentHandle | undefined
  try {
    handle = await deps.createAgent(target)
    const result = await deps.startWorkflow(handle, target.prompt)
    const failure = failureOf(result)
    if (failure !== undefined) return { ok: false, reason: failure }
    return { ok: true, result }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  } finally {
    // Disposal must not mask the outcome: an agent that resists teardown is a
    // leak, not a successful run.
    if (handle !== undefined) {
      try {
        await handle.dispose()
      } catch {
        // The run already settled; teardown failures are the Host's to observe.
      }
    }
  }
}
