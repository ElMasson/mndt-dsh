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

/** Where the owner finds the full DSH interface. */
export const ADVANCED_HREF = '/dsh/'

/** Who the gateway says the person is: `GET /mndt-api/me`. */
export interface Me {
  readonly you: string
  readonly name?: string
  readonly role?: string
}

/** What `/me` answered: the person, a refusal, or a workspace that could not be read. */
export type Identity =
  | { readonly kind: 'known'; readonly me: Me }
  | { readonly kind: 'refused' }
  | { readonly kind: 'unread' }

/** The fetch the page uses; tests pass their own. */
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

/**
 * @param fetcher - the fetch to use (the browser's by default).
 * @returns who the person is, as the product API says; a refusal is told apart from a silence.
 */
export async function whoAmI(fetcher: Fetcher = (input, init) => fetch(input, init)): Promise<Identity> {
  try {
    const response = await readWithin('/me', signal => fetcher('/mndt-api/me', { credentials: 'include', signal }))
    if (response.status === 401 || response.status === 403) return { kind: 'refused' }
    if (!response.ok) return { kind: 'unread' }
    const body = await response.json() as Partial<Me>
    return typeof body.you === 'string' ? { kind: 'known', me: body as Me } : { kind: 'unread' }
  } catch {
    // The workspace does not answer: the page opens anyway and says so (« L'espace ne répond pas »).
    return { kind: 'unread' }
  }
}

/** @param identity - what `/me` answered. @returns what the frame knows of the person. */
export function frameOf(identity: Identity): TeamFrame {
  const me = identity.kind === 'known' ? identity.me : undefined
  return {
    name: me?.name,
    advancedHref: me?.role === 'owner' ? ADVANCED_HREF : undefined,
  }
}

/** @param props - the two faces, and who the person is (read by the page when absent). */
export function TeamApp(props: {
  readonly api: MndtFace
  readonly chat: ChatFace
  readonly identity?: Promise<Identity>
}): ReactNode {
  const [identity, setIdentity] = useState<Identity | undefined>(undefined)
  const { identity: asked } = props
  useEffect(() => {
    let live = true
    void (asked ?? whoAmI()).then((next) => { if (live) setIdentity(next) })
    return () => { live = false }
  }, [asked])
  if (identity === undefined) return undefined
  if (identity.kind === 'refused') {
    return (
      <div className="mw-denied" role="alert" data-testid="team-denied">
        <p>{translate('shell.denied')}</p>
        <a href="/oauth2/sign_out">{translate('shell.sign-out')}</a>
      </div>
    )
  }
  return <CollabPage api={props.api} chat={props.chat} t={translate} tc={chatFrench} team={frameOf(identity)} />
}
