/**
 * Presentation layer for the governance panel.
 *
 * The values mirror the mndt brand guide already applied by
 * `@deepseek-ai/dsh-client-ui-brand-mndt`: offwhite canvas, white cards, warm
 * border, charcoal text, electric accent, Space Grotesk for display and Inter for
 * body. They are declared here, scoped under `.gov`, because a client plugin
 * cannot rely on the shell's own class names staying stable.
 */

const CSS = `
.gov {
  --gov-canvas: #F6F4F1;
  --gov-card: #FFFFFF;
  --gov-border: #E2E4E9;
  --gov-divider: #F0EFED;
  --gov-ink: #0C0F17;
  --gov-muted: #6E7480;
  --gov-faint: #B8BDC9;
  --gov-accent: var(--dsw-static-deepseek-500, #4B5CFF);
  --gov-accent-soft: var(--dsw-static-deepseek-50, #EFF1FF);
  --gov-warm: #FBF3E4;
  --gov-warm-border: #EADFC4;
  --gov-radius: 12px;
  --gov-radius-sm: 8px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 32px 40px 48px;
  width: 100%;
  max-width: 1180px;
  margin: 0 auto;
  min-height: 100%;
  box-sizing: border-box;
  background: transparent;
  color: var(--gov-ink);
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.45;
}

.gov-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.gov-title {
  margin: 0;
  font-family: "Space Grotesk", Inter, ui-sans-serif, system-ui, sans-serif;
  font-size: 32px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--gov-ink);
}

.gov-sub {
  margin: 6px 0 0;
  color: var(--gov-muted);
  font-size: 13px;
}

.gov-body {
  display: grid;
  grid-template-columns: 224px minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}

.gov-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  background: var(--gov-card);
  border: 1px solid var(--gov-border);
  border-radius: var(--gov-radius);
}

.gov-nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border: 0;
  border-radius: var(--gov-radius-sm);
  background: transparent;
  color: var(--gov-muted);
  font: inherit;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
}

.gov-nav-item:hover { background: var(--gov-divider); color: var(--gov-ink); }

.gov-nav-item[aria-selected="true"] {
  background: var(--gov-divider);
  color: var(--gov-ink);
  font-weight: 600;
}

.gov-nav-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--gov-faint);
  flex: 0 0 auto;
}

.gov-nav-item[aria-selected="true"] .gov-nav-dot { background: var(--gov-accent); }

.gov-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.gov-card {
  background: var(--gov-card);
  border: 1px solid var(--gov-border);
  border-radius: var(--gov-radius);
  overflow: hidden;
}

.gov-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--gov-divider);
}

.gov-card-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.gov-card-body { padding: 16px; }

.gov-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border: 1px solid var(--gov-border);
  border-radius: 999px;
  background: var(--gov-card);
  color: var(--gov-muted);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}

.gov-pill[data-tone="warn"] {
  background: var(--gov-warm);
  border-color: var(--gov-warm-border);
  color: #8A6A1F;
}

.gov-pill[data-tone="ok"] {
  background: var(--gov-accent-soft);
  border-color: #DDE1FF;
  color: #3F4DE6;
}

/* The identity is a fact about the reader, not a status of the table. */
.gov-pill[data-tone="id"] {
  background: var(--gov-card);
  border-color: var(--gov-border);
  color: var(--gov-text);
  font-family: var(--gov-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 10.5px;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.gov-head-state {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.gov-banner {
  display: flex;
  gap: 10px;
  align-items: baseline;
  padding: 12px 14px;
  border: 1px solid var(--gov-warm-border);
  border-radius: var(--gov-radius-sm);
  background: var(--gov-warm);
  color: #6E5416;
  font-size: 12px;
}

.gov-banner[data-tone="bad"] {
  border-color: #F0C9C9;
  background: #FDF1F1;
  color: #8C2F2F;
}

.gov-status { margin: 0; color: var(--gov-muted); font-size: 12px; }

.gov-form {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-end;
  padding: 16px;
}

.gov-field { display: flex; flex-direction: column; gap: 6px; min-width: 160px; }

.gov-label {
  color: var(--gov-muted);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.gov-input,
.gov-select {
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--gov-border);
  border-radius: var(--gov-radius-sm);
  background: var(--gov-card);
  color: var(--gov-ink);
  font: inherit;
}

.gov-input:focus,
.gov-select:focus {
  outline: none;
  border-color: var(--gov-accent);
  box-shadow: 0 0 0 3px var(--gov-accent-soft);
}

.gov-button {
  height: 34px;
  padding: 0 14px;
  border: 1px solid var(--gov-border);
  border-radius: var(--gov-radius-sm);
  background: var(--gov-card);
  color: var(--gov-ink);
  font: inherit;
  font-weight: 500;
  cursor: pointer;
}

.gov-button:hover { background: var(--gov-divider); }

.gov-button[data-variant="primary"] {
  background: var(--gov-ink);
  border-color: var(--gov-ink);
  color: #FFFFFF;
}

.gov-button[data-variant="primary"]:hover { background: #1E232C; }

.gov-button[data-variant="quiet"] {
  border-color: transparent;
  color: var(--gov-muted);
}

.gov-rows { display: flex; flex-direction: column; }

.gov-row {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 12px 16px;
  border-top: 1px solid var(--gov-divider);
}

.gov-row:first-child { border-top: 0; }

.gov-row[data-columns="2"] { grid-template-columns: minmax(0, 2fr) auto; }
.gov-row[data-columns="3"] { grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr) auto; }

.gov-row-head {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--gov-divider);
  color: var(--gov-muted);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.gov-row-head[data-columns="2"] { grid-template-columns: minmax(0, 2fr) auto; }
.gov-row-head[data-columns="3"] { grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr) auto; }

.gov-cell { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.gov-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--gov-ink);
}

.gov-muted { color: var(--gov-muted); }

.gov-empty {
  margin: 16px;
  padding: 36px 16px;
  border: 1px dashed var(--gov-border);
  border-radius: var(--gov-radius-sm);
  color: var(--gov-muted);
  text-align: center;
  font-size: 13px;
}

@media (max-width: 980px) {
  .gov-body { grid-template-columns: 1fr; }
  .gov-nav { flex-direction: row; flex-wrap: wrap; }
  .gov-nav-item { width: auto; }
}
`

/** Marker attribute so a hot reload replaces the sheet instead of stacking it. */
const STYLE_ID = 'dsh-governance-styles'

/**
 * Install the panel stylesheet once.
 * @returns a disposer that removes it.
 */
export function installGovernanceStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) existing.remove()
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.append(style)
  return () => { style.remove() }
}
