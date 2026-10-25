/**
 * Presentation for the morning page.
 *
 * Values mirror the mndt brand already applied by the brand plugin: offwhite
 * canvas, white cards, warm border, charcoal text, electric accent. Selectors are
 * scoped under `.mndt` because a client plugin cannot rely on shell class names.
 */
export const CSS = `
.mndt {
  --mndt-canvas: #F6F4F1;
  --mndt-card: #FFFFFF;
  --mndt-border: #E2E4E9;
  --mndt-text: #1B1D22;
  --mndt-muted: #6B7180;
  --mndt-accent: #4B5CFF;
  --mndt-accent-soft: #EDEFFF;
  --mndt-warm: #FDF3E2;
  --mndt-warm-border: #F0DDBB;
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 28px 32px 48px;
  background: var(--mndt-canvas);
  color: var(--mndt-text);
  font-family: Inter, system-ui, sans-serif;
  min-height: 100%;
  overflow-y: auto;
}

.mndt-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.mndt-title { margin: 0; font-family: "Space Grotesk", Inter, sans-serif; font-size: 30px; letter-spacing: -0.02em; }
.mndt-sub { margin: 6px 0 0; color: var(--mndt-muted); font-size: 14px; }

.mndt-pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px; border: 1px solid var(--mndt-border); border-radius: 999px;
  background: var(--mndt-card); color: var(--mndt-muted); font-size: 11px; white-space: nowrap;
}
.mndt-pill[data-tone="id"] {
  color: var(--mndt-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px;
}
.mndt-pill[data-tone="write"] { background: var(--mndt-accent-soft); border-color: #DDE1FF; color: #3F4DE6; }

.mndt-grid { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 18px; align-items: start; }
@media (max-width: 1100px) { .mndt-grid { grid-template-columns: minmax(0, 1fr); } }

.mndt-card { background: var(--mndt-card); border: 1px solid var(--mndt-border); border-radius: 14px; overflow: hidden; }
.mndt-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--mndt-border); }
.mndt-card-title { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: 0.01em; }
.mndt-count { font-size: 11px; color: var(--mndt-muted); }
.mndt-card-body { padding: 8px 16px 14px; display: flex; flex-direction: column; gap: 10px; }
.mndt-empty { margin: 6px 0; color: var(--mndt-muted); font-size: 13px; }

.mndt-row { display: flex; flex-direction: column; gap: 6px; padding: 10px 0; border-bottom: 1px dashed var(--mndt-border); }
.mndt-row:last-child { border-bottom: 0; }
.mndt-row-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.mndt-row-title { font-size: 13.5px; font-weight: 550; }
.mndt-row-meta { color: var(--mndt-muted); font-size: 11.5px; }
.mndt-row-actions { display: flex; gap: 8px; align-items: center; margin-top: 2px; }

.mndt-button {
  border: 1px solid var(--mndt-border); background: var(--mndt-card); color: var(--mndt-text);
  border-radius: 8px; padding: 5px 11px; font-size: 12px; cursor: pointer;
}
.mndt-button[data-variant="primary"] { background: var(--mndt-text); color: #fff; border-color: var(--mndt-text); }
.mndt-button[data-variant="danger"] { color: #B23A2E; border-color: #EED2CE; }
.mndt-button:disabled { opacity: 0.55; cursor: default; }

.mndt-input {
  border: 1px solid var(--mndt-border); border-radius: 8px; padding: 6px 9px;
  font-size: 12.5px; background: #fff; color: var(--mndt-text); min-width: 0;
}
.mndt-textarea { min-height: 54px; resize: vertical; }

.mndt-markdown { font-size: 12.8px; line-height: 1.55; color: var(--mndt-text); white-space: pre-wrap; }
.mndt-error { color: #B23A2E; font-size: 12px; }
.mndt-note { font-size: 12.5px; }
.mndt-note-meta { color: var(--mndt-muted); font-size: 11px; }
.mndt-details summary { cursor: pointer; font-size: 13px; font-weight: 550; }

.mndt-onboarding { flex-shrink: 0; }
.mndt-onboarding .mndt-sub { margin-top: 4px; font-size: 12.5px; }
.mndt-steps { list-style: none; margin: 4px 0 6px; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.mndt-step { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.mndt-step-dot {
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; border-radius: 999px;
  border: 1px solid var(--mndt-border); color: var(--mndt-muted); font-size: 11px;
}
.mndt-step[data-done="true"] .mndt-step-dot { background: var(--mndt-accent-soft); border-color: #DDE1FF; color: #3F4DE6; }
.mndt-step-label { flex: 1; }
.mndt-step-value { color: var(--mndt-muted); font-size: 11.5px; }
.mndt-team { border-top: 1px dashed var(--mndt-border); padding-top: 12px; display: flex; flex-direction: column; gap: 6px; }
.mndt-team-title { margin: 0; font-size: 12.5px; font-weight: 600; }
.mndt-team-cmd {
  display: block; padding: 8px 10px; border-radius: 8px;
  background: #F4F5F8; border: 1px solid var(--mndt-border);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
  overflow-x: auto; white-space: pre;
}
`
