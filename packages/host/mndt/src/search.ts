import type { WorkbenchState } from './types.ts'

/** One search hit the page can show. */
export interface SearchHitRow {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly detail: string
  readonly at: string
}

/** @param value - text to test. @param needle - lower-case query. @returns whether the text matches. */
function matches(value: string, needle: string): boolean {
  return value.toLowerCase().includes(needle)
}

/**
 * Search everything the caller may see, not only the page already loaded.
 * @param snapshot - the whole workbench state.
 * @param identity - who searches.
 * @param canAdmin - whether the caller holds the administration right.
 * @param query - the raw search text.
 * @returns the newest matching rows, forty at most.
 */
export function searchState(
  snapshot: WorkbenchState,
  identity: string,
  canAdmin: boolean,
  query: string,
): readonly SearchHitRow[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  const hits: SearchHitRow[] = []
  for (const mission of snapshot.missions) {
    if (mission.visibility !== 'team' && mission.createdBy !== identity) continue
    if (!matches(mission.prompt, needle) && !matches(mission.id, needle)) continue
    hits.push({
      id: mission.id, kind: 'mission', label: mission.prompt.slice(0, 90), at: mission.createdAt,
      detail: `${mission.kind}, ${mission.status}, par ${mission.createdBy}`,
    })
  }
  for (const brief of snapshot.briefs) {
    if ((brief.visibility ?? 'team') !== 'team' && brief.createdBy !== identity) continue
    const heading = brief.markdown.split('\n').map(line => line.replace(/^#+\s*/, '').trim()).find(line => line !== '') ?? brief.id
    if (!matches(brief.markdown, needle) && !matches(brief.id, needle) && !matches(heading, needle)) continue
    hits.push({ id: brief.id, kind: 'brief', label: heading.slice(0, 90), at: brief.createdAt, detail: 'brief' })
  }
  for (const approval of snapshot.approvals) {
    if (approval.state !== 'pending') continue
    if (!matches(approval.title, needle) && !matches(approval.id, needle)) continue
    hits.push({
      id: approval.id, kind: 'approval', label: approval.title, at: approval.requestedAt,
      detail: `${approval.kind}, demandee par ${approval.requestedBy}`,
    })
  }
  for (const mandate of snapshot.mandates) {
    if (!canAdmin && mandate.delegataire !== identity && mandate.delegant !== identity) continue
    const label = mandate.purpose === '' ? mandate.id : mandate.purpose
    if (!matches(label, needle) && !matches(mandate.id, needle)) continue
    hits.push({
      id: mandate.id, kind: 'mandate', label, at: mandate.expiresOn,
      detail: `${mandate.delegant} vers ${mandate.delegataire}, echeance ${mandate.expiresOn}`,
    })
  }
  for (const note of snapshot.memories) {
    if (note.scope !== 'team' && note.createdBy !== identity) continue
    if (!matches(note.text, needle) && !matches(note.id, needle)) continue
    hits.push({ id: note.id, kind: 'memory', label: note.text.slice(0, 90), at: note.createdAt, detail: note.scope })
  }
  hits.sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : 0))
  return hits.slice(0, 40)
}
