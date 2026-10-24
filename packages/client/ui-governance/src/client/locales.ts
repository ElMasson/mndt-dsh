/** Copy for the governance page, in both languages the harness ships. */

export const en = {
  title: 'Governance',
  subtitle: 'Who may do what, on which resource, and what is shared.',
  tabConnectors: 'Connectors',
  tabAgents: 'Agents',
  tabWorkflows: 'Workflows',
  tabRights: 'Rights',
  tabSharing: 'Sharing',
  loading: 'Loading...',
  empty: 'No grant recorded yet.',
  error: 'Could not read governance data.',
  subject: 'Subject',
  role: 'Role',
  scope: 'Scope',
  actions: 'Action',
  grant: 'Grant a role',
  revoke: 'Revoke',
  actor: 'Acting as',
  actorHint: 'The Host checks that this identity holds rights.write.',
  submit: 'Grant',
  cancel: 'Cancel',
  global: 'everything',
  notWired: 'This surface is not wired yet.',
  refused: 'Refused by the Host',
  liveTable: 'Live table',
  identityHint: 'The authority resolved this identity from your token or your Entra session.',
  run: 'Run',
  staleTable: 'Cached table, the authority is unreachable',
  accepted: 'Accepted',
  promptLabel: 'Prompt',
  connectorEnabled: 'enabled',
  connectorDisabled: 'disabled',
  roleViewer: 'viewer',
  roleOperator: 'operator',
  roleAdmin: 'admin',
  roleOwner: 'owner',
} as const

// The locale registry requires both built-in ids for every namespace.
// This slot mirrors English until a real translation is requested.
export const zh = en


export type GovernanceKey = keyof typeof en
