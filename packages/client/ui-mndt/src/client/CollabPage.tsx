/**
 * The collaboration space.
 *
 * Slack gives the shape, not the subject: a left list of channels, a structured
 * feed, a context panel, and a composer that launches work instead of chatting.
 * A channel is a perimeter of responsibility (the team, one mandate, the system),
 * every post is typed, and the approval card is the only place a decision is made.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MemberRow, MndtFace, MandateRow, PageStateRow } from './MndtPage.tsx'

/** One journal line as the Host reports it. */
interface EventRow {
  readonly at: string
  readonly actor: string
  readonly action: string
  readonly subject: string
  readonly detail?: string
}

/** The state with the links the collaboration view needs. */
interface CollabState extends PageStateRow {
  readonly events?: readonly EventRow[]
  readonly members?: readonly MemberRow[]
  readonly missions: readonly (PageStateRow['missions'][number] & { readonly mandateId?: string; readonly briefId?: string })[]
  readonly briefs: readonly (PageStateRow['briefs'][number] & { readonly missionId?: string })[]
  readonly approvals: readonly (PageStateRow['approvals'][number] & { readonly missionId?: string })[]
}

/** One selectable channel. */
interface Channel {
  readonly id: string
  readonly kind: 'team' | 'mandate' | 'system'
  readonly name: string
  readonly subject: string
  readonly badge?: number
}

/** One body in the feed. */
type PostBody =
  | ReturnType<typeof missionPost>
  | { readonly kind: 'brief'; readonly title: string; readonly markdown: string; readonly author: string; readonly at: string }
  | { readonly kind: 'approval'; readonly id: string; readonly title: string; readonly approvalKind: string; readonly author: string; readonly at: string }
  | { readonly kind: 'event'; readonly action: string; readonly actor: string; readonly subject: string; readonly detail?: string | undefined; readonly at: string }

/** Anything the feed can show. */
interface Post {
  readonly id: string
  readonly at: string
  readonly channel: string
  readonly body: PostBody
}

/** @param count - a number. @param singular - the word for one. @param plural - the word for several. @returns the right word. */
function word(count: number, singular: string, plural: string): string {
  return count > 1 ? plural : singular
}

/** @param at - ISO time. @returns a short French clock. */
function clockOf(at: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
}

/** @param at - ISO time. @returns a French day label. */
function dayOf(at: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
}

/** @param a - ISO time. @returns milliseconds, or zero. */
function timeOf(a: string): number {
  const value = new Date(a).getTime()
  return Number.isNaN(value) ? 0 : value
}

/** @param state - the page state. @returns the channels to show. */
function approvalsOfMandate(state: CollabState, mandate: MandateRow): number {
  const linked = state.approvals.filter(approval => approval.missionId !== undefined
    && state.missions.some(mission => mission.id === approval.missionId && mission.mandateId === mandate.id))
  return linked.length
}

function channelsOf(state: CollabState): Channel[] {
  const mandates = state.mandates ?? []
  const list: Channel[] = [{
    id: 'team',
    kind: 'team',
    name: 'equipe',
    subject: 'Tout ce qui se passe dans Duke Analytics',
  }]
  for (const mandate of mandates) {
    list.push({
      id: `mandate:${mandate.id}`,
      kind: 'mandate',
      name: mandate.purpose === '' ? mandate.id : `${mandate.purpose} - ${mandate.delegataire.split('@')[0] ?? mandate.delegataire}`,
      subject: `${mandate.delegant} delegue a ${mandate.delegataire}`,
      badge: approvalsOfMandate(state, mandate),
    })
  }
  list.push({
    id: 'system',
    kind: 'system',
    name: 'systeme',
    subject: 'Briefing automatique, refus, expirations, journal',
  })
  return list
}

/** @param mission - the mission. @returns a mission card. */
function missionPost(mission: CollabState['missions'][number], brief: CollabState['briefs'][number] | undefined, mandate: MandateRow | undefined) {
  const state = mission.status
  return {
    kind: 'mission' as const,
    title: mission.kind,
    prompt: mission.prompt,
    author: mission.createdBy,
    at: mission.createdAt,
    status: state,
    visibility: mission.visibility ?? 'private',
    mandate: mandate?.purpose,
    brief,
    error: mission.error,
  }
}

