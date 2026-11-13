// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelAgents, ChannelList, ChannelThread } from '../src/client/ChannelView.tsx'
import type { ThreadCard } from '../src/client/ChannelView.tsx'
import { renderBrief } from '../src/client/markdown.tsx'
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

  it('a refusal cannot be confirmed without its reason', async () => {
    const chat = double()
    const sent = await chat.post('chn_1', '@assistant prépare le brouillon')
    const onDecide = vi.fn(() => Promise.resolve(undefined))
    render(thread(chat, [
      { id: 'apr_1', kind: 'tool', title: 'Créer un brouillon de mail', requestedBy: 'assistant', requestedAt: AT, channelId: 'chn_1', messageId: sent.id },
    ], onDecide))
    const card = await screen.findByTestId('chat-card')
    fireEvent.click(within(card).getByRole('button', { name: 'Refuse' }))
    const confirm = within(card).getByRole('button', { name: 'Confirm the refusal' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(confirm.title).toBe('A refusal needs its reason.')
    fireEvent.click(confirm)
    fireEvent.change(within(card).getByLabelText('Reason for the refusal, kept in the log'), { target: { value: '   ' } })
    expect(confirm.disabled).toBe(true)
    expect(onDecide).not.toHaveBeenCalled()
  })

  it('a decided card stays under its message with who and when, and offers no button', async () => {
    const chat = double()
    const sent = await chat.post('chn_1', '@assistant deux brouillons')
    const decidedAt = '2026-11-13T08:40:00.000Z'
    render(thread(chat, [
      {
        id: 'apr_1', kind: 'tool', title: 'Premier brouillon', requestedBy: 'assistant', requestedAt: AT, channelId: 'chn_1', messageId: sent.id,
        state: 'approved', decidedBy: 'stephane@datanalysis.re', decidedAt,
      },
      {
        id: 'apr_2', kind: 'tool', title: 'Second brouillon', requestedBy: 'assistant', requestedAt: AT, channelId: 'chn_1', messageId: sent.id,
        state: 'rejected', decidedBy: 'stephane@datanalysis.re', decidedAt, reason: 'pas avant la revue',
      },
    ]))
    await waitFor(() => { expect(screen.getAllByTestId('chat-card')).toHaveLength(2) })
    const [approved, refused] = screen.getAllByTestId('chat-card')
    const time = new Date(decidedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    expect(within(approved!).getByTestId('chat-card-decision').textContent).toBe(`Approved by stephane at ${time}`)
    expect(within(refused!).getByTestId('chat-card-decision').textContent).toBe(`Refused by stephane at ${time}: pas avant la revue`)
    expect(within(approved!).queryAllByRole('button')).toHaveLength(0)
    expect(within(refused!).queryAllByRole('button')).toHaveLength(0)
  })

  it('cards that cannot be read are said so in the thread', async () => {
    const chat = double()
    render(
      <ChannelThread
        chat={chat}
        channel={channel()}
        agents={[agent()]}
        cards={[]}
        cardsError="the Host refused the call (500)"
        canDecide
        onDecide={() => Promise.resolve(undefined)}
        t={chatEnglish}
        pollMs={20}
      />,
    )
    expect((await screen.findByRole('alert')).textContent).toBe('The cards could not be read: the Host refused the call (500)')
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

describe('deleting one\'s own message (R-16)', () => {
  it('only the author is offered it; after the confirmation the text goes and the pending turn stops', async () => {
    const chat = double()
    render(
      <ChannelThread
        chat={chat}
        channel={channel()}
        agents={[agent(), agent({ id: 'agt_2', handle: 'analyste', name: 'Analyste' })]}
        cards={[]}
        canDecide
        onDecide={() => Promise.resolve(undefined)}
        you={YOU}
        t={chatEnglish}
        pollMs={20}
      />,
    )
    await screen.findByTestId('chat-empty')
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: '@assistant résume', selectionStart: 17 } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => { expect(screen.getAllByTestId('chat-message')).toHaveLength(1) })
    act(() => { chat.tick() })
    act(() => { chat.tick() })
    // The agent's answer is not the reader's: it offers nothing.
    await waitFor(() => { expect(screen.getAllByTestId('chat-message')).toHaveLength(2) })
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1)
    fireEvent.change(box, { target: { value: '@assistant une autre', selectionStart: 20 } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => { expect(screen.getAllByTestId('chat-message')).toHaveLength(3) })
    const mine = screen.getAllByTestId('chat-message')[2]!
    fireEvent.click(within(mine).getByRole('button', { name: 'Delete' }))
    // Nothing goes before the confirmation; cancelling keeps the message.
    fireEvent.click(within(mine).getByRole('button', { name: 'Cancel' }))
    expect(within(mine).getByText('@assistant une autre')).toBeTruthy()
    fireEvent.click(within(mine).getByRole('button', { name: 'Delete' }))
    fireEvent.click(within(mine).getByRole('button', { name: 'Confirm the deletion' }))
    await waitFor(() => { expect(within(mine).getByText('Message deleted.')).toBeTruthy() })
    expect(within(mine).getByText('stopped')).toBeTruthy()
    expect(within(mine).queryByRole('button', { name: 'Delete' })).toBeNull()
  })

  it('a refused deletion is said as served and the message stays', async () => {
    const chat = double()
    chat.remove = () => Promise.reject(new Error('not_the_author'))
    render(
      <ChannelThread
        chat={chat}
        channel={channel()}
        agents={[agent()]}
        cards={[]}
        canDecide
        onDecide={() => Promise.resolve(undefined)}
        you={YOU}
        t={chatEnglish}
        pollMs={20}
      />,
    )
    await screen.findByTestId('chat-empty')
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'bonjour', selectionStart: 7 } })
    fireEvent.keyDown(box, { key: 'Enter' })
    const mine = await screen.findByTestId('chat-message')
    fireEvent.click(within(mine).getByRole('button', { name: 'Delete' }))
    fireEvent.click(within(mine).getByRole('button', { name: 'Confirm the deletion' }))
    expect((await within(mine).findByRole('alert')).textContent).toBe('not_the_author')
    expect(within(mine).getByText('bonjour')).toBeTruthy()
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

describe('an agent\'s answer is read, not shown as raw Markdown', () => {
  it('bold, a table and a list become elements, and nothing in the text becomes HTML', () => {
    const answer = 'Voici **#compta** :\n\n| Facture | Montant |\n|---|---:|\n| FA2610-031 | 1 640,00 € |\n\n- relancer Sodiac\n- <img src=x onerror=alert(1)>'
    const { container } = render(<div>{renderBrief(answer)}</div>)
    expect(container.querySelector('strong')!.textContent).toBe('#compta')
    expect([...container.querySelectorAll('th')].map(th => th.textContent)).toEqual(['Facture', 'Montant'])
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(container.querySelectorAll('li')).toHaveLength(2)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).not.toContain('**')
    expect(container.textContent).not.toContain('|---')
  })

  it('in the thread, an agent\'s message goes through it and a person\'s keeps its own lines', async () => {
    const chat = double()
    render(thread(chat))
    await screen.findByTestId('chat-empty')
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: '@assistant ligne une', selectionStart: 20 } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => { expect(screen.getAllByTestId('chat-message')).toHaveLength(1) })
    act(() => { chat.tick() })
    act(() => { chat.tick() })
    await waitFor(() => { expect(screen.getAllByTestId('chat-message')).toHaveLength(2) })
    const [human, agentMessage] = screen.getAllByTestId('chat-message')
    expect(within(agentMessage!).getByTestId('chat-markdown')).toBeTruthy()
    expect(within(human!).queryByTestId('chat-markdown')).toBeNull()
  })
})

describe('times and numbers follow the page language, not the browser', () => {
  it('a French page reads a 24-hour time and spaced thousands, even in an English browser', async () => {
    document.documentElement.lang = 'fr'
    try {
      const chat = double()
      const sent = await chat.post('chn_1', '@assistant prépare le brouillon')
      const decidedAt = '2026-11-13T17:50:00.000Z'
      render(thread(chat, [{
        id: 'apr_1', kind: 'tool', title: 'Brouillon', requestedBy: 'assistant', requestedAt: AT, channelId: 'chn_1', messageId: sent.id,
        state: 'approved', decidedBy: 'stephane@datanalysis.re', decidedAt,
      }]))
      const decision = await screen.findByTestId('chat-card-decision')
      const french = new Date(decidedAt).toLocaleTimeString('fr', { hour: '2-digit', minute: '2-digit' })
      expect(decision.textContent).toContain(french)
      expect(decision.textContent).not.toMatch(/AM|PM/u)
      act(() => { chat.tick() })
      act(() => { chat.tick() })
      const cost = await screen.findByTestId('chat-turn-cost')
      expect(cost.textContent).toContain((1500).toLocaleString('fr'))
      expect(cost.textContent).not.toContain('1,500')
    } finally {
      document.documentElement.lang = ''
    }
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
