/**
 * The channel routes over the workbench HTTP API (lot 1 contract). Behind the single sign-on
 * front, the proxy proves the person on every request. A refusal throws with the Host's reason:
 * an error is never read as an empty list.
 */
import type {
  ChannelCreate,
  ChatAgent,
  ChatChannel,
  ChatChanges,
  ChatFace,
  ChatMessage,
} from './chat.ts'

/** Where the gateway mounts the API on the page origin. */
const BASE = '/mndt-api'

/** The fetch the face uses; tests pass their own. */
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Read a JSON body; a refusal throws with the Host's `{ error }`, or its status.
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
    throw new Error(reason)
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
    bodyOf<T>(await fetcher(`${BASE}${path}`, { credentials: 'include' }))
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
    agents: async () => (await get<{ agents: ChatAgent[] }>('/agents')).agents,
    addAgents: async (channelId, agentIds) =>
      (
        await post<{ channel: ChatChannel }>(
          `/channels/${id(channelId)}/agents`,
          { add: agentIds },
        )
      ).channel,
  }
}
