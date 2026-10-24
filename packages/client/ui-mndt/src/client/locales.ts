/**
 * Locale strings for the morning page.
 *
 * Both built-in ids are provided because the locale registry requires them; the
 * English slot mirrors the French one until a real translation is requested.
 */
export const en = {
  title: 'This morning',
  subtitle: 'What needs a decision, what is running, and what was produced.',
  loading: 'Reading the workbench',
  decisions: 'Waiting for your decision',
  noDecisions: 'Nothing is waiting on you.',
  missions: 'Missions',
  noMissions: 'No mission yet.',
  briefs: 'Produced briefs',
  noBriefs: 'No brief yet.',
  memory: 'What the team remembers',
  noMemory: 'No note yet.',
  runBriefing: 'Run the morning briefing',
  running: 'Running',
  approve: 'Approve',
  refuse: 'Refuse',
  reason: 'Reason for a refusal',
  remember: 'Remember',
  notePlaceholder: 'A fact or a decision to keep',
  readOnly: 'Read only',
  writer: 'May run missions',
  unknown: 'The workbench Remote is not mounted on this workstation.',
  failed: 'failed',
  draft: 'draft',
  approved: 'approved',
  you: 'You',
} as const

/** The same slot, mirrored. */
export const zh = en

/** One copy key. */
export type MndtKey = keyof typeof en
