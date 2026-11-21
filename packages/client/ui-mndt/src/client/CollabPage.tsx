/**
 * The collaboration space.
 *
 * Slack gives the shape, not the subject: a left list of channels, a structured
 * feed, a context panel, and a composer that launches work instead of chatting.
 * A channel is a perimeter of responsibility (the team, one mandate, the system),
 * every post is typed, and the approval card is the only place a decision is made.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { AutomationsAnswer, DecideOptions, MemberRow, MndtFace, SearchRow } from './face.ts'
import { ChatRefusal } from './chat.ts'
import type { AgentInput, ChatAgent, ChatChannel, ChatFace, MountedConnector, OfferedModel } from './chat.ts'
import { chatEnglish } from './chatLocales.ts'
import type { ChatTranslate } from './chatLocales.ts'
import { ChannelAgents, ChannelList, ChannelThread, euros, reasonOf } from './ChannelView.tsx'
import { TeamShell } from './TeamShell.tsx'
import { TeamContext } from './TeamContext.tsx'
import { ADMIN_CEILING_EUR, TeamAgentForm, modelsOf } from './TeamAgentForm.tsx'
import { WebCard, shownName } from './TeamFeed.tsx'
import type { IconName } from './Icons.tsx'
import type { MndtKey } from './locales.ts'
import { Icon } from './Icons.tsx'
import { FaceRefusal } from './httpFace.ts'
import type { DocumentsFace } from './documents.ts'
import type { TeamPlace } from './TeamShell.tsx'
import { isHostDown } from './hostDown.ts'
import type { ThreadCard } from './ChannelView.tsx'
import { renderBrief } from './markdown.tsx'
import { translate } from './locales.ts'
import type { MndtTranslate } from './locales.ts'

import {
  MISSION_KINDS, channelsOf, clockOf, dayOf, feedOf, humansOf, sentenceOf, subjectLabel, timeOf, word,
} from './feed.ts'
import type { Channel, CollabState, Post, SearchHit } from './feed.ts'

/** How often the cards are read again while a channel is open, in milliseconds. */
export const CARDS_MS = 10000

/** What the page shows while the workspace could not be read: nothing, and no right to act. */
const UNREAD_STATE: CollabState = {
  you: '', canWrite: false, canAdmin: false, missions: [], briefs: [], approvals: [], memories: [], mandates: [], events: [], members: [],
}

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
  /**
   * Draw the page in the team screen's frame, as mndt-web does (top bar, one navigation): the
   * standalone team page. Without it the page keeps its own channel rail, inside the DSH shell.
   */
  readonly team?: TeamFrame | undefined
  /** A channel's documents (the team frame); absent, the section says « Bientôt ». */
  readonly documents?: DocumentsFace | undefined
}

/**
 * @param message - the core's sentence refusing a decision. @param t - the copy.
 * @returns it in the page's words where the sentence is known (#82), else as served.
 */
export function decisionRefusal(message: string, t: ChatTranslate): string {
  const taken = /the handle @(\S+) is taken/u.exec(message)
  if (taken !== null) return t('agentHandleTaken', { handle: taken[1] ?? '' })
  if (message.includes('only the owner gives an agent a ceiling above')) return t('proposeAgentOwnerOnly', { max: ADMIN_CEILING_EUR })
  const unmounted = /connector not mounted: (.+)$/u.exec(message)
  if (unmounted !== null) return t('connNotMounted', { names: unmounted[1] ?? '' })
  const model = /model not offered: (.+)$/u.exec(message)
  if (model !== null) return t('proposeAgentModelGone', { model: model[1] ?? '' })
  if (message.includes('approve it from a screen that shows the whole proposal')) return t('proposeAgentUnreadable')
  return message
}

/**
 * @param failure - a refusal of the agents route. @param t - the copy.
 * @returns it in the page's words where the core's sentence is known, else as served.
 */
function agentRefusal(failure: unknown, t: ChatTranslate): string {
  if (failure instanceof ChatRefusal) {
    const taken = /^the handle @(\S+) is taken$/u.exec(failure.message)
    if (failure.status === 409 && taken !== null) return t('agentHandleTaken', { handle: taken[1] ?? '' })
    if (failure.message.startsWith('only the owner raises the ceiling')) return t('agentOnlyOwnerRaises')
    if (failure.message.startsWith('a handle is a slug')) return t('agentHandleShape')
  }
  return reasonOf(failure, t)
}

/** @param before - the agent as the sheet opened on it. @param now - as it is now. @returns whether it changed meanwhile. */
function agentChanged(before: ChatAgent, now: ChatAgent): boolean {
  return before.name !== now.name || before.provider !== now.provider || before.model !== now.model
    || (before.instructions ?? '') !== (now.instructions ?? '') || before.eurPerMonth !== now.eurPerMonth
    || [...before.connectors].sort().join(',') !== [...now.connectors].sort().join(',')
}

