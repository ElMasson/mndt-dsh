/**
 * The collaboration space.
 *
 * Slack gives the shape, not the subject: a left list of channels, a structured
 * feed, a context panel, and a composer that launches work instead of chatting.
 * A channel is a perimeter of responsibility (the team, one mandate, the system),
 * every post is typed, and the approval card is the only place a decision is made.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { AutomationsAnswer, MemberRow, MndtFace, SearchRow } from './face.ts'
import type { ChatAgent, ChatChannel, ChatFace } from './chat.ts'
import { chatEnglish } from './chatLocales.ts'
import type { ChatTranslate } from './chatLocales.ts'
import { ChannelAgents, ChannelList, ChannelThread, reasonOf } from './ChannelView.tsx'
import { translate } from './locales.ts'
import type { MndtTranslate } from './locales.ts'

import {
  MISSION_KINDS, channelsOf, clockOf, dayOf, feedOf, humansOf, sentenceOf, subjectLabel, timeOf, word,
} from './feed.ts'
import type { Channel, CollabState, Post, SearchHit } from './feed.ts'

/** How often the cards are read again while a channel is open, in milliseconds. */
export const CARDS_MS = 10000

/** @param props - the face the Host exposes. */
export interface CollabPageProps {
  readonly api: MndtFace
  /** The locale seat; the page falls back to French when it is absent. */
  readonly t?: MndtTranslate
  /** The team channels of lot 1; absent where they are not served. */
  readonly chat?: ChatFace | undefined
  /** The channels' copy (namespace `mndt.chat`). */
  readonly tc?: ChatTranslate | undefined
  /** Open a turn's DSH session, where this workstation can show it. */
  readonly openTrace?: ((sessionId: string) => void) | undefined
}

