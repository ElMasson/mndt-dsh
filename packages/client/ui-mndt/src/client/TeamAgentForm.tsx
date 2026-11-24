/**
 * An agent's sheet, to declare one or change it (lot 1a, Stéphane's rule: fewer clicks, no needless
 * drop-down). Short on purpose: the same sheet will serve as the confirmation card when an agent
 * proposes an agent. A name, what it is for in a sentence (its instructions), a model among buttons,
 * its connectors among pills, a monthly ceiling at 5 € by default, and a handle deduced from the
 * name, written once.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { AgentInput, ChatAgent, ChatSkill, MountedConnector } from './chat.ts'
import type { ChatTranslate } from './chatLocales.ts'
import { SkillPills } from './skills.tsx'

/** A model an agent can use: a provider and a model, as the core names them. */
export interface ModelChoice {
  readonly provider: string
  readonly model: string
}

/**
 * The models the page can offer until the API serves its routes (`GET /models`): the pairs already
 * used by a declared agent, which work by construction, the most used first.
 * @param agents - the declared agents.
 * @returns the distinct provider and model pairs.
 */
export function modelsOf(agents: readonly ChatAgent[]): readonly ModelChoice[] {
  const counted = new Map<string, { choice: ModelChoice; uses: number }>()
  for (const a of agents) {
    if (a.retiredAt !== undefined || a.provider === '' || a.model === '') continue
    const key = `${a.provider}/${a.model}`
    const held = counted.get(key)
    counted.set(key, { choice: { provider: a.provider, model: a.model }, uses: (held?.uses ?? 0) + 1 })
  }
  return [...counted.values()].sort((x, y) => y.uses - x.uses).map(entry => entry.choice)
}

/**
 * @param choice - a model.
 * @param t - the copy.
 * @returns the word a person reads on its button; the technical name goes beneath it.
 */
export function modelLabel(choice: ModelChoice, t: ChatTranslate): string {
  if (choice.provider.startsWith('vllm')) return t('modelLocal')
  if (/flash|mini|fast|small/iu.test(choice.model)) return t('modelFast')
  if (/glm|pro|large|think|reason/iu.test(choice.model)) return t('modelAnalysis')
  return choice.model
}

/**
 * @param name - the agent's name.
 * @returns the handle it gives: lower case, accents dropped, words joined by a dash, 2 to 32
 * characters, as the core accepts (`^[a-z0-9][a-z0-9-]{1,31}$`); empty when the name gives none.
 */
export function handleOf(name: string): string {
  const slug = name.normalize('NFD').replace(/[̀-ͯ]/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 32).replace(/-+$/u, '')
  return slug.length >= 2 ? slug : ''
}

/** The ceiling an admin may set on a new agent: above it, only the owner decides. */
export const ADMIN_CEILING_EUR = 5
/** The ceiling nobody may exceed from this sheet. */
export const MAX_CEILING_EUR = 50
/** The longest purpose (the agent's instructions) the sheet takes. */
export const MAX_PURPOSE = 2000

/** What the sheet needs. */
export interface TeamAgentFormProps {
  /** The agent to change; absent, the sheet declares a new one. */
  readonly agent?: ChatAgent | undefined
  readonly models: readonly ModelChoice[]
  /** The connectors mounted on the workbench. */
  readonly mounted: readonly MountedConnector[]
  /** Only the owner raises a ceiling (the core refuses anyone else). */
  readonly canRaiseCeiling: boolean
  /** The space's skills, to tick (three at most); absent, the field is not shown. */
  readonly skills?: readonly ChatSkill[] | undefined
  /** Resolves to the API's reason when it refuses. */
  readonly onSave: (input: AgentInput) => Promise<string | undefined>
  readonly onCancel: () => void
  readonly t: ChatTranslate
}