/** The memory's columns, one per scope the core keeps (there is no company scope to show). */
const MEMORY_COLUMNS: readonly { readonly scope: string; readonly icon: IconName; readonly title: MndtKey; readonly help: MndtKey }[] = [
  { scope: 'user', icon: 'Lock', title: 'shell.memory-user', help: 'shell.memory-user-help' },
  { scope: 'team', icon: 'Users', title: 'shell.memory-team', help: 'shell.memory-team-help' },
  { scope: 'mission', icon: 'Boxes', title: 'shell.memory-mission', help: 'shell.memory-mission-help' },
]

/** The kinds of note the core records, as the screen names them. */
const MEMORY_KINDS: Readonly<Record<string, MndtKey>> = {
  fact: 'shell.memory-kind-fact',
  decision: 'shell.memory-kind-decision',
  preference: 'shell.memory-kind-preference',
}

/** @param kind - a note's kind as served. @returns its label; an unknown kind is a « Note ». */
function kindOf(kind: string): MndtKey {
  return Object.hasOwn(MEMORY_KINDS, kind) ? MEMORY_KINDS[kind] ?? 'shell.memory-kind-other' : 'shell.memory-kind-other'
}

/** What the team frame knows beyond the page state. */
export interface TeamFrame {
  /** The organisation, where its name is served. */
  readonly org?: { readonly name: string; readonly env?: string | undefined } | undefined
  /** The person's name, where it is served. */
  readonly name?: string | undefined
  /** Where the full DSH interface is (« Mode avancé »), for whom the gateway gives the shell (`/me.shell`). */
  readonly advancedHref?: string | undefined
  /** The team's names by lower-case address, where they are served. */
  readonly names?: Readonly<Record<string, string>> | undefined
  /** Whether the person owns the team: missions and automations are theirs alone (#63). */
  readonly owner?: boolean | undefined
}

/** The views of the page: the legacy feed, a team channel, and the places of the team frame. */
type View = 'channel' | 'chat' | 'activity' | 'automations' | 'admin' | 'pending' | 'memory' | 'channels' | 'agents' | 'settings'

