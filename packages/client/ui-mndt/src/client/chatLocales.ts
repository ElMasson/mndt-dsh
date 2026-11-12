/**
 * Copy of the channel screens (lot 1), in their own namespace so the page's dictionary stays the
 * page's. English and French; the registry requires zh, which mirrors English.
 */

/** The namespace these keys live in. */
export const CHAT_NS = 'mndt.chat'

export const chatEn = {
  channels: 'Channels',
  lane: 'My lane',
  newChannel: 'New channel',
  channelTitle: 'Channel name',
  channelTitlePlaceholder: 'Bank reconciliation',
  create: 'Create',
  cancel: 'Cancel',
  notServed: 'Team channels are not served on this workstation.',
  loading: 'Loading…',
  empty: 'Nothing in this channel yet. Write to the team, or mention an agent with @.',
  unreadable: 'The thread could not be read: {reason}',
  composer: 'Message',
  composerPlaceholder: 'Write to the channel; @ to ask an agent',
  send: 'Send',
  sending: 'Sending…',
  mentionHint: 'Agents of this channel',
  noAgentHere: 'No agent in this channel: no one answers a mention.',
  notADecision: 'A message decides nothing: a card is decided by its button.',
  system: 'mndt',
  deleted: 'Message deleted.',
  delete: 'Delete',
  turnQueued: 'waiting',
  turnRunning: 'answering…',
  turnDone: 'answered',
  turnFailed: 'failed',
  turnRefused: 'refused',
  turnCancelled: 'stopped',
  turnCost: '{tokens} tokens · {eur}',
  trace: 'Trace',
  traceId: 'trace {id}',
  card: 'Approval required',
  askedBy: 'asked by {name}',
  approve: 'Approve',
  refuse: 'Refuse',
  refuseReason: 'Reason for the refusal, kept in the log',
  confirmRefuse: 'Confirm the refusal',
  confirmDelete: 'Confirm the deletion',
  agents: 'Agents',
  agentModel: '{provider} · {model}',
  agentMonth: '{spent} this month, of {ceiling}',
  agentNone: 'No agent in this channel.',
  members: 'Members',
  add: 'Add',
  chooseAgent: 'Choose an agent',
  addAgent: 'Add an agent to this channel',
} as const

/** One copy key. */
export type ChatKey = keyof typeof chatEn

/** French, every key of English: a missing one fails to compile. */
export const chatFr: Record<ChatKey, string> = {
  channels: 'Canaux',
  lane: 'Ma lane',
  newChannel: 'Nouveau canal',
  channelTitle: 'Nom du canal',
  channelTitlePlaceholder: 'Rapprochement bancaire',
  create: 'Créer',
  cancel: 'Annuler',
  notServed: 'Les canaux d\'équipe ne sont pas servis sur ce poste.',
  loading: 'Chargement…',
  empty: 'Rien dans ce canal pour le moment. Écrivez à l\'équipe, ou mentionnez un agent avec @.',
  unreadable: 'Le fil n\'a pas pu être lu : {reason}',
  composer: 'Message',
  composerPlaceholder: 'Écrire au canal ; @ pour solliciter un agent',
  send: 'Envoyer',
  sending: 'Envoi…',
  mentionHint: 'Agents de ce canal',
  noAgentHere: 'Aucun agent dans ce canal : personne ne répond à une mention.',
  notADecision: 'Un message ne décide rien : une carte se décide par son bouton.',
  system: 'mndt',
  deleted: 'Message supprimé.',
  delete: 'Supprimer',
  turnQueued: 'en attente',
  turnRunning: 'répond…',
  turnDone: 'a répondu',
  turnFailed: 'en échec',
  turnRefused: 'refusé',
  turnCancelled: 'arrêté',
  turnCost: '{tokens} jetons · {eur}',
  trace: 'Trace',
  traceId: 'trace {id}',
  card: 'Approbation requise',
  askedBy: 'demandée par {name}',
  approve: 'Approuver',
  refuse: 'Refuser',
  refuseReason: 'Motif du refus, conservé dans le journal',
  confirmRefuse: 'Confirmer le refus',
  confirmDelete: 'Confirmer la suppression',
  agents: 'Agents',
  agentModel: '{provider} · {model}',
  agentMonth: '{spent} ce mois-ci, sur {ceiling}',
  agentNone: 'Aucun agent dans ce canal.',
  members: 'Membres',
  add: 'Ajouter',
  chooseAgent: 'Choisir un agent',
  addAgent: 'Ajouter un agent à ce canal',
}

/** The same slot, mirrored: the registry requires zh. */
export const chatZh = chatEn

/** Substitution values for a message. */
export type ChatValues = Readonly<Record<string, string | number>>

/** The bound translate of this namespace. */
export type ChatTranslate = (key: ChatKey, values?: ChatValues) => string

/**
 * English, for tests and for a page mounted without the locale seat.
 * @param key - the message.
 * @param values - placeholders to fill.
 * @returns the text.
 */
export function chatEnglish(key: ChatKey, values?: ChatValues): string {
  const template: string = chatEn[key]
  if (values === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (match: string, name: string) => {
    const value = values[name]
    return value === undefined ? match : String(value)
  })
}
