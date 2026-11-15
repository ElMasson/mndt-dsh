/**
 * Formats the team screen shares: amounts, times and dates, in the language of the page.
 */

/**
 * The language the page is shown in (the locale plugin sets it on the document), not the browser's:
 * an English browser on a French workspace reads « 17:50 » and « 1 020 », not « 05:50 PM » and « 1,020 ».
 * @returns the page's language, or undefined where none is declared.
 */
export function pageLanguage(): string | undefined {
  if (typeof document === 'undefined') return undefined
  return document.documentElement.lang === '' ? undefined : document.documentElement.lang
}

/**
 * An amount in euros, small ones kept readable.
 * @param eur - the amount.
 * @returns it formatted in the page's language.
 */
export function euros(eur: number): string {
  return new Intl.NumberFormat(pageLanguage() ?? 'fr', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(eur)
}

/** @param iso - an instant. @returns its time of day, in the page's language. */
export function clock(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(pageLanguage(), { hour: '2-digit', minute: '2-digit' })
}

/** @param iso - an instant. @returns its day in full (« samedi 14 novembre 2026 »), in the page's language. */
export function dayLong(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat(pageLanguage() ?? 'fr', { dateStyle: 'full' }).format(d)
}

/** @param iso - an instant. @returns its date and time (« 14 nov. 2026, 10:32 »), in the page's language. */
export function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat(pageLanguage() ?? 'fr', { dateStyle: 'medium', timeStyle: 'short' }).format(d)
}
