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
  connectors: 'Connectors',
  noConnectors: 'No MCP connector is mounted in this composition.',
  mounted: 'mounted',
  off: 'off',
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
  filterLabel: 'Perimetre affiche',
  filterVisible: 'Tout ce que je vois',
  filterMine: 'Mes elements',
  filterTeam: 'Equipe',
  privateTag: 'prive',
  teamTag: 'equipe',
  shareToTeam: 'Partager a l equipe',
  makePrivate: 'Rendre prive',
  makePersonal: 'Rendre personnel',
  onboardingTitle: 'Premiers pas',
  onboardingLead: 'Quatre gestes suffisent pour prendre le produit en main. Ce qui est deja fait est coche.',
  onboardingDismiss: 'Masquer',
  stepIdentity: 'Votre identite et vos droits',
  stepMission: 'Lancer une mission',
  stepDecision: 'Trancher une decision',
  stepConnector: 'Verifier les connecteurs',
  stepNone: 'aucune',
  teamTitle: 'Travailler en equipe',
  teamLead: 'Chaque personne se connecte avec son compte Duke. Ses droits viennent de l autorite centrale, pas de cette page.',
  teamRoles: 'viewer lit, operator agit, admin gere, owner decide de tout.',
  teamShared: 'Missions, decisions et notes : personnelles par defaut, partagees sur decision explicite ; chaque action porte le nom de son auteur.',
  teamAdd: '/opt/governance/add-member.sh email@duke-analytics.com viewer',
} as const

/** The same slot, mirrored. */
export const zh = en

/** One copy key. */
export type MndtKey = keyof typeof en
