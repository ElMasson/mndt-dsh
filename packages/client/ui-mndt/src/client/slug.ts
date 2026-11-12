/**
 * A channel title as typed ("Compta Orange") written in the identifier form the workbench requires
 * for `name` (`[a-z0-9][a-z0-9-]{1,31}`): lowercase, accents dropped, any other run of characters a
 * single hyphen, no hyphen at either end, 32 characters at most. Formatting only: whether the
 * identifier is valid and free is the Host's answer (400 or 409, shown as served).
 */
export function slugOf(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 32)
    .replace(/-+$/gu, '')
}
