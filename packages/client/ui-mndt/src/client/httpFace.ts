/**
 * Browser face backed by the product HTTP API.
 *
 * Behind the single sign-on front, the proxy proves the person on every request,
 * so the API is the only path that can attribute a page action to the right
 * identity. The in-process Remote stays available for local development, where
 * no proxy sits in front of the API.
 */
import type {
  ApprovalRow,
  BriefRow,
  ConnectorRow,
  MemoryRow,
  MndtFace,
  OutcomeRow,
  PageStateRow,
} from './MndtPage.tsx'

/** Where the gateway mounts the API on the page origin. */
const BASE = '/mndt-api'

/** @param error - a thrown value. @returns its message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One API call.
 * @param path - route below the mount point.
 * @param init - fetch options.
 * @returns the response.
 */
async function call(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, { credentials: 'include', ...init })
}

/**
 * Read a JSON body and turn a refusal into a thrown error with its reason.
 * @param response - the API response.
 * @returns the parsed body.
 */
async function bodyOf<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch(() => ({}))
  if (!response.ok) {
    const reason = typeof body === 'object' && body !== null && 'error' in body && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `the Host refused the call (${response.status})`
    throw new Error(reason)
  }
  return body as T
}

/**
 * Run one call and report its outcome instead of throwing.
 * @param work - the call.
 * @returns the outcome the page renders.
 */
async function outcomeOf<T>(work: () => Promise<T>): Promise<OutcomeRow<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

/** @param path - route. @param payload - JSON body. @returns one JSON POST. */
function post(path: string, payload: unknown): Promise<Response> {
  return call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

/**
 * Build the HTTP face.
 * @returns the face the page renders against.
 */
export function createHttpFace(): MndtFace {
  return {
    state: async (): Promise<PageStateRow> => (await bodyOf<{ page: PageStateRow }>(await call('/state'))).page,
    runMission: (kind, prompt) => outcomeOf(async () => {
      const body = await bodyOf<Record<string, unknown>>(await post('/missions', { kind, prompt }))
      return body as { readonly mission: never; readonly brief?: never }
    }),
    decide: (approvalId, decision, reason) => outcomeOf(async () => {
      const body = await bodyOf<{ approval: ApprovalRow }>(await post(`/approvals/${approvalId}/decide`, { decision, reason }))
      return body.approval
    }),
    approveBrief: briefId => outcomeOf(async () => {
      const body = await bodyOf<{ brief: BriefRow }>(await post(`/briefs/${briefId}/approve`, {}))
      return body.brief
    }),
    remember: (scope, kind, text) => outcomeOf(async () => {
      const body = await bodyOf<{ memory: MemoryRow }>(await post('/memory', { scope, kind, text }))
      return body.memory
    }),
    connectors: async (): Promise<readonly ConnectorRow[]> => {
      const body = await bodyOf<{ connectors?: readonly ConnectorRow[] }>(await call('/connectors'))
      return body.connectors ?? []
    },
  }
}

/**
 * Ask whether the gateway serves the API on this origin.
 * @returns true when the per-user path is available.
 */
export async function available(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE}/health`, { credentials: 'include' })
    return response.ok
  } catch {
    return false
  }
}
