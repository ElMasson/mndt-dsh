// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelAgents, ChannelList, ChannelThread } from '../src/client/ChannelView.tsx'
import type { ThreadCard } from '../src/client/ChannelView.tsx'
import { chatEnglish } from '../src/client/chatLocales.ts'
import { createMockChat } from '../src/client/mockChat.ts'
import type { MockChat } from '../src/client/mockChat.ts'
import type { ChatAgent, ChatChannel } from '../src/client/chat.ts'

afterEach(() => { cleanup() })

const AT = '2026-11-12T09:00:00.000Z'
const YOU = 'me@datanalysis.re'

/** @param over - fields to change. @returns one declared agent. */
function agent(over: Partial<ChatAgent> = {}): ChatAgent {
  return {
    id: 'agt_1', handle: 'assistant', name: 'Assistant', provider: 'scaleway-genapi', model: 'glm-5.3',
    connectors: [], eurPerMonth: 5, eurThisMonth: 0.42, createdBy: YOU, createdAt: AT, ...over,
  }
}

/** @param over - fields to change. @returns one channel. */
function channel(over: Partial<ChatChannel> = {}): ChatChannel {
  return {
    id: 'chn_1', name: 'compta', title: 'Compta', kind: 'team', members: [YOU],
    agents: ['agt_1'], connectors: [], createdBy: YOU, createdAt: AT, ...over,
  }
}

/** @returns a double with two agents, one of them in the channel. */
function double(agents: ChatAgent[] = [agent(), agent({ id: 'agt_2', handle: 'analyste', name: 'Analyste' })]): MockChat {
  return createMockChat({ you: YOU, agents, channels: [channel()] }, () => Date.parse(AT))
}

/** @param chat - the double. @param cards - the cards to show. @returns what to render. */
function thread(chat: MockChat, cards: ThreadCard[] = [], onDecide = vi.fn(() => Promise.resolve(undefined))) {
  return (
    <ChannelThread
      chat={chat}
      channel={channel()}
      agents={[agent(), agent({ id: 'agt_2', handle: 'analyste', name: 'Analyste' })]}
      cards={cards}
      canDecide
      onDecide={onDecide}
      t={chatEnglish}
      pollMs={20}
    />
  )
}

describe('the channel list', () => {
  it('the solo lane reads « My lane »; a channel is created from its title alone, a refusal said as served', async () => {
    const onCreate = vi.fn()
      .mockResolvedValueOnce('name taken')
      .mockResolvedValueOnce(undefined)
    render(
      <ChannelList
        channels={[channel({ id: 'chn_0', kind: 'solo', name: 'me', title: 'me' }), channel()]}
        selected="chn_1"
        onSelect={() => undefined}
        onCreate={onCreate}
        t={chatEnglish}
      />,
    )
    const list = screen.getByTestId('chat-channels')
    expect(within(list).getByText('My lane')).toBeTruthy()
    expect(within(list).getByText('Compta')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'New channel' }))
    fireEvent.change(screen.getByLabelText('Channel name'), { target: { value: 'Compta Orange' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'name taken')
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => { expect(screen.queryByLabelText('Channel name')).toBeNull() })
    expect(onCreate).toHaveBeenCalledWith('Compta Orange')
  })
})

