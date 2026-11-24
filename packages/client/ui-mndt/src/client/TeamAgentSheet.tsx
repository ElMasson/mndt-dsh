/**
 * An agent's readable sheet (lot 3, brief of 15/11), opened from its tile in the Agents view: what
 * is served about it, said plainly, then its instructions whole. Nothing is read into the
 * instructions: they are free text, shown through the same safe renderer as an agent's messages
 * (no raw HTML, no link), folded beyond ten lines. What an agent does not decide is the product's
 * rule, the same for every agent, written once.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { ChatAgent, ChatChannel, ChatSkill, MountedConnector } from './chat.ts'
import type { ChatTranslate } from './chatLocales.ts'
import { euros, when } from './format.ts'
import { renderBrief } from './markdown.tsx'
import { modelLabel } from './TeamAgentForm.tsx'
import { SkillPills } from './skills.tsx'
import { shownName } from './TeamFeed.tsx'

/** Beyond this many lines the instructions are folded. */
const FOLD_LINES = 10

/** What the sheet reads. */
export interface TeamAgentSheetProps {
  readonly agent: ChatAgent
  /** Every agent, to say when the instructions were written by one (a proposed agent). */
  readonly agents?: readonly ChatAgent[] | undefined
  /** The channels the reader sees: the agent's are those that list it. */
  readonly channels: readonly ChatChannel[]
  /** The connectors mounted; undefined while unknown (no « non branché » is said then). */
  readonly mounted?: readonly MountedConnector[] | undefined
  /** The space's skills, to show the agent's by name and version. */
  readonly skills?: readonly ChatSkill[] | undefined
  /** The team's names by lower-case address, where they are served. */
  readonly names?: Readonly<Record<string, string>> | undefined
  /** Change the agent: owners and admins, and never a retired one. */
  readonly onEdit?: (() => void) | undefined
  readonly onClose: () => void
  readonly t: ChatTranslate
}

/** @param props - the agent and what is around it. @returns its readable sheet. */
export function TeamAgentSheet(props: TeamAgentSheetProps): ReactNode {
  const { agent: a, t } = props
  const [unfolded, setUnfolded] = useState(false)
  const usable = props.mounted === undefined ? undefined : new Set(props.mounted.filter(m => m.enabled).map(m => m.server))
  const where = props.channels.filter(c => c.kind === 'team' && c.agents.includes(a.id))
  const instructions = (a.instructions ?? '').trim()
  const lines = instructions.split('\n')
  const folded = lines.length > FOLD_LINES && !unfolded
  const shown = folded ? lines.slice(0, FOLD_LINES).join('\n') : instructions
  const author = shownName(a.createdBy, props.names)
  // Who wrote the instructions: an agent (a proposed agent), by its handle; otherwise a person.
  const writer = props.agents?.find(other => other.id === a.createdBy || other.handle === a.createdBy)
  const retired = a.retiredAt !== undefined
  return (
    <article className="mw-agent-sheet" data-testid="agent-sheet" aria-label={a.name}>
      <header className="mw-agent-sheet-head">
        <div>
          <h2 className="mw-agent-sheet-title">{a.name} <span className="mw-ctx-muted">@{a.handle}</span></h2>
          {retired ? <p className="mw-agent-retired" data-testid="agent-retired">{t('sheetRetired', { at: when(a.retiredAt ?? '') })}</p> : undefined}
        </div>
        <div className="mw-agent-sheet-actions">
          {props.onEdit === undefined || retired ? undefined : (
            <button type="button" className="mw-primary" onClick={props.onEdit}>{t('sheetEdit')}</button>
          )}
          <button type="button" className="mw-secondary" onClick={props.onClose}>{t('sheetClose')}</button>
        </div>
      </header>
      <dl className="mw-sheet-view">
        <dt>{t('agentModelLabel')}</dt>
        <dd>{modelLabel({ provider: a.provider, model: a.model }, t)} <span className="mw-model-tech">{a.provider} · {a.model}</span></dd>
        <dt>{t('ctxConnectors')}</dt>
        <dd>
          {a.connectors.length === 0 ? t('sheetNoConnector') : (
            <span className="mw-pills">
              {a.connectors.map((server) => {
                const off = usable !== undefined && !usable.has(server)
                return (
                  <span key={server} className="mw-pill mw-pill-static" data-off={off ? 'true' : undefined}>
                    {server}{off ? <span className="mw-pill-note">{t('connOff')}</span> : undefined}
                  </span>
                )
              })}
            </span>
          )}
        </dd>
        {props.skills === undefined ? undefined : (
          <><dt>{t('skillsTitle')}</dt><dd><SkillPills skills={props.skills} chosen={a.skills ?? []} t={t} /></dd></>
        )}
        <dt>{t('agentCeiling')}</dt>
        <dd>{t('agentMonth', { spent: euros(a.eurThisMonth ?? 0), ceiling: euros(a.eurPerMonth) })}</dd>
        <dt>{t('sheetChannels')}</dt>
        <dd data-testid="agent-channels">{where.length === 0 ? t('sheetNoChannel') : where.map(c => `# ${c.title || c.name}`).join(', ')}</dd>
        <dt>{t('sheetDeclared')}</dt>
        <dd>{t('sheetDeclaredBy', { who: author, at: when(a.createdAt) })}</dd>
        <dt>{t('sheetDoesNotDecide')}</dt>
        <dd>{t('sheetRule')}</dd>
      </dl>
      <section className="mw-agent-sheet-instructions" aria-label={t('agentPurpose')}>
        <h3 className="mw-ctx-title">{t('agentPurpose')}</h3>
        {instructions === '' ? <p className="mw-ctx-muted" data-testid="agent-no-instructions">{t('sheetNoInstructions')}</p> : (
          <>
            {/* A marked frame with a fixed header: the instructions cannot pass for a part of the sheet. */}
            <div className="mw-quoted" data-testid="agent-instructions-frame">
              <p className="mw-quoted-head">{writer === undefined ? t('sheetWrittenByPerson') : t('sheetWrittenByAgent', { handle: writer.handle })}</p>
              <div className="mw-agent-text" data-testid="agent-instructions">{renderBrief(shown, { plainHeadings: true })}</div>
            </div>
            {lines.length <= FOLD_LINES ? undefined : (
              <button type="button" className="mw-ctx-link" onClick={() => { setUnfolded(open => !open) }}>
                {folded ? t('sheetUnfold', { n: lines.length }) : t('sheetFold')}
              </button>
            )}
          </>
        )}
      </section>
    </article>
  )
}
