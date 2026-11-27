/**
 * « Mon ordinateur » (#163): the person's own computer, which their agents use for the terminal,
 * the desktop and the browser. Its state, Démarrer or Arrêter in one click, when it stops by itself;
 * the refusal when every computer is taken, in one sentence; for the owner, who has one on, never
 * what another's shows. Everything is read defensively: a state the page does not know reads as
 * stopped, a field of another shape is not shown, and a refusal reads a fixed sentence.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ChatRefusal } from './chat.ts'
import type { ChatFace } from './chat.ts'
import type { ChatTranslate } from './chatLocales.ts'
import { when } from './format.ts'
import { shownName } from './TeamFeed.tsx'

/** A computer's state as the page reads it. */
export interface MachineRow {
  readonly state: 'stopped' | 'starting' | 'running' | 'stopping'
  readonly startedAt?: string
  readonly stopsAt?: string
  readonly capacity?: { readonly used: number; readonly max: number }
}

const STATES = ['stopped', 'starting', 'running', 'stopping'] as const

/** @param value - an instant as served. @returns it when readable. */
function instantOf(value: unknown): string | undefined {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined
}

/** @param value - a capacity as served. @returns it when both counts are whole and sensible. */
function capacityOf(value: unknown): MachineRow['capacity'] {
  if (typeof value !== 'object' || value === null) return undefined
  const { used, max } = value as { used?: unknown; max?: unknown }
  return Number.isInteger(used) && Number.isInteger(max) && (used as number) >= 0 && (max as number) > 0
    ? { used: used as number, max: max as number } : undefined
}

/** @param raw - a computer as served. @returns it read; an unknown state reads as stopped. */
export function machineOf(raw: unknown): MachineRow {
  const r = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const state = STATES.find(s => s === r.state) ?? 'stopped'
  const startedAt = instantOf(r.startedAt)
  const stopsAt = instantOf(r.stopsAt)
  const capacity = capacityOf(r.capacity)
  return {
    state,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(stopsAt === undefined || state === 'stopped' ? {} : { stopsAt }),
    ...(capacity === undefined ? {} : { capacity }),
  }
}

/** One line of the owner's list. */
interface MemberMachine { readonly member: string; readonly state: MachineRow['state']; readonly startedAt?: string }

/** @param raw - `GET /machines/members` as served. @returns its lines and its capacity. */
function membersOf(raw: unknown): { readonly rows: readonly MemberMachine[]; readonly capacity?: MachineRow['capacity'] } {
  const r = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const rows = (Array.isArray(r.machines) ? r.machines : []).flatMap((row: unknown) => {
    if (typeof row !== 'object' || row === null) return []
    const m = row as Record<string, unknown>
    if (typeof m.member !== 'string' || m.member === '') return []
    const read = machineOf(m)
    return [{ member: m.member, state: read.state, ...(read.startedAt === undefined ? {} : { startedAt: read.startedAt }) }]
  })
  const capacity = capacityOf(r.capacity)
  return { rows, ...(capacity === undefined ? {} : { capacity }) }
}

/** What the page says of a refusal: fixed sentences by code, never the served text. */
function machineRefusal(failure: unknown, t: ChatTranslate, max: number | undefined): string {
  if (failure instanceof ChatRefusal && failure.code === 'machines-busy') return t('machineBusy', { max: max ?? 4 })
  return t('machineUnavailable')
}

type MachineFace = Pick<ChatFace, 'machine' | 'startMachine' | 'stopMachine' | 'machineMembers'>

/**
 * @param face - the chat face. @returns whether the instance serves computers: a 503 `no-machines`
 * (or no route) is « no », and the place is not offered.
 */
export async function machinesServed(face: MachineFace): Promise<boolean> {
  if (face.machine === undefined) return false
  try {
    await face.machine()
    return true
  } catch (failure) {
    return !(failure instanceof ChatRefusal && (failure.code === 'no-machines' || failure.status === 404 || failure.status === 503))
  }
}

