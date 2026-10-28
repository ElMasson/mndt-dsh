/**
 * Which person a mission acts for, published where the machine tools read it.
 *
 * MCP connectors are mounted once for the workbench, so their environment cannot
 * carry one person. The mission runner therefore writes this record for the
 * duration of a run and removes it afterwards, and missions run one at a time so
 * that a tool call can never read another mission's actor.
 */
import { readFile, unlink, writeFile } from 'node:fs/promises'

/** Where the record lives; the machine connector is configured from this path. */
export const actorFilePath = (): string => process.env.MNDT_MISSION_ACTOR_FILE ?? '/state/mission-actor.json'

/** @param actor - who the running mission acts for. @param missionId - the mission id. */
export async function publishActor(actor: string, missionId: string): Promise<void> {
  await writeFile(actorFilePath(), JSON.stringify({ actor, missionId }), 'utf8')
}

/** Remove the record once the mission settled. */
export async function clearActor(): Promise<void> {
  await unlink(actorFilePath()).catch(() => undefined)
}

/** @returns the published record, or undefined when no mission runs. */
export async function readActor(): Promise<{ actor: string; missionId: string } | undefined> {
  const raw = await readFile(actorFilePath(), 'utf8').catch(() => '')
  if (raw.trim() === '') return undefined
  try {
    const record = JSON.parse(raw) as { actor?: unknown; missionId?: unknown }
    if (typeof record.actor !== 'string' || record.actor === '') return undefined
    return { actor: record.actor, missionId: typeof record.missionId === 'string' ? record.missionId : '' }
  } catch {
    return undefined
  }
}
