/**
 * Sidebar glyph for the governance entry.
 *
 * Kept in its own `.tsx` file because the plugin entry is a `.ts` module: JSX is
 * not available there.
 * @returns The icon element.
 */
export function GovernanceIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.6 13.6 4v4.2c0 3.1-2.2 5.5-5.6 6.2-3.4-.7-5.6-3.1-5.6-6.2V4L8 1.6Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M5.9 8.1 7.4 9.6l2.9-3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
