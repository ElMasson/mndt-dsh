/**
 * Whether a failure means the workspace is not answering at all, rather than refusing one call.
 * The gateway answers 502, 503 or 504 when the workbench API is down; a request that never reaches
 * it rejects with a TypeError (the fetch network failure). Both are told in the page's own words.
 */
import { ChatRefusal } from './chat.ts'
import { FaceRefusal } from './httpFace.ts'

/** The gateway statuses that mean the workbench API is not there. */
const GATEWAY_DOWN: ReadonlySet<number> = new Set([502, 503, 504])

/**
 * @param failure - a thrown value.
 * @returns whether it says the workspace is not answering.
 */
export function isHostDown(failure: unknown): boolean {
  if (failure instanceof FaceRefusal || failure instanceof ChatRefusal) return GATEWAY_DOWN.has(failure.status)
  return failure instanceof TypeError
}
