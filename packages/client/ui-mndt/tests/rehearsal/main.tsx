/**
 * Rehearsal of the team page, outside what is served: the page over the repository's test double
 * (mockChat) with a filled channel, so the feed can be compared with mndt-web by anyone. Every
 * datum here is simulated; captures taken from it say so (« données simulées »).
 *
 * It lives under tests/ so the client typecheck and the lint keep it current. Build:
 * `pnpm exec vite build --config packages/client/ui-mndt/rehearsal/vite.config.ts`, then serve
 * `rehearsal/dist` statically.
 */
import { createRoot } from 'react-dom/client'
import '../../../ui-brand-mndt/src/styles/brand-font.css'
import { CollabPage } from '../../src/client/CollabPage.tsx'
import { createMockChat } from '../../src/client/mockChat.ts'
import { createMockDocuments } from '../doubles/documents.ts'
import { chatFrench } from '../../src/client/chatLocales.ts'
import { translate } from '../../src/client/locales.ts'
import { CSS } from '../../src/client/styles.ts'
import { TEAM_CSS } from '../../src/client/teamStyles.ts'
import type { MndtFace, PageStateRow } from '../../src/client/face.ts'

const you = 'stephane@datanalysis.re'
const t0 = Date.parse('2026-11-14T09:12:00.000Z')
const at = (min: number): string => new Date(t0 + min * 60000).toISOString()
const assistant = { id: 'agt_1', handle: 'assistant', name: 'Assistant', provider: 'scaleway-genapi', model: 'deepseek-v4.1-flash', connectors: ['office365', 'qonto'], eurPerMonth: 5, eurThisMonth: 0.0041, createdBy: you, createdAt: at(-600) }
const analyste = { id: 'agt_2', handle: 'analyste', name: 'Analyste', provider: 'scaleway-genapi', model: 'glm-5.3', connectors: [], eurPerMonth: 5, eurThisMonth: 0, createdBy: you, createdAt: at(-600) }
const channel = { id: 'chn_1', name: 'recouvrement', title: 'recouvrement', kind: 'team' as const, members: [you, 'smarion@datanalysis.re'], agents: ['agt_1'], connectors: ['qonto'], createdBy: you, createdAt: at(-600) }
const lane = { id: 'chn_0', name: 'solo', title: 'Ma lane', kind: 'solo' as const, members: [you], agents: ['agt_1'], connectors: [], createdBy: you, createdAt: at(-600) }
const redacteur = { id: 'agt_3', handle: 'redacteur', name: 'Rédacteur', provider: 'scaleway-genapi', model: 'qwen-3.5', connectors: [], eurPerMonth: 5, eurThisMonth: 0.02, createdBy: you, createdAt: at(-600) }
const synthese = { id: 'agt_4', handle: 'synthese', name: 'Synthèse', provider: 'scaleway-genapi', model: 'glm-5.3', connectors: [], eurPerMonth: 5, eurThisMonth: 0.01, createdBy: you, createdAt: at(-600) }
// Two coordinated channels (simulated): an author then a verifier, and parts in parallel then a synthesis.
const relecture = {
  id: 'chn_2', name: 'relecture', title: 'relecture', kind: 'team' as const, members: [you], agents: ['agt_1', 'agt_2', 'agt_3'], connectors: [],
  createdBy: you, createdAt: at(-600), coordination: { mode: 'author-verifier', authorId: 'agt_1', verifierId: 'agt_2' },
}
const parallele = {
  id: 'chn_3', name: 'veille', title: 'veille', kind: 'team' as const, members: [you], agents: ['agt_1', 'agt_2', 'agt_3', 'agt_4'], connectors: [],
  createdBy: you, createdAt: at(-600), coordination: { mode: 'parallel-synthesis', workerIds: ['agt_1', 'agt_3'], synthesizerId: 'agt_4', maxEurPerTurn: 1 },
}
const chat = createMockChat({
  you,
  agents: [assistant, analyste, redacteur, synthese],
  channels: [lane, channel, relecture, parallele],
  messages: [
    {
      id: 'msg_21', channelId: 'chn_2', author: { kind: 'human', email: you }, text: '@assistant rédige la relance Sodiac', mentions: ['agt_1'], createdAt: at(1), updatedAt: at(2),
      turns: [{
        id: 'trn_21', agentId: 'agt_1', status: 'done', eur: 0.0062, startedAt: at(1), finishedAt: at(2),
        steps: [
          { role: 'author', agentId: 'agt_1', tokens: { input: 3100, output: 420 }, eur: 0.0021 },
          { role: 'verifier', agentId: 'agt_2', tokens: { input: 1200, output: 160 }, eur: 0.0018, verdict: 'issues', notes: ['Le montant ne correspond pas à FA2610-031 (1 640,00 €).'] },
          { role: 'revision', agentId: 'agt_1', tokens: { input: 3500, output: 430 }, eur: 0.0023, replaced: true },
        ],
      }],
    },
    { id: 'msg_22', channelId: 'chn_2', author: { kind: 'agent', agentId: 'agt_1' }, replyTo: 'msg_21', text: 'Relance prête, montant corrigé : 1 640,00 €.', mentions: [], createdAt: at(2), updatedAt: at(2) },
    {
      id: 'msg_23', channelId: 'chn_2', author: { kind: 'human', email: you }, text: '@assistant prépare le récapitulatif des impayés', mentions: ['agt_1'], createdAt: at(5), updatedAt: at(6),
      turns: [{
        id: 'trn_23', agentId: 'agt_1', status: 'done', eur: 0.0019, startedAt: at(5), finishedAt: at(6),
        steps: [
          { role: 'author', agentId: 'agt_1', eur: 0.0019 },
          { role: 'verifier', agentId: 'agt_2', verdict: 'skipped', notes: ['plafond mensuel de @analyste atteint'] },
        ],
      }],
    },
    { id: 'msg_24', channelId: 'chn_2', author: { kind: 'agent', agentId: 'agt_1' }, replyTo: 'msg_23', text: 'Récapitulatif : 3 factures, 4 210,00 €.', mentions: [], createdAt: at(6), updatedAt: at(6) },
    {
      id: 'msg_31', channelId: 'chn_3', author: { kind: 'human', email: you }, text: '@synthese que disent les appels d\'offres de la semaine ?', mentions: ['agt_4'], createdAt: at(1), updatedAt: at(3),
      turns: [{
        id: 'trn_31', agentId: 'agt_4', status: 'done', eur: 0.0105, startedAt: at(1), finishedAt: at(3),
        steps: [
          { role: 'worker', agentId: 'agt_1', text: 'Région Réunion : 2 appels BI, clôture le 05/12.', eur: 0.004 },
          { role: 'worker', agentId: 'agt_3', verdict: 'skipped', notes: ['le coût du tour atteindrait sa borne (1 €)'] },
          { role: 'synthesis', agentId: 'agt_4', eur: 0.0065 },
        ],
      }],
    },
    { id: 'msg_32', channelId: 'chn_3', author: { kind: 'agent', agentId: 'agt_4' }, replyTo: 'msg_31', text: 'Deux appels BI à la Région, clôture le 05/12 ; une source n\'a pas répondu.', mentions: [], createdAt: at(3), updatedAt: at(3) },
    { id: 'msg_1', channelId: 'chn_1', author: { kind: 'human', email: 'smarion@datanalysis.re' }, text: 'Sodiac n\'a toujours pas réglé FA2610-031.', mentions: [], createdAt: at(0), updatedAt: at(0) },
    {
      id: 'msg_2', channelId: 'chn_1', author: { kind: 'human', email: you }, text: '@assistant prépare un brouillon de relance pour Sodiac', mentions: ['agt_1'], createdAt: at(3), updatedAt: at(4),
      turns: [{ id: 'trn_1', agentId: 'agt_1', status: 'done', tokens: { input: 4421, output: 540 }, eur: 0.0041, startedAt: at(3), finishedAt: at(4) }],
    },
    { id: 'msg_3', channelId: 'chn_1', author: { kind: 'agent', agentId: 'agt_1' }, replyTo: 'msg_2', text: 'Brouillon prêt :\n\n| Facture | Montant | Échéance |\n|---|---:|---|\n| FA2610-031 | 1 640,00 € | 02/10 |\n\nLa carte attend votre décision : rien ne part sans elle.', mentions: [], createdAt: at(4), updatedAt: at(4) },
  ],
  models: [{ provider: 'scaleway-genapi', model: 'deepseek-v4.1-flash' }, { provider: 'scaleway-genapi', model: 'glm-5.3' }],
  mounted: [
    { module: 'office365', server: 'office365', enabled: true },
    { module: 'qonto', server: 'qonto', enabled: true },
    { module: 'dolibarr', server: 'dolibarr', enabled: false },
  ],
  cards: [{
    id: 'apr_2', kind: 'propose_agent', title: 'propose_agent', requestedBy: you, requestedByAgent: { id: 'agt_1', handle: 'assistant' },
    requestedAt: at(6), channelId: 'chn_1', messageId: 'msg_3', state: 'pending', canDecide: true,
    proposal: {
      name: 'Recouvrement', handle: 'recouvrement', provider: 'scaleway-genapi', model: 'deepseek-v4.1-flash',
      instructions: 'Suit les factures impayées de plus de 30 jours et prépare les relances, sans rien envoyer.', connectors: ['qonto'], eurPerMonth: 3,
    },
  }, { id: 'apr_1', kind: 'send-email', title: 'Envoyer la relance de la facture FA2610-031 à la comptabilité de Sodiac', requestedBy: 'assistant', requestedAt: at(4), channelId: 'chn_1', messageId: 'msg_2', state: 'pending' }],
}, () => t0 + 10 * 60000)