export function CollabPage({ api, t = translate, chat, tc = chatEnglish, openTrace, team, documents }: CollabPageProps) {
  const [state, setState] = useState<CollabState | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [channelId, setChannelId] = useState('team')
  const [view, setView] = useState<View>('channel')
  // On a narrow screen the channel's context opens over the page (the team frame only).
  const [contextOpen, setContextOpen] = useState(false)
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
      setError(isHostDown(failure) ? t('ui.l-espace-ne-repond-pas') : failure instanceof Error ? failure.message : String(failure))
      // The page stays usable (rail, lane, activity): it opens on a state that holds nothing read,
      // and the banner says why. A later read replaces it.
      setState(held => held ?? UNREAD_STATE)
    }
  }, [api, t])

  useEffect(() => { void load() }, [load])

  // The thread's cards, decided ones included (who and when), read apart from the page state.
  const [chatCards, setChatCards] = useState<readonly ThreadCard[] | undefined>(undefined)
  const [cardsError, setCardsError] = useState<string | undefined>(undefined)
  const loadCards = useCallback(async () => {
    if (chat === undefined) return
    try {
      setChatCards(await chat.cards())
      setCardsError(undefined)
    } catch (failure) {
      setCardsError(reasonOf(failure, tc))
    }
  }, [chat, tc])

  // The first read of the channels decides the arrival: the person's own lane, where the team's
  // conversations with its agents start, rather than the legacy feed. Later reads change nothing.
  const arrived = useRef(false)
  // The connectors mounted on the workbench, read with the channels for the team frame's pills.
  // `absent`: the route is not served here, and nothing is marked « non branché » for that.
  const [mounted, setMounted] = useState<readonly MountedConnector[] | 'absent' | undefined>(undefined)
  const [mountedError, setMountedError] = useState<string | undefined>(undefined)
  // The models the core offers (#82); undefined while unknown or not served.
  const [offered, setOffered] = useState<readonly OfferedModel[] | undefined>(undefined)
  const loadOffered = useCallback(async () => {
    if (team === undefined || chat?.models === undefined) return
    try {
      setOffered(await chat.models())
    } catch {
      setOffered(undefined)
    }
  }, [team, chat])
  const loadMounted = useCallback(async () => {
    if (team === undefined || chat?.mounted === undefined) return
    try {
      setMounted(await chat.mounted())
      setMountedError(undefined)
    } catch (failure) {
      if (failure instanceof ChatRefusal && failure.status === 404) setMounted('absent')
      else setMountedError(reasonOf(failure, tc))
    }
  }, [team, chat, tc])

  // When the page last changed a channel: a read that left before it brings back an older state.
  const lastWrite = useRef(0)
  const loadChat = useCallback(async () => {
    if (chat === undefined) return
    void loadCards()
    void loadMounted()
    void loadOffered()
    const started = Date.now()
    try {
      const [channels, agents] = await Promise.all([chat.channels(), chat.agents()])
      // A read that left before the page's last change would undo what is shown of it.
      if (started >= lastWrite.current) setChatChannels(channels)
      setChatAgents(agents)
      setChatError(undefined)
      if (!arrived.current) {
        arrived.current = true
        const lane = channels.find(c => c.kind === 'solo')
        if (lane !== undefined) {
          setChatId(held => held ?? lane.id)
          setView(held => (held === 'channel' ? 'chat' : held))
        }
      }
    } catch (failure) {
      setChatError(reasonOf(failure, tc))
    }
  }, [chat, tc, loadCards, loadMounted, loadOffered])

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
    const timer = setInterval(() => { void load(); void loadCards() }, CARDS_MS)
    return () => { clearInterval(timer) }
  }, [view, load, loadCards])

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

  // Owners and admins declare and change agents; the sheet open, if any.
  const canManageAgents = chat?.createAgent !== undefined && (state?.role === 'owner' || state?.role === 'admin')
  const [editing, setEditing] = useState<ChatAgent | 'new' | undefined>(undefined)
  // An agent's sheet opens on the agent as it is now, read again, not as the list last showed it.
  const openAgent = useCallback(async (agent: ChatAgent): Promise<void> => {
    if (chat === undefined) return
    try {
      const fresh = (await chat.agents()).find(a => a.id === agent.id)
      setChatAgents(await chat.agents())
      setEditing(fresh ?? agent)
    } catch {
      setEditing(agent)
    }
  }, [chat])
  const saveAgent = useCallback(async (input: AgentInput): Promise<string | undefined> => {
    if (chat?.createAgent === undefined || chat.updateAgent === undefined || editing === undefined) return undefined
    try {
      if (editing === 'new') await chat.createAgent(input)
      else {
        // Someone may have changed the agent since the sheet opened: said, never overwritten.
        const now = (await chat.agents()).find(a => a.id === editing.id)
        if (now === undefined) return tc('agentGone')
        if (agentChanged(editing, now)) {
          setChatAgents(await chat.agents())
          return tc('agentChangedMeanwhile')
        }
        const { handle: _fixed, ...patch } = input
        await chat.updateAgent(editing.id, patch)
      }
      setEditing(undefined)
      setChatAgents(await chat.agents())
      return undefined
    } catch (failure) {
      return agentRefusal(failure, tc)
    }
  }, [chat, editing, tc])

  /** @param next - the channel as the Host returned it. */
  const replaceChannel = (next: ChatChannel): void => {
    lastWrite.current = Date.now()
    setChatChannels(held => held?.map(c => (c.id === next.id ? next : c)))
  }

  // One click puts an agent in the open channel or takes it out (the team frame's pills).
  const toggleChatAgent = useCallback(async (agentId: string, inChannel: boolean): Promise<string | undefined> => {
    if (chat === undefined || chatId === undefined) return undefined
    try {
      if (inChannel) replaceChannel(await chat.addAgents(chatId, [agentId]))
      else if (chat.removeAgents !== undefined) replaceChannel(await chat.removeAgents(chatId, [agentId]))
      return undefined
    } catch (failure) {
      return reasonOf(failure, tc)
    }
  }, [chat, chatId, tc])

  /**
   * One click adds a connector to the open channel or takes it out. The API sets the whole list and
   * has no concurrency check, so the list is built from the channel read again just before: a page
   * not yet refreshed never gives back a connector someone else took out. A list holding a connector
   * that is no longer mounted is refused whole by the API: the page says which one, in words.
   */
  const toggleChannelConnector = useCallback(async (server: string, inChannel: boolean): Promise<string | undefined> => {
    if (chat?.setConnectors === undefined || chatId === undefined) return undefined
    try {
      const fresh = (await chat.channels()).find(c => c.id === chatId)
      if (fresh === undefined) return tc('channelGone')
      replaceChannel(fresh)
      const next = inChannel
        ? [...new Set([...fresh.connectors, server])]
        : fresh.connectors.filter(s => s !== server)
      const served = mounted === undefined || mounted === 'absent' ? undefined : mounted
      const on = new Set(served === undefined ? next : served.filter(m => m.enabled).map(m => m.server))
      const stale = next.filter(s => !on.has(s))
      if (stale.length > 0) return tc('connRemoveFirst', { names: stale.join(', ') })
      replaceChannel(await chat.setConnectors(chatId, next))
      return undefined
    } catch (failure) {
      return reasonOf(failure, tc)
    }
  }, [chat, chatId, tc, mounted])

  const decideCard = useCallback(async (id: string, decision: 'approved' | 'rejected', reason?: string, options?: DecideOptions): Promise<string | undefined> => {
    const outcome = await api.decide(id, decision, reason, options)
    if (outcome.ok) {
      void load()
      void loadCards()
      // An approved proposal created an agent: the list is read again.
      if (decision === 'approved' && options?.showsProposal === true && chat !== undefined) void chat.agents().then(setChatAgents, () => undefined)
      return undefined
    }
    // A model or a connector gone since the card was drawn: both lists are read again, and the card
    // then offers « Refuser » only — no second try of what the core just refused.
    if (options?.showsProposal === true) {
      void loadOffered()
      void loadMounted()
    }
    return decisionRefusal(outcome.error ?? decision, tc)
  }, [api, load, loadCards, chat, tc, loadOffered, loadMounted])

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
      // In a team, automations are the owner's alone: the API answers 404 to anyone else.
      setAutomationError(failure instanceof FaceRefusal && failure.status === 404
        ? t('shell.owner-only')
        : failure instanceof Error ? failure.message : String(failure))
    }
  }, [api, t])

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
  // A role change waiting for its confirmation (a promotion to admin or owner, any demotion).
  type RoleChange = { readonly subject: string; readonly from?: MemberRole; readonly to: MemberRole }
  const [confirming, setConfirming] = useState<RoleChange | undefined>(undefined)
  const RANK: Readonly<Record<MemberRole, number>> = { viewer: 0, operator: 1, admin: 2, owner: 3 }
  const readerRole = MEMBER_ROLES.find(r => r === state?.role)
  // Only the roles this person may give: never owner but by an owner, never above their own role.
  // A reader whose role is not served gives at most « Opérateur ».
  const grantable = MEMBER_ROLES.filter(role => readerRole === undefined
    ? RANK[role] <= RANK.operator
    : RANK[role] <= RANK[readerRole] && (role !== 'owner' || readerRole === 'owner'))
  /** @param subject - a person of the table. @param role - their role. @returns whether this reader may change their line. */
  const canTouch = (subject: string, role: string): boolean =>
    subject !== state?.you && (role !== 'owner' || readerRole === 'owner')
  /** @param from - the role now, if any. @param to - the role chosen. @returns whether to ask first. */
  const asksFirst = (from: MemberRole | undefined, to: MemberRole): boolean =>
    to === 'admin' || to === 'owner' || (from !== undefined && RANK[to] < RANK[from])
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
  const storageKey = state === undefined || state.you === '' ? undefined : `mndt.seen.${state.you}`

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

  /** @param page - what the page shows. @returns it, in the team frame where the page has one. */
  const frame = (page: ReactNode): ReactNode => {
    if (team === undefined) return page
    const current = chatChannels?.find(c => c.id === chatId)
    const place: TeamPlace | undefined = view === 'chat'
      ? (current === undefined || current.kind === 'solo' ? 'lane' : 'channels')
      : view === 'pending' || view === 'memory' || view === 'channels' || view === 'agents' || view === 'settings'
        ? view
        : 'settings'
    return (
      <TeamShell
        t={t}
        place={place}
        onPlace={(next) => {
          if (next === 'lane') {
            const lane = chatChannels?.find(c => c.kind === 'solo')
            if (lane !== undefined) setChatId(lane.id)
            setView('chat')
            return
          }
          setView(next)
        }}
        pending={pendingCards.length}
        channels={(chatChannels ?? []).filter(c => c.kind !== 'solo').map(c => ({
          id: c.id, label: c.title || c.name, active: view === 'chat' && c.id === chatId,
        }))}
        onChannel={(id) => { setChatId(id); setView('chat') }}
        agents={chatAgents.filter(a => a.retiredAt === undefined).map(a => ({ id: a.id, label: a.name, active: false }))}
        onAgent={() => { setView('agents') }}
        org={team.org}
        you={state?.you ?? ''}
        name={team.name}
        live={error === undefined}
      >
        {page}
      </TeamShell>
    )
  }
  // « À traiter » is what this person has to decide: the pending cards the API marks theirs
  // (`canDecide`, the filter `mine=1` applies too). Cards they may only read stay in the feed.
  // Without the channels, the page state's cards count only for whoever decides.
  const pendingCards: readonly ThreadCard[] = chatCards === undefined
    ? (state?.canAdmin === true ? state.approvals : [])
    : chatCards.filter(card => (card.state === undefined || card.state === 'pending') && (card.canDecide ?? state?.canAdmin === true))

  if (state === undefined) {
    return frame(
      <div className="mndt mndt-loading" role="status" aria-live="polite">
        {error === undefined ? t('ui.chargement-de-l-espace') : (
          <div className="mndt-error mndt-error-banner">
            <p>{error}</p>
            <button type="button" className="mndt-button" onClick={() => { void load() }}>{t('ui.reessayer')}</button>
          </div>
        )}
      </div>,
    )
  }

  const pending = state.approvals.length

  // On a phone the rail is hidden: one switcher reaches the team channels (the lane first) and the
  // legacy ones, whichever view is open.
  const switched = view === 'chat' && chatId !== undefined ? `chat:${chatId}` : `legacy:${channelId}`
  const mobileSwitcher = team !== undefined ? undefined : (
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

  return frame(
    <div className="mndt mndt-collab" data-view={view} data-team={team === undefined ? undefined : 'true'}>
      {team !== undefined ? undefined : (
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
            {state.you === '' ? undefined : (
            // Nobody read yet (the workspace did not answer): no presence, rather than « membre ».
              <div className="mndt-presence" data-testid="presence">
                <span className="mndt-dot" data-state="available" />
                <span>{state.you}</span>
                <span className="mndt-role">{state.role ?? t('ui.membre')}</span>
              </div>
            )}
            <div className="mndt-presence">
              <span className="mndt-dot" data-state="working" />
              <span>{pending} {t('ui.decision')}{pending > 1 ? t('ui.s') : ''} {t('ui.en-attente')}</span>
            </div>
          </div>
        </aside>
      )}

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
              <Segmented
                label={t('ui.type-de-mission')}
                value={kind}
                options={MISSION_KINDS.map(option => ({ value: option.value, label: t(option.label) }))}
                onChange={setKind}
              />
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
        if (team !== undefined) {
          // As mndt-web draws a channel: a large title and its kind, the feed with its composer, and
          // the context card beside it (a full-screen sheet below 1024 px, behind « Contexte »).
          return (
            <div className="mw-channel" style={{ display: view === 'chat' ? undefined : 'none' }}>
              <section className="mw-channel-main" aria-label={current.kind === 'solo' ? tc('lane') : `# ${current.title || current.name}`}>
                <header className="mw-channel-head">
                  <div>
                    <h1 className="mw-title">{current.kind === 'solo' ? tc('lane') : `# ${current.title || current.name}`}</h1>
                    {current.kind === 'solo' ? undefined : <p className="mw-subtitle">{tc('ctxKindTeam')}</p>}
                  </div>
                  <button type="button" className="mw-secondary mw-context-open" onClick={() => { setContextOpen(true) }}>
                    <Icon name="Info" /> {tc('context')}
                  </button>
                </header>
                <ChannelThread
                  chat={chat}
                  channel={current}
                  agents={chatAgents}
                  cards={chatCards ?? state.approvals}
                  cardsError={cardsError}
                  canDecide={state.canAdmin === true}
                  onDecide={decideCard}
                  openTrace={openTrace}
                  you={state.you}
                  onSettled={settled}
                  t={tc}
                  names={team.names}
                  onPending={() => { setView('pending') }}
                  mounted={mounted === undefined || mounted === 'absent' ? undefined : mounted}
                  isOwner={state.role === 'owner'}
                  offered={offered}
                  look="mndt-web"
                />
              </section>
              <aside className="mw-aside" data-open={contextOpen ? 'true' : undefined} aria-label={tc('channelContext')}>
                {!contextOpen ? undefined : (
                  <div className="mw-aside-close">
                    <button type="button" className="mw-secondary" aria-label={tc('closeContext')} onClick={() => { setContextOpen(false) }}>
                      <Icon name="X" />
                    </button>
                  </div>
                )}
                <TeamContext
                  // One card per channel: a refusal met on a channel is not shown on the next one.
                  key={current.id}
                  channel={current}
                  agents={chatAgents}
                  t={tc}
                  onToggleAgent={toggleChatAgent}
                  canRemoveAgents={chat.removeAgents !== undefined}
                  onToggleConnector={toggleChannelConnector}
                  mounted={mounted}
                  mountedError={mountedError}
                  canManage={state.canWrite}
                  names={team.names}
                  documents={documents}
                  onMemory={() => { setContextOpen(false); setView('memory') }}
                />
              </aside>
            </div>
          )
        }
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
                cards={chatCards ?? state.approvals}
                cardsError={cardsError}
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
                  {canTouch(member.subject, member.role) ? (
                    <>
                      <Segmented
                        label={t('ui.role-de-personne', { name: member.subject })}
                        value={member.role}
                        disabled={adminBusy === `grant:${member.subject}` || confirming !== undefined}
                        options={grantable.map(role => ({ value: role, label: roleWord(role, t) }))}
                        onChange={(role) => {
                          // A button gives one of the table's roles: found back, never cast.
                          const chosen = grantable.find(r => r === role)
                          if (chosen === undefined) return
                          const from = MEMBER_ROLES.find(r => r === member.role)
                          const change = { subject: member.subject, ...(from === undefined ? {} : { from }), to: chosen }
                          if (asksFirst(from, chosen)) setConfirming(change)
                          else void changeMemberRole(member.subject, chosen)
                        }}
                      />
                      <button
                        type="button"
                        className="mndt-button"
                        disabled={adminBusy === `revoke:${member.subject}`}
                        onClick={() => { void revokeMemberNow(member.subject) }}
                      >
                        {t('ui.retirer')}
                      </button>
                    </>
                  ) : (
                    <span className="mndt-role" data-testid="member-role-fixed">{roleWord(member.role, t)}</span>
                  )}
                </div>
              ))}
              {adminMembers !== undefined && adminMembers.length === 0 ? <p className="mndt-empty">{t('ui.aucune-personne')}</p> : undefined}
              {confirming === undefined ? undefined : (
                <div className="mndt-confirm" role="alertdialog" aria-label={t('ui.confirmer-le-role')} data-testid="role-confirm">
                  <p>
                    {confirming.from === undefined || RANK[confirming.to] > RANK[confirming.from]
                      ? t('ui.confirmer-promotion', { name: confirming.subject === '' ? grantEmail.trim() : confirming.subject, role: roleWord(confirming.to, t) })
                      : t('ui.confirmer-retrogradation', { name: confirming.subject === '' ? grantEmail.trim() : confirming.subject, from: roleWord(confirming.from, t), to: roleWord(confirming.to, t) })}
                  </p>
                  <button
                    type="button"
                    className="mndt-button"
                    onClick={() => {
                      const { subject, to } = confirming
                      setConfirming(undefined)
                      if (subject === '') void grantTypedMember()
                      else void changeMemberRole(subject, to)
                    }}
                  >
                    {t('ui.confirmer')}
                  </button>
                  <button type="button" className="mndt-button" onClick={() => { setConfirming(undefined) }}>{t('ui.annuler')}</button>
                </div>
              )}
            </div>
            <div className="mndt-post-actions">
              <input
                className="mndt-input"
                aria-label={t('ui.adresse-de-la-personne-a-accorder')}
                placeholder={t('ui.prenom-datanalysis-re')}
                value={grantEmail}
                onChange={(event) => { setGrantEmail(event.target.value) }}
              />
              <Segmented
                label={t('ui.role-a-accorder')}
                value={grantRole}
                options={grantable.map(role => ({ value: role, label: roleWord(role, t) }))}
                onChange={setGrantRole}
              />
              <button
                type="button"
                className="mndt-button"
                disabled={grantEmail.trim() === '' || adminBusy === 'grant' || confirming !== undefined || !grantable.includes(grantRole)}
                onClick={() => {
                  // Admin or owner to a new person: asked first, naming them. An empty subject marks the typed one.
                  if (asksFirst(undefined, grantRole)) setConfirming({ subject: '', to: grantRole })
                  else void grantTypedMember()
                }}
              >
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
            <Segmented
              label={t('ui.filtrer-par-canal')}
              value={activityChannel}
              options={[{ value: 'all', label: t('ui.tous-les-canaux') }, ...channels.map(candidate => ({ value: candidate.id, label: candidate.name }))]}
              onChange={setActivityChannel}
            />
            <Segmented
              label={t('ui.filtrer-l-activite')}
              value={activityFilter}
              options={[
                { value: 'all', label: t('ui.tout') },
                { value: 'humans', label: t('ui.humains') },
                { value: 'agents', label: t('ui.agents') },
                { value: 'me', label: t('ui.moi') },
              ] as const}
              onChange={setActivityFilter}
            />
            <button type="button" className="mndt-button" onClick={markAllRead}>{t('ui.tout-marquer-comme-lu')}</button>
            <button type="button" className="mndt-button" onClick={exportActivity}>{t('ui.exporter-en-csv')}</button>
            <span className="mndt-pill" data-tone="id">{filteredEvents.length} {word(filteredEvents.length, 'ligne', 'lignes')}</span>
          </div>
        </header>

        {error === undefined ? undefined : (
          // Nothing read is not « nothing happened »: the activity says so too.
          <div className="mndt-error mndt-error-banner" data-testid="activity-unread">
            <span>{error}</span>
            <button type="button" className="mndt-button" onClick={() => { void load() }}>{t('ui.reessayer')}</button>
          </div>
        )}
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
                  <span className="mndt-event-actor" data-agent={isHuman(event.actor) ? 'false' : 'true'}>{subjectLabel(event.actor, t)}</span>
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
      {team === undefined ? undefined : (
        <>
          {view !== 'chat' || chatChannels?.some(c => c.id === chatId) === true ? undefined : (
            <section className="mw-screen" data-testid="team-lane-missing">
              <h1 className="mw-title">{t('shell.lane')}</h1>
              <p className="mw-empty">{chatError === undefined ? t('ui.chargement-de-l-espace') : t('shell.lane-missing')}</p>
            </section>
          )}
          {view !== 'pending' ? undefined : (
            <section className="mw-screen" data-testid="team-pending">
              <h1 className="mw-title">{t('shell.pending')}</h1>
              {cardsError === undefined ? undefined : <p role="alert" className="mw-alert">{t('shell.pending-unread', { reason: cardsError })}</p>}
              {pendingCards.length === 0 ? (
                <div className="mw-empty-state"><p>{t('shell.pending-none')}</p></div>
              ) : (
                <>
                  <p className="mw-counts">{t('shell.pending-count', { count: pendingCards.length })}</p>
                  <div className="mw-queue">
                    {pendingCards.map((card) => {
                      const where = chatChannels?.find(c => c.id === card.channelId)
                      return (
                        <div key={card.id} className="mw-queue-item">
                          {where !== undefined ? (
                            <button type="button" className="mw-queue-where" onClick={() => { setChatId(where.id); setView('chat') }}>
                              {where.kind === 'solo' ? tc('lane') : `# ${where.title || where.name}`}
                            </button>
                          ) : card.missionId === undefined ? undefined : (
                            // A mission's card belongs to no channel: said, not a link (missions have no screen yet).
                            <span className="mw-queue-from" data-testid="queue-from-mission">{tc('webFromMission')}</span>
                          )}
                          <WebCard
                            card={card}
                            canDecide={card.canDecide ?? state.canAdmin === true}
                            onDecide={decideCard}
                            names={team.names}
                            mounted={mounted === undefined || mounted === 'absent' ? undefined : mounted}
                            isOwner={state.role === 'owner'}
                            offered={offered}
                            t={tc}
                          />
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
            </section>
          )}
          {view !== 'memory' ? undefined : (
            <section className="mw-screen" data-testid="team-memory">
              <h1 className="mw-title">{t('shell.memory')}</h1>
              <p className="mw-intro">{t('shell.memory-intro')}</p>
              <div className="mw-memory-columns">
                {MEMORY_COLUMNS.map((column) => {
                  const notes = state.memories.filter(memory => memory.scope === column.scope)
                  return (
                    <section key={column.scope} className="mw-memory-column" aria-label={t(column.title)}>
                      <h2 className="mw-memory-title"><Icon name={column.icon} />{t(column.title)}</h2>
                      <p className="mw-memory-help">{t(column.help)}</p>
                      {notes.length === 0 ? <p className="mw-memory-none">{t('shell.memory-none')}</p> : notes.map(memory => (
                        <article key={memory.id} className="mw-memory-card" data-testid="team-memory-card">
                          <p className="mw-memory-text">{memory.text}</p>
                          <p className="mw-memory-meta">
                            <span className="mw-chip">{t(kindOf(memory.kind))}</span>
                            {t('shell.memory-kept-by', { name: shownName(memory.createdBy, team.names) })}
                          </p>
                        </article>
                      ))}
                    </section>
                  )
                })}
              </div>
            </section>
          )}
          {view !== 'channels' ? undefined : (
            <section className="mw-screen" data-testid="team-channels">
              <h1 className="mw-title">{t('shell.channels')}</h1>
              {chatChannels === undefined
                ? <p className="mw-empty">{chatError === undefined ? t('ui.chargement-de-l-espace') : `${tc('notServed')} (${chatError})`}</p>
                : (
                  <div className="mw-card">
                    <ChannelList
                      channels={chatChannels.filter(c => c.kind !== 'solo')}
                      selected={undefined}
                      onSelect={(id) => { setChatId(id); setView('chat') }}
                      onCreate={createChat}
                      t={tc}
                    />
                  </div>
                )}
            </section>
          )}
          {view !== 'agents' ? undefined : (
            <section className="mw-screen" data-testid="team-agents">
              <div className="mw-screen-head">
                <h1 className="mw-title">{t('shell.agents')}</h1>
                {/* Owners and admins declare and change agents (Stéphane, 15/11). */}
                {!canManageAgents || editing !== undefined ? undefined : (
                  <button type="button" className="mw-primary" onClick={() => { setEditing('new') }}>{tc('agentNew')}</button>
                )}
              </div>
              {editing === undefined || chat === undefined ? undefined : (
                <TeamAgentForm
                  key={editing === 'new' ? 'new' : editing.id}
                  agent={editing === 'new' ? undefined : editing}
                  models={modelsOf(chatAgents)}
                  mounted={mounted === undefined || mounted === 'absent' ? [] : mounted}
                  canRaiseCeiling={state.role === 'owner'}
                  onSave={saveAgent}
                  onCancel={() => { setEditing(undefined) }}
                  t={tc}
                />
              )}
              {chatAgents.filter(a => a.retiredAt === undefined).length === 0 ? (
                <div className="mw-empty-state"><p>{t('shell.agents-none')}</p></div>
              ) : (
                <ul className="mw-tiles">
                  {chatAgents.filter(a => a.retiredAt === undefined).map((agent) => {
                    const body = (
                      <>
                        <span className="mw-tile-title"><Icon name="Bot" className="mw-slate" />{agent.name}</span>
                        <span className="mw-tile-text">@{agent.handle} · {agent.model}</span>
                        <span className="mw-tile-text">{tc('agentMonth', { spent: euros(agent.eurThisMonth ?? 0), ceiling: euros(agent.eurPerMonth) })}</span>
                      </>
                    )
                    return (
                      <li key={agent.id} data-testid="team-agent">
                        {canManageAgents ? (
                          <button
                            type="button"
                            className="mw-tile mw-tile-link"
                            aria-label={tc('agentEdit', { name: agent.name })}
                            onClick={() => { void openAgent(agent) }}
                          >
                            {body}
                          </button>
                        ) : <div className="mw-tile">{body}</div>}
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          )}
          {view !== 'settings' ? undefined : (
            <section className="mw-screen" data-testid="team-settings">
              <h1 className="mw-title">{t('shell.settings')}</h1>
              <ul className="mw-tiles">
                <li>
                  <button type="button" className="mw-tile mw-tile-link" onClick={() => { setView('activity') }}>
                    <span className="mw-tile-title"><Icon name="Activity" className="mw-slate" />{t('ui.activite')}</span>
                    <span className="mw-tile-text">{t('shell.settings-activity')}</span>
                  </button>
                </li>
                {state.canAdmin !== true ? undefined : (
                  <li>
                    <button type="button" className="mw-tile mw-tile-link" onClick={() => { setView('admin') }}>
                      <span className="mw-tile-title"><Icon name="UserCog" className="mw-slate" />{t('ui.administration')}</span>
                      <span className="mw-tile-text">{t('shell.settings-admin')}</span>
                    </button>
                  </li>
                )}
                {/* Missions and automations are the owner's in a team (#63): nobody else is offered them. */}
                {team.owner !== true ? undefined : (
                  <>
                    <li>
                      <button type="button" className="mw-tile mw-tile-link" onClick={() => { setView('automations') }}>
                        <span className="mw-tile-title"><Icon name="Clock" className="mw-slate" />{t('ui.automatisations')}</span>
                        <span className="mw-tile-text">{t('shell.settings-automations')}</span>
                      </button>
                    </li>
                    <li>
                      <button type="button" className="mw-tile mw-tile-link" onClick={() => { setChannelId('team'); setView('channel') }}>
                        <span className="mw-tile-title"><Icon name="Boxes" className="mw-slate" />{t('shell.legacy-feed')}</span>
                        <span className="mw-tile-text">{t('shell.settings-legacy')}</span>
                      </button>
                    </li>
                  </>
                )}
                {team.advancedHref === undefined ? undefined : (
                  <li>
                    <a className="mw-tile mw-tile-link" data-testid="advanced-mode" href={team.advancedHref}>
                      <span className="mw-tile-title"><Icon name="Settings2" className="mw-slate" />{t('shell.advanced')}</span>
                      <span className="mw-tile-text">{t('shell.advanced-hint')}</span>
                    </a>
                  </li>
                )}
              </ul>
            </section>
          )}
        </>
      )}
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
    </div>,
  )
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
        <span className="mndt-event-actor">{subjectLabel(body.actor, t)}</span>
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

/** @param role - a role of the grant table. @param t - the copy. @returns its name for a person. */
function roleWord(role: string, t: MndtTranslate): string {
  return role === 'owner' ? t('shell.role-owner')
    : role === 'admin' ? t('shell.role-admin')
      : role === 'operator' ? t('shell.role-operator')
        : role === 'viewer' ? t('shell.role-viewer') : role
}

/**
 * A choice among a few values, as buttons side by side rather than a drop-down (Stéphane's rule):
 * every option is visible, one click chooses.
 */
function Segmented<V extends string>(props: {
  readonly label: string
  readonly value: V
  readonly options: readonly { readonly value: V; readonly label: string }[]
  readonly onChange: (value: V) => void
  readonly disabled?: boolean
}): ReactNode {
  return (
    <div className="mndt-segmented" role="group" aria-label={props.label}>
      {props.options.map(option => (
        <button
          key={option.value}
          type="button"
          className="mndt-segment"
          aria-pressed={option.value === props.value}
          disabled={props.disabled === true}
          onClick={() => { if (option.value !== props.value) props.onChange(option.value) }}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
