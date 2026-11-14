/**
 * Presentation of the team screen's frame, translated from mndt-web (`src/styles.css` tokens,
 * `components/shell/AppShell.tsx` and `Rail.tsx` classes): the same colours, radii, spacing and
 * motion, written as plain CSS because the DSH client carries no Tailwind. Scoped under `.mw-app`.
 * Breakpoints are Tailwind's: sm 640, md 768, lg 1024.
 */
export const TEAM_CSS = `
.mw-app {
  --mw-charcoal: #0C0F17;
  --mw-offwhite: #F6F4F1;
  --mw-card: #FFFFFF;
  --mw-line: #E2E4E9;
  --mw-surface: #F0EFED;
  --mw-slate: #5A6475;
  --mw-mist: #B8BDC9;
  --mw-accent-text: #3445D1;
  --mw-success: #16724B;
  --mw-warning: #8A4B00;
  --mw-ease: cubic-bezier(0.16, 1, 0.3, 1);
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--mw-offwhite);
  color: var(--mw-charcoal);
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  font-size: 15px;
  line-height: 1.5;
}
.mw-app *, .mw-app *::before, .mw-app *::after { box-sizing: border-box; }
.mw-app button { font: inherit; color: inherit; }
.mw-app button:focus-visible, .mw-app select:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(52, 69, 209, 0.3);
}
.mw-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.mw-slate { color: var(--mw-slate); flex-shrink: 0; }
.mw-shrink { flex-shrink: 0; }
.mw-ellipsis { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.mw-header { flex-shrink: 0; z-index: 30; background: var(--mw-card); border-bottom: 1px solid var(--mw-line); }
.mw-header-row { display: flex; align-items: center; gap: 12px; height: 56px; padding: 0 16px; }
.mw-logo { display: inline-flex; flex-shrink: 0; }
.mw-logo img { display: block; height: 20px; width: auto; }
.mw-org {
  display: flex; align-items: center; gap: 8px; min-width: 0;
  padding: 6px 12px; border: 1px solid var(--mw-line); border-radius: 12px;
  background: var(--mw-card); font-size: 14px; line-height: 20px;
}
.mw-org-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.mw-env {
  padding: 2px 6px; border: 1px solid #F0DDBB; border-radius: 10px;
  background: #FDF3E2; color: var(--mw-warning); font-size: 12px; font-weight: 500; line-height: 16px;
}
.mw-spaces { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 14px; }
.mw-select {
  max-width: 192px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 6px 12px; border: 1px solid var(--mw-line); border-radius: 12px;
  background: var(--mw-card); color: var(--mw-charcoal); font: inherit; font-size: 14px; line-height: 20px;
}
.mw-select:disabled { opacity: 0.6; }
.mw-header-end { margin-left: auto; display: flex; align-items: center; gap: 8px; min-width: 0; }
.mw-live { display: none; align-items: center; gap: 6px; font-size: 12px; color: var(--mw-slate); }
.mw-live[data-state="live"] svg { color: var(--mw-success); }
.mw-live[data-state="paused"] svg { color: var(--mw-warning); }
.mw-account { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 12px; font-size: 14px; }
.mw-account-text { display: none; min-width: 0; flex-direction: column; align-items: flex-start; line-height: 1.25; }
.mw-account-name, .mw-account-email { max-width: 192px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mw-account-email { font-size: 12px; color: var(--mw-slate); }
.mw-header-spaces { border-top: 1px solid var(--mw-line); padding: 8px 16px; }
.mw-md-only { display: none; }

.mw-body { display: flex; flex: 1; min-height: 0; }
.mw-nav {
  display: none; flex-direction: column; gap: 4px; flex-shrink: 0;
  width: 224px; padding: 12px; overflow-y: auto;
  background: var(--mw-card); border-right: 1px solid var(--mw-line);
}
.mw-page { display: flex; flex: 1; min-width: 0; min-height: 0; flex-direction: column; overflow: hidden; padding-bottom: 57px; }

.mw-app .mw-link {
  display: flex; align-items: center; gap: 12px; width: 100%;
  padding: 8px 12px; border: 0; border-radius: 12px; background: transparent;
  color: var(--mw-slate); font-size: 14px; line-height: 20px; text-align: left; cursor: pointer;
  transition: background-color 160ms var(--mw-ease), color 160ms var(--mw-ease);
}
.mw-app .mw-link:hover { background: var(--mw-surface); color: var(--mw-charcoal); }
.mw-app .mw-link[data-active="true"] { background: var(--mw-surface); color: var(--mw-charcoal); font-weight: 500; }
.mw-app .mw-link[data-disabled="true"] { color: var(--mw-mist); cursor: default; }
.mw-app .mw-link[data-disabled="true"]:hover { background: transparent; color: var(--mw-mist); }
.mw-soon { margin-left: auto; font-size: 12px; color: var(--mw-mist); }
.mw-badge {
  margin-left: auto; padding: 0 6px; border-radius: 10px;
  background: var(--mw-charcoal); color: #FFFFFF; font-size: 12px; font-weight: 400; line-height: 18px;
}
.mw-sublist { margin: 0; padding: 0; list-style: none; }
.mw-app .mw-sublink {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 4px 12px 4px 40px; border: 0; border-radius: 12px; background: transparent;
  color: var(--mw-slate); font-size: 13px; line-height: 20px; text-align: left; cursor: pointer;
  transition: background-color 160ms var(--mw-ease), color 160ms var(--mw-ease);
}
.mw-app .mw-sublink:hover { background: var(--mw-surface); color: var(--mw-charcoal); }
.mw-app .mw-sublink[data-active="true"] { background: var(--mw-surface); color: var(--mw-charcoal); font-weight: 500; }
.mw-rule { width: 100%; margin: 8px 0; border: 0; border-top: 1px solid var(--mw-line); }
.mw-section {
  margin: 0; padding: 0 12px 4px; font-size: 12px; font-weight: 500;
  text-transform: uppercase; letter-spacing: 0.025em; color: var(--mw-slate);
}
.mw-foot { margin-top: auto; padding-top: 8px; }

.mw-bottom {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 30;
  display: flex; border-top: 1px solid var(--mw-line); background: var(--mw-card);
}
.mw-app .mw-compact {
  display: flex; flex: 1; min-width: 64px; flex-direction: column; align-items: center; gap: 4px;
  padding: 6px 8px; border: 0; background: transparent; color: var(--mw-slate);
  font-size: 12px; line-height: 16px; cursor: pointer;
}
.mw-app .mw-compact[data-active="true"] { color: var(--mw-charcoal); font-weight: 500; }
.mw-sheet-backdrop { position: absolute; inset: 0; z-index: 40; background: rgba(12, 15, 23, 0.4); }
.mw-sheet {
  position: absolute; top: 0; bottom: 0; left: 0; width: 288px; max-width: 85%;
  display: flex; flex-direction: column; overflow-y: auto; padding: 12px;
  background: var(--mw-card); border-right: 1px solid var(--mw-line);
}
.mw-sheet-close {
  position: absolute; top: 12px; right: 12px; display: inline-flex; padding: 4px;
  border: 0; border-radius: 10px; background: transparent; cursor: pointer; opacity: 0.7;
}
.mw-sheet-links { display: flex; min-height: 100%; flex-direction: column; gap: 4px; padding-top: 32px; }

/* The page inside the frame: its views side by side with the right card, none of them a rail. */
.mndt-collab[data-team] { display: flex; flex-direction: row; flex: 1; height: 100%; min-height: 0; }
.mndt-collab[data-team] > .mndt-main { flex: 1; }
.mndt-collab[data-team] > .mndt-context { width: 320px; flex-shrink: 0; }

.mw-screen {
  display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 16px;
  padding: 24px 16px 40px; overflow-y: auto;
  color: var(--mw-charcoal, #0C0F17);
}
.mw-title {
  margin: 0; font-family: "Space Grotesk", Inter, sans-serif; font-size: 28px; font-weight: 700;
  line-height: 1.25; letter-spacing: -0.01em;
}
.mw-empty { margin: 0; padding: 24px 0; text-align: center; font-size: 14px; color: var(--mw-slate, #5A6475); }
.mw-cards { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.mw-card {
  display: flex; flex-direction: column; gap: 8px; padding: 16px;
  border: 1px solid var(--mw-line, #E2E4E9); border-radius: 16px; background: var(--mw-card, #FFFFFF);
}
.mw-card-title { margin: 0; font-family: "Space Grotesk", Inter, sans-serif; font-size: 16px; font-weight: 600; }
.mw-card-text { margin: 0; font-size: 14px; white-space: pre-wrap; }
.mw-card-meta { margin: 0; font-size: 12px; color: var(--mw-slate, #5A6475); }
.mw-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.mw-app .mw-button {
  padding: 8px 16px; border: 1px solid var(--mw-line); border-radius: 12px;
  background: var(--mw-card); color: var(--mw-charcoal); font-size: 14px; font-weight: 500; cursor: pointer;
  transition: background-color 160ms var(--mw-ease);
}
.mw-app .mw-button:hover { background: var(--mw-surface); }

.mw-denied {
  display: flex; height: 100%; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
  padding: 16px; font-family: Inter, ui-sans-serif, system-ui, sans-serif; font-size: 15px; color: #0C0F17; text-align: center;
}
.mw-denied a { color: #3445D1; }

@media (min-width: 640px) { .mw-account-text { display: flex; } }
@media (min-width: 768px) { .mw-screen { padding: 24px 32px 40px; } }
@media (min-width: 768px) {
  .mw-md-only { display: block; }
  .mw-header-spaces { display: none; }
  .mw-nav { display: flex; }
  .mw-bottom { display: none; }
  .mw-page { padding-bottom: 0; }
}
@media (min-width: 1024px) { .mw-live { display: flex; } }
`
