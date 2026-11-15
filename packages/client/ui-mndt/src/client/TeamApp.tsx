/**
 * The standalone team page: what every member of the tenant opens at `/`.
 *
 * No DSH shell, no Remote, no mux: the page speaks only to the product API (`/mndt-api`), the one
 * path that knows the person, proven by the single sign-on front on every request. The gateway
 * serves it at `/` and its files under `/team-assets/`; the owner alone also reaches the full DSH
 * interface, under `/dsh/` (« Mode avancé »).
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { CollabPage } from './CollabPage.tsx'
import type { TeamFrame } from './CollabPage.tsx'
import type { MndtFace } from './face.ts'
import type { ChatFace } from './chat.ts'
import { chatFrench } from './chatLocales.ts'
import { translate } from './locales.ts'
import { readWithin } from './deadline.ts'
import type { DocumentsFace } from './documents.ts'

/** Where the owner finds the full DSH interface. */
export const ADVANCED_HREF = '/dsh/'

/** Who the gateway says the person is: `GET /mndt-api/me`. */
export interface Me {
  readonly you: string
  readonly name?: string
  readonly role?: string
  /** Whether the gateway gives this person the DSH shell, under /dsh/. */
  readonly shell?: boolean
}

/** What `/me` answered: the person, a refusal, or a workspace that could not be read. */
export type Identity =
  | { readonly kind: 'known'; readonly me: Me }
  | { readonly kind: 'refused' }
  | { readonly kind: 'unread' }

/** The fetch the page uses; tests pass their own. */
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

/** The organisation the top bar names: `GET /mndt-api/org`. */
export interface Org {
  readonly name: string
  readonly slug: string
  readonly env?: string
}

/** One person of the team: `GET /mndt-api/people`. */
export interface Person {
  readonly email: string
  readonly role?: string
  readonly name?: string
}

/**
 * @param fetcher - the fetch to use.
 * @param path - the route under `/mndt-api`.
 * @returns the response, within the read deadline.
 */
function read(fetcher: Fetcher, path: string): Promise<Response> {
  return readWithin(path, signal => fetcher(`/mndt-api${path}`, { credentials: 'include', signal }))
}

/**
 * @param fetcher - the fetch to use (the browser's by default).
 * @returns who the person is, as the product API says; a refusal is told apart from a silence.
 * Someone the API knows but who holds no role in the team is refused too: the gateway stops them
 * first, and the page does not draw the team for them either.
 */
export async function whoAmI(fetcher: Fetcher = (input, init) => fetch(input, init)): Promise<Identity> {
  try {
    const response = await read(fetcher, '/me')
    if (response.status === 401 || response.status === 403) return { kind: 'refused' }
    if (!response.ok) return { kind: 'unread' }
    const body = await response.json() as Partial<Me>
    if (typeof body.you !== 'string') return { kind: 'unread' }
    if (typeof body.role !== 'string' || body.role === '') return { kind: 'refused' }
    return { kind: 'known', me: body as Me }
  } catch {
    // The workspace does not answer: the page opens anyway and says so (« L'espace ne répond pas »).
    return { kind: 'unread' }
  }
}

/**
 * @param fetcher - the fetch to use.
 * @returns the organisation, or undefined where none is declared or it could not be read: the bar
 * then shows no organisation rather than a guess.
 */
export async function orgOf(fetcher: Fetcher = (input, init) => fetch(input, init)): Promise<Org | undefined> {
  try {
    const response = await read(fetcher, '/org')
    if (!response.ok) return undefined
    const body = await response.json() as Partial<Org>
    return typeof body.name === 'string' && body.name.trim() !== '' && typeof body.slug === 'string'
      ? { name: body.name, slug: body.slug, ...(typeof body.env === 'string' && body.env !== '' ? { env: body.env } : {}) }
      : undefined
  } catch {
    return undefined
  }
}

/**
 * @param fetcher - the fetch to use.
 * @returns each person's name by lower-case address; empty where the team could not be read, and
 * the screen then shows the part of the address before @.
 */
export async function namesOf(fetcher: Fetcher = (input, init) => fetch(input, init)): Promise<Readonly<Record<string, string>>> {
  try {
    const response = await read(fetcher, '/people')
    if (!response.ok) return {}
    const body = await response.json() as { people?: unknown }
    // No prototype: an address is only ever a key of the team's own names.
    const names = Object.create(null) as Record<string, string>
    for (const row of Array.isArray(body.people) ? body.people as Partial<Person>[] : []) {
      if (typeof row.email === 'string' && typeof row.name === 'string' && row.name.trim() !== '') names[row.email.toLowerCase()] = row.name
    }
    return names
  } catch {
    return {}
  }
}

/** @param env - the environment the API declares. @returns its label in the bar; production shows none, as in mndt-web. */
export function envLabel(env: string | undefined): string | undefined {
  return env === 'preprod' ? translate('shell.env-preprod') : undefined
}

/**
 * @param identity - what `/me` answered.
 * @param org - what `/org` answered.
 * @param names - the team's names, from `/people`.
 * @returns what the frame knows of the person and their organisation.
 */
export function frameOf(identity: Identity, org?: Org, names: Readonly<Record<string, string>> = {}): TeamFrame {
  const me = identity.kind === 'known' ? identity.me : undefined
  return {
    name: me?.name,
    // « Mode avancé » only for whom the gateway gives the DSH shell (`/me.shell`, #70): a second
    // owner of the grants who is not the gateway's would see the tile, then a 404. Absent = no.
    advancedHref: me?.shell === true ? ADVANCED_HREF : undefined,
    owner: me?.role === 'owner',
    org: org === undefined ? undefined : { name: org.name, env: envLabel(org.env) },
    names,
  }
}

/** What the page reads before drawing the frame. */
interface Reads {
  readonly identity: Identity
  readonly org: Org | undefined
  readonly names: Readonly<Record<string, string>>
}

/** @param props - the two faces, and what to read first (the page reads it itself when absent). */
export function TeamApp(props: {
  readonly api: MndtFace
  readonly chat: ChatFace
  readonly identity?: Promise<Identity>
  readonly fetcher?: Fetcher
  /** A channel's documents; the page detects whether the route is served. */
  readonly documents?: DocumentsFace
}): ReactNode {
  const [reads, setReads] = useState<Reads | undefined>(undefined)
  const { identity: asked, fetcher } = props
  useEffect(() => {
    let live = true
    const go = async (): Promise<void> => {
      const identity = await (asked ?? whoAmI(fetcher))
      // A refused person reads nothing else: not the organisation, not the team.
      if (identity.kind === 'refused') {
        if (live) setReads({ identity, org: undefined, names: {} })
        return
      }
      const [org, names] = await Promise.all([orgOf(fetcher), namesOf(fetcher)])
      if (live) setReads({ identity, org, names })
    }
    void go()
    return () => { live = false }
  }, [asked, fetcher])
  if (reads === undefined) return undefined
  if (reads.identity.kind === 'refused') {
    return (
      <div className="mw-denied" role="alert" data-testid="team-denied">
        <p>{translate('shell.denied')}</p>
        <a href="/oauth2/sign_out">{translate('shell.sign-out')}</a>
      </div>
    )
  }
  return (
    <CollabPage
      api={props.api}
      chat={props.chat}
      documents={props.documents}
      t={translate}
      tc={chatFrench}
      team={frameOf(reads.identity, reads.org, reads.names)}
    />
  )
}
