import type { Server } from 'node:http'

/** @param ip - an address, as resolved. @param denied - the instance's own addresses. @returns whether it is a public one. */
export function isPublicAddress(ip: string, denied?: readonly string[]): boolean
/** @returns the public address to connect to, or undefined when any of the host's addresses is not public. */
export function publicTarget(host: string, denied?: readonly string[]): Promise<string | undefined>
/** @returns the proxy server, not yet listening. */
export function egressProxy(denied?: readonly string[]): Server
