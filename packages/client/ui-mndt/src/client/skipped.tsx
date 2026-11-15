/**
 * Rows of the role file the core set aside (#75): read from `/me` only when well formed, and said
 * in a quiet band to whom `/me` tells them (owners and admins, and the owner whose own row it is).
 */
import type { ReactNode } from 'react'
import { translate } from './locales.ts'

/** One row of the role file the core set aside, and why. */
export interface SkippedRow {
  readonly row: number
  readonly reason: string
}

/**
 * @param me - what `/me` answered.
 * @returns the rows of the role file set aside, as the API serves them; anything of another shape
 * is dropped, and an absent or empty field gives none.
 */
export function skippedOf(me: { readonly grantsSkipped?: unknown } | undefined): readonly SkippedRow[] {
  const rows: unknown = me?.grantsSkipped
  if (!Array.isArray(rows)) return []
  return rows.flatMap((item: unknown): SkippedRow[] => {
    if (typeof item !== 'object' || item === null) return []
    const { row, reason } = item as { row?: unknown; reason?: unknown }
    if (typeof row !== 'number' || !Number.isInteger(row) || row < 1 || typeof reason !== 'string' || reason.trim() === '') return []
    // A reason is the core's sentence: shown as text, bounded.
    return [{ row, reason: reason.length > 200 ? `${reason.slice(0, 199)}…` : reason }]
  })
}

/** @param props - the rows set aside. @returns the line that says them, or nothing when there are none. */
export function SkippedRows(props: { readonly rows: readonly SkippedRow[] }): ReactNode {
  if (props.rows.length === 0) return undefined
  const [first] = props.rows
  return (
    <div className="mw-skipped" role="note" data-testid="grants-skipped">
      {props.rows.length === 1 && first !== undefined
        ? <p>{translate('shell.skipped-one', { row: first.row, reason: first.reason })}</p>
        : (
          <>
            <p>{translate('shell.skipped-many', { count: props.rows.length })}</p>
            <ul>{props.rows.map(r => <li key={r.row}>{translate('shell.skipped-row', { row: r.row, reason: r.reason })}</li>)}</ul>
          </>
        )}
    </div>
  )
}
