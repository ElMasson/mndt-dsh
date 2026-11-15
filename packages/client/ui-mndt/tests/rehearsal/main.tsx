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
const channel = { id: 'chn_1', name: 'recouvrement', title: 'recouvrement', kind: 'team' as const, members: [you, 'smarion@datanalysis.re'], agents: ['agt_1'], connectors: [], createdBy: you, createdAt: at(-600) }
const lane = { id: 'chn_0', name: 'solo', title: 'Ma lane', kind: 'solo' as const, members: [you], agents: ['agt_1'], connectors: [], createdBy: you, createdAt: at(-600) }
const chat = createMockChat({
  you,
  agents: [assistant, analyste],
  channels: [lane, channel],
  messages: [
    { id: 'msg_1', channelId: 'chn_1', author: { kind: 'human', email: 'smarion@datanalysis.re' }, text: 'Sodiac n\'a toujours pas réglé FA2610-031.', mentions: [], createdAt: at(0), updatedAt: at(0) },
    {
      id: 'msg_2', channelId: 'chn_1', author: { kind: 'human', email: you }, text: '@assistant prépare un brouillon de relance pour Sodiac', mentions: ['agt_1'], createdAt: at(3), updatedAt: at(4),
      turns: [{ id: 'trn_1', agentId: 'agt_1', status: 'done', tokens: { input: 4421, output: 540 }, eur: 0.0041, startedAt: at(3), finishedAt: at(4) }],
    },
    { id: 'msg_3', channelId: 'chn_1', author: { kind: 'agent', agentId: 'agt_1' }, replyTo: 'msg_2', text: 'Brouillon prêt :\n\n| Facture | Montant | Échéance |\n|---|---:|---|\n| FA2610-031 | 1 640,00 € | 02/10 |\n\nLa carte attend votre décision : rien ne part sans elle.', mentions: [], createdAt: at(4), updatedAt: at(4) },
  ],
  cards: [{ id: 'apr_1', kind: 'send-email', title: 'Envoyer la relance de la facture FA2610-031 à la comptabilité de Sodiac', requestedBy: 'assistant', requestedAt: at(4), channelId: 'chn_1', messageId: 'msg_2', state: 'pending' }],
}, () => t0 + 10 * 60000)

const page: PageStateRow = {
  you, canWrite: true, canAdmin: true, role: 'owner', missions: [], briefs: [],
  approvals: [{ id: 'apr_1', kind: 'send-email', title: 'Envoyer la relance de la facture FA2610-031 à la comptabilité de Sodiac', requestedBy: 'assistant', requestedAt: at(4) }],
  memories: [
    { id: 'mem_1', scope: 'team', kind: 'fact', text: 'Sodiac paie à 60 jours fin de mois ; relancer la comptabilité, pas l\'acheteur.', createdBy: you },
    { id: 'mem_2', scope: 'user', kind: 'preference', text: 'Les relances partent depuis contact@, jamais depuis duke@.', createdBy: you },
  ],
}
const api = new Proxy({}, {
  get: (_t, key) => key === 'state' ? async () => page
    : key === 'members' ? async () => [{ subject: you, role: 'owner' }, { subject: 'smarion@datanalysis.re', role: 'operator' }]
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
