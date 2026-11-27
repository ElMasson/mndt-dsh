/**
 * The team screen's frame, drawn as mndt-web draws it (`components/shell/AppShell.tsx`, `Rail.tsx`):
 * a full-width top bar, one navigation column (a bottom bar and a sheet on a phone), and the page
 * beside them. Only the frame lives here; what each entry opens is the page's business.
 *
 * Nothing is shown without a function (Stéphane, 15/11): no spaces selector and no chevron on the
 * organisation until spaces and a second organisation exist, a deliberate departure from
 * mndt-web; the organisation shows only where its name is known; the steering
 * section (Missions, Mandats, Preuves) is not shown until one of its screens exists.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import wordmark from '../assets/mndt-wordmark-dark.png'
import { Icon } from './Icons.tsx'
import type { IconName } from './Icons.tsx'
import type { MndtTranslate } from './locales.ts'

/** Where the navigation can lead. */
export type TeamPlace =
  'lane' | 'pending' | 'memory' | 'channels' | 'agents' | 'scheduled' | 'machine' | 'settings'

/** One sub-entry under Canaux or Agents. */
export interface TeamSubLink {
  readonly id: string
  readonly label: string
  readonly active: boolean
}

/** What the frame shows and where its links lead. */
export interface TeamShellProps {
  readonly t: MndtTranslate
  /** The entry the page shows, if one; a channel shows as its sub-entry instead. */
  readonly place: TeamPlace | undefined
  readonly onPlace: (place: TeamPlace) => void
  /** The cards waiting on this person, for the badge of À traiter. */
  readonly pending: number
  readonly channels: readonly TeamSubLink[]
  readonly onChannel: (id: string) => void
  readonly agents: readonly TeamSubLink[]
  readonly onAgent: (id: string) => void
  /** The organisation, where its name is served. */
  readonly org?:
    { readonly name: string; readonly env?: string | undefined } | undefined
  /** The person: their address, and their name where it is served. */
  readonly you: string
  readonly name?: string | undefined
  /** Whether the last read of the workspace succeeded. */
  readonly live: boolean
  /** The owner's « Tâches planifiées » entry (missions and automations are the owner's, #63). */
  readonly scheduled?: boolean | undefined
  /** « Mon ordinateur », offered only where the instance serves computers (#163). */
  readonly machine?: boolean | undefined
  readonly children: ReactNode
}

/** @param props - the frame's content. @returns the team screen. */
export function TeamShell(props: TeamShellProps): ReactNode {
  const { t } = props
  const [menu, setMenu] = useState(false)
  // Until the name is served, the part of the address before @ stands for it.
  const name =
    props.name ??
    (props.you.includes('@')
      ? props.you.slice(0, props.you.indexOf('@'))
      : props.you)
  const freshness = props.live ? t('shell.live') : t('shell.paused')
  const follow = (act: () => void) => () => {
    act()
    setMenu(false)
  }
  const rail = (
    <RailLinks
      {...props}
      onPlace={(place) => {
        follow(() => {
          props.onPlace(place)
        })()
      }}
      onChannel={(id) => {
        follow(() => {
          props.onChannel(id)
        })()
      }}
      onAgent={(id) => {
        follow(() => {
          props.onAgent(id)
        })()
      }}
    />
  )
  return (
    <div className="mw-app" data-testid="team-shell">
      <header className="mw-header" data-testid="app-header">
        <div className="mw-header-row">
          <span className="mw-logo">
            <img src={wordmark} alt="mndt" />
          </span>
          {props.org === undefined ? undefined : (
            <span className="mw-org" data-testid="org">
              <span className="mw-org-name">{props.org.name}</span>
              {props.org.env === undefined ? undefined : (
                <span className="mw-env">{props.org.env}</span>
              )}
            </span>
          )}
          <div className="mw-header-end">
            <span
              className="mw-live"
              title={freshness}
              data-state={props.live ? 'live' : 'paused'}
            >
              <Icon name="Radio" size={14} />
              <span>{freshness}</span>
            </span>
            <span
              className="mw-account"
              title={t('shell.account', { name: `${name} · ${props.you}` })}
              data-testid="account-name"
            >
              <Icon name="UserRound" className="mw-slate" />
              <span className="mw-account-text">
                <span className="mw-account-name">{name}</span>
                {props.you === '' ? undefined : (
                  <span
                    className="mw-account-email"
                    data-testid="account-email"
                  >
                    {props.you}
                  </span>
                )}
              </span>
            </span>
          </div>
        </div>
      </header>
      <div className="mw-body">
        <nav
          className="mw-nav"
          aria-label={t('shell.main')}
          data-testid="side-nav"
        >
          {rail}
        </nav>
        <div className="mw-page">{props.children}</div>
      </div>
      <nav
        className="mw-bottom"
        aria-label={t('shell.main')}
        data-testid="bottom-nav"
      >
        <CompactLink
          icon="Lock"
          label={t('shell.lane')}
          active={props.place === 'lane'}
          onClick={() => {
            props.onPlace('lane')
          }}
        />
        <CompactLink
          icon="ListChecks"
          label={t('shell.pending')}
          active={props.place === 'pending'}
          onClick={() => {
            props.onPlace('pending')
          }}
        />
        <CompactLink
          icon="Layers"
          label={t('shell.memory')}
          active={props.place === 'memory'}
          onClick={() => {
            props.onPlace('memory')
          }}
        />
        <CompactLink
          icon="Menu"
          label={t('shell.menu')}
          active={false}
          onClick={() => {
            setMenu(true)
          }}
        />
      </nav>
      {!menu ? undefined : (
        <div
          className="mw-sheet-backdrop"
          onClick={() => {
            setMenu(false)
          }}
          data-testid="menu-sheet"
        >
          <div
            className="mw-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={t('shell.main')}
            onClick={(event) => {
              event.stopPropagation()
            }}
          >
            <button
              type="button"
              className="mw-sheet-close"
              aria-label={t('shell.close')}
              onClick={() => {
                setMenu(false)
              }}
            >
              <Icon name="X" />
            </button>
            <div className="mw-sheet-links">{rail}</div>
          </div>
        </div>
      )}
    </div>
  )
}

