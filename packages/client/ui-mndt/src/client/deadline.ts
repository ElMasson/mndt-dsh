/**
 * A read that waits for the workspace at most so long. A gateway that never answers (neither 502
 * nor refused) would otherwise leave the page on « Chargement de l'espace… » until the browser
 * gives up, minutes later. Writes are not bounded: a mission is answered once it settled.
 */

/** How long a read waits for the workspace, in milliseconds. */
export const READ_DEADLINE_MS = 15000

/** The workspace did not answer a read in time. */
export class HostTimeout extends Error {
  /** @param path - the route that did not answer. */
  constructor(path: string) {
    super(`the workspace did not answer ${path} within ${String(READ_DEADLINE_MS / 1000)} s`)
    this.name = 'HostTimeout'
  }
}

/**
 * Run one read with its deadline.
 * @param path - the route, for the error.
 * @param work - the fetch, given the signal that stops it.
 * @param ms - the deadline (tests pass their own).
 * @returns the response.
 */
export async function readWithin(
  path: string,
  work: (signal: AbortSignal) => Promise<Response>,
  ms: number = READ_DEADLINE_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, ms)
  try {
    return await work(controller.signal)
  } catch (failure) {
    if (controller.signal.aborted) throw new HostTimeout(path)
    throw failure
  } finally {
    clearTimeout(timer)
  }
}
