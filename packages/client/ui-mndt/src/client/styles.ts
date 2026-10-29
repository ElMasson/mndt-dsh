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
  --mndt-text: #0C0F17;
  --mndt-muted: #5A6475;
  --mndt-accent: #4B5CFF;
  --mndt-accent-soft: #EDEFFF;
  --mndt-warm: #FDF3E2;
  --mndt-warm-border: #F0DDBB;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 24px 28px 48px;
  background: var(--mndt-canvas);
  color: var(--mndt-text);
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  font-size: 15px;
  line-height: 1.5;
  min-height: 100%;
  overflow-y: auto;
}

.mndt-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.mndt-title { margin: 0; font-family: "Space Grotesk", Inter, sans-serif; font-size: 28px; font-weight: 700; letter-spacing: -0.01em; }
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

.mndt-card { background: var(--mndt-card); border: 1px solid var(--mndt-border); border-radius: 16px; overflow: hidden; }
.mndt-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--mndt-border); }
.mndt-card-title { margin: 0; font-family: "Space Grotesk", Inter, sans-serif; font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
.mndt-count { font-size: 11px; color: var(--mndt-muted); }
.mndt-card-body { padding: 10px 18px 16px; display: flex; flex-direction: column; gap: 10px; }
.mndt-empty { margin: 6px 0; color: var(--mndt-muted); font-size: 13px; }

.mndt-row { display: flex; flex-direction: column; gap: 6px; padding: 10px 0; border-bottom: 1px dashed var(--mndt-border); }
.mndt-row:last-child { border-bottom: 0; }
.mndt-row-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.mndt-row-title { font-size: 13.5px; font-weight: 550; }
.mndt-row-meta { color: var(--mndt-muted); font-size: 11.5px; }
.mndt-row-actions { display: flex; gap: 8px; align-items: center; margin-top: 2px; flex-wrap: wrap; }
.mndt-form-input { min-width: 130px; }

.mndt-button {
  border: 1px solid var(--mndt-border); background: var(--mndt-card); color: var(--mndt-text);
  border-radius: 12px; padding: 7px 14px; font-size: 13px; font-weight: 500; cursor: pointer; transition: background-color 160ms cubic-bezier(0.16, 1, 0.3, 1), border-color 160ms cubic-bezier(0.16, 1, 0.3, 1);
}
.mndt-button[data-variant="primary"] { background: #0C0F17; color: #fff; border-color: #0C0F17; }
.mndt-button:hover { background: #F0EFED; }
.mndt-button[data-variant="primary"]:hover { background: #121722; border-color: #121722; }
.mndt-button[data-variant="danger"] { color: #B23A2E; border-color: #EED2CE; }
.mndt-button:disabled { opacity: 0.55; cursor: default; }

.mndt-input {
  border: 1px solid var(--mndt-border); border-radius: 10px; padding: 7px 10px;
  font-size: 13.5px; background: #fff; color: var(--mndt-text); min-width: 0;
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

.mndt-filter { max-width: 190px; }
.mndt-tag {
  display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 999px;
  border: 1px solid var(--mndt-border); color: var(--mndt-muted); font-size: 10px; font-weight: 500;
}

.mndt-usage { display: flex; flex-wrap: wrap; gap: 12px; font-size: 11.5px; color: var(--mndt-muted); }

.mndt-tour { position: fixed; inset: 0; z-index: 60; background: rgba(26, 26, 26, 0.28); }
.mndt-tour-ring {
  position: fixed; border: 2px solid var(--mndt-accent); border-radius: 14px;
  box-shadow: 0 0 0 9999px rgba(26, 26, 26, 0.18); pointer-events: none; transition: all 160ms ease;
}
.mndt-tour-card {
  position: fixed; width: 380px; padding: 18px 20px; border-radius: 16px;
  background: var(--mndt-surface); border: 1px solid var(--mndt-border);
  box-shadow: 0 18px 40px rgba(20, 20, 20, 0.18);
}
.mndt-tour-count { font-size: 11px; color: var(--mndt-muted); }
.mndt-tour-title { margin: 6px 0 8px; font-size: 16px; }
.mndt-tour-body { margin: 0 0 14px; font-size: 13px; line-height: 1.5; color: var(--mndt-muted); }
.mndt-tour-actions { display: flex; align-items: center; gap: 8px; }
.mndt-tour-spacer { flex: 1; }

.mndt-shot { display: block; width: 100%; height: auto; margin-top: 10px; border-radius: 12px; border: 1px solid var(--mndt-border); }

.mndt-error { margin: 8px 0 0; font-size: 12px; color: #b3261e; }
.mndt-browser-text { max-height: 180px; overflow: auto; margin: 8px 0 0; padding: 10px; border-radius: 10px;
  background: var(--mndt-surface-alt, #f4f2ee); font-size: 11px; line-height: 1.4; white-space: pre-wrap; }
/* ---------- collaboration space (P0): channels, feed, context ---------- */
.mndt-collab {
  display: grid;
  grid-template-columns: 264px minmax(0, 1fr) 320px;
  gap: 0;
  padding: 0;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--mndt-canvas);
}
.mndt-loading { padding: 40px; color: var(--mndt-muted); }

.mndt-channels {
  display: flex; flex-direction: column; gap: 2px;
  padding: 14px 10px 12px;
  background: var(--mndt-card);
  border-right: 1px solid var(--mndt-border);
  overflow-y: auto;
}
.mndt-channels-head { display: flex; flex-direction: column; gap: 2px; padding: 4px 8px 12px; }
.mndt-channels-title { font-family: "Space Grotesk", Inter, sans-serif; font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }
.mndt-channels-workspace { color: var(--mndt-muted); font-size: 12px; }
.mndt-channel-group { display: flex; flex-direction: column; gap: 2px; padding: 8px 0 4px; }
.mndt-channel-group-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 2px 8px; color: var(--mndt-muted); font-size: 11px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.06em;
}
.mndt-channel-group-count { font-weight: 500; }
.mndt-channel {
  display: flex; align-items: center; gap: 8px;
  width: 100%; padding: 7px 10px; border: 0; border-radius: 10px;
  background: transparent; color: var(--mndt-text); font-size: 13.5px;
  text-align: left; cursor: pointer;
  transition: background-color 160ms cubic-bezier(0.16, 1, 0.3, 1), color 160ms cubic-bezier(0.16, 1, 0.3, 1);
}
.mndt-channel:hover { background: #F5F3F0; }
.mndt-channel[data-active="true"] { background: #F0EFED; font-weight: 600; }
.mndt-channel-hash { color: var(--mndt-muted); width: 14px; text-align: center; font-size: 12px; }
.mndt-channel-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mndt-channel-badge {
  min-width: 18px; padding: 1px 5px; border-radius: 999px;
  background: #0C0F17; color: #fff; font-size: 10.5px; text-align: center;
}
.mndt-channels-foot { display: flex; flex-direction: column; gap: 6px; margin-top: auto; padding: 12px 8px 2px; border-top: 1px solid var(--mndt-border); }
.mndt-presence { display: flex; align-items: center; gap: 7px; color: var(--mndt-muted); font-size: 12px; }
.mndt-dot { width: 7px; height: 7px; border-radius: 999px; background: #B8BDC9; }
.mndt-dot[data-state="available"] { background: #16724B; }
.mndt-dot[data-state="working"] { background: #8A4B00; }
.mndt-role { color: var(--mndt-muted); font-size: 11px; }

.mndt-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--mndt-canvas); }
.mndt-channel-head {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  min-height: 64px; padding: 10px 22px;
  background: var(--mndt-card); border-bottom: 1px solid var(--mndt-border);
}
.mndt-channel-head-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.mndt-channel-title {
  margin: 0; font-family: "Space Grotesk", Inter, sans-serif;
  font-size: 20px; font-weight: 700; letter-spacing: -0.01em;
}
.mndt-channel-subject { margin: 0; color: var(--mndt-muted); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mndt-channel-head-side { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }

.mndt-feed { flex: 1; min-height: 0; overflow-y: auto; padding: 18px 22px 24px; display: flex; flex-direction: column; gap: 10px; }
.mndt-day { padding: 8px 0 2px; color: var(--mndt-muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; text-align: center; }
.mndt-post-card {
  display: flex; flex-direction: column; gap: 8px;
  padding: 14px 16px; background: var(--mndt-card);
  border: 1px solid var(--mndt-border); border-radius: 16px;
  max-width: 760px; width: 100%;
}
.mndt-post-card[data-kind="approval"] { border-color: #F0DDBB; background: #FFFDF8; }
.mndt-post-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mndt-post-kind { font-size: 12.5px; font-weight: 600; }
.mndt-post-time { margin-left: auto; color: var(--mndt-muted); font-size: 11px; }
.mndt-post-title { margin: 0; font-family: "Space Grotesk", Inter, sans-serif; font-size: 15px; font-weight: 600; }
.mndt-post-meta, .mndt-post-note { margin: 0; color: var(--mndt-muted); font-size: 12px; }
.mndt-post-body { margin: 0; color: var(--mndt-text); font-size: 13.5px; line-height: 1.5; white-space: pre-wrap; }
.mndt-post-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mndt-brief-body {
  margin: 4px 0 0; padding: 10px 12px; border-radius: 12px;
  background: #F7F6F3; border: 1px solid var(--mndt-border);
  font-family: Inter, ui-sans-serif, sans-serif; font-size: 12.5px; line-height: 1.5;
  white-space: pre-wrap; max-height: 320px; overflow: auto;
}
.mndt-event-post { display: flex; align-items: baseline; gap: 8px; padding: 2px 8px; color: var(--mndt-muted); font-size: 12px; }
.mndt-event-time { font-variant-numeric: tabular-nums; min-width: 36px; }
.mndt-event-actor { font-weight: 600; }
.mndt-event-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.mndt-composer { padding: 10px 22px 16px; background: var(--mndt-canvas); }
.mndt-composer-frame {
  display: flex; flex-direction: column; gap: 8px;
  padding: 12px 14px; background: var(--mndt-card);
  border: 1px solid var(--mndt-border); border-radius: 16px;
  max-width: 760px;
}
.mndt-composer-line { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.mndt-composer-hint { color: var(--mndt-muted); font-size: 12px; }
.mndt-composer-note { color: #8A4B00; font-size: 11px; }
.mndt-composer-input { width: 100%; min-height: 52px; resize: none; }
.mndt-composer-actions { display: flex; justify-content: flex-end; gap: 8px; }

.mndt-context {
  display: flex; flex-direction: column; gap: 14px;
  padding: 16px 16px 24px; background: var(--mndt-card);
  border-left: 1px solid var(--mndt-border); overflow-y: auto;
}
.mndt-context-title { margin: 0; font-family: "Space Grotesk", Inter, sans-serif; font-size: 15px; font-weight: 700; }
.mndt-context-block { display: flex; flex-direction: column; gap: 6px; }
.mndt-context-label { color: var(--mndt-muted); font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
.mndt-context-value { margin: 0; color: var(--mndt-text); font-size: 12.5px; line-height: 1.45; }
.mndt-context-grid { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 6px 10px; align-items: baseline; }
.mndt-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.mndt-person { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.mndt-avatar {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border-radius: 999px;
  background: #F0EFED; color: var(--mndt-text); font-size: 11px; font-weight: 600;
}
.mndt-avatar[data-agent="true"] { border-radius: 8px; background: #EDEFFF; color: #3445D1; }
.mndt-person-name { flex: 1; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mndt-person-role { color: var(--mndt-muted); font-size: 11px; }

@media (max-width: 1280px) {
  .mndt-collab { grid-template-columns: 232px minmax(0, 1fr) 280px; }
}
@media (max-width: 1080px) {
  .mndt-collab { grid-template-columns: 220px minmax(0, 1fr); }
  .mndt-context { display: none; }
}

.mndt-composer-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mndt-composer-row .mndt-input { max-width: 240px; }
.mndt-check { display: inline-flex; align-items: center; gap: 6px; color: var(--mndt-muted); font-size: 12px; }
.mndt-check input { accent-color: #0C0F17; }

.mndt-refusal { display: flex; flex-direction: column; gap: 8px; padding: 10px 0 0; }
.mndt-refusal .mndt-input { min-height: 56px; width: 100%; }

.mndt-button:disabled { opacity: 0.4; cursor: not-allowed; }
.mndt-button[data-variant="primary"]:disabled { background: #E2E4E9; border-color: #E2E4E9; color: #5A6475; }
.mndt-button:disabled:hover { background: #E2E4E9; border-color: #E2E4E9; color: #5A6475; }
`