/** @param props - the frame's content. @returns the navigation, as the column and the sheet show it. */
function RailLinks(props: TeamShellProps): ReactNode {
  const { t } = props
  const link = (
    place: TeamPlace,
    icon: IconName,
    label: string,
    extra?: ReactNode,
  ): ReactNode => (
    <button
      type="button"
      className="mw-link"
      data-active={props.place === place}
      aria-current={props.place === place ? 'page' : undefined}
      onClick={() => {
        props.onPlace(place)
      }}
    >
      <Icon name={icon} className="mw-shrink" />
      <span>{label}</span>
      {extra}
    </button>
  )
  const subs = (
    items: readonly TeamSubLink[],
    open: (id: string) => void,
    hash: boolean,
    testId: string,
  ): ReactNode =>
    items.length === 0 ? undefined : (
      <ul className="mw-sublist" data-testid={testId}>
        {items.map(item => (
          <li key={item.id}>
            <button
              type="button"
              className="mw-sublink"
              data-active={item.active}
              aria-current={item.active ? 'page' : undefined}
              onClick={() => {
                open(item.id)
              }}
            >
              <span className="mw-ellipsis">
                {hash ? `# ${item.label}` : item.label}
              </span>
            </button>
          </li>
        ))}
      </ul>
    )
  return (
    <>
      {link('lane', 'Lock', t('shell.lane'))}
      {link(
        'pending',
        'ListChecks',
        t('shell.pending'),
        props.pending > 0 ? (
          <span
            className="mw-badge"
            aria-label={t('shell.pending-count', { count: props.pending })}
          >
            {props.pending}
          </span>
        ) : undefined,
      )}
      {link('memory', 'Layers', t('shell.memory'))}
      <hr className="mw-rule" />
      {link('channels', 'Hash', t('shell.channels'))}
      {subs(props.channels, props.onChannel, true, 'rail-channels')}
      {link('agents', 'Bot', t('shell.agents'))}
      {subs(props.agents, props.onAgent, false, 'rail-agents')}
      {props.scheduled === true ? link('scheduled', 'Clock', t('shell.scheduled')) : undefined}
      {props.machine === true ? link('machine', 'Monitor', t('shell.machine')) : undefined}
      {/* No « Pilotage » until one of its places has a function (Stéphane: nothing shown without one). */}
      <div className="mw-foot">
        {link('settings', 'Settings2', t('shell.settings'))}
      </div>
    </>
  )
}

/** One place of the phone bar. */
function CompactLink(props: {
  readonly icon: IconName
  readonly label: string
  readonly active: boolean
  readonly onClick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      className="mw-compact"
      data-active={props.active}
      aria-current={props.active ? 'page' : undefined}
      onClick={props.onClick}
    >
      <Icon name={props.icon} className="mw-shrink" />
      <span>{props.label}</span>
    </button>
  )
}