describe('the thread', () => {
  it('offers only this channel\'s agents after @, sends, then shows the turn moving to its answer and cost', async () => {
    const chat = double()
    render(thread(chat))
    await screen.findByTestId('chat-empty')
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: '@a', selectionStart: 2 } })
    const offered = within(screen.getByTestId('chat-mentions')).getAllByRole('option').map(o => o.textContent)
    expect(offered).toEqual(['@assistant Assistant'])
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => { expect(box.value).toBe('@assistant ') })
    fireEvent.change(box, { target: { value: '@assistant que dit la facture ?', selectionStart: 31 } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => { expect(screen.getAllByTestId('chat-message')).toHaveLength(1) })
    expect(within(screen.getByTestId('chat-turn')).getByText('waiting')).toBeTruthy()
    act(() => { chat.tick() })
    act(() => { chat.tick() })
    await waitFor(() => { expect(screen.getAllByTestId('chat-message')).toHaveLength(2) })
    expect(within(screen.getByTestId('chat-turn')).getByText('answered')).toBeTruthy()
    expect(screen.getByTestId('chat-turn-cost').textContent).toMatch(/1,500 tokens · /u)
    expect(screen.getByTestId('chat-turn').textContent).toContain('trace ses_')
    expect(box.value).toBe('')
  })

  it('past the monthly ceiling the turn is refused and a system line says so', async () => {
    const chat = double([agent({ eurThisMonth: 5 })])
    render(thread(chat))
    await screen.findByTestId('chat-empty')
    const box = screen.getByLabelText('Message')
    fireEvent.change(box, { target: { value: '@assistant encore', selectionStart: 17 } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => { expect(screen.getAllByTestId('chat-message')).toHaveLength(1) })
    act(() => { chat.tick() })
    await waitFor(() => { expect(screen.getAllByTestId('chat-message')).toHaveLength(2) })
    expect(within(screen.getByTestId('chat-turn')).getByText('refused')).toBeTruthy()
    const system = screen.getAllByTestId('chat-message').find(m => m.dataset['author'] === 'system')!
    expect(system.textContent).toContain('Plafond mensuel atteint pour @assistant')
  })

  it('a card asked during a turn sits under its message, decided only by its button', async () => {
    const chat = double()
    const sent = await chat.post('chn_1', '@assistant prépare le brouillon')
    const onDecide = vi.fn(() => Promise.resolve(undefined))
    render(thread(chat, [
      { id: 'apr_1', kind: 'tool', title: 'Créer un brouillon de mail', requestedBy: 'assistant', requestedAt: AT, channelId: 'chn_1', messageId: sent.id },
      { id: 'apr_2', kind: 'tool', title: 'Ailleurs', requestedBy: 'assistant', requestedAt: AT, channelId: 'chn_9', messageId: sent.id },
    ], onDecide))
    const card = await screen.findByTestId('chat-card')
    expect(screen.getAllByTestId('chat-card')).toHaveLength(1)
    expect(card.textContent).toContain('Créer un brouillon de mail')
    fireEvent.click(within(card).getByRole('button', { name: 'Refuse' }))
    fireEvent.change(within(card).getByLabelText('Reason for the refusal, kept in the log'), { target: { value: 'pas maintenant' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Confirm the refusal' }))
    await waitFor(() => { expect(onDecide).toHaveBeenCalledWith('apr_1', 'rejected', 'pas maintenant') })
  })

  it('a thread that cannot be read says why, never shows as empty', async () => {
    const chat = double()
    chat.messages = () => Promise.reject(new Error('channel_not_found'))
    render(thread(chat))
    expect((await screen.findByRole('alert')).textContent).toContain('channel_not_found')
    expect(screen.queryByTestId('chat-empty')).toBeNull()
  })

  it('a turn that ends is told once, so the cards and the spending it asked for are read at once', async () => {
    const chat = double()
    const onSettled = vi.fn()
    render(
      <ChannelThread
        chat={chat}
        channel={channel()}
        agents={[agent()]}
        cards={[]}
        canDecide
        onDecide={() => Promise.resolve(undefined)}
        onSettled={onSettled}
        t={chatEnglish}
        pollMs={20}
      />,
    )
    await screen.findByTestId('chat-empty')
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: '@assistant bonjour', selectionStart: 18 } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => { expect(screen.getAllByTestId('chat-message')).toHaveLength(1) })
    act(() => { chat.tick() })
    await waitFor(() => { expect(within(screen.getByTestId('chat-turn')).getByText('answering…')).toBeTruthy() })
    expect(onSettled).not.toHaveBeenCalled()
    act(() => { chat.tick() })
    await waitFor(() => { expect(onSettled).toHaveBeenCalledTimes(1) })
    // Read again and again through the inclusive cursor, the ended turn is not told twice.
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('a channel without agents says that no one answers a mention', async () => {
    const chat = createMockChat({ you: YOU, agents: [], channels: [channel({ agents: [] })] }, () => Date.parse(AT))
    render(
      <ChannelThread
        chat={chat}
        channel={channel({ agents: [] })}
        agents={[]}
        cards={[]}
        canDecide={false}
        onDecide={() => Promise.resolve(undefined)}
        t={chatEnglish}
        pollMs={20}
      />,
    )
    expect((await screen.findByTestId('chat-no-agent')).textContent).toBe('No agent in this channel: no one answers a mention.')
  })
})

describe('the thread follows the newest message', () => {
  /** @param box - the feed. @param height - its content height. */
  function sized(box: HTMLElement, height: number): void {
    Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => height })
    Object.defineProperty(box, 'clientHeight', { configurable: true, get: () => 100 })
  }

  it('at the bottom it follows; scrolled up to read, it stays where the reader is', async () => {
    const chat = double()
    render(thread(chat))
    await screen.findByTestId('chat-empty')
    const feed = screen.getByTestId('chat-thread')
    sized(feed, 600)
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: '@assistant bonjour', selectionStart: 18 } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => { expect(feed.scrollTop).toBe(600) })
    // The reader scrolls up: a new answer does not pull them down.
    feed.scrollTop = 50
    fireEvent.scroll(feed)
    sized(feed, 900)
    act(() => { chat.tick() })
    act(() => { chat.tick() })
    await waitFor(() => { expect(screen.getAllByTestId('chat-message')).toHaveLength(2) })
    expect(feed.scrollTop).toBe(50)
  })
})

describe('the channel agents', () => {
  it('model and this month\'s spending against the ceiling', () => {
    render(<ChannelAgents channel={channel()} agents={[agent(), agent({ id: 'agt_2', handle: 'analyste' })]} t={chatEnglish} />)
    const rows = screen.getAllByTestId('chat-agent')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.textContent).toContain('scaleway-genapi · glm-5.3')
    expect(screen.getByTestId('chat-agent-month').textContent).toMatch(/this month, of /u)
  })
})

describe('adding an agent to a channel, as a colleague', () => {
  it('offers the declared agents not yet here nor retired; a refusal is said as served', async () => {
    const onAdd = vi.fn()
      .mockResolvedValueOnce('me@datanalysis.re is viewer and does not hold workflows.write')
      .mockResolvedValueOnce(undefined)
    render(
      <ChannelAgents
        channel={channel()}
        agents={[agent(), agent({ id: 'agt_2', handle: 'analyste', name: 'Analyste' }), agent({ id: 'agt_3', handle: 'ancien', name: 'Ancien', retiredAt: AT })]}
        onAdd={onAdd}
        t={chatEnglish}
      />,
    )
    const pick = screen.getByLabelText('Add an agent to this channel')
    expect(within(pick).getAllByRole('option').map(o => o.textContent)).toEqual(['Choose an agent', '@analyste · Analyste'])
    fireEvent.change(pick, { target: { value: 'agt_2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect((await screen.findByRole('alert')).textContent).toContain('does not hold workflows.write')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
    expect(onAdd).toHaveBeenLastCalledWith('agt_2')
  })
})
