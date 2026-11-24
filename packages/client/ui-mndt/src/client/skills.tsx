/**
 * The space's reusable skills (lot 3): a SKILL.md pasted once, read by the agents that take it,
 * three at most per agent. Every member reads them; owners and admins add, change and remove them.
 * The fields of a SKILL.md that have no effect here are said plainly. A skill's body is an agent's
 * reading: shown through the safe renderer, headings as plain bold, folded.
 */
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ChatSkill, SkillWritten } from './chat.ts'
import type { ChatTranslate } from './chatLocales.ts'
import { renderBrief } from './markdown.tsx'

/** The most skills an agent reads. */
export const MAX_SKILLS = 3

/** @param skill - a skill. @returns its SKILL.md, as the person may change it. */
export function markdownOf(skill: ChatSkill): string {
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body}\n`
}

/**
 * The Compétences section of the Agents view: the skills, readable; « Ajouter » with a field to paste
 * a SKILL.md; « Modifier » and « Supprimer » (asked once) for owners and admins. A change made by
 * someone else meanwhile is said, never overwritten.
 */
export function SkillsSection(props: {
  readonly skills: readonly ChatSkill[] | undefined
  readonly canManage: boolean
  readonly onCreate?: ((markdown: string) => Promise<SkillWritten | string>) | undefined
  readonly onUpdate?: ((slug: string, markdown: string, version: number) => Promise<SkillWritten | string>) | undefined
  readonly onDelete?: ((slug: string) => Promise<string | undefined>) | undefined
  readonly t: ChatTranslate
}): ReactNode {
  const { t } = props
  // The skill being written: « new », or a slug being changed.
  const [editing, setEditing] = useState<string | undefined>(undefined)
  // The version read when the edit opened: always the one sent, never a list read again since.
  const [editVersion, setEditVersion] = useState<number | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const [deleting, setDeleting] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [ignored, setIgnored] = useState<readonly string[]>([])
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const run = async (work: () => Promise<SkillWritten | string | undefined>): Promise<void> => {
    if (busy.current) return
    busy.current = true
    setPending(true)
    const result = await work()
    if (typeof result === 'string') setError(result)
    else {
      setError(undefined)
      setEditing(undefined)
      setDeleting(undefined)
      setIgnored(result?.ignoredFields ?? [])
    }
    busy.current = false
    setPending(false)
  }
  /**
   * @param onSave - the write. @param stale - the skill as it is now when it changed since the edit
   * opened: « Enregistrer » stays off until the edit is opened again on it.
   */
  const editor = (onSave: () => void, stale?: ChatSkill): ReactNode => (
    <div className="mw-context-edit" data-testid="skill-editor">
      <textarea
        className="mw-input"
        rows={8}
        aria-label={t('skillPaste')}
        placeholder={t('skillPasteHint')}
        value={draft}
        onChange={(event) => { setDraft(event.target.value) }}
      />
      {stale === undefined ? undefined : (
        <div className="mw-turn-unchecked" role="note" data-testid="skill-stale">
          <p>{stale.updatedBy === undefined ? t('skillChanged') : t('skillChangedBy', { who: stale.updatedBy })}</p>
          <div className="mw-quoted"><div className="mw-agent-text">{renderBrief(stale.body, { plainHeadings: true })}</div></div>
          <button type="button" className="mw-secondary" onClick={() => { setDraft(markdownOf(stale)); setEditVersion(stale.version); setError(undefined) }}>
            {t('skillReopen')}
          </button>
        </div>
      )}
      <div className="mw-decide-buttons">
        <button type="button" className="mw-primary" disabled={pending || draft.trim() === '' || stale !== undefined} onClick={onSave}>{t('agentSave')}</button>
        <button type="button" className="mw-secondary" disabled={pending} onClick={() => { setEditing(undefined); setError(undefined) }}>{t('cancel')}</button>
      </div>
    </div>
  )
  return (
    <section className="mw-screen-part" aria-label={t('skillsTitle')} data-testid="skills">
      <div className="mw-screen-head">
        <h2 className="mw-card-title">{t('skillsTitle')}</h2>
        {!props.canManage || props.onCreate === undefined || editing !== undefined ? undefined : (
          <button type="button" className="mw-secondary" onClick={() => { setDraft(''); setEditing('new'); setError(undefined); setIgnored([]) }}>{t('skillAdd')}</button>
        )}
      </div>
      <p className="mw-ctx-small mw-ctx-muted">{t('skillsWhat')}</p>
      {editing === 'new' ? editor(() => { void run(() => props.onCreate?.(draft) ?? Promise.resolve(undefined)) }) : undefined}
      {ignored.length === 0 ? undefined : (
        <p className="mw-turn-unchecked" role="note" data-testid="skill-ignored">{t('skillIgnored', { fields: ignored.join(', ') })}</p>
      )}
      {props.skills === undefined ? <p className="mw-ctx-muted">{t('loading')}</p>
        : props.skills.length === 0 ? <p className="mw-ctx-muted" data-testid="skills-none">{t('skillsNone')}</p> : (
          <ul className="mw-skills">
            {props.skills.map(skill => (
              <li key={skill.slug} className="mw-skill" data-testid="skill">
                <p className="mw-ctx-strong">{skill.name} <span className="mw-model-tech">v{skill.version}</span></p>
                <p className="mw-ctx-small">{skill.description}</p>
                {editing === skill.slug ? editor(() => {
                  const version = editVersion
                  if (version === undefined) return
                  void run(() => props.onUpdate?.(skill.slug, draft, version) ?? Promise.resolve(undefined))
                }, editVersion !== undefined && skill.version !== editVersion ? skill : undefined) : (
                  <details className="mw-turn-steps">
                    <summary>{t('skillRead')}</summary>
                    <div className="mw-quoted"><div className="mw-agent-text">{renderBrief(skill.body, { plainHeadings: true })}</div></div>
                  </details>
                )}
                {!props.canManage || editing !== undefined ? undefined : deleting === skill.slug ? (
                  <div className="mw-decide-buttons" role="alertdialog" aria-label={t('skillDeleteAsk', { name: skill.name })} data-testid="skill-delete-confirm">
                    <p className="mw-ctx-small">{t('skillDeleteAsk', { name: skill.name })}</p>
                    <button type="button" className="mw-primary" disabled={pending} onClick={() => { void run(() => props.onDelete?.(skill.slug) ?? Promise.resolve(undefined)) }}>{t('skillDelete')}</button>
                    <button type="button" className="mw-secondary" disabled={pending} onClick={() => { setDeleting(undefined) }}>{t('cancel')}</button>
                  </div>
                ) : (
                  <div className="mw-decide-buttons">
                    {props.onUpdate === undefined ? undefined : (
                      <button
                        type="button"
                        className="mw-secondary"
                        onClick={() => {
                          setDraft(markdownOf(skill))
                          setEditVersion(skill.version)
                          setEditing(skill.slug)
                          setError(undefined)
                          setIgnored([])
                        }}
                      >
                        {t('sheetEdit')}
                      </button>
                    )}
                    {props.onDelete === undefined ? undefined : (
                      <button type="button" className="mw-secondary" onClick={() => { setDeleting(skill.slug); setError(undefined) }}>{t('skillDelete')}</button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      {/* A change made meanwhile is said in its editor, with the new text; not twice. */}
      {error === undefined || (editing !== undefined && editing !== 'new' && props.skills?.find(k => k.slug === editing)?.version !== editVersion)
        ? undefined
        : <p role="alert" className="mw-ctx-error">{error}</p>}
    </section>
  )
}

/**
 * The skills an agent reads, as pills: to tick in the form (three at most, the others greyed with the
 * reason), or shown as they are on its sheet. Each with its version.
 */
export function SkillPills(props: {
  readonly skills: readonly ChatSkill[]
  readonly chosen: readonly string[]
  readonly onChange?: ((chosen: readonly string[]) => void) | undefined
  readonly t: ChatTranslate
}): ReactNode {
  const { t } = props
  const known = new Map(props.skills.map(k => [k.slug, k]))
  if (props.onChange === undefined) {
    return props.chosen.length === 0 ? <span>{t('skillsNoneChosen')}</span> : (
      <span className="mw-pills" data-testid="agent-skills">
        {props.chosen.map((slug) => {
          const skill = known.get(slug)
          return (
            <span key={slug} className="mw-pill mw-pill-static">
              {skill?.name ?? slug}{skill === undefined ? undefined : <span className="mw-pill-note">v{skill.version}</span>}
            </span>
          )
        })}
      </span>
    )
  }
  const full = props.chosen.length >= MAX_SKILLS
  return (
    <div className="mw-pills" role="group" aria-label={t('skillsTitle')} data-testid="skill-pills">
      {props.skills.map((skill) => {
        const on = props.chosen.includes(skill.slug)
        const blocked = !on && full
        return (
          <button
            key={skill.slug}
            type="button"
            className="mw-pill"
            aria-pressed={on}
            aria-disabled={blocked}
            aria-label={blocked ? `${skill.name}, ${t('skillsThreeAtMost')}` : skill.name}
            title={blocked ? t('skillsThreeAtMost') : skill.description}
            onClick={() => {
              if (blocked) return
              props.onChange?.(on ? props.chosen.filter(s => s !== skill.slug) : [...props.chosen, skill.slug])
            }}
          >
            {skill.name}
            <span className="mw-pill-note">v{skill.version}</span>
          </button>
        )
      })}
    </div>
  )
}
