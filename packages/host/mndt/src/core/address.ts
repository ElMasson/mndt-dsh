/**
 * The spelling of a person's e-mail.
 * @module
 */
/**
 * One rule for every e-mail that names a person (the proxy's header, the role
 * file's subjects, a channel's members): printable ASCII only, before any
 * lower-casing. toLowerCase() folds a few Unicode characters onto ASCII ones
 * (the Kelvin sign becomes k), so a lookalike spelling could become another
 * person's address.
 * @param value - an e-mail as written.
 * @returns whether it is printable ASCII once trimmed.
 */
export function isPlainAscii(value: string): boolean {
  return /^[\x21-\x7e]+$/.test(value.trim())
}
