import type { Server } from 'node:http'

/** @param entry - an item of EGRESS_DENY. @returns whether it is an address or a CIDR range. */
export function validDenial(entry: string): boolean
/** @param ip - an address, as resolved. @param denied - EGRESS_DENY: addresses or CIDR ranges. @returns whether it is a public one. */
export function isPublicAddress(ip: string, denied?: readonly string[]): boolean
/** @returns the public address to connect to, or undefined when any of the host's addresses is not public. */
export function publicTarget(host: string, denied?: readonly string[]): Promise<string | undefined>
/** @returns the proxy server, not yet listening. */
export function egressProxy(denied?: readonly string[]): Server
/** @returns a plain request's headers as sent upstream: without this proxy's or this hop's. */
export function forwardedHeaders(headers: Readonly<Record<string, unknown>>, host: string): Record<string, unknown>
