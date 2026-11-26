/**
 * What each agent's turns and task runs in flight may still spend, in memory.
 *
 * An agent's monthly ceiling is read from what was published (spentThisMonth):
 * a conversation's turn and a task's run of one agent, checked on the same
 * snapshot, could each pass and together go over it. Each one reserves its
 * bound when it starts (a run: its eurPerRun; a turn: an estimate, its cost
 * being unknown before it ends) and releases it when it ends; the ceiling is
 * checked against what was spent plus what is reserved. One process holds the
 * turns and the runs (the workbench), so this map is the whole truth.
 */

/** What a conversation's turn reserves: an estimate (a turn has no bound of its own), never more than what remains. */
export const TURN_RESERVE_EUR = 0.5

const reserved = new Map<string, number>()

/** @param agentId - an agent. @returns what its turns and runs in flight have reserved, in euros. */
export function reservedFor(agentId: string): number {
  return reserved.get(agentId) ?? 0
}

/**
 * @param agentId - an agent.
 * @param eur - what this turn or run reserves.
 * @returns its release, to call once when it ends (a second call does nothing).
 */
export function reserveSpend(agentId: string, eur: number): () => void {
  const amount = Number.isFinite(eur) && eur > 0 ? eur : 0
  reserved.set(agentId, reservedFor(agentId) + amount)
  let released = false
  return () => {
    if (released) return
    released = true
    const left = Math.max(0, reservedFor(agentId) - amount)
    if (left === 0) reserved.delete(agentId)
    else reserved.set(agentId, left)
  }
}
