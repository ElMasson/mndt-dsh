/**
 * The channel routes over the workbench HTTP API (lot 1 contract). Behind the single sign-on
 * front, the proxy proves the person on every request. A refusal throws with the Host's reason:
 * an error is never read as an empty list.
 */
import { ChatRefusal } from './chat.ts'
import { readWithin } from './deadline.ts'
import type { ChannelCreate, ChatAgent, ChatCard, ChatChanges, ChatChannel, ChatFace, ChatMessage, MountedConnector, OfferedModel } from './chat.ts'

/** Where the gateway mounts the API on the page origin. */
const BASE = '/mndt-api'

/** The fetch the face uses; tests pass their own. */
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Read a JSON body; a refusal throws a `ChatRefusal` with the Host's `{ error }` and its status.
 * @param response - the API response.
 * @returns the parsed body.
 */
async function bodyOf<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch(() => ({}))
  if (!response.ok) {
    const reason =
      typeof body === 'object' &&
      body !== null &&
      typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `the Host refused the call (${response.status})`
    const code = typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string'
      ? (body as { code: string }).code
      : undefined
    throw new ChatRefusal(reason, response.status, code)
  }
  return body as T
}

/**
 * Build the channel face.
 * @param fetcher - the fetch to use (the browser's by default).
 * @returns the face.
 */
export function createHttpChat(
  fetcher: Fetcher = (input, init) => fetch(input, init),
): ChatFace {
  const get = async <T>(path: string): Promise<T> =>
    bodyOf<T>(await readWithin(path, signal => fetcher(`${BASE}${path}`, { credentials: 'include', signal })))
  const post = async <T>(path: string, payload: unknown): Promise<T> =>
    bodyOf<T>(
      await fetcher(`${BASE}${path}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    )
  const id = encodeURIComponent
  return {
    channels: async () =>
      (await get<{ channels: ChatChannel[] }>('/channels')).channels,
    createChannel: async (input: ChannelCreate) =>
      (await post<{ channel: ChatChannel }>('/channels', input)).channel,
    messages: async channelId =>
      get<ChatChanges>(`/channels/${id(channelId)}/messages`),
    changes: async (channelId, since) =>
      get<ChatChanges>(
        `/channels/${id(channelId)}/messages?since=${id(since)}`,
      ),
    post: async (channelId, text, replyTo) =>
      (
        await post<{ message: ChatMessage }>(
          `/channels/${id(channelId)}/messages`,
          replyTo ? { text, replyTo } : { text },
        )
      ).message,
    remove: async (channelId, messageId) =>
      (
        await post<{ message: ChatMessage }>(
          `/channels/${id(channelId)}/messages/${id(messageId)}/delete`,
          {},
        )
      ).message,
    cards: async () =>
      (await get<{ approvals: ChatCard[] }>('/approvals?state=all')).approvals,
    agents: async () => (await get<{ agents: ChatAgent[] }>('/agents')).agents,
    addAgents: async (channelId, agentIds) =>
      (
        await post<{ channel: ChatChannel }>(
          `/channels/${id(channelId)}/agents`,
          { add: agentIds },
        )
      ).channel,
    removeAgents: async (channelId, agentIds) =>
      (await post<{ channel: ChatChannel }>(`/channels/${id(channelId)}/agents`, { remove: agentIds })).channel,
    setCoordination: async (channelId, change) =>
      (await post<{ channel: ChatChannel }>(`/channels/${id(channelId)}/coordination`, change)).channel,
    setConnectors: async (channelId, servers) =>
      (await post<{ channel: ChatChannel }>(`/channels/${id(channelId)}/connectors`, { connectors: servers })).channel,
    createAgent: async input => (await post<{ agent: ChatAgent }>('/agents', input)).agent,
    updateAgent: async (agentId, patch) => (await post<{ agent: ChatAgent }>(`/agents/${id(agentId)}`, patch)).agent,
    models: async () => {
      const body = await get<{ models?: unknown }>('/models')
      return (Array.isArray(body.models) ? body.models : []).filter((row): row is OfferedModel => {
        const m = row as Partial<OfferedModel> | null
        return m !== null && typeof m === 'object' && typeof m.provider === 'string' && typeof m.model === 'string'
      }).map(m => ({ provider: m.provider, model: m.model }))
    },
    mounted: async () => {
      const body = await get<{ connectors?: unknown }>('/connectors')
      // A row of another shape is dropped: the page never offers what it cannot read.
      return (Array.isArray(body.connectors) ? body.connectors : []).filter((row): row is MountedConnector => {
        const c = row as Partial<MountedConnector> | null
        return c !== null && typeof c === 'object' && typeof c.server === 'string' && typeof c.module === 'string' && typeof c.enabled === 'boolean'
      })
    },
  }
}