/** @param props - the agent, the choices and the actions. @returns the sheet. */
export function TeamAgentForm(props: TeamAgentFormProps): ReactNode {
  const { agent, t } = props
  const editing = agent !== undefined
  const [name, setName] = useState(agent?.name ?? '')
  const [purpose, setPurpose] = useState(agent?.instructions ?? '')
  // The handle follows the name until the person writes their own.
  const [handle, setHandle] = useState(agent?.handle ?? '')
  const [handleTouched, setHandleTouched] = useState(editing)
  const shownHandle = handleTouched ? handle : handleOf(name)
  const models = editing && !props.models.some(m => m.provider === agent.provider && m.model === agent.model)
    ? [{ provider: agent.provider, model: agent.model }, ...props.models]
    : props.models
  const first = models[0]
  const [model, setModel] = useState<ModelChoice | undefined>(editing ? { provider: agent.provider, model: agent.model } : first)
  const usable = props.mounted.filter(m => m.enabled).map(m => m.server)
  const [connectors, setConnectors] = useState<readonly string[]>(agent?.connectors ?? [])
  const [chosenSkills, setChosenSkills] = useState<readonly string[]>(agent?.skills ?? [])
  const [ceiling, setCeiling] = useState(String(agent?.eurPerMonth ?? 5))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const euros = Number(ceiling.replace(',', '.'))
  // The highest ceiling this person may set here: an admin keeps an agent at most where it is (or at
  // 5 EUR for a new one), only the owner goes higher, and nobody beyond 50 EUR a month.
  const allowed = props.canRaiseCeiling ? MAX_CEILING_EUR : Math.min(editing ? agent.eurPerMonth : ADMIN_CEILING_EUR, MAX_CEILING_EUR)
  const raising = Number.isFinite(euros) && euros > allowed
  // A connector the agent still carries but that is no longer mounted: the API would refuse the whole sheet.
  const stale = connectors.filter(server => !usable.includes(server))
  const ready = name.trim() !== '' && shownHandle !== '' && Number.isFinite(euros) && euros > 0 && !raising
    && purpose.length <= MAX_PURPOSE && stale.length === 0

  const save = async (): Promise<void> => {
    // No model known yet (no agent declared on the server): nothing can be declared from here.
    if (!ready || busy || model === undefined) return
    setBusy(true)
    setError(await props.onSave({
      handle: shownHandle,
      name: name.trim(),
      provider: model.provider,
      model: model.model,
      instructions: purpose.trim(),
      connectors,
      eurPerMonth: euros,
      ...(props.skills === undefined ? {} : { skills: chosenSkills }),
    }))
    setBusy(false)
  }

  return (
    <form className="mw-agent-form" data-testid="agent-form" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <h2 className="mw-card-title">{editing ? t('agentEdit', { name: agent.name }) : t('agentNew')}</h2>
      <label className="mw-field">
        {t('agentName')}
        <input className="mw-input" value={name} onChange={(event) => { setName(event.target.value) }} />
      </label>
      <label className="mw-field">
        {t('agentPurpose')}
        <textarea
          className="mw-input"
          rows={2}
          maxLength={MAX_PURPOSE}
          placeholder={t('agentPurposeHint')}
          value={purpose}
          onChange={(event) => { setPurpose(event.target.value) }}
        />
      </label>
      <span className="mw-counter" aria-live="polite">{t('agentPurposeCount', { count: purpose.length, max: MAX_PURPOSE })}</span>
      <div className="mw-field">
        <span>{t('agentModelLabel')}</span>
        {models.length === 0 ? <p className="mw-ctx-muted">{t('agentNoModel')}</p> : (
          <div className="mw-model-buttons" role="group" aria-label={t('agentModelLabel')}>
            {models.map((choice) => {
              const on = model?.provider === choice.provider && model.model === choice.model
              return (
                <button
                  key={`${choice.provider}/${choice.model}`}
                  type="button"
                  className="mw-model"
                  aria-pressed={on}
                  onClick={() => { setModel(choice) }}
                >
                  <span className="mw-model-label">{modelLabel(choice, t)}</span>
                  <span className="mw-model-tech">{choice.provider} · {choice.model}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>
      <div className="mw-field">
        <span>{t('ctxConnectors')}</span>
        {usable.length === 0 && connectors.length === 0 ? <p className="mw-ctx-muted">{t('connNone')}</p> : (
          <div className="mw-pills" role="group" aria-label={t('ctxConnectors')}>
            {[...new Set([...usable, ...connectors])].sort().map((server) => {
              const on = connectors.includes(server)
              const off = !usable.includes(server)
              return (
                <button
                  key={server}
                  type="button"
                  className="mw-pill"
                  aria-pressed={on}
                  aria-disabled={off && !on}
                  aria-label={`${on ? t('pillRemoveConnector', { server }) : t('pillAddConnector', { server })}${off ? `, ${t('connOff')}` : ''}`}
                  onClick={() => {
                    if (off && !on) return
                    setConnectors(held => (on ? held.filter(s => s !== server) : [...held, server]))
                  }}
                >
                  {server}
                  {off ? <span className="mw-pill-note" aria-hidden="true">{t('connOff')}</span> : undefined}
                </button>
              )
            })}
          </div>
        )}
      </div>
      {props.skills === undefined || props.skills.length === 0 ? undefined : (
        <div className="mw-field">
          <span>{t('skillsTitle')}</span>
          <SkillPills skills={props.skills} chosen={chosenSkills} onChange={setChosenSkills} t={t} />
        </div>
      )}
      <div className="mw-field-row">
        <label className="mw-field mw-field-narrow">
          {t('agentCeiling')}
          <input className="mw-input" inputMode="decimal" value={ceiling} onChange={(event) => { setCeiling(event.target.value) }} />
        </label>
        <label className="mw-field">
          {t('agentHandle')}
          <input
            className="mw-input"
            value={shownHandle}
            readOnly={editing}
            onChange={(event) => { setHandleTouched(true); setHandle(event.target.value.toLowerCase()) }}
          />
        </label>
      </div>
      {editing ? <p className="mw-ctx-small mw-ctx-muted">{t('agentHandleFixed')}</p> : undefined}
      <p className="mw-ctx-small mw-ctx-muted">
        {props.canRaiseCeiling ? t('agentCeilingOwner', { max: MAX_CEILING_EUR }) : t('agentCeilingAdmin', { max: allowed })}
      </p>
      {raising ? (
        <p role="alert" className="mw-ctx-error">
          {props.canRaiseCeiling ? t('agentCeilingTooHigh', { max: MAX_CEILING_EUR }) : t('agentOnlyOwnerRaises')}
        </p>
      ) : undefined}
      {stale.length === 0 ? undefined : <p role="alert" className="mw-ctx-error">{t('connRemoveFirst', { names: stale.join(', ') })}</p>}
      {error === undefined ? undefined : <p role="alert" className="mw-ctx-error">{error}</p>}
      <div className="mw-actions">
        <button type="submit" className="mw-primary" disabled={!ready || busy || model === undefined}>{editing ? t('agentSave') : t('agentCreate')}</button>
        <button type="button" className="mw-secondary" onClick={props.onCancel}>{t('cancel')}</button>
      </div>
    </form>
  )
}

/**
 * The agent a card proposes to declare (`propose_agent`), read from what the API served: only a
 * proposal with a name, a handle the core accepts, a provider and a model is shown; anything else is
 * no proposal at all. Text is bounded; connectors are server names.
 * @param raw - the card's `proposal` field.
 * @returns the proposal, or undefined.
 */
export function proposalOf(raw: unknown): AgentInput | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const p = raw as Record<string, unknown>
  // Bounded after trim(), as the core bounds them (#82).
  const text = (key: string, max: number): string | undefined => {
    const value = p[key]
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed !== '' && trimmed.length <= max ? trimmed : undefined
  }
  // A name is one line of 60 characters at most, as the core holds it (#82).
  const rawName = text('name', 60)
  const name = rawName !== undefined && /[\r\n]/u.test(rawName) ? undefined : rawName
  const handle = text('handle', 32)
  const provider = text('provider', 64)
  const model = text('model', 128)
  if (name === undefined || handle === undefined || provider === undefined || model === undefined) return undefined
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/u.test(handle)) return undefined
  // A field that is present is never dropped: one the page cannot read makes the whole proposal
  // unreadable (only « Refuser »), so what is validated is never less than what the core holds.
  let connectors: string[] = []
  if (p.connectors !== undefined) {
    if (!Array.isArray(p.connectors)) return undefined
    for (const c of p.connectors) {
      if (typeof c !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/u.test(c)) return undefined
    }
    connectors = p.connectors as string[]
  }
  let eurPerMonth: number | undefined
  if (p.eurPerMonth !== undefined) {
    const eur = p.eurPerMonth
    if (typeof eur !== 'number' || !Number.isFinite(eur) || eur <= 0 || eur > MAX_CEILING_EUR) return undefined
    eurPerMonth = eur
  }
  let instructions: string | undefined
  if (p.instructions !== undefined) {
    if (typeof p.instructions !== 'string') return undefined
    const trimmed = p.instructions.trim()
    if (trimmed.length > MAX_PURPOSE) return undefined
    instructions = trimmed === '' ? undefined : trimmed
  }
  return {
    name,
    handle,
    provider,
    model,
    connectors,
    ...(instructions === undefined ? {} : { instructions }),
    ...(eurPerMonth === undefined ? {} : { eurPerMonth }),
  }
}

/**
 * The sheet of a proposed agent, read-only: the same fields as the form, so what is validated is
 * what was read. A connector the proposal names but that is not mounted is said.
 */
export function AgentSheetView(props: {
  readonly proposal: AgentInput
  readonly mounted: readonly MountedConnector[]
  readonly t: ChatTranslate
}): ReactNode {
  const { proposal: p, t } = props
  const usable = new Set(props.mounted.filter(m => m.enabled).map(m => m.server))
  const choice = { provider: p.provider, model: p.model }
  return (
    <dl className="mw-sheet-view" data-testid="agent-sheet-view">
      <dt>{t('agentName')}</dt>
      <dd>{p.name} <span className="mw-ctx-muted">· @{p.handle}</span></dd>
      <dt>{t('agentPurpose')}</dt>
      <dd className="mw-sheet-purpose">{p.instructions ?? '—'}</dd>
      <dt>{t('agentModelLabel')}</dt>
      <dd>{modelLabel(choice, t)} <span className="mw-model-tech">{p.provider} · {p.model}</span></dd>
      <dt>{t('ctxConnectors')}</dt>
      <dd>
        {(p.connectors ?? []).length === 0 ? '—' : (
          <span className="mw-pills">
            {(p.connectors ?? []).map(server => (
              <span key={server} className="mw-pill mw-pill-static" data-off={usable.has(server) ? undefined : 'true'}>
                {server}
                {usable.has(server) ? undefined : <span className="mw-pill-note">{t('connOff')}</span>}
              </span>
            ))}
          </span>
        )}
      </dd>
      <dt>{t('agentCeiling')}</dt>
      <dd>{p.eurPerMonth ?? ADMIN_CEILING_EUR}</dd>
    </dl>
  )
}