export function CollabPage({ api, t = translate, chat, tc = chatEnglish, openTrace }: CollabPageProps) {
  const [state, setState] = useState<CollabState | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [channelId, setChannelId] = useState('team')
  const [view, setView] = useState<'channel' | 'chat' | 'activity' | 'automations' | 'admin'>('channel')
  // Team channels (lot 1): what the workbench serves, or why it could not be read.
  const [chatChannels, setChatChannels] = useState<readonly ChatChannel[] | undefined>(undefined)
  const [chatAgents, setChatAgents] = useState<readonly ChatAgent[]>([])
  const [chatError, setChatError] = useState<string | undefined>(undefined)
  const [chatId, setChatId] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [openBriefs, setOpenBriefs] = useState<ReadonlySet<string>>(new Set())
  const [prompt, setPrompt] = useState('')
  const [kind, setKind] = useState('custom')
  const [share, setShare] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [activityFilter, setActivityFilter] = useState<'all' | 'humans' | 'agents' | 'me'>('all')
  const [activityChannel, setActivityChannel] = useState('all')
  const [search, setSearch] = useState<string | undefined>(undefined)
  const [searchIndex, setSearchIndex] = useState(0)
  const [serverHits, setServerHits] = useState<readonly SearchRow[]>([])

  useEffect(() => {
    const needle = (search ?? '').trim()
    if (needle.length < 2) {
      setServerHits([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      api.search(needle)
        .then((hits) => { if (!cancelled) setServerHits(hits) })
        .catch(() => { if (!cancelled) setServerHits([]) })
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [search, api])
  const [seen, setSeen] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    try {
      const [next, members] = await Promise.all([api.state(), api.members().catch(() => [] as readonly MemberRow[])])
      setState({ ...next, members })
      setError(undefined)
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure)
      setError(/failed to fetch|networkerror|load failed/i.test(message) ? 'L espace n a pas repondu. Verifiez la connexion, puis reessayez.' : message)
    }
  }, [api])

  useEffect(() => { void load() }, [load])

  const loadChat = useCallback(async () => {
    if (chat === undefined) return
    try {
      const [channels, agents] = await Promise.all([chat.channels(), chat.agents()])
      setChatChannels(channels)
      setChatAgents(agents)
      setChatError(undefined)
    } catch (failure) {
      setChatError(reasonOf(failure, tc))
    }
  }, [chat, tc])

  useEffect(() => {
    void loadChat()
    // The agents' spending moves with each turn: read the list again now and then.
    const timer = setInterval(() => { void loadChat() }, 30000)
    return () => { clearInterval(timer) }
  }, [loadChat])

  // A turn ended: its cards and the agents' spending are read at once, not at the next tick.
  const settled = useCallback((): void => {
    void load()
    void loadChat()
  }, [load, loadChat])

  useEffect(() => {
    if (view !== 'chat') return undefined
    // A card asked in another channel, or decided by someone else, still reaches the page.
    const timer = setInterval(() => { void load() }, CARDS_MS)
    return () => { clearInterval(timer) }
  }, [view, load])

  const createChat = useCallback(async (title: string): Promise<string | undefined> => {
    if (chat === undefined) return undefined
    try {
      // The Host derives the identifier from the title, with a free suffix if taken.
      const made = await chat.createChannel({ title })
      setChatChannels(held => [...(held ?? []), made])
      setChatId(made.id)
      setView('chat')
      return undefined
    } catch (failure) {
      return reasonOf(failure, tc)
    }
  }, [chat, tc])

  const addChatAgent = useCallback(async (agentId: string): Promise<string | undefined> => {
    if (chat === undefined || chatId === undefined) return undefined
    try {
      const next = await chat.addAgents(chatId, [agentId])
      setChatChannels(held => held?.map(c => (c.id === next.id ? next : c)))
      return undefined
    } catch (failure) {
      return reasonOf(failure, tc)
    }
  }, [chat, chatId, tc])

  const decideCard = useCallback(async (id: string, decision: 'approved' | 'rejected', reason?: string): Promise<string | undefined> => {
    const outcome = await api.decide(id, decision, reason)
    if (outcome.ok) {
      void load()
      return undefined
    }
    return outcome.error ?? decision
  }, [api, load])

  const [automations, setAutomations] = useState<AutomationsAnswer | undefined>(undefined)
  const [automationError, setAutomationError] = useState<string | undefined>(undefined)
  const [automationBusy, setAutomationBusy] = useState<string | undefined>(undefined)
  const [automationNotice, setAutomationNotice] = useState<string | undefined>(undefined)

  /** Read the automation registry, seeded on the Host side. */
  const loadAutomations = useCallback(async () => {
    try {
      setAutomations(await api.automations())
      setAutomationError(undefined)
    } catch (failure) {
      setAutomationError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [api])

  useEffect(() => {
    if (view === 'automations' && automations === undefined) void loadAutomations()
  }, [view, automations, loadAutomations])

  /** @param id - automation. @param enabled - target state. */
  const toggleAutomation = async (id: string, enabled: boolean): Promise<void> => {
    setAutomationBusy(id)
    setAutomationNotice(undefined)
    try {
      const result = await api.toggleAutomation(id, enabled)
      if (!result.ok) setAutomationError(result.error ?? 'le changement a ete refuse')
      else await loadAutomations()
    } catch (failure) {
      setAutomationError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setAutomationBusy(undefined)
    }
  }

  /** @param id - automation to run now, synchronously. */
  const runAutomationNow = async (id: string): Promise<void> => {
    setAutomationBusy(id)
    setAutomationNotice(undefined)
    try {
      const result = await api.runAutomationNow(id)
      if (!result.ok) setAutomationError(result.error ?? 'l execution a ete refusee')
      else {
        setAutomationNotice(`Execution terminee : ${result.value?.outcome ?? 'ok'}`)
        await loadAutomations()
      }
    } catch (failure) {
      setAutomationError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setAutomationBusy(undefined)
    }
  }


  type MemberRole = 'viewer' | 'operator' | 'admin' | 'owner'
  const MEMBER_ROLES: readonly MemberRole[] = ['viewer', 'operator', 'admin', 'owner']

  const [adminMembers, setAdminMembers] = useState<readonly MemberRow[] | undefined>(undefined)
  const [adminError, setAdminError] = useState<string | undefined>(undefined)
  const [adminNotice, setAdminNotice] = useState<string | undefined>(undefined)
  const [adminBusy, setAdminBusy] = useState<string | undefined>(undefined)
  const [grantEmail, setGrantEmail] = useState('')
  const [grantRole, setGrantRole] = useState<MemberRole>('viewer')
  const [mandatePurpose, setMandatePurpose] = useState('')
  const [mandateDelegate, setMandateDelegate] = useState('')
  const [mandateUntil, setMandateUntil] = useState('')

  /** Read the grant table, which only an administrator can change. */
  const loadAdmin = useCallback(async () => {
    try {
      setAdminMembers(await api.members())
      setAdminError(undefined)
    } catch (failure) {
      setAdminError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [api])

  useEffect(() => {
    if (view === 'admin' && adminMembers === undefined) void loadAdmin()
  }, [view, adminMembers, loadAdmin])

  /** @param subject - the person. @param role - the right to give. */
  const changeMemberRole = async (subject: string, role: MemberRole): Promise<void> => {
    setAdminBusy(`grant:${subject}`)
    setAdminError(undefined)
    try {
      const result = await api.grantMember(subject, role)
      if (!result.ok) setAdminError(result.error ?? 'le droit n a pas ete accorde')
      else {
        setAdminNotice(`${subject} : ${role}`)
        setAdminMembers(await api.members())
      }
    } catch (failure) {
      setAdminError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setAdminBusy(undefined)
    }
  }

  const grantTypedMember = async (): Promise<void> => {
    const subject = grantEmail.trim()
    if (subject === '') return
    setAdminBusy('grant')
    setAdminError(undefined)
    setAdminNotice(undefined)
    try {
      const result = await api.grantMember(subject, grantRole)
      if (!result.ok) setAdminError(result.error ?? 'le droit n a pas ete accorde')
      else {
        setAdminNotice(`${subject} : ${grantRole}`)
        setGrantEmail('')
        setAdminMembers(await api.members())
      }
    } catch (failure) {
      setAdminError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setAdminBusy(undefined)
    }
  }

  /** @param subject - the person to remove. */
  const revokeMemberNow = async (subject: string): Promise<void> => {
    setAdminBusy(`revoke:${subject}`)
    setAdminError(undefined)
    try {
      const result = await api.revokeMember(subject)
      if (!result.ok) setAdminError(result.error ?? 'le retrait a ete refuse')
      else {
        setAdminNotice(`${subject} : acces retire`)
        setAdminMembers(await api.members())
        await load()
      }
    } catch (failure) {
      setAdminError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setAdminBusy(undefined)
    }
  }

  const proposeMandate = async (): Promise<void> => {
    if (mandatePurpose.trim() === '' || mandateDelegate.trim() === '') {
      setAdminError('un mandat a besoin d un objet et d un delegataire')
      return
    }
    setAdminBusy('mandate')
    setAdminError(undefined)
    setAdminNotice(undefined)
    try {
      const result = await api.createMandate({
        purpose: mandatePurpose.trim(),
        delegataire: mandateDelegate.trim(),
        dailyCap: 3,
        ...(mandateUntil === '' ? {} : { expiresOn: mandateUntil }),
      })
      if (!result.ok) setAdminError(result.error ?? 'le mandat a ete refuse')
      else {
        setAdminNotice(`mandat propose : ${result.value?.purpose ?? mandatePurpose.trim()}`)
        setMandatePurpose('')
        setMandateDelegate('')
        setMandateUntil('')
        await load()
      }
    } catch (failure) {
      setAdminError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setAdminBusy(undefined)
    }
  }

  /** @param id - mandate. @param action - sign it or retire it. */
  const settleMandate = async (id: string, action: 'sign' | 'retire'): Promise<void> => {
    setAdminBusy(`${action}:${id}`)
    setAdminError(undefined)
    try {
      const result = action === 'sign' ? await api.signMandate(id) : await api.retireMandate(id)
      if (!result.ok) setAdminError(result.error ?? 'le changement a ete refuse')
      else {
        setAdminNotice(`${id} : ${action === 'sign' ? 'signe' : 'retire'}`)
        await load()
      }
    } catch (failure) {
      setAdminError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setAdminBusy(undefined)
    }
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearch('')
        setSearchIndex(0)
      }
      if (event.key === 'Escape') setSearch(undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [])

  const channels = useMemo(() => (state === undefined ? [] : channelsOf(state)), [state])
  const storageKey = state === undefined ? undefined : `mndt.seen.${state.you}`

  useEffect(() => {
    if (storageKey === undefined) return
    const raw = window.localStorage.getItem(storageKey)
    if (raw !== null) {
      try {
        setSeen(JSON.parse(raw) as Record<string, string>)
        return
      } catch {
        window.localStorage.removeItem(storageKey)
      }
    }
    const now = new Date().toISOString()
    const fresh: Record<string, string> = {}
    for (const candidate of channels) fresh[candidate.id] = now
    window.localStorage.setItem(storageKey, JSON.stringify(fresh))
    setSeen(fresh)
  }, [storageKey, channels])
  const channel = channels.find(candidate => candidate.id === channelId) ?? channels[0]

  useEffect(() => {
    if (storageKey === undefined || channel === undefined) return
    const key = storageKey
    const channelKey = channel.id
    setSeen((previous) => {
      if (previous[channelKey] !== undefined) {
        const last = timeOf(previous[channelKey])
        if (Date.now() - last < 5000) return previous
      }
      const next = { ...previous, [channelKey]: new Date().toISOString() }
      window.localStorage.setItem(key, JSON.stringify(next))
      return next
    })
  }, [storageKey, channel])
  const posts = useMemo(() => (state === undefined || channel === undefined ? [] : feedOf(state, channel)), [state, channel])
  const mandate = state === undefined || channel?.kind !== 'mandate'
    ? undefined
    : (state.mandates ?? []).find(candidate => `mandate:${candidate.id}` === channel.id)

  /** @param id - mission. @param action - stop it or run it again. */
  const trackMission = async (id: string, action: 'cancel' | 'retry'): Promise<void> => {
    setBusy('track:' + id)
    setError(undefined)
    try {
      const result = action === 'cancel' ? await api.cancelMission(id) : await api.retryMission(id)
      if (!result.ok) setError(result.error ?? t('ui.action-refusee'))
      else await load()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(undefined)
    }
  }

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
    return (
      <div className="mndt mndt-loading" role="status" aria-live="polite">
        {error === undefined ? t('ui.chargement-de-l-espace') : (
          <div className="mndt-error mndt-error-banner">
            <p>{error}</p>
            <button type="button" className="mndt-button" onClick={() => { void load() }}>{t('ui.reessayer')}</button>
          </div>
        )}
      </div>
    )
  }

  const pending = state.approvals.length

  // On a phone the rail is hidden: one switcher reaches the team channels (the lane first) and the
  // legacy ones, whichever view is open.
  const switched = view === 'chat' && chatId !== undefined ? `chat:${chatId}` : `legacy:${channelId}`
  const mobileSwitcher = (
    <div className="mndt-mobile-bar" data-testid="mobile-switcher">
      <select
        className="mndt-input"
        value={switched}
        onChange={(event) => {
          const [kind, id] = event.target.value.split(/:(.*)/su)
          if (id === undefined) return
          if (kind === 'chat') {
            setChatId(id)
            setView('chat')
          } else {
            setChannelId(id)
            setView('channel')
          }
        }}
        aria-label={t('ui.choisir-un-canal')}
      >
        {chatChannels === undefined || chatChannels.length === 0 ? undefined : (
          <optgroup label={tc('channels')}>
            {chatChannels.map(c => (
              <option key={c.id} value={`chat:${c.id}`}>{c.kind === 'solo' ? tc('lane') : `# ${c.title || c.name}`}</option>
            ))}
          </optgroup>
        )}
        <optgroup label={t('ui.equipe')}>
          {channels.map(candidate => <option key={candidate.id} value={`legacy:${candidate.id}`}>{candidate.name}</option>)}
        </optgroup>
      </select>
      <button type="button" className="mndt-button" onClick={() => { setView(view === 'activity' ? 'channel' : 'activity') }}>
        {view === 'activity' ? t('ui.retour-au-canal') : t('ui.activite')}
      </button>
    </div>
  )
  const humans = humansOf(state)
  const agents = [...new Set(state.missions.map(mission => mission.createdBy))].filter(subject => subject !== state.you && !humans.some(human => human.subject === subject) && !subject.includes('@'))
  const unreadOf = (candidate: Channel): number => {
    const last = seen[candidate.id]
    if (last === undefined) return 0
    return feedOf(state, candidate).filter(post => timeOf(post.at) > timeOf(last)).length
  }
  const activity = [...(state.events ?? [])].sort((a, b) => timeOf(b.at) - timeOf(a.at))
  const isHuman = (actor: string): boolean => humans.some(human => human.subject === actor) || actor.includes('@')
  const channelOfEvent = (subject: string): string => {
    if (subject.startsWith('mis_')) {
      const mission = state.missions.find(candidate => candidate.id === subject)
      if (mission === undefined) return 'system'
      return mission.mandateId === undefined ? 'team' : `mandate:${mission.mandateId}`
    }
    if (subject.startsWith('brf_')) {
      const brief = state.briefs.find(candidate => candidate.id === subject)
      return brief?.missionId === undefined ? 'system' : channelOfEvent(brief.missionId)
    }
    if (subject.startsWith('apr_')) {
      const approval = state.approvals.find(candidate => candidate.id === subject)
      return approval?.missionId === undefined ? 'team' : channelOfEvent(approval.missionId)
    }
    if (subject.startsWith('mnd_')) return `mandate:${subject}`
    return 'system'
  }
  const filteredEvents = activity.filter((event) => {
    if (activityChannel !== 'all' && channelOfEvent(event.subject) !== activityChannel) return false
    if (activityFilter === 'me') return event.actor === state.you
    if (activityFilter === 'humans') return isHuman(event.actor)
    if (activityFilter === 'agents') return !isHuman(event.actor)
    return true
  })
  const markAllRead = (): void => {
    const now = new Date().toISOString()
    const next: Record<string, string> = { ...seen }
    for (const candidate of channels) next[candidate.id] = now
    if (storageKey !== undefined) window.localStorage.setItem(storageKey, JSON.stringify(next))
    setSeen(next)
  }
  const openSearchHit = (hit: SearchHit): void => {
    setSearch(undefined)
    if (hit.kind === 'channel' || hit.kind === 'mandate') {
      setChannelId(hit.kind === 'mandate' ? `mandate:${hit.id}` : hit.id)
      setView('channel')
      return
    }
    if (hit.kind === 'mission' || hit.kind === 'brief') {
      const mission = hit.kind === 'mission'
        ? state.missions.find(candidate => candidate.id === hit.id)
        : state.missions.find(candidate => candidate.id === state.briefs.find(brief => brief.id === hit.id)?.missionId)
      if (mission === undefined) return
      setChannelId(mission.mandateId === undefined ? 'team' : `mandate:${mission.mandateId}`)
      setView('channel')
      setOpenBriefs(previous => new Set([...previous, `mission:${mission.id}`]))
      return
    }
    setChannelId('team')
    setView('channel')
  }
  const searchHits: SearchHit[] = (() => {
    const needle = (search ?? '').trim().toLowerCase()
    if (needle === '') return []
    const hits: SearchHit[] = []
    for (const candidate of channels) {
      if (candidate.name.toLowerCase().includes(needle)) hits.push({ id: candidate.id, kind: 'channel', label: candidate.name, detail: candidate.subject })
    }
    for (const mission of state.missions) {
      if (mission.prompt.toLowerCase().includes(needle) || mission.id.toLowerCase().includes(needle)) {
        hits.push({ id: mission.id, kind: 'mission', label: mission.prompt.slice(0, 90), detail: `${mission.kind}, ${mission.status}, par ${mission.createdBy}` })
      }
    }
    for (const brief of state.briefs) {
      const heading = brief.markdown.split('\n').map(line => line.replace(/^#+\s*/, '').trim()).find(line => line !== '') ?? brief.id
      if (brief.markdown.toLowerCase().includes(needle) || brief.id.toLowerCase().includes(needle)) {
        hits.push({ id: brief.id, kind: 'brief', label: heading.slice(0, 90), detail: 'brief' })
      }
    }
    for (const approval of state.approvals) {
      if (approval.title.toLowerCase().includes(needle) || approval.id.toLowerCase().includes(needle)) {
        hits.push({ id: approval.id, kind: 'approval', label: approval.title, detail: `${approval.kind}, demandee par ${approval.requestedBy}` })
      }
    }
    for (const mandate of state.mandates ?? []) {
      const label = mandate.purpose === '' ? mandate.id : mandate.purpose
      if (label.toLowerCase().includes(needle) || mandate.id.toLowerCase().includes(needle)) {
        hits.push({ id: mandate.id, kind: 'mandate', label, detail: `${mandate.delegant} vers ${mandate.delegataire}, echeance ${mandate.expiresOn}` })
      }
    }
    for (const human of humans) {
      if (human.subject.toLowerCase().includes(needle)) hits.push({ id: human.subject, kind: 'person', label: human.subject, detail: human.role })
    }
    for (const agent of agents) {
      if (agent.toLowerCase().includes(needle)) hits.push({ id: agent, kind: 'person', label: agent, detail: 'agent' })
    }
    const allowed: readonly SearchHit['kind'][] = ['mission', 'brief', 'approval', 'mandate', 'memory']
    for (const hit of serverHits) {
      if (!allowed.includes(hit.kind as SearchHit['kind'])) continue
      if (hits.some(existing => existing.kind === hit.kind && existing.id === hit.id)) continue
      hits.push({ id: hit.id, kind: hit.kind as SearchHit['kind'], label: hit.label, detail: hit.detail })
    }
    return hits.slice(0, 40)
  })()
  const openEvent = (subject: string): void => {
    if (subject.startsWith('mis_')) {
      const mission = state.missions.find(candidate => candidate.id === subject)
      if (mission === undefined) return
      setChannelId(mission.mandateId === undefined ? 'team' : `mandate:${mission.mandateId}`)
      setView('channel')
      setOpenBriefs(previous => new Set([...previous, `mission:${mission.id}`]))
      return
    }
    if (subject.startsWith('brf_')) {
      const brief = state.briefs.find(candidate => candidate.id === subject)
      const mission = state.missions.find(candidate => candidate.id === brief?.missionId)
      if (mission !== undefined) { openSubjectToMission(mission.id); return }
      return
    }
    if (subject.startsWith('mnd_')) {
      setChannelId(`mandate:${subject}`)
      setView('channel')
      return
    }
    setChannelId('team')
    setView('channel')
  }
  const openSubjectToMission = (missionId: string): void => {
    const mission = state.missions.find(candidate => candidate.id === missionId)
    if (mission === undefined) return
    setChannelId(mission.mandateId === undefined ? 'team' : `mandate:${mission.mandateId}`)
    setView('channel')
    setOpenBriefs(previous => new Set([...previous, `mission:${mission.id}`]))
    window.setTimeout(() => {
      const card = document.querySelector(`.mndt-post-card[data-mission="mission:${mission.id}"]`)
      card?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 350)
  }
  const exportActivity = (): void => {
    const rows: string[][] = [['heure', 'acteur', 'action', 'objet', 'detail']]
    for (const event of filteredEvents) {
      rows.push([new Date(event.at).toISOString(), event.actor, sentenceOf(event.action, t), subjectLabel(event.subject, t), event.detail ?? ''])
    }
    const csv = rows.map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `mndt-activite-${new Date().toISOString().slice(0, 10)}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="mndt mndt-collab" data-view={view}>
      <aside className="mndt-channels" aria-label={t('ui.canaux')}>
        <div className="mndt-channels-head">
          <span className="mndt-channels-title">{t('ui.mndt')}</span>
          <span className="mndt-channels-workspace">{t('ui.duke-analytics')}</span>
        </div>
        <button type="button" className="mndt-search-open" onClick={() => { setSearch(''); setSearchIndex(0) }}>
          <span>{t('ui.rechercher')}</span>
          <kbd>{t('ui.ctrl-k')}</kbd>
        </button>
        <div className="mndt-channel-group">
          <div className="mndt-channel-group-head">
            <span>{t('ui.vues')}</span>
          </div>
          <button
            type="button"
            className="mndt-channel"
            data-active={view === 'activity'}
            onClick={() => { setView('activity') }}
          >
            <span className="mndt-channel-hash">{'\u2261'}</span>
            <span className="mndt-channel-name">{t('ui.activite')}</span>
            <span className="mndt-channel-badge">{activity.length}</span>
          </button>
          <button
            type="button"
            className="mndt-channel"
            data-active={view === 'automations'}
            onClick={() => { setView('automations') }}
          >
            <span className="mndt-channel-hash">{'\u2699'}</span>
            <span className="mndt-channel-name">{t('ui.automatisations')}</span>
            <span className="mndt-channel-badge">{automations?.items.filter(item => item.enabled).length ?? 0}</span>
          </button>
          {state.canAdmin !== true ? undefined : (
            <button
              type="button"
              className="mndt-channel"
              data-active={view === 'admin'}
              onClick={() => { setView('admin') }}
            >
              <span className="mndt-channel-hash">{'\u2699'}</span>
              <span className="mndt-channel-name">{t('ui.administration')}</span>
            </button>
          )}
        </div>
        {chat === undefined ? undefined : chatChannels !== undefined ? (
          <ChannelList
            channels={chatChannels}
            selected={view === 'chat' ? chatId : undefined}
            onSelect={(id) => { setChatId(id); setView('chat') }}
            onCreate={createChat}
            t={tc}
          />
        ) : chatError === undefined ? undefined : (
          <p className="mndt-hint mndt-channel-note" role="note" data-testid="chat-not-served">
            {tc('notServed')} ({chatError})
          </p>
        )}
        {['team', 'mandate', 'system'].map((kind) => {
          const group = channels.filter(candidate => candidate.kind === kind)
          if (group.length === 0) return undefined
          const label = kind === 'team' ? t('ui.equipe') : kind === 'mandate' ? t('ui.mandats') : t('ui.systeme')
          return (
            <div key={kind} className="mndt-channel-group">
              <div className="mndt-channel-group-head">
                <span>{label}</span>
                <span className="mndt-channel-group-count">{group.length}</span>
              </div>
              {group.map((candidate) => {
                const unread = unreadOf(candidate)
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    className="mndt-channel"
                    data-active={view === 'channel' && candidate.id === channel?.id}
                    onClick={() => { setChannelId(candidate.id); setView('channel') }}
                  >
                    <span className="mndt-channel-hash">{candidate.kind === 'mandate' ? '\u25CF' : '#'}</span>
                    <span className="mndt-channel-name">{candidate.name}</span>
                    {candidate.badge !== undefined && candidate.badge > 0 ? <span className="mndt-channel-badge">{candidate.badge}</span> : undefined}
                    {unread === 0 ? undefined : <span className="mndt-channel-unread">{unread > 9 ? '9+' : unread}</span>}
                  </button>
                )
              })}
            </div>
          )
        })}
        <div className="mndt-channels-foot">
          <div className="mndt-presence">
            <span className="mndt-dot" data-state="available" />
            <span>{state.you}</span>
            <span className="mndt-role">{state.role ?? t('ui.membre')}</span>
          </div>
          <div className="mndt-presence">
            <span className="mndt-dot" data-state="working" />
            <span>{pending} {t('ui.decision')}{pending > 1 ? t('ui.s') : ''} {t('ui.en-attente')}</span>
          </div>
        </div>
      </aside>

      <section className="mndt-main" style={{ display: view === 'channel' ? undefined : 'none' }}>
        <header className="mndt-channel-head">
          <div className="mndt-channel-head-main">
            <h1 className="mndt-channel-title">
              {channel?.kind === 'mandate' ? channel.name : `# ${channel?.name ?? 'equipe'}`}
            </h1>
            <p className="mndt-channel-subject">{channel?.subject}</p>
            {mandate === undefined ? undefined : (
              <div className="mndt-mandate-band">
                <span>{t('ui.donne-par')} <strong>{mandate.delegant}</strong> {t('ui.a')} <strong>{mandate.delegataire}</strong></span>
                <span>{t('ui.jusqu-au')} {mandate.expiresOn}</span>
                <span>{mandate.dailyCap} {t('ui.missions-par-jour')}</span>
                <span>{t('ui.perimetre')} {mandate.missionKinds.join(', ') || t('ui.aucun-type')}</span>
              </div>
            )}
          </div>
          <div className="mndt-channel-head-side">
            {mobileSwitcher}
            <button type="button" className="mndt-button" onClick={() => { void load() }}>{t('ui.rafraichir')}</button>
            {mandate === undefined ? undefined : <span className="mndt-pill" data-tone="state">{mandate.state}</span>}
            <span className="mndt-pill" data-tone="id">{posts.length} {word(posts.length, 'post', 'posts')}</span>
            {pending > 0 ? <span className="mndt-pill" data-tone="write">{pending} {t('ui.a-decider')}</span> : undefined}
          </div>
        </header>

        {error === undefined ? undefined : (
          <div className="mndt-error mndt-error-banner">
            <span>{error}</span>
            <button type="button" className="mndt-button" onClick={() => { void load() }}>{t('ui.reessayer')}</button>
          </div>
        )}

        <div className="mndt-feed">
          {posts.length === 0 ? <p className="mndt-empty">{t('ui.rien-dans-ce-canal-pour-le-moment')}</p> : undefined}
          {posts.map((post, index) => {
            const previous = posts[index - 1]
            const newDay = previous === undefined || dayOf(previous.at) !== dayOf(post.at)
            return (
              <div key={post.id}>
                {newDay ? <div className="mndt-day">{dayOf(post.at)}</div> : undefined}
                <PostView
                  post={post}
                  t={t}
                  busy={busy}
                  canDecide={state.canAdmin === true}
                  isYou={post.body.kind === 'approval' && post.body.author === state.you}
                  open={openBriefs.has(post.id)}
                  onToggle={() => { toggleBrief(post.id) }}
                  onDecide={(id, decision, reason) => { void decide(id, decision, reason) }}
                  onTrack={(id, action) => { void trackMission(id, action) }}
                />
              </div>
            )
          })}
        </div>

        <div className="mndt-composer">
          <div className="mndt-composer-frame">
            <div className="mndt-composer-line">
              <span className="mndt-composer-hint">{t('ui.lancer-une-mission-dans')} {channel?.kind === 'mandate' ? channel.name : `# ${channel?.name ?? 'equipe'}`}.</span>
              <span className="mndt-composer-note">{t('ui.elle-demarre-en-prive-cochez-le-partage')}</span>
            </div>
            <div className="mndt-composer-row">
              <select className="mndt-input" value={kind} onChange={(event) => { setKind(event.target.value) }} aria-label={t('ui.type-de-mission')}>
                {MISSION_KINDS.map(option => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
              </select>
              {state.canShare === true ? (
                <label className="mndt-check">
                  <input type="checkbox" checked={share} onChange={(event) => { setShare(event.target.checked) }} />
                  {t('ui.partager-a-l-equipe')}
                </label>
              ) : undefined}
            </div>
            <textarea
              className="mndt-input mndt-composer-input"
              placeholder={t('ui.ce-que-vous-voulez-obtenir-en-une')}
              value={prompt}
              onChange={(event) => { setPrompt(event.target.value) }}
              disabled={!state.canWrite}
            />
            <div className="mndt-composer-actions">
              <span className="mndt-role">{!state.canWrite ? t('ui.lecture-seule') : t('ui.caracteres', { count: prompt.trim().length })}</span>
              <button
                type="button"
                className="mndt-button"
                data-variant="primary"
                disabled={!state.canWrite || launching || prompt.trim() === ''}
                onClick={() => { void launch() }}
              >{launching ? t('ui.lancement') : t('ui.lancer-une-mission')}</button>
            </div>
          </div>
        </div>
      </section>

      {(() => {
        const current = chatChannels?.find(c => c.id === chatId)
        if (chat === undefined || current === undefined) return undefined
        return (
          <>
            <section className="mndt-main mndt-chat" style={{ display: view === 'chat' ? undefined : 'none' }}>
              <header className="mndt-channel-head">
                <div className="mndt-channel-head-main">
                  <h1 className="mndt-channel-title">{current.kind === 'solo' ? tc('lane') : `# ${current.title || current.name}`}</h1>
                </div>
                <div className="mndt-channel-head-side">{mobileSwitcher}</div>
              </header>
              <ChannelThread
                chat={chat}
                channel={current}
                agents={chatAgents}
                cards={state.approvals}
                canDecide={state.canAdmin === true}
                onDecide={decideCard}
                openTrace={openTrace}
                you={state.you}
                onSettled={settled}
                t={tc}
              />
            </section>
            <aside className="mndt-context" aria-label={t('ui.contexte')} style={{ display: view === 'chat' ? undefined : 'none' }}>
              <ChannelAgents channel={current} agents={chatAgents} onAdd={addChatAgent} t={tc} />
              <div className="mndt-context-block">
                <h3 className="mndt-context-title">{tc('members')}</h3>
                <ul className="mndt-plain-list">
                  {current.members.map(email => <li key={email}>{email}</li>)}
                </ul>
              </div>
            </aside>
          </>
        )
      })()}
      <section className="mndt-main mndt-automations" style={{ display: view === 'automations' ? undefined : 'none' }}>
        <header className="mndt-channel-head">
          <div className="mndt-channel-head-main">
            <h1 className="mndt-channel-title">{t('ui.automatisations')}</h1>
            <p className="mndt-channel-subject">
              {t('ui.des-missions-planifiees-sans-conversation-elles-ne')}
            </p>
          </div>
          <div className="mndt-channel-head-side">
            <button type="button" className="mndt-button" onClick={() => { void loadAutomations() }}>{t('ui.rafraichir')}</button>
            <span className="mndt-pill" data-tone="id">{automations?.items.length ?? 0} {t('ui.planifiees')}</span>
          </div>
        </header>
        {automationError === undefined ? undefined : <div className="mndt-error mndt-error-banner"><span>{automationError}</span></div>}
        {automationNotice === undefined ? undefined : <p className="mndt-empty">{automationNotice}</p>}
        <div className="mndt-feed">
          {(automations?.items ?? []).map(item => (
            <article key={item.id} className="mndt-post-card" data-kind="automation">
              <div className="mndt-post-head">
                <span className="mndt-post-kind">{item.name}</span>
                <span className="mndt-pill" data-tone="state">{item.enabled ? t('ui.active') : t('ui.suspendue')}</span>
                <span className="mndt-pill" data-tone="id">{item.at} {t('ui.chaque-jour')}</span>
                <span className="mndt-post-time">{item.kind}</span>
              </div>
              <p className="mndt-post-body">{item.prompt}</p>
              <div className="mndt-post-actions">
                {item.lastFiredDate === undefined ? undefined : <span className="mndt-tag">{t('ui.derniere')} {item.lastFiredDate}</span>}
                {item.lastOutcome === undefined ? undefined : <span className="mndt-tag">{item.lastOutcome}</span>}
                {automations?.canAdmin !== true ? undefined : (
                  <>
                    <button
                      type="button"
                      className="mndt-button"
                      disabled={automationBusy === item.id}
                      onClick={() => { void runAutomationNow(item.id) }}
                    >
                      {automationBusy === item.id ? t('ui.en-cours') : t('ui.executer-maintenant')}
                    </button>
                    <button
                      type="button"
                      className="mndt-button"
                      disabled={automationBusy === item.id}
                      onClick={() => { void toggleAutomation(item.id, !item.enabled) }}
                    >
                      {item.enabled ? t('ui.suspendre') : t('ui.activer')}
                    </button>
                  </>
                )}
              </div>
            </article>
          ))}
          {automations !== undefined && automations.items.length === 0 ? <p className="mndt-empty">{t('ui.aucune-automatisation')}</p> : undefined}
        </div>
      </section>

      <section className="mndt-main mndt-admin" style={{ display: view === 'admin' ? undefined : 'none' }}>
        <header className="mndt-channel-head">
          <div className="mndt-channel-head-main">
            <h1 className="mndt-channel-title">{t('ui.administration')}</h1>
            <p className="mndt-channel-subject">{t('ui.les-personnes-leurs-droits-et-les-mandats')}</p>
          </div>
          <div className="mndt-channel-head-side">
            <button type="button" className="mndt-button" onClick={() => { void loadAdmin() }}>{t('ui.rafraichir')}</button>
            <span className="mndt-pill" data-tone="id">{adminMembers?.length ?? 0} {t('ui.personnes')}</span>
          </div>
        </header>
        {adminError === undefined ? undefined : <div className="mndt-error mndt-error-banner"><span>{adminError}</span></div>}
        {adminNotice === undefined ? undefined : <p className="mndt-empty">{adminNotice}</p>}
        <div className="mndt-feed">
          <article className="mndt-post-card" data-kind="members">
            <div className="mndt-post-head">
              <span className="mndt-post-kind">{t('ui.personnes-et-droits')}</span>
              <span className="mndt-pill" data-tone="id">{adminMembers?.length ?? 0}</span>
            </div>
            <div className="mndt-post-body">
              {(adminMembers ?? []).map(member => (
                <div key={member.subject} className="mndt-post-actions">
                  <span className="mndt-tag">{member.subject}</span>
                  <select
                    className="mndt-input"
                    aria-label={t('ui.role-de-personne', { name: member.subject })}
                    value={member.role}
                    disabled={adminBusy === `grant:${member.subject}`}
                    onChange={(event) => { void changeMemberRole(member.subject, event.target.value as MemberRole) }}
                  >
                    {MEMBER_ROLES.map(role => <option key={role} value={role}>{role}</option>)}
                  </select>
                  <button
                    type="button"
                    className="mndt-button"
                    disabled={adminBusy === `revoke:${member.subject}`}
                    onClick={() => { void revokeMemberNow(member.subject) }}
                  >
                    {t('ui.retirer')}
                  </button>
                </div>
              ))}
              {adminMembers !== undefined && adminMembers.length === 0 ? <p className="mndt-empty">{t('ui.aucune-personne')}</p> : undefined}
            </div>
            <div className="mndt-post-actions">
              <input
                className="mndt-input"
                aria-label={t('ui.adresse-de-la-personne-a-accorder')}
                placeholder={t('ui.prenom-datanalysis-re')}
                value={grantEmail}
                onChange={(event) => { setGrantEmail(event.target.value) }}
              />
              <select
                className="mndt-input"
                aria-label={t('ui.role-a-accorder')}
                value={grantRole}
                onChange={(event) => { setGrantRole(event.target.value as MemberRole) }}
              >
                {MEMBER_ROLES.map(role => <option key={role} value={role}>{role}</option>)}
              </select>
              <button type="button" className="mndt-button" disabled={grantEmail.trim() === '' || adminBusy === 'grant'} onClick={() => { void grantTypedMember() }}>
                {t('ui.accorder')}
              </button>
            </div>
          </article>

          <article className="mndt-post-card" data-kind="mandates">
            <div className="mndt-post-head">
              <span className="mndt-post-kind">{t('ui.mandats')}</span>
              <span className="mndt-pill" data-tone="id">{(state.mandates ?? []).length}</span>
            </div>
            <div className="mndt-post-body">
              {(state.mandates ?? []).map(item => (
                <div key={item.id} className="mndt-post-actions">
                  <span className="mndt-tag">{item.purpose === '' ? item.id : item.purpose}</span>
                  <span className="mndt-post-time">{item.delegant} {t('ui.vers')} {item.delegataire}</span>
                  <span className="mndt-pill" data-tone="state">{item.state}</span>
                  <span className="mndt-post-time">{t('ui.echeance')} {item.expiresOn}</span>
                  {item.state !== 'proposed' ? undefined : (
                    <button type="button" className="mndt-button" disabled={adminBusy === `sign:${item.id}`} onClick={() => { void settleMandate(item.id, 'sign') }}>{t('ui.signer')}</button>
                  )}
                  {item.state === 'retired' ? undefined : (
                    <button type="button" className="mndt-button" disabled={adminBusy === `retire:${item.id}`} onClick={() => { void settleMandate(item.id, 'retire') }}>{t('ui.retirer')}</button>
                  )}
                </div>
              ))}
              <p className="mndt-empty">{t('ui.un-mandat-se-propose-se-signe-par')}</p>
            </div>
            <div className="mndt-post-actions">
              <input
                className="mndt-input"
                aria-label={t('ui.objet-du-mandat')}
                placeholder={t('ui.objet-du-mandat')}
                value={mandatePurpose}
                onChange={(event) => { setMandatePurpose(event.target.value) }}
              />
              <input
                className="mndt-input"
                aria-label={t('ui.delegataire-du-mandat')}
                placeholder={t('ui.prenom-datanalysis-re')}
                value={mandateDelegate}
                onChange={(event) => { setMandateDelegate(event.target.value) }}
              />
              <input
                className="mndt-input"
                aria-label={t('ui.echeance-du-mandat')}
                type="date"
                value={mandateUntil}
                onChange={(event) => { setMandateUntil(event.target.value) }}
              />
              <button type="button" className="mndt-button" disabled={adminBusy === 'mandate'} onClick={() => { void proposeMandate() }}>
                {t('ui.proposer')}
              </button>
            </div>
          </article>
        </div>
      </section>
      <section className="mndt-main mndt-activity" style={{ display: view === 'activity' ? undefined : 'none' }}>
        <header className="mndt-channel-head">
          <div className="mndt-channel-head-main">
            <h1 className="mndt-channel-title">{t('ui.activite')}</h1>
            <p className="mndt-channel-subject">{t('ui.tout-ce-qui-s-est-passe-dans')}</p>
          </div>
          <div className="mndt-channel-head-side">
            <select className="mndt-input" value={activityChannel} onChange={(event) => { setActivityChannel(event.target.value) }} aria-label={t('ui.filtrer-par-canal')}>
              <option value="all">{t('ui.tous-les-canaux')}</option>
              {channels.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
            </select>
            <select
              className="mndt-input"
              value={activityFilter}
              onChange={(event) => { setActivityFilter(event.target.value as 'all' | 'humans' | 'agents' | 'me') }}
              aria-label={t('ui.filtrer-l-activite')}
            >
              <option value="all">{t('ui.tout')}</option>
              <option value="humans">{t('ui.humains')}</option>
              <option value="agents">{t('ui.agents')}</option>
              <option value="me">{t('ui.moi')}</option>
            </select>
            <button type="button" className="mndt-button" onClick={markAllRead}>{t('ui.tout-marquer-comme-lu')}</button>
            <button type="button" className="mndt-button" onClick={exportActivity}>{t('ui.exporter-en-csv')}</button>
            <span className="mndt-pill" data-tone="id">{filteredEvents.length} {word(filteredEvents.length, 'ligne', 'lignes')}</span>
          </div>
        </header>
        <div className="mndt-feed">
          {filteredEvents.length === 0 ? <p className="mndt-empty">{t('ui.aucune-ligne-pour-ce-filtre')}</p> : undefined}
          {filteredEvents.map((event, index) => {
            const previous = filteredEvents[index - 1]
            const newDay = previous === undefined || dayOf(previous.at) !== dayOf(event.at)
            return (
              <div key={`${event.at}-${index}`}>
                {newDay ? <div className="mndt-day">{dayOf(event.at)}</div> : undefined}
                <button type="button" className="mndt-event-post mndt-event-button" onClick={() => { openEvent(event.subject) }}>
                  <span className="mndt-event-time">{clockOf(event.at)}</span>
                  <span className="mndt-event-actor" data-agent={isHuman(event.actor) ? 'false' : 'true'}>{event.actor}</span>
                  <span className="mndt-event-text">{sentenceOf(event.action, t)} : {subjectLabel(event.subject, t)}</span>
                </button>
              </div>
            )
          })}
        </div>
      </section>

      <aside className="mndt-context" aria-label={t('ui.contexte')} style={{ display: view === 'channel' ? undefined : 'none' }}>
        {mandate === undefined ? (
          <>
            <h2 className="mndt-context-title">{t('ui.espace')}</h2>
            <section className="mndt-context-block">
              <div className="mndt-context-label">{t('ui.vue')}</div>
              <p className="mndt-context-value">{posts.length} {word(posts.length, 'post', 'posts')} {t('ui.sur-ce-canal')} {state.missions.length} {word(state.missions.length, 'mission', 'missions')}, {state.briefs.length} {word(state.briefs.length, 'brief', 'briefs')}.</p>
            </section>
            <section className="mndt-context-block">
              <div className="mndt-context-label">{t('ui.humains')}</div>
              {humans.length === 0 ? <p className="mndt-context-value">{t('ui.la-liste-des-membres-se-charge-avec')}</p> : humans.map(human => (
                <div key={human.subject} className="mndt-person">
                  <span className="mndt-avatar">{human.subject.slice(0, 1).toUpperCase()}</span>
                  <span className="mndt-person-name">{human.subject}</span>
                  <span className="mndt-person-role">{human.role}</span>
                </div>
              ))}
            </section>
            <section className="mndt-context-block">
              <div className="mndt-context-label">{t('ui.agents')}</div>
              {agents.length === 0 ? <p className="mndt-context-value">{t('ui.les-agents-apparaissent-ici-des-qu-ils')}</p> : agents.map(agent => (
                <div key={agent} className="mndt-person">
                  <span className="mndt-avatar" data-agent="true">{agent.slice(0, 1).toUpperCase()}</span>
                  <span className="mndt-person-name">{agent}</span>
                  <span className="mndt-person-role">{state.missions.some(mission => mission.createdBy === agent && (mission.status === 'running' || mission.status === 'queued')) ? t('ui.agent-en-mission') : t('ui.agent-disponible')}</span>
                </div>
              ))}
            </section>
          </>
        ) : (
          <>
            <h2 className="mndt-context-title">{t('ui.mandat')}</h2>
            <section className="mndt-context-block">
              <div className="mndt-context-grid">
                <span className="mndt-context-label">{t('ui.mandant')}</span><span className="mndt-context-value">{mandate.delegant}</span>
                <span className="mndt-context-label">{t('ui.delegataire')}</span><span className="mndt-context-value">{mandate.delegataire}</span>
                <span className="mndt-context-label">{t('ui.etat')}</span><span className="mndt-context-value">{mandate.state}{mandate.signedBy === undefined ? '' : ` ${t('ui.par')} ${mandate.signedBy}`}</span>
                <span className="mndt-context-label">{t('ui.echeance-2')}</span><span className="mndt-context-value">{mandate.expiresOn}</span>
                <span className="mndt-context-label">{t('ui.limite')}</span><span className="mndt-context-value">{mandate.dailyCap} {t('ui.missions-par-jour')}</span>
              </div>
            </section>
            <section className="mndt-context-block">
              <div className="mndt-context-label">{t('ui.perimetre-2')}</div>
              <p className="mndt-context-value">{mandate.missionKinds.join(', ') || t('ui.aucune-mission-autorisee')}</p>
            </section>
            <section className="mndt-context-block">
              <div className="mndt-context-label">{t('ui.connecteurs-autorises')}</div>
              <div className="mndt-tags">
                {mandate.connectors.map(connector => <span key={connector} className="mndt-tag">{connector}</span>)}
              </div>
            </section>
            <section className="mndt-context-block">
              <div className="mndt-context-label">{t('ui.missions-liees')}</div>
              <p className="mndt-context-value">{posts.filter(post => post.body.kind === 'mission').length} {word(posts.filter(post => post.body.kind === 'mission').length, 'mission', 'missions')} {t('ui.sur-ce-mandat')}</p>
            </section>
            <section className="mndt-context-block">
              <div className="mndt-context-label">{t('ui.approbations')}</div>
              <p className="mndt-context-value">{state.approvals.filter(approval => approval.missionId !== undefined && state.missions.some(mission => mission.id === approval.missionId && mission.mandateId === mandate.id)).length} {t('ui.en-attente-2')}</p>
            </section>
          </>
        )}
      </aside>
      {search === undefined ? undefined : (
        <div className="mndt-search-overlay" role="dialog" aria-modal="true" aria-label={t('ui.recherche')}>
          <div className="mndt-search-box">
            <input
              className="mndt-input mndt-search-input"
              value={search}
              autoFocus
              placeholder={t('ui.chercher-une-mission-un-brief-une-approbation')}
              onChange={(event) => { setSearch(event.target.value); setSearchIndex(0) }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setSearch(undefined)
                else if (event.key === 'ArrowDown') { event.preventDefault(); setSearchIndex(previous => Math.min(previous + 1, Math.max(searchHits.length - 1, 0))) }
                else if (event.key === 'ArrowUp') { event.preventDefault(); setSearchIndex(previous => Math.max(previous - 1, 0)) }
                else if (event.key === 'Enter') { const hit = searchHits[searchIndex]; if (hit !== undefined) openSearchHit(hit) }
              }}
            />
            <div className="mndt-search-results">
              {searchHits.length === 0 ? <p className="mndt-empty">{search.trim() === '' ? t('ui.tapez-un-mot-pour-chercher') : t('ui.aucun-resultat')}</p> : undefined}
              {searchHits.map((hit, index) => (
                <button
                  key={`${hit.kind}-${hit.id}`}
                  type="button"
                  className="mndt-search-row"
                  data-active={index === searchIndex}
                  onMouseEnter={() => { setSearchIndex(index) }}
                  onClick={() => { openSearchHit(hit) }}
                >
                  <span className="mndt-search-kind">{hit.kind}</span>
                  <span className="mndt-search-label">{hit.label}</span>
                  <span className="mndt-search-detail">{hit.detail}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


/** @param text - inline markdown. @returns nodes with bold and code. */
function inlineNodes(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  parts.forEach((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) nodes.push(<strong key={index}>{part.slice(2, -2)}</strong>)
    else if (part.startsWith('`') && part.endsWith('`')) nodes.push(<code key={index}>{part.slice(1, -1)}</code>)
    else if (part !== '') nodes.push(part)
  })
  return nodes
}

/** @param markdown - a brief body. @returns readable blocks, never raw markers. */
function renderBrief(markdown: string): ReactNode[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let list: string[] = []
  const flush = (): void => {
    if (list.length === 0) return
    blocks.push(<ul key={`ul-${blocks.length}`}>{list.map((item, index) => <li key={index}>{inlineNodes(item)}</li>)}</ul>)
    list = []
  }
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? '').trim()
    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed)
    if (heading !== null) {
      flush()
      const level = heading[1]?.length ?? 1
      const content = inlineNodes(heading[2] ?? '')
      blocks.push(level <= 2 ? <h3 key={`h-${index}`}>{content}</h3> : <h4 key={`h-${index}`}>{content}</h4>)
      continue
    }
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      flush()
      const rows: string[][] = []
      while (index < lines.length) {
        const row = (lines[index] ?? '').trim()
        if (!row.startsWith('|') || !row.endsWith('|')) break
        const cells = row.slice(1, -1).split('|').map(cell => cell.trim())
        if (!cells.every(cell => /^:?-{2,}:?$/.test(cell))) rows.push(cells)
        index += 1
      }
      index -= 1
      const [head, ...body] = rows
      if (head !== undefined) {
        blocks.push(
          <table key={`t-${index}`}>
            <thead><tr>{head.map((cell, cellIndex) => <th key={cellIndex}>{inlineNodes(cell)}</th>)}</tr></thead>
            <tbody>
              {body.map((cells, rowIndex) => (
                <tr key={rowIndex}>
                  {cells.map((cell, cellIndex) => <td key={cellIndex}>{inlineNodes(cell)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>,
        )
      }
      continue
    }
    const item = /^[-*]\s+(.*)$/.exec(trimmed)
    if (item !== null) { list.push(item[1] ?? ''); continue }
    if (trimmed === '' || /^-{3,}$/.test(trimmed)) { flush(); continue }
    flush()
    blocks.push(<p key={`p-${index}`}>{inlineNodes(trimmed)}</p>)
  }
  flush()
  return blocks
}

/** @param postId - a post id. @returns the mission id it points at, when it is a mission. */
function postIdOf(postId: string): string {
  return postId.startsWith('mission:') ? postId.slice('mission:'.length) : ''
}

/** One post in the feed. */
function PostView(props: {
  post: Post
  t: MndtTranslate
  busy: string | undefined
  canDecide: boolean
  isYou: boolean
  open: boolean
  onToggle(): void
  onDecide(id: string, decision: 'approved' | 'rejected', reason?: string): void
  onTrack(id: string, action: 'cancel' | 'retry'): void
}) {
  const { post, t, busy, canDecide, isYou, open } = props
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
        <span className="mndt-event-text">{sentenceOf(body.action, t)} : {subjectLabel(body.subject, t)}</span>
      </div>
    )
  }
  if (body.kind === 'approval') {
    return (
      <article className="mndt-post-card" data-kind="approval">
        <div className="mndt-post-head">
          <span className="mndt-post-kind">{t('ui.approbation-requise')}</span>
          <span className="mndt-pill" data-tone="write">{body.approvalKind}</span>
          <span className="mndt-post-time">{clockOf(body.at)}</span>
        </div>
        <p className="mndt-post-title">{body.title}</p>
        <p className="mndt-post-meta">{t('ui.demandee-par')} {body.author}</p>
        <div className="mndt-post-actions">
          <button
            type="button"
            className="mndt-button"
            data-variant="primary"
            disabled={!canDecide || isYou || busy === body.id}
            onClick={() => { decide(body.id, 'approved') }}
          >{t('ui.approuver')}</button>
          {refusing ? undefined : (
            <button
              type="button"
              className="mndt-button"
              disabled={!canDecide || isYou || busy === body.id}
              onClick={() => { setRefusing(true) }}
            >{t('ui.refuser')}</button>
          )}
          {isYou ? <span className="mndt-post-note">{t('ui.vous-avez-demande-cette-decision-un-autre')}</span> : undefined}
          {!isYou && !canDecide ? <span className="mndt-post-note">{t('ui.seul-un-owner-ou-un-admin-peut')}</span> : undefined}
        </div>
        {refusing ? (
          <div className="mndt-refusal">
            <textarea
              className="mndt-input"
              placeholder={t('ui.motif-du-refus-conserve-dans-le-journal')}
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
              >{t('ui.confirmer-le-refus')}</button>
              <button
                type="button"
                className="mndt-button"
                onClick={() => { setRefusing(false); setReason('') }}
              >{t('ui.annuler')}</button>
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
          <span className="mndt-post-kind">{t('ui.brief')}</span>
          <span className="mndt-role">{t('ui.agent')}</span>
          <span className="mndt-post-time">{clockOf(body.at)}</span>
        </div>
        <p className="mndt-post-title">{body.title}</p>
        <p className="mndt-post-body">{preview}{preview.length >= 220 ? '...' : ''}</p>
      </article>
    )
  }
  return (
    <article className="mndt-post-card" data-kind="mission" data-mission={post.id}>
      <div className="mndt-post-head">
        <span className="mndt-post-kind">{t('ui.mission')} {body.title}</span>
        <span className="mndt-role" data-agent={body.author.includes('@') ? undefined : 'true'}>{body.author}</span>
        <span className="mndt-pill" data-tone="state">{body.status}</span>
        <span className="mndt-post-time">{clockOf(body.at)}</span>
      </div>
      <p className="mndt-post-body">{body.prompt}</p>
      <div className="mndt-post-actions">
        <span className="mndt-tag">{body.visibility === 'team' ? t('ui.equipe-2') : t('ui.privee')}</span>
        {body.mandate === undefined ? undefined : <span className="mndt-tag">{body.mandate.slice(0, 32)}</span>}
        {body.error === undefined ? undefined : <span className="mndt-error mndt-error-banner">{body.error}</span>}
        {body.brief === undefined ? undefined : (
          <button type="button" className="mndt-button" onClick={toggle}>{open ? t('ui.masquer-le-brief') : t('ui.ouvrir-le-brief')}</button>
        )}
        {body.status === 'failed' ? (
          <button type="button" className="mndt-button" onClick={() => { props.onTrack(postIdOf(post.id), 'retry') }}>
            {t('ui.relancer')}
          </button>
        ) : undefined}
        {body.status !== 'queued' && body.status !== 'running' ? undefined : (
          <button
            type="button"
            className="mndt-button"
            disabled={!isYou && !canDecide}
            onClick={() => { props.onTrack(postIdOf(post.id), 'cancel') }}
          >{t('ui.annuler')}</button>
        )}
      </div>
      {open && body.brief !== undefined ? <div className="mndt-brief-body">{renderBrief(body.brief.markdown)}</div> : undefined}
    </article>
  )
}
