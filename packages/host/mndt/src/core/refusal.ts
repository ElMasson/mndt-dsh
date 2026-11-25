/**
 * A refusal the host writes: its message is the host's own words (« a rejection
 * needs a reason », « no channel … »), meant for the person or the agent who
 * asked, and served as such. Anything else that fails (a network call, a
 * provider, the file system, a parser) carries words the host did not write:
 * it is never served as such (publicFailure, src/public-failure.ts).
 */
export class Refusal extends Error {
  /** @param message - the host's words. */
  constructor(message: string) {
    super(message)
    this.name = 'Refusal'
  }
}