/**
 * Build the feed of one channel.
 * @param state - the page state.
 * @param channel - the selected channel.
 * @returns the posts, newest first.
 */
function feedOf(state: CollabState, channel: Channel): Post[] {
  const mandates = state.mandates ?? []
  const mandateId = channel.kind === 'mandate' ? channel.id.slice('mandate:'.length) : undefined
  const mandate = mandates.find(candidate => candidate.id === mandateId)
  const missions = state.missions.filter((mission) => {
    if (channel.kind === 'system') return mission.createdBy !== state.you && !(state.mandates ?? []).some(m => m.delegataire === mission.createdBy && m.state === 'active')
    if (mandateId === undefined) return true
    return mission.mandateId === mandateId
  })
  const missionIds = new Set(missions.map(mission => mission.id))
  const briefs = state.briefs.filter(brief => brief.missionId === undefined || missionIds.has(brief.missionId))
  const posts: Post[] = []
  for (const mission of missions) {
    const brief = state.briefs.find(candidate => candidate.id === mission.briefId)
    posts.push({
      id: `mission:${mission.id}`,
      at: mission.createdAt,
      channel: channel.id,
      body: missionPost(mission, brief, mandate),
    })
  }
  if (channel.kind === 'team') {
    const known = new Set(missions.map(mission => mission.id))
    for (const brief of briefs) {
      if (brief.missionId !== undefined && known.has(brief.missionId)) continue
      posts.push({
        id: `brief:${brief.id}`,
        at: brief.createdAt,
        channel: channel.id,
        body: { kind: 'brief' as const, title: brief.title, markdown: brief.markdown, author: brief.createdBy ?? 'agent', at: brief.createdAt },
      })
    }
  }
  for (const approval of state.approvals) {
    if (channel.kind !== 'team' && (approval.missionId === undefined || !missionIds.has(approval.missionId))) continue
    posts.push({
      id: `approval:${approval.id}`,
      at: approval.requestedAt,
      channel: channel.id,
      body: { kind: 'approval' as const, id: approval.id, title: approval.title, approvalKind: approval.kind, author: approval.requestedBy, at: approval.requestedAt },
    })
  }
  if (channel.kind === 'system' || channel.kind === 'team') {
    for (const event of state.events ?? []) {
      posts.push({
        id: `event:${event.at}:${event.action}:${event.subject}`,
        at: event.at,
        channel: channel.id,
        body: { kind: 'event' as const, action: event.action, actor: event.actor, subject: event.subject, detail: event.detail, at: event.at },
      })
    }
  }
  posts.sort((a, b) => timeOf(b.at) - timeOf(a.at))
  return posts
}

/** @param state - the page state. @returns known human members. */
function humansOf(state: CollabState): readonly MemberRow[] {
  return state.members ?? []
}

/** @param subject - the identifier an event points at. @returns a readable label. */
function subjectLabel(subject: string): string {
  if (subject.startsWith('mis_')) return 'une mission'
  if (subject.startsWith('apr_')) return 'une approbation'
  if (subject.startsWith('mnd_')) return 'un mandat'
  if (subject.startsWith('brf_')) return 'un brief'
  return subject
}

/** @param action - the journal action. @returns a readable sentence. */
function sentenceOf(action: string): string {
  const table: Record<string, string> = {
    'mission.created': 'mission lancee',
    'mission.started': 'mission lancee',
    'mission.queued': 'mission mise en file',
    'mission.done': 'mission terminee',
    'mission.completed': 'mission terminee',
    'mission.failed': 'mission echouee',
    'mission.refused': 'mission refusee',
    'approval.requested': 'approbation demandee',
    'approval.decided': 'approbation decidee',
    'approval.approved': 'approbation approuvee',
    'approval.rejected': 'approbation refusee',
    'mandate.proposed': 'mandat propose',
    'mandate.signed': 'mandat signe',
    'mandate.retired': 'mandat retire',
  }
  return table[action] ?? action
}

