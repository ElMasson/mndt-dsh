/**
 * What a previous process left unfinished, settled before this one serves
 * anyone: the missions left running (failed), the helps left open (closed,
 * their peers unnamed), the turns left running or queued (cancelled, never
 * relaunched on their own). Only what predates this process's start is
 * touched, so a request posted since it started is never cancelled, even if
 * the API were already open. The gateway awaits it before opening the API.
 */
import type { WorkbenchService } from './core/index.ts'

/**
 * @param service - the product service.
 * @param before - when this process started (ISO): what is newer is left alone.
 * @param warn - the operator's log line.
 * @param fail - an unexpected fault, said with its cause; the API opens anyway.
 * @returns once everything left over has been settled.
 */
export async function reconcileInterrupted(
  service: WorkbenchService,
  before: string,
  warn: (message: string) => void,
  fail: (message: string) => void,
): Promise<void> {
  try {
    const stuck = (await service.listMissions({ status: 'running' })).filter(mission => (mission.startedAt ?? mission.createdAt) < before)
    for (const mission of stuck) {
      await service.failMission(mission.id, 'interrupted by a workbench restart; no result was produced')
    }
    if (stuck.length > 0) warn(`mndt: ${stuck.length} mission(s) left running by a previous process were marked failed`)
    // A help left open by a previous process will never run either: closed,
    // without a reading, so its peers stay unnamed. Then its turns, and every
    // turn left running or queued: cancelled, never relaunched on their own.
    const helps = await service.closeInterruptedHelps(before)
    if (helps > 0) warn(`mndt: ${helps} help(s) left open by a previous process were closed (« redémarrage »)`)
    const turns = await service.cancelInterruptedTurns(before)
    if (turns.running + turns.queued > 0) {
      warn(`mndt: ${turns.running} turn(s) running and ${turns.queued} queued, left by a previous process, were cancelled`)
    }
  } catch (error) {
    fail(`mndt: could not reconcile what a previous process left: ${error instanceof Error ? error.message : String(error)}`)
  }
}
