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
.mw-header-end { margin-left: auto; display: flex; align-items: center; gap: 8px; min-width: 0; }
.mw-live { display: none; align-items: center; gap: 6px; font-size: 12px; color: var(--mw-slate); }
.mw-live[data-state="live"] svg { color: var(--mw-success); }
.mw-live[data-state="paused"] svg { color: var(--mw-warning); }
.mw-account { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 12px; font-size: 14px; }
.mw-account-text { display: none; min-width: 0; flex-direction: column; align-items: flex-start; line-height: 1.25; }
.mw-account-name, .mw-account-email { max-width: 192px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mw-account-email { font-size: 12px; color: var(--mw-slate); }

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
  background: var(--mw-charcoal); color: #FFFFFF; font-size: 12px; font-weight: 500; line-height: 20px;
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

/* A channel, as mndt-web draws it (ChannelScreens, ChannelFeed, ComposerFrame, ChannelContextPanel). */
.mw-channel { display: flex; flex: 1; min-width: 0; min-height: 0; gap: 16px; padding: 24px 16px 0; }
.mw-channel-main { display: flex; flex: 1; min-width: 0; min-height: 0; flex-direction: column; gap: 12px; }
.mw-channel-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px; }
.mw-subtitle { margin: 4px 0 0; font-size: 14px; color: var(--mw-slate); }
.mw-app .mw-channel .mndt-thread { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.mw-app .mw-channel .mndt-thread-feed { flex: 1; min-height: 0; overflow-y: auto; padding: 0 0 12px; gap: 4px; }
.mw-feed-empty { margin: 0; padding: 24px 0; text-align: center; font-size: 14px; color: var(--mw-slate); }

.mw-composer { flex-shrink: 0; padding: 8px 16px; border-top: 1px solid var(--mw-line); background: var(--mw-card); }
.mw-composer-inner { display: flex; flex-direction: column; gap: 8px; max-width: 768px; margin: 0 auto; }
.mw-composer-mode { margin: 0; font-size: 12px; line-height: 16px; color: var(--mw-slate); }
.mw-composer-mode b { font-weight: 500; color: var(--mw-charcoal); }
.mw-composer-row { display: flex; align-items: flex-start; gap: 8px; }
.mw-composer-input {
  flex: 1; min-width: 0; min-height: 40px; resize: vertical;
  padding: 8px 12px; border: 1px solid var(--mw-line); border-radius: 12px;
  background: var(--mw-card); color: var(--mw-charcoal); font: inherit; font-size: 14px; line-height: 20px;
}
.mw-composer-input::placeholder { color: var(--mw-slate); }
.mw-composer-input:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(52, 69, 209, 0.3); }
.mw-composer-error { margin: 0; font-size: 12px; color: #B3261E; }
.mw-app .mw-primary {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  padding: 8px 16px; border: 0; border-radius: 12px; background: var(--mw-charcoal); color: #FFFFFF;
  font-size: 14px; font-weight: 500; line-height: 20px; cursor: pointer;
  transition: background-color 160ms var(--mw-ease);
}
.mw-app .mw-primary:hover { background: #121722; }
.mw-app .mw-primary:disabled { cursor: not-allowed; opacity: 0.5; }
.mw-app .mw-secondary {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  padding: 8px 16px; border: 1px solid var(--mw-line); border-radius: 12px; background: var(--mw-card);
  color: var(--mw-charcoal); font-size: 14px; font-weight: 500; line-height: 20px; cursor: pointer;
}
.mw-app .mw-secondary:hover { background: var(--mw-surface); }
.mw-app .mw-secondary:disabled { cursor: not-allowed; opacity: 0.5; }

.mw-aside {
  display: none; flex-shrink: 0; align-self: flex-start; width: 320px; max-height: calc(100% - 24px); overflow-y: auto;
  padding: 16px; border: 1px solid var(--mw-line); border-radius: 16px; background: var(--mw-card);
}
.mw-aside[data-open] {
  /* As mndt-web opens it on a phone (fixed inset-0): over the whole screen, composer and bars included. */
  display: block; position: fixed; inset: 0; z-index: 50; width: auto; max-height: none; overflow-y: auto;
  /* flex-start would size a fixed box to its content: stretched, it covers the screen. */
  align-self: stretch; border: 0; border-radius: 0;
}
.mw-aside-close { display: flex; justify-content: flex-end; margin-bottom: 12px; }
.mw-ctx { display: flex; flex-direction: column; gap: 16px; font-size: 14px; line-height: 20px; }
.mw-ctx p { margin: 0; }
.mw-ctx-section { display: flex; flex-direction: column; gap: 8px; }
.mw-ctx-title { margin: 0; font-size: 12px; font-weight: 500; line-height: 16px; text-transform: uppercase; letter-spacing: 0.025em; color: var(--mw-slate); }
.mw-ctx-muted { color: var(--mw-slate); }
.mw-ctx-small { font-size: 12px; line-height: 16px; }
.mw-ctx-strong { font-weight: 500; }
.mw-ctx-list, .mw-ctx-members { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.mw-ctx-members { gap: 4px; }
.mw-ctx-item { display: flex; flex-direction: column; gap: 4px; padding: 8px; border: 1px solid var(--mw-line); border-radius: 12px; }
.mw-ctx-member { display: flex; align-items: center; gap: 8px; }
.mw-ctx-icon { flex-shrink: 0; color: var(--mw-slate); }
.mw-app .mw-ctx-link { padding: 0; border: 0; background: none; color: inherit; font-size: inherit; text-decoration: underline; cursor: pointer; }
.mw-ctx-add { display: flex; gap: 8px; }
.mw-ctx-select { flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid var(--mw-line); border-radius: 12px; background: var(--mw-card); font: inherit; font-size: 13px; }
.mw-ctx-error { font-size: 12px; color: #B3261E; }

@media (min-width: 768px) {
  .mw-channel { padding: 24px 32px 0; }
  .mw-composer { margin-bottom: 40px; }
}
@media (min-width: 1024px) {
  .mw-aside { display: block; }
  .mw-aside[data-open] { position: static; z-index: auto; align-self: flex-start; width: 320px; max-height: calc(100% - 24px); border: 1px solid var(--mw-line); border-radius: 16px; }
  .mw-aside-close { display: none; }
  .mw-app .mw-context-open { display: none; }
}

/* The feed, as mndt-web draws it (ChannelFeed, MessageItem, TurnLine, ApprovalDecision). */
.mw-feed-item { display: flex; flex-direction: column; gap: 4px; }
.mw-day { display: flex; align-items: center; gap: 12px; margin: 12px 0; font-size: 12px; color: var(--mw-slate); }
.mw-day-line { flex: 1; height: 1px; background: var(--mw-line); }
.mw-message {
  position: relative; display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; border-radius: 12px;
  transition: background-color 160ms var(--mw-ease);
}
.mw-message:hover { background: var(--mw-surface); }
.mw-message-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 14px; line-height: 20px; }
.mw-message-name { font-weight: 500; }
.mw-message-time { font-size: 12px; color: var(--mw-slate); }
.mw-message-actions { position: absolute; top: 6px; right: 8px; display: inline-flex; gap: 8px; opacity: 0; transition: opacity 160ms var(--mw-ease); }
.mw-message:hover .mw-message-actions, .mw-message-actions:focus-within { opacity: 1; }
.mw-app .mw-text-button {
  padding: 0; border: 0; background: none; color: var(--mw-slate); font-size: 12px; text-decoration: underline; cursor: pointer;
}
.mw-app .mw-text-button[data-tone="danger"] { color: #B3261E; }
.mw-message-body { margin: 0; font-size: 14px; line-height: 20px; white-space: pre-wrap; overflow-wrap: anywhere; }
.mw-agent-text { white-space: normal; display: flex; flex-direction: column; gap: 8px; }
.mw-agent-text p { margin: 0; white-space: pre-wrap; }
.mw-agent-text strong, .mw-agent-text b { font-weight: 600; }
.mw-agent-text ul, .mw-agent-text ol { margin: 0; padding-left: 20px; }
.mw-agent-text h3, .mw-agent-text h4 { margin: 0; font-family: "Space Grotesk", Inter, sans-serif; font-size: 15px; }
.mw-agent-text table {
  display: block; width: fit-content; max-width: 100%; overflow-x: auto; border-collapse: separate; border-spacing: 0;
  border: 1px solid var(--mw-line); border-radius: 12px; font-size: 13px;
}
.mw-agent-text th, .mw-agent-text td { padding: 6px 8px; border-bottom: 1px solid var(--mw-line); text-align: left; white-space: nowrap; }
.mw-agent-text tr:last-child td { border-bottom: 0; }
.mw-agent-text th { background: var(--mw-surface); font-weight: 500; }
.mw-agent-text code { padding: 1px 4px; border-radius: 4px; background: var(--mw-surface); font-size: 12.5px; }
/* A fenced block: its lines as written, in a frame; long lines scroll inside it, never the page. */
.mw-agent-text pre.md-code {
  margin: 0; max-width: 100%; overflow-x: auto; padding: 8px 12px;
  border: 1px solid var(--mw-line); border-radius: 12px; background: var(--mw-surface);
}
.mw-agent-text pre.md-code code {
  padding: 0; background: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px; line-height: 18px; white-space: pre;
}
.mw-message-removed { margin: 0; font-size: 14px; font-style: italic; color: var(--mw-slate); }
.mw-chip { padding: 2px 6px; border: 1px solid var(--mw-line); border-radius: 10px; font-size: 12px; line-height: 16px; }
.mw-chip-strong { font-weight: 500; }

.mw-turn { display: flex; flex-wrap: wrap; align-items: center; column-gap: 8px; margin: 0; font-size: 12px; line-height: 20px; color: var(--mw-slate); }
.mw-turn-live { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 12px; color: var(--mw-slate); }
.mw-dots { display: inline-flex; gap: 4px; }
.mw-dots span { width: 6px; height: 6px; border-radius: 50%; background: var(--mw-accent-text); animation: mw-pulse 1.2s ease-in-out infinite; }
.mw-dots span:nth-child(2) { animation-delay: 150ms; }
.mw-dots span:nth-child(3) { animation-delay: 300ms; }
@keyframes mw-pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .mw-dots span { animation: none; } }
.mw-turn-failed { display: flex; align-items: center; gap: 4px; margin: 0; font-size: 12px; color: var(--mw-warning); }
.mw-waiting { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 12px; color: var(--mw-slate); }

.mw-card-box {
  display: flex; flex-direction: column; gap: 12px; margin-top: 4px; padding: 12px;
  border: 1px solid var(--mw-line); border-radius: 16px; background: var(--mw-card);
}
.mw-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.mw-card-box .mw-card-title { margin: 0; font-family: Inter, ui-sans-serif, system-ui, sans-serif; font-size: 14px; font-weight: 500; line-height: 20px; }
.mw-card-box .mw-card-meta { margin: 0; font-size: 12px; color: var(--mw-slate); }
.mw-status {
  display: inline-flex; flex-shrink: 0; align-items: center; gap: 6px; padding: 2px 8px;
  border: 1px solid rgba(138, 75, 0, 0.4); border-radius: 10px; color: var(--mw-warning);
  font-size: 12px; font-weight: 500; line-height: 20px; white-space: nowrap;
}
.mw-status[data-state="approved"] { border-color: rgba(22, 114, 75, 0.4); color: var(--mw-success); }
.mw-status[data-state="rejected"] { border-color: rgba(179, 38, 30, 0.4); color: #B3261E; }
.mw-decided { display: flex; flex-direction: column; gap: 4px; padding: 8px 12px; border: 1px solid var(--mw-line); border-radius: 12px; background: var(--mw-surface); font-size: 14px; }
.mw-decided p { margin: 0; }
.mw-decided b { font-weight: 500; }
.mw-decided-reason { color: var(--mw-slate); white-space: pre-wrap; }
.mw-decide { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--mw-line); border-radius: 16px; background: var(--mw-card); }
.mw-decide-label { display: flex; flex-direction: column; gap: 4px; font-size: 14px; color: var(--mw-slate); }
.mw-decide-input {
  min-height: 40px; resize: vertical; padding: 8px 12px; border: 1px solid var(--mw-line); border-radius: 12px;
  background: var(--mw-card); color: var(--mw-charcoal); font: inherit; font-size: 14px;
}
.mw-decide-buttons { display: grid; gap: 8px; }
.mw-decide-buttons > button { min-height: 44px; }
.mw-decide-error { margin: 0; font-size: 12px; color: #B3261E; }
.mw-cannot { margin: 0; padding: 16px; border: 1px solid var(--mw-line); border-radius: 16px; font-size: 14px; font-weight: 500; }
@media (min-width: 640px) { .mw-decide-buttons { display: flex; flex-wrap: wrap; } }

/* À traiter and Mémoire, as mndt-web draws them (ApprovalQueueScreen, MemoryScreen, EmptyState). */
.mw-empty-state {
  padding: 32px; border: 1px dashed var(--mw-line); border-radius: 16px; background: var(--mw-card); text-align: center;
}
.mw-empty-state p { margin: 0; font-size: 14px; font-weight: 500; }
.mw-alert { margin: 0; font-size: 14px; color: #B3261E; }
.mw-counts { display: flex; gap: 12px; margin: 0; font-size: 14px; }
.mw-queue { display: flex; flex-direction: column; gap: 12px; max-width: 768px; }
.mw-queue-item { display: flex; flex-direction: column; gap: 4px; }
.mw-app .mw-queue-where { align-self: flex-start; padding: 0; border: 0; background: none; color: var(--mw-slate); font-size: 12px; text-decoration: underline; cursor: pointer; }
.mw-queue-from { align-self: flex-start; font-size: 12px; color: var(--mw-slate); }
.mw-intro { margin: 0; font-size: 14px; color: var(--mw-slate); }
.mw-memory-columns { display: grid; gap: 16px; }
.mw-memory-column { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.mw-memory-title { display: flex; align-items: center; gap: 8px; margin: 0; font-family: "Space Grotesk", Inter, sans-serif; font-size: 16px; font-weight: 600; }
.mw-memory-help { margin: 0; font-size: 13px; color: var(--mw-slate); }
.mw-memory-none { margin: 0; font-size: 14px; color: var(--mw-slate); }
.mw-memory-card { display: flex; flex-direction: column; gap: 6px; padding: 12px; border: 1px solid var(--mw-line); border-radius: 16px; background: var(--mw-card); font-size: 14px; }
.mw-memory-text { margin: 0; font-weight: 500; white-space: pre-wrap; }
.mw-memory-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0; font-size: 12px; color: var(--mw-slate); }
@media (min-width: 1024px) { .mw-memory-columns { grid-template-columns: repeat(3, minmax(0, 1fr)); } }

/* Agents and Réglages, as mndt-web draws them (AgentScreens, SettingsScreen): tiles in two columns. */
.mw-tiles { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; }
.mw-tile {
  display: flex; flex-direction: column; gap: 4px; height: 100%; padding: 16px;
  border: 1px solid var(--mw-line); border-radius: 16px; background: var(--mw-card);
  color: var(--mw-charcoal); text-align: left; text-decoration: none;
}
.mw-app .mw-tile-link { width: 100%; font: inherit; cursor: pointer; transition: background-color 160ms var(--mw-ease); }
.mw-app .mw-tile-link:hover { background: var(--mw-surface); }
.mw-tile-title { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 14px; font-weight: 500; line-height: 20px; }
.mw-tile-text { margin: 0; font-size: 14px; line-height: 20px; color: var(--mw-slate); }
@media (min-width: 640px) { .mw-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }

/* DOCUMENTS in the context card, as mndt-web draws it (ChannelDocuments). */
.mw-docs { display: flex; flex-direction: column; gap: 8px; }
.mw-docs-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.mw-doc { display: flex; flex-direction: column; gap: 4px; }
.mw-doc-row { display: flex; align-items: flex-start; gap: 8px; }
.mw-doc-row .mw-ctx-icon { margin-top: 2px; }
.mw-doc-main { display: flex; flex: 1; min-width: 0; flex-direction: column; }
.mw-doc-name {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--mw-charcoal); font-weight: 500; text-decoration: none;
}
.mw-doc-name:hover { text-decoration: underline; }
.mw-doc-facts { font-size: 12px; line-height: 16px; color: var(--mw-slate); }
.mw-app .mw-doc-retire { padding: 4px 10px; font-size: 12px; }
.mw-doc-retiring { display: flex; flex-direction: column; gap: 4px; padding-left: 24px; }
.mw-doc-label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.mw-doc-input { width: 100%; padding: 8px 12px; border: 1px solid var(--mw-line); border-radius: 12px; background: var(--mw-card); font: inherit; font-size: 14px; }
.mw-doc-buttons { display: flex; gap: 8px; }
.mw-deposit { display: flex; flex-direction: column; gap: 8px; padding: 8px; border: 1px dashed var(--mw-line); border-radius: 12px; }
.mw-deposit-title { font-size: 13px; font-weight: 500; }
.mw-deposit-file { display: block; width: 100%; font-size: 12px; }
.mw-app .mw-deposit-send { align-self: flex-start; }

/* Pills: one click to put an agent or a connector in a channel, or to take it out. */
.mw-pills { display: flex; flex-wrap: wrap; gap: 6px; }
.mw-app .mw-pill {
  display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px;
  border: 1px solid var(--mw-line); border-radius: 999px; background: var(--mw-card);
  color: var(--mw-charcoal); font-size: 13px; line-height: 18px; cursor: pointer;
  transition: background-color 160ms var(--mw-ease), color 160ms var(--mw-ease);
}
.mw-app .mw-pill:hover:not([aria-disabled="true"]) { background: var(--mw-surface); }
.mw-app .mw-pill[aria-pressed="true"] { border-color: var(--mw-charcoal); background: var(--mw-charcoal); color: #FFFFFF; }
.mw-app .mw-pill[aria-disabled="true"] { cursor: default; opacity: 0.55; }
.mw-app .mw-pill[aria-disabled="true"]:hover { background: var(--mw-card); }
.mw-app .mw-pill[aria-pressed="true"][aria-disabled="true"] { opacity: 0.8; background: var(--mw-charcoal); }
@media (max-width: 767px) { .mw-app .mw-pill { min-height: 36px; padding: 6px 12px; } }
.mw-pill-note { font-size: 11px; opacity: 0.8; }

.mw-turn-coord { display: flex; flex-direction: column; gap: 4px; }
.mw-turn-coord-line { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0; }
.mw-turn-unchecked {
  margin: 0; padding: 6px 10px; border: 1px solid rgba(138, 75, 0, 0.45); border-radius: 10px;
  background: #FDF3E2; color: var(--mw-warning, #8A4B00); font-size: 13px; font-weight: 500;
}
.mw-turn-steps summary { cursor: pointer; color: var(--mw-slate); font-size: 12.5px; }
.mw-turn-steps ol { margin: 4px 0 0; padding-left: 18px; font-size: 13px; }
.mw-turn-part {
  margin: 4px 0 6px; padding: 8px 10px; border-left: 2px solid var(--mw-line); background: var(--mw-surface);
  border-radius: 0 8px 8px 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13.5px;
}
.mw-turn-notes { margin: 2px 0 4px; padding-left: 16px; color: var(--mw-slate); white-space: pre-wrap; overflow-wrap: anywhere; }

@media (min-width: 640px) { .mw-account-text { display: flex; } }
@media (min-width: 768px) { .mw-screen { padding: 24px 32px 40px; } }
@media (min-width: 768px) {
  .mw-nav { display: flex; }
  .mw-bottom { display: none; }
  .mw-page { padding-bottom: 0; }
}
@media (min-width: 1024px) { .mw-live { display: flex; } }
`
