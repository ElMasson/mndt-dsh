/**
 * mndt workbench domain: what the product promises, and the rules that keep it.
 *
 * The package has no runtime dependency on purpose: a page, an HTTP route or a
 * test can load it without starting a host, so the rules are provable on their
 * own before anything is wired to a real connector.
 */
export * from './types.ts'
export * from './store.ts'
export * from './service.ts'
