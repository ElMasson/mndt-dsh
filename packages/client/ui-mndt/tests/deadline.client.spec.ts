import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostTimeout, READ_DEADLINE_MS, readWithin } from '../src/client/deadline.ts'
import { isHostDown } from '../src/client/hostDown.ts'
import { createHttpChat } from '../src/client/httpChat.ts'
import { createHttpFace, probe } from '../src/client/httpFace.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** A fetch that never answers, unless its signal stops it. */
function hanging(_input: unknown, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) })
  })
}

/** @param status - HTTP status. @returns a Response-like object. */
function answer(status: number): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => ({}) } as unknown as Response
}

describe('a read waits for the workspace at most 15 s', () => {
  it('a read that never answers ends at its deadline as the workspace not answering', async () => {
    vi.useFakeTimers()
    const read = readWithin('/state', signal => hanging('/state', { signal }))
    const caught = read.catch((failure: unknown) => failure)
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS - 1)
    let settled = false
    void caught.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const failure = await caught
    expect(READ_DEADLINE_MS).toBe(15000)
    expect(failure).toBeInstanceOf(HostTimeout)
    expect(isHostDown(failure)).toBe(true)
  })

  it('an answer in time is returned; a failure of its own passes through unchanged', async () => {
    expect((await readWithin('/state', async () => answer(200))).status).toBe(200)
    const own = new TypeError('Failed to fetch')
    await expect(readWithin('/state', () => Promise.reject(own))).rejects.toBe(own)
  })

  it('both faces bound their reads, and only their reads', async () => {
    vi.useFakeTimers()
    const calls: { url: string; signal: boolean }[] = []
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, signal: init?.signal !== undefined })
      return init?.method === 'POST' ? Promise.resolve(answer(200)) : hanging(url, init)
    }))
    const state = createHttpFace().state().catch((failure: unknown) => failure)
    const channels = createHttpChat().channels().catch((failure: unknown) => failure)
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS)
    expect(await state).toBeInstanceOf(HostTimeout)
    expect(await channels).toBeInstanceOf(HostTimeout)
    // A mission is answered once it settled: a write is never cut by the read deadline.
    await createHttpFace().runMission('custom', 'revue')
    expect(calls.find(c => c.url.endsWith('/missions'))?.signal).toBe(false)
  })
})

describe('the probe tells a workstation without the API from a workspace that is down', () => {
  it('served, absent, or down (gateway status, network failure, no answer in time)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(200)))
    expect(await probe()).toBe('served')
    vi.stubGlobal('fetch', vi.fn(async () => answer(404)))
    expect(await probe()).toBe('absent')
    vi.stubGlobal('fetch', vi.fn(async () => answer(502)))
    expect(await probe()).toBe('down')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    expect(await probe()).toBe('down')
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(hanging))
    const pending = probe()
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS)
    expect(await pending).toBe('down')
  })
})
