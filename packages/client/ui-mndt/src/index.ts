/**
 * Host face of the browser package: a no-op.
 *
 * The page is registered by the `./client` entry. The Cordis row for the browser
 * bundle still needs a module to load on the Host side, so this face exports an
 * `apply` that does nothing: without it the row reports a failed import at boot.
 */
export function apply(): void {}

export type { MndtKey } from './client/locales.ts'