const page: PageStateRow = {
  you, canWrite: true, canAdmin: true, role: 'owner', rolesFrom: 'authority', missions: [], briefs: [],
  approvals: [{ id: 'apr_1', kind: 'send-email', title: 'Envoyer la relance de la facture FA2610-031 à la comptabilité de Sodiac', requestedBy: 'assistant', requestedAt: at(4) }],
  memories: [
    { id: 'mem_1', scope: 'team', kind: 'fact', text: 'Sodiac paie à 60 jours fin de mois ; relancer la comptabilité, pas l\'acheteur.', createdBy: you },
    { id: 'mem_2', scope: 'user', kind: 'preference', text: 'Les relances partent depuis contact@, jamais depuis duke@.', createdBy: you },
  ],
}
const api = new Proxy({}, {
  get: (_t, key) => key === 'state' ? async () => page
    : key === 'members' ? async () => [
      { subject: you, role: 'owner' }, { subject: 'jlebon@datanalysis.re', role: 'admin' },
      { subject: 'smarion@datanalysis.re', role: 'operator' }, { subject: 'stagiaire@datanalysis.re', role: 'viewer' },
    ]
      : key === 'grantMember' ? async (subject: string, role: string) => ({ ok: true, value: { subject, role } })
        : key === 'search' ? async () => []
          : key === 'decide' ? async () => ({ ok: true })
            : async () => { throw new Error('harnais') },
}) as MndtFace

const documents = createMockDocuments({
  chn_1: {
    canDeposit: true,
    documents: [{ id: 'doc_1', name: 'Relevé Sodiac octobre 2026.pdf', size: 248_312, type: 'application/pdf', pages: 3, uploadedBy: 'smarion@datanalysis.re', uploadedAt: at(-30), canRetire: false }],
  },
}, you)

const style = document.createElement('style')
style.textContent = CSS + TEAM_CSS
document.head.append(style)
createRoot(document.getElementById('root') as HTMLElement).render(
  <CollabPage api={api} chat={chat} documents={documents} t={translate} tc={chatFrench}
    team={{ name: 'Stéphane Masson', owner: true, advancedHref: '/dsh/', org: { name: 'DATANALYSIS', env: 'Préproduction' }, names: { [you]: 'Stéphane Masson', 'smarion@datanalysis.re': 'Sophie Marion' } }} />,
)