/** The missions a person can launch from a channel. */
const MISSION_KINDS = [
  { value: 'custom', label: 'Demande libre' },
  { value: 'briefing', label: 'Briefing du matin' },
  { value: 'meeting-prep', label: 'Preparation de reunion' },
  { value: 'account-review', label: 'Revue de compte' },
  { value: 'invoice-chase', label: 'Relance de facture' },
  { value: 'signal-watch', label: 'Veille de signaux' },
  { value: 'weekly-synthesis', label: 'Synthese hebdomadaire' },
] as const

/** @param props - the face the Host exposes. */
export interface CollabPageProps {
  readonly api: MndtFace
}

export function CollabPage({ api }: CollabPageProps) {
  const [state, setState] = useState<CollabState | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [channelId, setChannelId] = useState('team')
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [openBriefs, setOpenBriefs] = useState<ReadonlySet<string>>(new Set())
  const [prompt, setPrompt] = useState('')
  const [kind, setKind] = useState('custom')
  const [share, setShare] = useState(false)
  const [launching, setLaunching] = useState(false)

  const load = useCallback(async () => {
    try {
      const [next, members] = await Promise.all([api.state(), api.members().catch(() => [] as readonly MemberRow[])])
      setState({ ...next, members })
      setError(undefined)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [api])

  useEffect(() => { void load() }, [load])

  const channels = useMemo(() => (state === undefined ? [] : channelsOf(state)), [state])
  const channel = channels.find(candidate => candidate.id === channelId) ?? channels[0]
  const posts = useMemo(() => (state === undefined || channel === undefined ? [] : feedOf(state, channel)), [state, channel])
  const mandate = state === undefined || channel?.kind !== 'mandate'
    ? undefined
    : (state.mandates ?? []).find(candidate => `mandate:${candidate.id}` === channel.id)

  const decide = async (id: string, decision: 'approved' | 'rejected', reason?: string): Promise<void> => {
    if (decision === 'rejected' && (reason === undefined || reason.trim() === '')) {
      setError('un motif est requis pour refuser une approbation')
      return
    }
    setBusy(id)
    try {
      await api.decide(id, decision, reason)
      await load()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(undefined)
    }
  }

  const launch = async (): Promise<void> => {
    if (prompt.trim() === '' || launching) return
    const request = prompt.trim()
    setLaunching(true)
    setError(undefined)
    setPrompt('')
    // The Host answers once the mission settled, which can take minutes. The
    // mission exists as soon as it is accepted, so the feed is refreshed while
    // the call is still running instead of waiting in silence.
    const timer = setInterval(() => { void load() }, 5000)
    try {
      const outcome = await api.runMission(kind, request)
      if (!outcome.ok) throw new Error(outcome.error ?? 'la mission a ete refusee')
      const mission = outcome.value?.mission
      if (share && mission !== undefined) await api.shareMission(mission.id, 'team')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      clearInterval(timer)
      setLaunching(false)
      await load()
    }
  }

  const toggleBrief = (id: string): void => {
    setOpenBriefs((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (state === undefined) {
    return <div className="mndt mndt-loading">{error === undefined ? 'Chargement de l espace...' : error}</div>
  }

  const pending = state.approvals.length
  const humans = humansOf(state)
  const agents = [...new Set(state.missions.map(mission => mission.createdBy))].filter(subject => subject !== state.you && !humans.some(human => human.subject === subject) && !subject.includes('@'))

  return (
    <div className="mndt mndt-collab">
      <aside className="mndt-channels" aria-label="Canaux">
        <div className="mndt-channels-head">
          <span className="mndt-channels-title">mndt</span>
          <span className="mndt-channels-workspace">Duke Analytics</span>
        </div>
        {['team', 'mandate', 'system'].map((kind) => {
          const group = channels.filter(candidate => candidate.kind === kind)
          if (group.length === 0) return undefined
          const label = kind === 'team' ? 'Equipe' : kind === 'mandate' ? 'Mandats' : 'Systeme'
          return (
            <div key={kind} className="mndt-channel-group">
              <div className="mndt-channel-group-head">
                <span>{label}</span>
                <span className="mndt-channel-group-count">{group.length}</span>
              </div>
              {group.map(candidate => (
                <button
                  key={candidate.id}
                  type="button"
                  className="mndt-channel"
                  data-active={candidate.id === channel?.id}
                  onClick={() => { setChannelId(candidate.id) }}
                >
                  <span className="mndt-channel-hash">{candidate.kind === 'mandate' ? '\u25CF' : '#'}</span>
                  <span className="mndt-channel-name">{candidate.name}</span>
                  {candidate.badge !== undefined && candidate.badge > 0 ? <span className="mndt-channel-badge">{candidate.badge}</span> : undefined}
                </button>
              ))}
            </div>
          )
        })}
        <div className="mndt-channels-foot">
          <div className="mndt-presence">
            <span className="mndt-dot" data-state="available" />
            <span>{state.you}</span>
            <span className="mndt-role">{state.role ?? 'membre'}</span>
          </div>
          <div className="mndt-presence">
            <span className="mndt-dot" data-state="working" />
            <span>{pending} decision{pending > 1 ? 's' : ''} en attente</span>
          </div>
        </div>
      </aside>

      <section className="mndt-main">
        <header className="mndt-channel-head">
          <div className="mndt-channel-head-main">
            <h1 className="mndt-channel-title">
              {channel?.kind === 'mandate' ? channel.name : `# ${channel?.name ?? 'equipe'}`}
            </h1>
            <p className="mndt-channel-subject">{channel?.subject}</p>
          </div>
          <div className="mndt-channel-head-side">
            <button type="button" className="mndt-button" onClick={() => { void load() }}>Rafraichir</button>
            {mandate === undefined ? undefined : <span className="mndt-pill" data-tone="state">{mandate.state}</span>}
            <span className="mndt-pill" data-tone="id">{posts.length} {word(posts.length, 'post', 'posts')}</span>
            {pending > 0 ? <span className="mndt-pill" data-tone="write">{pending} a decider</span> : undefined}
          </div>
        </header>

        {error === undefined ? undefined : <div className="mndt-error">{error}</div>}

        <div className="mndt-feed">
          {posts.length === 0 ? <p className="mndt-empty">Rien dans ce canal pour le moment.</p> : undefined}
          {posts.map((post, index) => {
            const previous = posts[index - 1]
            const newDay = previous === undefined || dayOf(previous.at) !== dayOf(post.at)
            return (
              <div key={post.id}>
                {newDay ? <div className="mndt-day">{dayOf(post.at)}</div> : undefined}
                <PostView
                  post={post}
                  busy={busy}
                  canDecide={state.canAdmin === true}
                  isYou={post.body.kind === 'approval' && post.body.author === state.you}
                  open={openBriefs.has(post.id)}
                  onToggle={() => { toggleBrief(post.id) }}
                  onDecide={(id, decision, reason) => { void decide(id, decision, reason) }}
                />
              </div>
            )
          })}
        </div>

        <div className="mndt-composer">
          <div className="mndt-composer-frame">
            <div className="mndt-composer-line">
              <span className="mndt-composer-hint">Lancer une mission dans {channel?.kind === 'mandate' ? channel.name : `# ${channel?.name ?? 'equipe'}`}.</span>
              <span className="mndt-composer-note">Elle demarre en prive ; cochez le partage pour la montrer a l equipe.</span>
            </div>
            <div className="mndt-composer-row">
              <select className="mndt-input" value={kind} onChange={(event) => { setKind(event.target.value) }} aria-label="Type de mission">
                {MISSION_KINDS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              {state.canShare === true ? (
                <label className="mndt-check">
                  <input type="checkbox" checked={share} onChange={(event) => { setShare(event.target.checked) }} />
                  partager a l equipe
                </label>
              ) : undefined}
            </div>
            <textarea
              className="mndt-input mndt-composer-input"
              placeholder="Ce que vous voulez obtenir, en une phrase."
              value={prompt}
              onChange={(event) => { setPrompt(event.target.value) }}
              disabled={!state.canWrite}
            />
            <div className="mndt-composer-actions">
              <span className="mndt-role">{!state.canWrite ? 'lecture seule' : `${prompt.trim().length} caracteres`}</span>
              <button
                type="button"
                className="mndt-button"
                data-variant="primary"
                disabled={!state.canWrite || launching || prompt.trim() === ''}
                onClick={() => { void launch() }}
              >{launching ? 'Lancement...' : 'Lancer une mission'}</button>
            </div>
          </div>
        </div>
      </section>

      <aside className="mndt-context" aria-label="Contexte">
        {mandate === undefined ? (
          <>
            <h2 className="mndt-context-title">Espace</h2>
            <section className="mndt-context-block">
              <div className="mndt-context-label">Vue</div>
              <p className="mndt-context-value">{posts.length} {word(posts.length, 'post', 'posts')} sur ce canal, {state.missions.length} {word(state.missions.length, 'mission', 'missions')}, {state.briefs.length} {word(state.briefs.length, 'brief', 'briefs')}.</p>
            </section>
            <section className="mndt-context-block">
              <div className="mndt-context-label">Humains</div>
              {humans.length === 0 ? <p className="mndt-context-value">La liste des membres se charge avec le panneau Membres.</p> : humans.map(human => (
                <div key={human.subject} className="mndt-person">
                  <span className="mndt-avatar">{human.subject.slice(0, 1).toUpperCase()}</span>
                  <span className="mndt-person-name">{human.subject}</span>
                  <span className="mndt-person-role">{human.role}</span>
                </div>
              ))}
            </section>
            <section className="mndt-context-block">
              <div className="mndt-context-label">Agents</div>
              {agents.length === 0 ? <p className="mndt-context-value">Les agents apparaissent ici des qu ils ont produit un brief.</p> : agents.map(agent => (
                <div key={agent} className="mndt-person">
                  <span className="mndt-avatar" data-agent="true">{agent.slice(0, 1).toUpperCase()}</span>
                  <span className="mndt-person-name">{agent}</span>
                  <span className="mndt-person-role">{state.missions.some(mission => mission.createdBy === agent && (mission.status === 'running' || mission.status === 'queued')) ? 'agent, en mission' : 'agent, disponible'}</span>
                </div>
              ))}
            </section>
          </>
        ) : (
          <>
            <h2 className="mndt-context-title">Mandat</h2>
            <section className="mndt-context-block">
              <div className="mndt-context-grid">
                <span className="mndt-context-label">Mandant</span><span className="mndt-context-value">{mandate.delegant}</span>
                <span className="mndt-context-label">Delegataire</span><span className="mndt-context-value">{mandate.delegataire}</span>
                <span className="mndt-context-label">Etat</span><span className="mndt-context-value">{mandate.state}{mandate.signedBy === undefined ? '' : ` par ${mandate.signedBy}`}</span>
                <span className="mndt-context-label">Echeance</span><span className="mndt-context-value">{mandate.expiresOn}</span>
                <span className="mndt-context-label">Limite</span><span className="mndt-context-value">{mandate.dailyCap} missions par jour</span>
              </div>
            </section>
            <section className="mndt-context-block">
              <div className="mndt-context-label">Perimetre</div>
              <p className="mndt-context-value">{mandate.missionKinds.join(', ') || 'aucune mission autorisee'}</p>
            </section>
            <section className="mndt-context-block">
              <div className="mndt-context-label">Connecteurs autorises</div>
              <div className="mndt-tags">
                {mandate.connectors.map(connector => <span key={connector} className="mndt-tag">{connector}</span>)}
              </div>
            </section>
            <section className="mndt-context-block">
              <div className="mndt-context-label">Missions liees</div>
              <p className="mndt-context-value">{posts.filter(post => post.body.kind === 'mission').length} {word(posts.filter(post => post.body.kind === 'mission').length, 'mission', 'missions')} sur ce mandat.</p>
            </section>
            <section className="mndt-context-block">
              <div className="mndt-context-label">Approbations</div>
              <p className="mndt-context-value">{state.approvals.filter(approval => approval.missionId !== undefined && state.missions.some(mission => mission.id === approval.missionId && mission.mandateId === mandate.id)).length} en attente.</p>
            </section>
          </>
        )}
      </aside>
    </div>
  )
}

/** One post in the feed. */
function PostView(props: {
  post: Post
  busy: string | undefined
  canDecide: boolean
  isYou: boolean
  open: boolean
  onToggle(): void
  onDecide(id: string, decision: 'approved' | 'rejected', reason?: string): void
}) {
  const { post, busy, canDecide, isYou, open } = props
  const [refusing, setRefusing] = useState(false)
  const [reason, setReason] = useState('')
  const toggle = (): void => { props.onToggle() }
  const decide = (id: string, decision: 'approved' | 'rejected', why?: string): void => { props.onDecide(id, decision, why) }
  const body = post.body
  if (body.kind === 'event') {
    return (
      <div className="mndt-event-post">
        <span className="mndt-event-time">{clockOf(body.at)}</span>
        <span className="mndt-event-actor">{body.actor}</span>
        <span className="mndt-event-text">{sentenceOf(body.action)} : {subjectLabel(body.subject)}</span>
      </div>
    )
  }
  if (body.kind === 'approval') {
    return (
      <article className="mndt-post-card" data-kind="approval">
        <div className="mndt-post-head">
          <span className="mndt-post-kind">Approbation requise</span>
          <span className="mndt-pill" data-tone="write">{body.approvalKind}</span>
          <span className="mndt-post-time">{clockOf(body.at)}</span>
        </div>
        <p className="mndt-post-title">{body.title}</p>
        <p className="mndt-post-meta">demandee par {body.author}</p>
        <div className="mndt-post-actions">
          <button
            type="button"
            className="mndt-button"
            data-variant="primary"
            disabled={!canDecide || isYou || busy === body.id}
            onClick={() => { decide(body.id, 'approved') }}
          >Approuver</button>
          {refusing ? undefined : (
            <button
              type="button"
              className="mndt-button"
              disabled={!canDecide || isYou || busy === body.id}
              onClick={() => { setRefusing(true) }}
            >Refuser</button>
          )}
          {isYou ? <span className="mndt-post-note">Vous avez demande cette decision, un autre humain la prend.</span> : undefined}
          {!isYou && !canDecide ? <span className="mndt-post-note">Seul un owner ou un admin peut decider.</span> : undefined}
        </div>
        {refusing ? (
          <div className="mndt-refusal">
            <textarea
              className="mndt-input"
              placeholder="Motif du refus, conserve dans le journal"
              value={reason}
              onChange={(event) => { setReason(event.target.value) }}
            />
            <div className="mndt-post-actions">
              <button
                type="button"
                className="mndt-button"
                data-variant="primary"
                disabled={reason.trim() === ''}
                onClick={() => { decide(body.id, 'rejected', reason.trim()); setRefusing(false) }}
              >Confirmer le refus</button>
              <button
                type="button"
                className="mndt-button"
                onClick={() => { setRefusing(false); setReason('') }}
              >Annuler</button>
            </div>
          </div>
        ) : undefined}
      </article>
    )
  }
  if (body.kind === 'brief') {
    const preview = body.markdown.replace(/[#*`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 220)
    return (
      <article className="mndt-post-card" data-kind="brief">
        <div className="mndt-post-head">
          <span className="mndt-post-kind">Brief</span>
          <span className="mndt-role">agent</span>
          <span className="mndt-post-time">{clockOf(body.at)}</span>
        </div>
        <p className="mndt-post-title">{body.title}</p>
        <p className="mndt-post-body">{preview}{preview.length >= 220 ? '...' : ''}</p>
      </article>
    )
  }
  return (
    <article className="mndt-post-card" data-kind="mission">
      <div className="mndt-post-head">
        <span className="mndt-post-kind">Mission {body.title}</span>
        <span className="mndt-role" data-agent={body.author.includes('@') ? undefined : 'true'}>{body.author}</span>
        <span className="mndt-pill" data-tone="state">{body.status}</span>
        <span className="mndt-post-time">{clockOf(body.at)}</span>
      </div>
      <p className="mndt-post-body">{body.prompt}</p>
      <div className="mndt-post-actions">
        <span className="mndt-tag">{body.visibility === 'team' ? 'equipe' : 'privee'}</span>
        {body.mandate === undefined ? undefined : <span className="mndt-tag">{body.mandate.slice(0, 32)}</span>}
        {body.error === undefined ? undefined : <span className="mndt-error">{body.error}</span>}
        {body.brief === undefined ? undefined : (
          <button type="button" className="mndt-button" onClick={toggle}>{open ? 'Masquer le brief' : 'Ouvrir le brief'}</button>
        )}
      </div>
      {open && body.brief !== undefined ? <pre className="mndt-brief-body">{body.brief.markdown}</pre> : undefined}
    </article>
  )
}