/** The « Mon ordinateur » screen. */
export function MachineScreen(props: {
  readonly face: MachineFace
  /** The owner and admins see who has a computer on (rights.write). */
  readonly canSeeMembers: boolean
  readonly names?: Readonly<Record<string, string>> | undefined
  readonly title: string
  readonly t: ChatTranslate
}): ReactNode {
  const { face, t } = props
  const [machine, setMachine] = useState<MachineRow | undefined>(undefined)
  const [members, setMembers] = useState<ReturnType<typeof membersOf> | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const load = useCallback(async (): Promise<void> => {
    if (face.machine === undefined) return
    try {
      setMachine(machineOf(await face.machine()))
    } catch (failure) {
      setError(machineRefusal(failure, t, undefined))
    }
    if (props.canSeeMembers && face.machineMembers !== undefined) {
      try {
        setMembers(membersOf(await face.machineMembers()))
      } catch {
        setMembers(undefined)
      }
    }
  }, [face, props.canSeeMembers, t])
  useEffect(() => { void load() }, [load])
  // While it starts or stops, its state is read again every few seconds.
  useEffect(() => {
    if (machine?.state !== 'starting' && machine?.state !== 'stopping') return undefined
    const timer = setInterval(() => { void load() }, 3000)
    return () => { clearInterval(timer) }
  }, [machine?.state, load])
  const act = async (gesture: (() => Promise<unknown>) | undefined): Promise<void> => {
    if (gesture === undefined || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(undefined)
    try {
      const answered = await gesture()
      if (answered !== undefined) setMachine(machineOf(answered))
      await load()
    } catch (failure) {
      setError(machineRefusal(failure, t, machine?.capacity?.max))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  const on = machine?.state === 'running' || machine?.state === 'starting'
  return (
    <section className="mw-screen" data-testid="team-machine">
      <h1 className="mw-title">{props.title}</h1>
      <p className="mw-intro">{t('machineIntro')}</p>
      {machine === undefined && error === undefined ? <p className="mw-empty">{t('machineLoading')}</p> : undefined}
      {machine === undefined ? undefined : (
        <div className="mw-card" data-testid="machine-card" data-state={machine.state}>
          <p className="mw-ctx-small">
            <span className="mw-ctx-strong" data-testid="machine-state">{t(`machineState_${machine.state}`)}</span>
            {machine.state === 'running' && machine.startedAt !== undefined ? ` · ${t('machineSince', { at: when(machine.startedAt) })}` : ''}
          </p>
          {machine.stopsAt === undefined || machine.state !== 'running' ? undefined : (
            <p className="mw-ctx-small mw-ctx-muted" data-testid="machine-stops">{t('machineStopsAt', { at: when(machine.stopsAt) })}</p>
          )}
          {machine.capacity === undefined ? undefined : (
            <p className="mw-ctx-small mw-ctx-muted" data-testid="machine-capacity">
              {t('machineCapacity', { used: machine.capacity.used, max: machine.capacity.max })}
            </p>
          )}
          <div className="mw-ctx-actions">
            {on ? (
              <button type="button" className="mw-secondary" disabled={busy || machine.state === 'starting'} onClick={() => { void act(face.stopMachine) }}>
                {t('machineStop')}
              </button>
            ) : (
              <button type="button" className="mw-primary" disabled={busy || machine.state === 'stopping'} onClick={() => { void act(face.startMachine) }}>
                {t('machineStart')}
              </button>
            )}
          </div>
        </div>
      )}
      {error === undefined ? undefined : <p role="alert" className="mw-decide-error" data-testid="machine-error">{error}</p>}
      {members === undefined ? undefined : (
        <section className="mw-ctx-section" aria-label={t('machineMembersTitle')} data-testid="machine-members">
          <h2 className="mw-ctx-title">{t('machineMembersTitle')}</h2>
          {members.capacity === undefined ? undefined : (
            <p className="mw-ctx-small mw-ctx-muted">{t('machineCapacity', { used: members.capacity.used, max: members.capacity.max })}</p>
          )}
          {members.rows.filter(r => r.state !== 'stopped').length === 0 ? <p className="mw-ctx-small mw-ctx-muted">{t('machineNoneOn')}</p> : (
            members.rows.filter(r => r.state !== 'stopped').map(r => (
              <p key={r.member} className="mw-ctx-small" data-testid="machine-member">
                <span className="mw-ctx-strong">{shownName(r.member, props.names)}</span>
                {` · ${t(`machineState_${r.state}`)}`}
                {r.startedAt === undefined ? '' : ` · ${t('machineSince', { at: when(r.startedAt) })}`}
              </p>
            ))
          )}
        </section>
      )}
    </section>
  )
}
