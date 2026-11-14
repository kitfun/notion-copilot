// The side panel's UI, tested as a user meets it: the whole panel runs (see panel.ts) and the tests
// only type, click, and read what is on screen. Besides the screen they look at the edges alone:
// what the model was sent, and what Notion was asked to do.
import '@testing-library/jest-dom/vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeNotionTab, FakeWorkspace, PAGE, PAGE_URL, SPACE, pageTab } from './notion-tab'
import { closeBrowser, FakeBrowser, START } from './panel'

afterEach(closeBrowser)

/** A browser signed in to Notico, with the side panel open on `tab`. */
async function openPanel(tab: FakeNotionTab = pageTab()) {
  const browser = await FakeBrowser.start(tab, { signedInAs: 'user_alice' })
  await browser.openPanel()
  return { browser, user: userEvent.setup() }
}

const composer = () => screen.getByRole('textbox', { name: 'Message' })
/** The conversation, without the header above it, which also shows the first question. */
const conversation = () => within(screen.getByRole('main'))
/** The session list, while it is open. */
const sessionList = () => within(screen.getByRole('dialog', { name: 'Chats' }))

async function ask(user: UserEvent, question: string) {
  await user.type(composer(), question)
  await user.click(screen.getByRole('button', { name: 'Send' }))
}

/** The question has ended: the composer offers Send again. */
const answered = () => screen.findByRole('button', { name: 'Send' })

/**
 * A model reply that stops partway until `resume` is called. The fake model streams each word as an
 * event of about 60 bytes, so it stops after the first two words.
 */
function pausedReply(browser: FakeBrowser, reply: string, after = 150) {
  let resume!: () => void
  browser.ai.pause = { after, until: new Promise<void>((resolve) => (resume = resolve)) }
  browser.ai.script.push({ reply })
  return resume
}

const comesBefore = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

const NOTE = '2c2c2c2c-0000-4000-8000-000000000021'

/** A workspace whose open page has one child page, "Old notes". */
function workspaceTab() {
  const page = (id: string, title: string, parent: string, content: string[] = []) => ({
    id,
    type: 'page',
    properties: { title: [[title]] },
    parent_id: parent,
    parent_table: 'block',
    content,
  })
  const workspace = new FakeWorkspace(
    [
      { id: SPACE, pages: [PAGE] },
      { ...page(PAGE, 'Fixture page', SPACE, [NOTE]), parent_table: 'space' },
      page(NOTE, 'Old notes', PAGE),
    ],
    SPACE,
  )
  const tab = new FakeNotionTab(PAGE_URL)
  tab.workspace = workspace
  return { tab, workspace }
}

/** The rows of the reply's details, opened from its "…" button. */
async function replyDetails(user: UserEvent) {
  await user.click(screen.getByRole('button', { name: 'Reply details' }))
  const popover = screen.getByRole('dialog', { name: 'Reply details' })
  return [...popover.querySelectorAll('p')].map((row) => row.textContent)
}

describe('asking the AI', () => {
  it('[UC-NOTICO-CHAT-001-S03] the sent message appears and the reply streams in below it', async () => {
    const { browser, user } = await openPanel()
    // The model has written its first words and is still writing.
    const resume = pausedReply(browser, 'The roadmap has three milestones')

    await user.type(composer(), 'What is on the roadmap?{Enter}')

    const question = await conversation().findByText('What is on the roadmap?')
    const reply = await screen.findByText(/^The roadmap/)
    expect(reply).not.toHaveTextContent('milestones')
    expect(comesBefore(question, reply)).toBe(true)
    expect(composer()).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Stop' })).toBeVisible()

    resume()
    expect(await screen.findByText('The roadmap has three milestones')).toBeVisible()
    await answered()
  })

  // UC-NOTICO-AGENT-001-S16 itself stays ai-e2e: whether the model answers from the note, without a tool, is its
  // own judgment. This is the panel's part of it.
  it('a question goes to the model with a note naming the open page, and the panel shows only what the user typed', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ reply: 'You are on "Fixture page".' })

    await ask(user, 'Which page am I on?')

    expect(await screen.findByText('You are on "Fixture page".')).toBeVisible()
    await answered()
    const sent = browser.sentToModel().at(-1)!
    expect(sent.content).toContain(`[The Notion page open in the current tab: "Fixture page", ${PAGE_URL}]`)
    expect(sent.content).toContain('Which page am I on?')
    // What the user typed is shown, not the note the extension added.
    expect(screen.queryByText(/The Notion page open in the current tab/)).not.toBeInTheDocument()
    // Telling the model which page is open asks nothing of Notion.
    expect(browser.tab.sent).toEqual([])
  })

  it('[UC-NOTICO-AGENT-001-S22] a reply says in words what a tool did and on what, and on request the tool, its input, and its result', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push(
      { toolCalls: [{ name: 'read_page', arguments: JSON.stringify({ part: 1 }) }] },
      { reply: 'It is a fixture.' },
    )

    await ask(user, 'What does this page say?')
    const answer = await screen.findByText('It is a fixture.')
    await answered()

    // What it did, by the name of the page it read.
    const page = screen.getByText('Fixture page', { selector: 'em' })
    const tool = page.closest('summary')!
    expect(tool).toHaveTextContent(/^Read Fixture page$/)
    expect(screen.getByRole('img', { name: 'Done' })).toBeVisible()
    // In the order it happened: the tool ran before the answer.
    expect(comesBefore(tool, answer)).toBe(true)
    // Its own terms stay folded away until the user asks for them.
    expect(screen.getByText('read_page')).not.toBeVisible()

    await user.click(tool)
    expect(screen.getByText('read_page')).toBeVisible()
    expect(screen.getByText('Arguments')).toBeVisible()
    expect(screen.getByText(/"part": 1/)).toBeVisible()
    expect(screen.getByText('Result')).toBeVisible()
    expect(screen.getByText(/Hello \*\*bold\*\*/)).toBeVisible()
  })

  it('[UC-NOTICO-AGENT-001-S22] a tool that failed says so in words, with its error on request', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push(
      { toolCalls: [{ name: 'read_page', arguments: JSON.stringify({ page: 'my notes' }) }] },
      { reply: 'I could not read it.' },
    )

    await ask(user, 'Read my notes')
    await screen.findByText('I could not read it.')
    await answered()

    const tool = screen.getByText("Couldn't read a page")
    expect(tool).toBeVisible()
    expect(screen.getByRole('img', { name: 'Failed' })).toBeVisible()
    await user.click(tool)
    expect(screen.getByText('Error')).toBeVisible()
    expect(screen.getByText('Not a Notion page URL or id: my notes')).toBeVisible()
  })

  it('a call with no arguments shows none', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push(
      { toolCalls: [{ name: 'get_selection', arguments: '{}' }] },
      { reply: 'Nothing is selected.' },
    )

    await ask(user, 'What did I select?')
    await answered()

    // The fake tab has nothing selected to give, so the call fails; it has no arguments either way.
    await user.click(screen.getByText("Couldn't read the selection"))
    expect(screen.getByText('get_selection')).toBeVisible()
    expect(screen.queryByText('Arguments')).not.toBeInTheDocument()
  })
})

describe('a formatted reply', () => {
  it('[UC-NOTICO-CHAT-001-S16] the reply is shown formatted, and the question as typed', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({
      reply: [
        '## Shopping',
        'You need **milk** and `eggs`, *today*:',
        '1. milk\n   - whole\n2. eggs',
        '- [x] bread',
        '> Buy early.',
        '---',
        '| Item | Count |\n| --- | --- |\n| milk | 2 |',
        '```\nlist = [milk, eggs]\n```',
        'See [the store](https://shop.example.com/list).',
      ].join('\n\n'),
    })

    await ask(user, 'What do I **need**?')
    const heading = await screen.findByRole('heading', { level: 2, name: 'Shopping' })
    await answered()

    // The question stays as the user typed it.
    expect(conversation().getByText('What do I **need**?')).toBeVisible()
    expect(heading).toBeVisible()
    expect(screen.getByText('milk', { selector: 'strong' })).toBeVisible()
    expect(screen.getByText('eggs', { selector: 'code' })).toBeVisible()
    expect(screen.getByText('today', { selector: 'em' })).toBeVisible()
    expect(screen.getByRole('separator')).toBeInTheDocument()
    // The reply's own lists; the question's list of pages has a name.
    const lists = screen.getAllByRole('list', { name: '' })
    expect(within(lists[0]).getByText('whole')).toBeVisible()
    expect(screen.getByRole('checkbox', { name: '' })).toBeChecked()
    expect(screen.getByText('Buy early.').closest('blockquote')).not.toBeNull()
    const table = screen.getByRole('table')
    expect(within(table).getByRole('columnheader', { name: 'Count' })).toBeVisible()
    expect(within(table).getByRole('cell', { name: '2' })).toBeVisible()
    expect(screen.getByText('list = [milk, eggs]').closest('pre')).not.toBeNull()
    const link = screen.getByRole('link', { name: 'the store' })
    expect(link).toHaveAttribute('href', 'https://shop.example.com/list')
    expect(link).toHaveAttribute('target', '_blank')
    // None of the Markdown's own characters are left on screen.
    expect(screen.queryByText(/\*\*milk\*\*|## Shopping|\| Item/)).not.toBeInTheDocument()
  })

  it('[UC-NOTICO-CHAT-001-S16] a single line break in a reply stays a line break', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ reply: 'Owner: Ana\nDue: Friday' })

    await ask(user, 'Who owns it?')
    const owner = await screen.findByText(/Owner: Ana/)
    await answered()

    expect(owner.querySelector('br')).not.toBeNull()
  })

  it('a reply still coming in is formatted as it streams, an unclosed code block included', async () => {
    const { browser, user } = await openPanel()
    const resume = pausedReply(browser, 'Run:\n\n```\nnpm test now\n```\n\nThen wait.')

    await ask(user, 'How do I test?')

    // The first two words are in: the code block has started and is not closed yet.
    const code = await screen.findByText(/^npm/)
    expect(code.closest('pre')).not.toBeNull()
    expect(screen.queryByText(/```/)).not.toBeInTheDocument()

    resume()
    expect(await screen.findByText('Then wait.')).toBeVisible()
    await answered()
    expect(screen.getByText('npm test now').closest('pre')).not.toBeNull()
  })

  it('[UC-NOTICO-CHAT-001-S17] HTML in a reply is shown as text, and only web links can be followed', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({
      reply: 'Look: <b onclick="alert(1)">bold</b>\n\n[run](javascript:alert(1)) and [mail](mailto:a@example.com)',
    })

    await ask(user, 'Show me')
    await screen.findByText(/Look:/)
    await answered()

    const reply = screen.getByText(/Look:/)
    expect(reply).toHaveTextContent('Look: <b onclick="alert(1)">bold</b>')
    expect(reply.querySelector('b')).toBeNull()
    // Links that are not http or https are shown as their text, not as links.
    expect(screen.getByText('run')).toBeVisible()
    expect(screen.getByText('mail')).toBeVisible()
    expect(screen.queryAllByRole('link')).toEqual([])
  })

  it('[UC-NOTICO-CHAT-001-S18] an image in a reply is not loaded: its description links to it instead', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ reply: 'Here is the chart: ![Sales by month](https://images.example.com/chart.png)' })

    await ask(user, 'Show the chart')
    await screen.findByText(/Here is the chart/)
    await answered()

    expect(within(screen.getByText(/Here is the chart/)).queryByRole('img')).toBeNull()
    // Nothing on the page asks for the image's address.
    expect(document.querySelector('[src*="images.example.com"]')).toBeNull()
    expect(screen.getByRole('link', { name: 'Sales by month' })).toHaveAttribute(
      'href',
      'https://images.example.com/chart.png',
    )
  })

  it('[UC-NOTICO-CHAT-001-S18] an image inside a link is shown as its description, and the link goes where it says', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({
      reply: 'Status: [![Build passing](https://img.example.com/b.svg)](https://ci.example.com)',
    })

    await ask(user, 'Show the status')
    await screen.findByText(/Status:/)
    await answered()

    expect(screen.getAllByRole('link')).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Build passing' })).toHaveAttribute('href', 'https://ci.example.com')
    expect(document.querySelector('[src*="img.example.com"]')).toBeNull()
  })
})

describe('on a tab that is not Notion', () => {
  const INBOX = 'https://mail.example.com/inbox?token=secret'

  /** The side panel open on a tab showing another site. */
  function openElsewhere() {
    const tab = new FakeNotionTab(INBOX)
    tab.title = 'Inbox (3)'
    return openPanel(tab)
  }

  /** What the model was sent as the results of the tools it called. */
  const toolResults = (browser: FakeBrowser) =>
    browser
      .sentToModel()
      .filter((m) => m.role === 'tool')
      .map((m) => m.content)

  it('[UC-NOTICO-PANEL-001-S03] a question is answered, and the model is told only that the tab is not a Notion page', async () => {
    const { browser, user } = await openElsewhere()
    browser.ai.script.push({ reply: 'A haiku has three lines.' })

    await ask(user, 'How many lines does a haiku have?')

    expect(await screen.findByText('A haiku has three lines.')).toBeVisible()
    await answered()
    const sent = browser.sentToModel()
    expect(sent.at(-1)!.content).toBe('[The current tab is not a Notion page.]\n\nHow many lines does a haiku have?')
    // Nothing of the tab itself: not its address, and not its title.
    const everything = JSON.stringify(sent)
    expect(everything).not.toContain('mail.example.com')
    expect(everything).not.toContain('Inbox')
    expect(browser.tab.injections).toEqual([])
  })

  it('[UC-NOTICO-PANEL-001-S04] a Notion tool fails there, telling the model to send the user to a Notion page, and Notion is not asked', async () => {
    const { browser, user } = await openElsewhere()
    browser.ai.script.push(
      { toolCalls: [{ name: 'read_page', arguments: JSON.stringify({}) }] },
      { reply: 'Switch to a Notion page and ask again.' },
    )

    await ask(user, 'Summarize this page')

    expect(await screen.findByText('Switch to a Notion page and ask again.')).toBeVisible()
    await answered()
    expect(screen.getByRole('img', { name: 'Failed' })).toBeVisible()
    expect(toolResults(browser)).toEqual([
      expect.stringMatching(/The current tab is not a Notion page.*Tell the user to switch to a Notion page/),
    ])
    // Nothing ran in the tab, so nothing was sent anywhere from it.
    expect(browser.tab.injections).toEqual([])
    expect(browser.tab.sent).toEqual([])
  })

  it('[UC-NOTICO-PANEL-001-S05] the model gets the address and title of a tab on another site when it asks for them', async () => {
    const { browser, user } = await openElsewhere()
    browser.ai.script.push(
      { toolCalls: [{ name: 'get_current_tab', arguments: JSON.stringify({}) }] },
      { reply: 'You are in your inbox.' },
    )

    await ask(user, 'Which site am I on?')

    expect(await screen.findByText('You are in your inbox.')).toBeVisible()
    await answered()
    expect(screen.getByRole('img', { name: 'Done' })).toBeVisible()
    expect(toolResults(browser)).toEqual([JSON.stringify({ title: 'Inbox (3)', url: INBOX })])
    // Only what Chrome says about the tab: nothing ran in it.
    expect(browser.tab.injections).toEqual([])
  })

  it('[UC-NOTICO-PANEL-001-S06] the model gets the address and title of a Notion tab the same way', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push(
      { toolCalls: [{ name: 'get_current_tab', arguments: JSON.stringify({}) }] },
      { reply: 'You are on the fixture page.' },
    )

    await ask(user, 'Give me a link to this tab')

    expect(await screen.findByText('You are on the fixture page.')).toBeVisible()
    await answered()
    expect(toolResults(browser)).toEqual([JSON.stringify({ title: 'Fixture page', url: PAGE_URL })])
    expect(browser.tab.sent).toEqual([])
  })

  it('[UC-NOTICO-PANEL-001-S10] a Notion page open in another tab is never read in place of the current tab', async () => {
    const OTHER = 'https://app.notion.com/p/Other-page-2b2b2b2b000040008000000000000020'
    const tab = pageTab()
    tab.otherTabs = [{ url: OTHER, title: 'Other page' }]
    const { browser, user } = await openPanel(tab)
    const readThisPage = { toolCalls: [{ name: 'read_page', arguments: JSON.stringify({}) }] }
    browser.ai.script.push(readThisPage, { reply: 'It is the fixture page.' })

    await ask(user, 'Summarize this page')
    expect(await screen.findByText('It is the fixture page.')).toBeVisible()
    await answered()
    // The page in the current tab was read, in that tab, and the other tab's page was not.
    expect(toolResults(browser)).toEqual([expect.stringContaining('Fixture page')])
    expect(tab.sent).not.toEqual([])
    expect(tab.injections.map((i) => i.tabId)).toEqual(tab.injections.map(() => 7))
    expect(tab.sent.map((r) => (r.body.page as { id: string }).id)).toEqual(tab.sent.map(() => PAGE))
    expect(JSON.stringify(browser.sentToModel())).not.toContain('Other page')
    const injected = tab.injections.length
    const sent = tab.sent.length

    // The user moves to another site; both Notion pages are now in tabs behind it.
    act(() => tab.switchTab(INBOX, 'Inbox (3)'))
    tab.otherTabs = [
      { url: PAGE_URL, title: 'Fixture page' },
      { url: OTHER, title: 'Other page' },
    ]
    browser.ai.script.push(readThisPage, { reply: 'Switch to a Notion page and ask again.' })
    await ask(user, 'Summarize this page')
    expect(await screen.findByText('Switch to a Notion page and ask again.')).toBeVisible()
    await answered()
    expect(toolResults(browser).at(-1)).toMatch(/The current tab is not a Notion page.*Tell the user to switch/)
    // Nothing ran in any tab, so nothing was asked of Notion.
    expect(tab.injections).toHaveLength(injected)
    expect(tab.sent).toHaveLength(sent)
  })

  // UC-NOTICO-PANEL-001-S07 itself stays ai-e2e: that Chrome keeps the panel open across tabs. This is
  // the panel's part of it.
  it('a conversation started on a Notion page goes on after the user switches to another site', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ reply: 'It is a fixture.' }, { reply: 'You left Notion.' })

    await ask(user, 'What is this page?')
    await screen.findByText('It is a fixture.')
    await answered()
    act(() => browser.tab.switchTab(INBOX, 'Inbox (3)'))
    // No page to send on another site.
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Pages to send' })).not.toBeInTheDocument())
    await ask(user, 'And now?')

    expect(await screen.findByText('You left Notion.')).toBeVisible()
    await answered()
    expect(conversation().getByText('What is this page?')).toBeVisible()
    expect(
      browser
        .sentToModel()
        .filter((m) => m.role === 'user')
        .map((m) => m.content),
    ).toEqual([
      `[The Notion page open in the current tab: "Fixture page", ${PAGE_URL}]\n\nWhat is this page?`,
      '[The current tab is not a Notion page.]\n\nAnd now?',
    ])
  })
})

describe('the page a question goes with', () => {
  const ROADMAP = '2b2b2b2b-0000-4000-8000-000000000020'
  const ROADMAP_URL = `https://app.notion.com/p/Roadmap-${ROADMAP.replace(/-/g, '')}`
  const INBOX = 'https://mail.example.com/inbox'
  /** The pages the composer will send the question with, if it shows any. */
  const toSend = () => screen.queryByRole('list', { name: 'Pages to send' })
  const sentQuestions = (browser: FakeBrowser) =>
    browser
      .sentToModel()
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
  /** The lists of pages the conversation's questions went with, each as the titles it shows. */
  const pagesSent = () =>
    conversation()
      .queryAllByRole('list', { name: 'Pages sent' })
      .map((list) =>
        within(list)
          .getAllByRole('listitem')
          .map((li) => li.textContent),
      )

  it('[UC-NOTICO-AGENT-001-S27] the message box shows the open page, and follows the tab', async () => {
    const { browser } = await openPanel()

    const shown = await screen.findByRole('list', { name: 'Pages to send' })
    expect(within(shown).getByText('Fixture page')).toBeVisible()
    expect(within(shown).getByRole('button', { name: 'Remove Fixture page' })).toBeVisible()

    act(() => browser.tab.navigate(ROADMAP_URL, 'Roadmap | Notion'))
    expect(await within(toSend()!).findByText('Roadmap')).toBeVisible()
    expect(within(toSend()!).queryByText('Fixture page')).not.toBeInTheDocument()

    // Chrome swapping in a prerendered tab for a navigation.
    act(() => browser.tab.replaceTab(PAGE_URL, 'Fixture page'))
    expect(await within(toSend()!).findByText('Fixture page')).toBeVisible()

    act(() => browser.tab.switchTab(INBOX, 'Inbox'))
    await waitFor(() => expect(toSend()).not.toBeInTheDocument())
    expect(screen.queryByText('Inbox')).not.toBeInTheDocument()

    // Only Chrome's word for the tab: nothing was asked of Notion.
    expect(browser.tab.injections).toEqual([])
  })

  it('[UC-NOTICO-AGENT-001-S26] a question sent without the open page does not name it, and the agent cannot read it in its place', async () => {
    const { browser, user } = await openPanel()
    const change = { action: 'add_property', property: 'Owner', type: 'text' }
    browser.ai.script.push(
      {
        toolCalls: [
          { name: 'read_page', arguments: '{}' },
          { name: 'read_comments', arguments: '{}' },
          { name: 'query_database', arguments: '{}' },
          { name: 'update_database_schema', arguments: JSON.stringify({ changes: [change] }) },
          { name: 'get_selection', arguments: '{}' },
          { name: 'get_current_tab', arguments: '{}' },
        ],
      },
      { reply: 'Which page do you mean?' },
    )

    await user.click(await screen.findByRole('button', { name: 'Remove Fixture page' }))
    expect(toSend()).not.toBeInTheDocument()
    expect(composer()).toHaveFocus()
    await ask(user, 'Summarize it')

    expect(await screen.findByText('Which page do you mean?')).toBeVisible()
    await answered()
    const [question] = sentQuestions(browser)
    expect(question).toMatch(/^\[No Notion page is attached to this question.*\]\n\nSummarize it$/)
    // Each call that would have used the open page was refused, before anything was asked of Notion.
    const results = browser
      .sentToModel()
      .filter((m) => m.role === 'tool')
      .map((m) => m.content)
    expect(results).toHaveLength(6)
    for (const result of results) expect(result).toMatch(/No page is attached.*Ask the user which page.*or search/)
    const everything = JSON.stringify(browser.sentToModel())
    expect(everything).not.toContain('Fixture page')
    expect(everything).not.toContain(PAGE.replace(/-/g, ''))
    expect(browser.tab.sent).toEqual([])
    expect(browser.tab.injections).toEqual([])
    // The question went with no page, and says so by showing none.
    expect(pagesSent()).toEqual([])
  })

  it('with a page taken off, a tab on another site is looked up and Notion tools say to switch to Notion, as without it', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push(
      {
        toolCalls: [
          { name: 'get_current_tab', arguments: '{}' },
          { name: 'read_page', arguments: '{}' },
        ],
      },
      { reply: 'Saved the link.' },
    )

    await user.click(await screen.findByRole('button', { name: 'Remove Fixture page' }))
    await act(async () => browser.tab.switchTab(INBOX, 'Inbox'))
    await ask(user, 'Save a link to this site')

    expect(await screen.findByText('Saved the link.')).toBeVisible()
    await answered()
    const results = browser
      .sentToModel()
      .filter((m) => m.role === 'tool')
      .map((m) => m.content)
    expect(results).toEqual([
      JSON.stringify({ title: 'Inbox', url: INBOX }),
      expect.stringMatching(/The current tab is not a Notion page.*Tell the user to switch to a Notion page/),
    ])
    expect(browser.tab.injections).toEqual([])
  })

  it('[UC-NOTICO-AGENT-001-S28] a page taken off stays off for the chat until the user goes to another page or starts a new chat', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ reply: 'One.' }, { reply: 'Two.' })
    const leftOut = /^\[No Notion page is attached to this question/

    await user.click(await screen.findByRole('button', { name: 'Remove Fixture page' }))
    await ask(user, 'First?')
    await screen.findByText('One.')
    await answered()
    expect(toSend()).not.toBeInTheDocument()
    await ask(user, 'Second?')
    await screen.findByText('Two.')
    await answered()
    expect(sentQuestions(browser)).toEqual([expect.stringMatching(leftOut), expect.stringMatching(leftOut)])

    // A tab on another site doesn't count as another page: back on this one, it is still off.
    await act(async () => browser.tab.switchTab(INBOX, 'Inbox'))
    await act(async () => browser.tab.switchTab(PAGE_URL, 'Fixture page'))
    expect(toSend()).not.toBeInTheDocument()
    browser.ai.script.push({ reply: 'Again.' })
    await ask(user, 'Again?')
    await screen.findByText('Again.')
    await answered()
    expect(sentQuestions(browser).at(-1)).toMatch(leftOut)

    // Another page brings its chip, and coming back brings this one's.
    act(() => browser.tab.navigate(ROADMAP_URL, 'Roadmap'))
    expect(await screen.findByRole('button', { name: 'Remove Roadmap' })).toBeVisible()
    act(() => browser.tab.navigate(PAGE_URL, 'Fixture page'))
    expect(await screen.findByRole('button', { name: 'Remove Fixture page' })).toBeVisible()

    // A new chat does too.
    await user.click(screen.getByRole('button', { name: 'Remove Fixture page' }))
    await user.click(screen.getByRole('button', { name: 'New chat' }))
    expect(await screen.findByRole('button', { name: 'Remove Fixture page' })).toBeVisible()
    browser.ai.script.push({ reply: 'Three.' })
    await ask(user, 'Third?')
    await screen.findByText('Three.')
    await answered()
    expect(sentQuestions(browser)).toEqual([
      `[The Notion page open in the current tab: "Fixture page", ${PAGE_URL}]\n\nThird?`,
    ])
  })

  it('[UC-NOTICO-AGENT-001-S29] a question shows the page it went with, also after the session is reopened', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ reply: 'With the page.' }, { reply: 'Without it.' })

    await ask(user, 'With?')
    await screen.findByText('With the page.')
    await answered()
    await user.click(screen.getByRole('button', { name: 'Remove Fixture page' }))
    await ask(user, 'Without?')
    await screen.findByText('Without it.')
    await answered()

    // One list, shown with the first question: after it and before the second.
    const shows = () => {
      expect(pagesSent()).toEqual([['Fixture page']])
      const list = conversation().getByRole('list', { name: 'Pages sent' })
      expect(comesBefore(conversation().getByText('With?'), list)).toBe(true)
      expect(comesBefore(list, conversation().getByText('Without?'))).toBe(true)
    }
    shows()

    // Reopened in a new panel, on another site.
    browser.tab.url = INBOX
    await browser.openPanel()
    await user.click(screen.getByRole('button', { name: 'Chats' }))
    await user.click(await sessionList().findByRole('button', { name: /^With\?/ }))
    await conversation().findByText('With?')
    shows()
  })
})

describe('a tool that needs confirmation', () => {
  async function askToTrash() {
    const { tab, workspace } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    browser.ai.script.push({ toolCalls: [{ name: 'trash_page', arguments: JSON.stringify({ pages: [NOTE] }) }] })
    await ask(user, 'Delete the old notes')
    const prompt = await screen.findByRole('group', { name: 'Allow this? Move 1 page to the trash' })
    return { browser, user, workspace, prompt }
  }

  it('[UC-NOTICO-AGENT-001-S11] asks first, showing what the tool will do, and runs it only after the user agrees', async () => {
    const { browser, user, workspace, prompt } = await askToTrash()
    browser.ai.script.push({ reply: 'The old notes are in the trash.' })

    // The user sees which page would go, by the name Notion has for it now.
    expect(screen.getByText(/Move 1 page to the trash, with everything in it/)).toBeVisible()
    expect(screen.getByText(/"Old notes"/)).toBeVisible()
    expect(screen.getByRole('img', { name: 'Waiting for your OK' })).toBeVisible()
    // Nothing has changed, and the model has not been asked again.
    expect(workspace.transactions).toEqual([])
    expect(workspace.records.get(NOTE)).toMatchObject({ alive: true })
    expect(browser.ai.calls).toHaveLength(1)

    await user.click(within(prompt).getByRole('button', { name: 'Allow' }))

    expect(await screen.findByText('The old notes are in the trash.')).toBeVisible()
    await answered()
    expect(workspace.records.get(NOTE)).toMatchObject({ alive: false })
    expect(screen.getByRole('img', { name: 'Done' })).toBeVisible()
    expect(screen.queryByRole('group', { name: 'Allow this? Move 1 page to the trash' })).not.toBeInTheDocument()
  })

  it('[UC-NOTICO-AGENT-001-S24] a reply says how many pages it changed', async () => {
    const first = await askToTrash()
    first.browser.ai.script.push({ reply: 'Done.' })
    await first.user.click(within(first.prompt).getByRole('button', { name: 'Allow' }))
    await screen.findByText('Done.')
    await answered()
    expect(await replyDetails(first.user)).toContain('Changed 1 page')
  })

  it('[UC-NOTICO-AGENT-001-S24] a change the user declined is not counted as changed', async () => {
    const { browser, user, prompt } = await askToTrash()
    browser.ai.script.push({ reply: 'Left it.' })
    await user.click(within(prompt).getByRole('button', { name: 'Deny' }))
    await screen.findByText('Left it.')
    await answered()
    expect((await replyDetails(user)).join('\n')).not.toMatch(/Changed \d+ page/)
  })

  it('[UC-NOTICO-AGENT-001-S11] does not run the tool when the user declines, and the agent goes on without it', async () => {
    const { browser, user, workspace, prompt } = await askToTrash()
    browser.ai.script.push({ reply: 'I left the old notes where they are.' })

    await user.click(within(prompt).getByRole('button', { name: 'Deny' }))

    expect(await screen.findByText('I left the old notes where they are.')).toBeVisible()
    await answered()
    expect(workspace.transactions).toEqual([])
    expect(workspace.records.get(NOTE)).toMatchObject({ alive: true })
    expect(screen.getByRole('img', { name: 'Declined' })).toBeVisible()
    expect(browser.sentToModel().at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('declined') })
  })
})

describe('sessions', () => {
  /** Asks a question the agent answers by reading the open page. */
  async function askAboutPage(browser: FakeBrowser, user: UserEvent) {
    browser.ai.script.push(
      { toolCalls: [{ name: 'read_page', arguments: JSON.stringify({ part: 1 }) }] },
      { reply: 'It is a fixture.' },
    )
    await ask(user, 'What does this page say?')
    await screen.findByText('It is a fixture.')
    await answered()
  }

  async function openSession(user: UserEvent, title: RegExp) {
    await user.click(screen.getByRole('button', { name: 'Chats' }))
    await user.click(await screen.findByRole('button', { name: title }))
  }

  it('[UC-NOTICO-SESSION-001-S06] a reopened session shows its tool calls, and a follow-up continues it', async () => {
    const { browser, user } = await openPanel()
    await askAboutPage(browser, user)

    // The next day, the side panel is opened again.
    vi.setSystemTime(new Date(START.getTime() + 24 * 60 * 60 * 1000))
    await browser.openPanel()
    expect(screen.queryByText('What does this page say?')).not.toBeInTheDocument()
    await openSession(user, /What does this page say\?/)

    const question = await conversation().findByText('What does this page say?')
    const tool = screen.getByText('Fixture page', { selector: 'em' }).closest('summary')!
    const answer = screen.getByText('It is a fixture.')
    expect(comesBefore(question, tool)).toBe(true)
    expect(comesBefore(tool, answer)).toBe(true)
    expect(screen.getByRole('img', { name: 'Done' })).toBeVisible()
    await user.click(tool)
    expect(screen.getByText(/Hello \*\*bold\*\*/)).toBeVisible()

    browser.ai.script.push({ reply: 'Its first heading is "Fixture page".' })
    await ask(user, 'And its first heading?')

    expect(await screen.findByText('Its first heading is "Fixture page".')).toBeVisible()
    await answered()
    // The model got the earlier conversation, with the tool call and what it returned, then the new question.
    expect(browser.sentToModel()).toMatchObject([
      { role: 'system' },
      { role: 'user', content: expect.stringContaining('What does this page say?') },
      { role: 'assistant', tool_calls: [{ function: { name: 'read_page' } }] },
      { role: 'tool', content: expect.stringContaining('Hello **bold**') },
      { role: 'assistant', content: expect.stringContaining('It is a fixture.') },
      { role: 'user', content: expect.stringContaining('And its first heading?') },
    ])
  })

  it('[UC-NOTICO-SESSION-001-S20] sessions stay after signing out, and are there again after signing back in', async () => {
    const { browser, user } = await openPanel()
    await askAboutPage(browser, user)

    await user.click(screen.getByRole('button', { name: 'Account' }))
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }))
    expect(await screen.findByText('Sign in to use Notico.')).toBeVisible()
    await browser.signInAgain()

    await openSession(user, /What does this page say\?/)
    expect(await conversation().findByText('What does this page say?')).toBeVisible()
    expect(screen.getByText('It is a fixture.')).toBeVisible()
  })

  it('[UC-NOTICO-AGENT-001-S22] an edit names the page it changed, also after the session is reopened', async () => {
    const { browser, user } = await openPanel(workspaceTab().tab)
    browser.ai.script.push(
      { toolCalls: [{ name: 'read_page', arguments: JSON.stringify({ page: PAGE }) }] },
      {
        toolCalls: [
          {
            name: 'edit_page',
            arguments: JSON.stringify({
              page: PAGE,
              edits: [{ action: 'insert', position: 'end', markdown: 'A new line' }],
            }),
          },
        ],
      },
      { reply: 'Added it.' },
    )

    await ask(user, 'Add a line')
    await screen.findByText('Added it.')
    await answered()

    // Each tool call as the reply says it, in order.
    const said = () => screen.getAllByText((_, el) => el?.tagName === 'SUMMARY').map((s) => s.textContent?.trim())
    expect(said()).toEqual(['Read Fixture page', 'Edited Fixture page'])

    await browser.openPanel()
    await openSession(user, /Add a line/)
    await screen.findByText('Added it.')
    expect(said()).toEqual(['Read Fixture page', 'Edited Fixture page'])
  })

  it('[UC-NOTICO-AGENT-001-S23][UC-NOTICO-AGENT-001-S25] a reply shows the pages it read, and its details the Notion requests, tokens, and model, also after the session is reopened', async () => {
    const { browser, user } = await openPanel()
    // Each model call reports 1,200 input tokens, 800 of them cached, and 50 output tokens.
    browser.ai.usage = { prompt_tokens: 1200, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } }
    await askAboutPage(browser, user)

    const made = browser.tab.sent.length
    expect(made).toBeGreaterThan(0)
    // The row under the reply stays quiet: what it read is in its details, first.
    expect(screen.queryByText(/Read 1 page|Notion request/)).not.toBeInTheDocument()
    // Both model calls of the question, and not the request for the session's title.
    const details = [
      'Read 1 page',
      `Sent ${made} Notion request${made === 1 ? '' : 's'}`,
      'Tokens: 2.4k in (1.6k cached) · 100 out',
    ]
    expect(await replyDetails(user)).toEqual(details)
    // The model that answered is named in the reply's row.
    expect(screen.getByRole('note', { name: 'Answered by Auto' })).toBeVisible()

    await browser.openPanel()
    await openSession(user, /What does this page say\?/)

    await screen.findByText('It is a fixture.')
    expect(await replyDetails(user)).toEqual(details)
    expect(screen.getByRole('note', { name: 'Answered by Auto' })).toBeVisible()
    // Showing a saved session asks nothing of Notion.
    expect(browser.tab.sent).toHaveLength(made)
  })

  it('[UC-NOTICO-CHAT-003-S13] a reply shows what it cost in credits, summed over its model calls, also after the session is reopened', async () => {
    const { browser, user } = await openPanel()
    // Each model call costs 400 new input tokens at 300 micro-credits, 800 cached at 6, and 50 output
    // at 1,200: 184,800 micro-credits. The question's two calls cost 0.37 credits.
    browser.ai.usage = { prompt_tokens: 1200, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } }
    await askAboutPage(browser, user)

    // In the row under the reply, not in its details.
    expect(conversation().getByText('0.37 credits')).toBeVisible()
    expect(await replyDetails(user)).not.toContainEqual(expect.stringMatching(/credit/))

    await browser.openPanel()
    await openSession(user, /What does this page say\?/)
    expect(await conversation().findByText('0.37 credits')).toBeVisible()
  })

  it('[UC-NOTICO-CHAT-003-S14] a reply the user stopped shows no cost', async () => {
    const { browser, user } = await openPanel()
    // The page is read in full; the answer after it stops partway, until the user stops it.
    const words = Array.from({ length: 50 }, (_, n) => `word${n}`).join(' ')
    browser.ai.pause = { after: 1500, until: new Promise<void>(() => {}) }
    browser.ai.script.push(
      { toolCalls: [{ name: 'read_page', arguments: JSON.stringify({ part: 1 }) }] },
      { reply: words },
    )

    await ask(user, 'What does this page say?')
    await screen.findByText(/^word0/)
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    await answered()

    // The call that read the page reported its cost, but the one stopped never hears what it was
    // charged: no number is shown rather than one that is too low.
    expect(screen.getByRole('note', { name: 'Answered by Auto' })).toBeVisible()
    expect(conversation().queryByText(/\bcredits?$/)).not.toBeInTheDocument()
  })

  it("a reply's details close on Escape, on a click outside, and when pressed again", async () => {
    const { browser, user } = await openPanel()
    await askAboutPage(browser, user)
    const button = screen.getByRole('button', { name: 'Reply details' })
    const popover = () => screen.queryByRole('dialog', { name: 'Reply details' })

    await user.click(button)
    expect(popover()).toBeVisible()
    expect(button).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{Escape}')
    expect(popover()).not.toBeInTheDocument()
    expect(button).toHaveFocus()

    await user.click(button)
    await user.click(screen.getByText('It is a fixture.'))
    expect(popover()).not.toBeInTheDocument()

    await user.click(button)
    await user.click(button)
    expect(popover()).not.toBeInTheDocument()
    expect(button).toHaveAttribute('aria-expanded', 'false')
  })

  it('[UC-NOTICO-AGENT-001-S23] a page read twice for a question counts once', async () => {
    const { browser, user } = await openPanel(workspaceTab().tab)
    browser.ai.script.push(
      { toolCalls: [{ name: 'read_page', arguments: JSON.stringify({}) }] },
      { toolCalls: [{ name: 'read_page', arguments: JSON.stringify({ page: NOTE }) }] },
      { toolCalls: [{ name: 'read_page', arguments: JSON.stringify({ page: PAGE_URL }) }] },
      { reply: 'Read them.' },
    )

    await ask(user, 'Read this page and its child, then this page again')
    await screen.findByText('Read them.')
    await answered()

    expect(await replyDetails(user)).toContain('Read 2 pages')
  })

  it('[UC-NOTICO-CHAT-001-S19] copying a reply puts its Markdown on the clipboard, without its tool calls or what it read', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push(
      { reply: 'Let me look.', toolCalls: [{ name: 'read_page', arguments: JSON.stringify({ part: 1 }) }] },
      { reply: 'It has **two** items:\n\n- One\n- Two' },
    )

    await ask(user, 'What does this page say?')
    await answered()
    await user.click(screen.getByRole('button', { name: 'Copy reply' }))

    expect(await navigator.clipboard.readText()).toBe('Let me look.\n\nIt has **two** items:\n\n- One\n- Two')
    expect(screen.getByRole('button', { name: 'Copied' })).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('Copied')
  })

  it('a reply cannot be copied until it has ended', async () => {
    const { browser, user } = await openPanel()
    const resume = pausedReply(browser, 'The roadmap has three milestones')

    await ask(user, 'What is on the roadmap?')
    await screen.findByText(/The roadmap/)
    expect(screen.queryByRole('button', { name: 'Copy reply' })).not.toBeInTheDocument()

    resume()
    await answered()
    expect(screen.getByRole('button', { name: 'Copy reply' })).toBeVisible()
  })

  it('says so when the clipboard refuses the reply', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ reply: 'Hello.' })
    await ask(user, 'Hi')
    await answered()
    // The browser's clipboard, refusing: as when the panel has lost focus.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new DOMException('Document is not focused.', 'NotAllowedError')) },
    })

    await user.click(screen.getByRole('button', { name: 'Copy reply' }))

    expect(await screen.findByRole('button', { name: "Couldn't copy" })).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent("Couldn't copy the reply")
  })

  it('a reply that used no Notion tool says nothing about Notion under it', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ reply: 'Hello.' })

    await ask(user, 'Hi')
    await screen.findByText('Hello.')
    await answered()

    expect(screen.queryByText(/Read \d+ page|Changed \d+ page/)).not.toBeInTheDocument()
    // It sent nothing to Notion, so its details say only what the model used.
    expect(await replyDetails(user)).toEqual(['Tokens: 12 in · 5 out'])
    // The model that answered is in the reply's row, outside its details.
    expect(screen.getByRole('note', { name: 'Answered by Auto' })).toHaveTextContent('Auto')
  })

  it('[UC-NOTICO-SESSION-001-S07] opening the side panel starts a new, empty session, with the earlier ones in the list', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ reply: 'Three milestones.' }, { reply: 'Alice.' })
    await ask(user, 'What is on the roadmap?')
    await screen.findByText('Three milestones.')
    await answered()
    vi.setSystemTime(new Date(START.getTime() + 60_000))
    await user.click(screen.getByRole('button', { name: 'New chat' }))
    await ask(user, 'Who owns the launch?')
    await screen.findByText('Alice.')
    await answered()

    vi.setSystemTime(new Date(START.getTime() + 120_000))
    await browser.openPanel()

    expect(await screen.findByRole('list', { name: 'Suggestions' })).toBeVisible()
    expect(screen.queryByText('Who owns the launch?')).not.toBeInTheDocument()
    expect(composer()).toHaveValue('')

    await user.click(screen.getByRole('button', { name: 'Chats' }))
    const sessions = await within(await screen.findByRole('dialog', { name: 'Chats' })).findAllByRole('button', {
      name: /Fixture page/,
    })
    // Most recently used first, each with its first question and the page it started on.
    expect(sessions.map((s) => s.textContent)).toEqual([
      expect.stringMatching(/^Who owns the launch\?Fixture page/),
      expect.stringMatching(/^What is on the roadmap\?Fixture page/),
    ])

    // A question asked now starts a session of its own: nothing of the earlier ones goes to the model.
    await user.click(screen.getByRole('button', { name: 'Close' }))
    browser.ai.script.push({ reply: 'Hello.' })
    await ask(user, 'Hi')
    await screen.findByText('Hello.')
    await answered()
    expect(browser.sentToModel().map((m) => m.role)).toEqual(['system', 'user'])
  })

  it('[UC-NOTICO-SESSION-001-S14] after its first reply, a session is titled by the model, found by that title, and keeps it', async () => {
    const { browser, user } = await openPanel()
    browser.titles.failWith = undefined
    // Quotes and a full stop the model adds anyway are dropped.
    browser.titles.script.push({ reply: '"Roadmap milestones overview."' })
    browser.ai.script.push({ reply: 'Three milestones.' }, { reply: 'Alice.' })
    await ask(user, 'What is on the roadmap?')
    await screen.findByText('Three milestones.')
    await answered()

    await user.click(screen.getByRole('button', { name: 'Chats' }))
    const rows = () =>
      sessionList()
        .queryAllByRole('button', { name: /Fixture page/ })
        .map((b) => b.textContent)
    await waitFor(() => expect(rows()).toEqual([expect.stringMatching(/^Roadmap milestones overviewFixture page/)]))
    // One request, without tools, with the first question and the start of the reply; it went
    // through the worker, which charges it like any other.
    expect(browser.titles.calls).toHaveLength(1)
    const { inputs } = browser.titles.calls[0]
    expect(inputs.tools).toBeUndefined()
    expect(inputs.messages).toEqual([
      { role: 'system', content: expect.stringContaining('title') },
      {
        role: 'user',
        content: expect.stringMatching(/What is on the roadmap\?[\s\S]*Three milestones\./),
      },
    ])
    expect(browser.sentToWorker.filter((sent) => sent.includes('/v1/chat/completions'))).toHaveLength(2)

    // The list search matches the title, not the question it replaced.
    await user.type(screen.getByRole('searchbox', { name: 'Search chats' }), 'MILESTONES')
    expect(rows()).toHaveLength(1)
    await user.clear(screen.getByRole('searchbox'))
    await user.type(screen.getByRole('searchbox'), 'What is on')
    expect(rows()).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Close' }))

    // A follow-up does not ask again, and the title stays, also in a panel opened later.
    browser.titles.script.push({ reply: 'Launch owner' })
    await ask(user, 'Who owns the launch?')
    await screen.findByText('Alice.')
    await answered()
    await browser.openPanel()
    await openSession(user, /^Roadmap milestones overview/)
    browser.ai.script.push({ reply: 'Next week.' })
    await ask(user, 'When is it?')
    await screen.findByText('Next week.')
    await answered()
    await user.click(screen.getByRole('button', { name: 'Chats' }))
    await waitFor(() => expect(rows()).toEqual([expect.stringMatching(/^Roadmap milestones overviewFixture page/)]))
    expect(browser.titles.calls).toHaveLength(1)
  })

  it('[UC-NOTICO-SESSION-001-S15] a session whose title request fails, or gives no title, keeps its first question, with no error shown', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ reply: 'Three milestones.' }, { reply: 'Alice.' })
    // The title model fails.
    await ask(user, 'What is on the roadmap?')
    await screen.findByText('Three milestones.')
    await answered()
    // The first title request has failed before the title model is scripted for the second session.
    await waitFor(() => expect(browser.titles.calls).toHaveLength(1))
    vi.setSystemTime(new Date(START.getTime() + 60_000))

    // It answers with more than a title.
    browser.titles.failWith = undefined
    browser.titles.script.push({ reply: 'Here is a title:\n\nLaunch owner' })
    await user.click(screen.getByRole('button', { name: 'New chat' }))
    await ask(user, 'Who owns the launch?')
    await screen.findByText('Alice.')
    await answered()

    await waitFor(() => expect(browser.titles.calls).toHaveLength(2))
    await user.click(screen.getByRole('button', { name: 'Chats' }))
    const rows = () =>
      sessionList()
        .queryAllByRole('button', { name: /Fixture page/ })
        .map((b) => b.textContent)
    await waitFor(() =>
      expect(rows()).toEqual([
        expect.stringMatching(/^Who owns the launch\?Fixture page/),
        expect.stringMatching(/^What is on the roadmap\?Fixture page/),
      ]),
    )
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText(/title/i)).not.toBeInTheDocument()
    // The chat goes on.
    browser.ai.script.push({ reply: 'Next week.' })
    await ask(user, 'When is the launch?')
    expect(await screen.findByText('Next week.')).toBeVisible()
  })

  it('[UC-NOTICO-SESSION-001-S16] the header shows the open session\'s title, or "New chat" before its first question', async () => {
    const { browser, user } = await openPanel()
    const title = () => screen.getByRole('heading', { level: 1 })
    expect(title()).toHaveTextContent(/^New chat$/)

    browser.titles.failWith = undefined
    browser.titles.script.push({ reply: 'Roadmap milestones' }, { reply: 'Launch owner' })
    browser.ai.script.push({ reply: 'Three milestones.' }, { reply: 'Alice.' })
    await ask(user, 'What is   on the\nroadmap?')
    // Right away, before the reply, and on one line.
    expect(title()).toHaveTextContent(/^What is on the roadmap\?$/, { normalizeWhitespace: false })
    await screen.findByText('Three milestones.')
    await answered()
    // Then the title the model wrote.
    await waitFor(() => expect(title()).toHaveTextContent(/^Roadmap milestones$/))

    vi.setSystemTime(new Date(START.getTime() + 60_000))
    await user.click(screen.getByRole('button', { name: 'New chat' }))
    expect(title()).toHaveTextContent(/^New chat$/)
    await ask(user, 'Who owns the launch?')
    await screen.findByText('Alice.')
    await answered()
    await waitFor(() => expect(title()).toHaveTextContent(/^Launch owner$/))

    await openSession(user, /^Roadmap milestones/)
    await screen.findByText('Three milestones.')
    expect(title()).toHaveTextContent(/^Roadmap milestones$/)
  })

  it('the session list closes from its Close button, the Sessions button, or Escape, back to the chat', async () => {
    const { user } = await openPanel()
    const toggle = screen.getByRole('button', { name: 'Chats' })
    const list = () => screen.queryByRole('dialog', { name: 'Chats' })

    await user.click(toggle)
    expect(list()).toBeVisible()
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(list()).not.toBeInTheDocument()
    expect(toggle).toHaveFocus()

    await user.click(toggle)
    await user.click(toggle)
    expect(list()).not.toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    // In the search box, Escape first clears what was typed, then closes the list.
    await user.click(toggle)
    await user.type(screen.getByRole('searchbox'), 'road')
    await user.keyboard('{Escape}')
    expect(list()).toBeVisible()
    await user.clear(screen.getByRole('searchbox'))
    await user.keyboard('{Escape}')
    expect(list()).not.toBeInTheDocument()
    expect(toggle).toHaveFocus()
    expect(composer()).toBeVisible()
  })

  it('the session list is searched by title, and deleting a session takes a second click', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ reply: 'Three milestones.' }, { reply: 'Alice.' })
    await ask(user, 'What is on the roadmap?')
    await screen.findByText('Three milestones.')
    await answered()
    vi.setSystemTime(new Date(START.getTime() + 60_000))
    await user.click(screen.getByRole('button', { name: 'New chat' }))
    await ask(user, 'Who owns the launch?')
    await screen.findByText('Alice.')
    await answered()

    await user.click(screen.getByRole('button', { name: 'Chats' }))
    const rows = () =>
      sessionList()
        .queryAllByRole('button', { name: /Fixture page/ })
        .map((b) => b.textContent)
    await within(await screen.findByRole('dialog', { name: 'Chats' })).findAllByRole('button', {
      name: /Fixture page/,
    })
    // Only search by title: there is no other filter.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    await user.type(screen.getByRole('searchbox', { name: 'Search chats' }), 'ROADMAP')
    expect(rows()).toEqual([expect.stringMatching(/^What is on the roadmap\?/)])
    await user.clear(screen.getByRole('searchbox'))
    expect(rows()).toHaveLength(2)

    // The first click only asks; the second deletes.
    const [first] = screen.getAllByRole('button', { name: 'Delete chat' })
    await user.click(first)
    expect(rows()).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: 'Delete?' }))
    await waitFor(() => expect(rows()).toEqual([expect.stringMatching(/^What is on the roadmap\?/)]))
  })

  /** The chats in the open list, by what each row says, newest first. */
  const listed = () =>
    sessionList()
      .queryAllByRole('button', { name: /Fixture page/ })
      .map((b) => b.textContent)
  /** Each tool call of the conversation as its reply says it, in order. */
  const toolsSaid = () =>
    conversation()
      .queryAllByText((_, el) => el?.tagName === 'SUMMARY')
      .map((s) => s.textContent?.trim())

  /**
   * A model reply long enough to stop partway, until `resume` is called, while the replies before it
   * that only call tools, which are shorter, come in whole.
   */
  const pausedAfterTools = (browser: FakeBrowser, start: string) =>
    pausedReply(browser, `${start} ${Array.from({ length: 200 }, (_, n) => `word${n}`).join(' ')}`, 4000)

  /** Asks a question the agent reads the open page for; its answer stops partway until the returned function is called. */
  async function askAndHoldReply(browser: FakeBrowser, user: UserEvent, question: string) {
    browser.ai.script.push({ toolCalls: [{ name: 'read_page', arguments: JSON.stringify({ part: 1 }) }] })
    const resume = pausedAfterTools(browser, 'Alice owns the launch')
    await ask(user, question)
    await screen.findByText(/^Alice owns/)
    return () => {
      resume()
      browser.ai.pause = undefined
    }
  }

  it('[UC-NOTICO-SESSION-001-S08] switching sessions stops a question, which keeps the tools it used in the session it was asked in', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ reply: 'Three milestones.' })
    await ask(user, 'What is on the roadmap?')
    await screen.findByText('Three milestones.')
    await answered()
    vi.setSystemTime(new Date(START.getTime() + 60_000))
    await user.click(screen.getByRole('button', { name: 'New chat' }))
    const resume = await askAndHoldReply(browser, user, 'Who owns the launch?')

    await openSession(user, /What is on the roadmap\?/)

    // The earlier session is on screen, ready for a question, with nothing of the one that was stopped.
    expect(await screen.findByText('Three milestones.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Send' })).toBeVisible()
    expect(screen.queryByText(/Alice owns/)).not.toBeInTheDocument()
    expect(screen.queryByText('Who owns the launch?')).not.toBeInTheDocument()
    expect(toolsSaid()).toEqual([])

    // Whatever the model still writes for the stopped question goes nowhere.
    resume()
    vi.setSystemTime(new Date(START.getTime() + 120_000))
    browser.ai.script.push({ reply: 'In March.' })
    await ask(user, 'When is the first one?')
    expect(await screen.findByText('In March.')).toBeVisible()
    await answered()
    expect(screen.queryByText(/Alice owns/)).not.toBeInTheDocument()
    expect(JSON.stringify(browser.sentToModel())).not.toContain('launch')

    // The session the question was asked in was saved with it, under the question: a stopped
    // question asks the model for no title.
    await user.click(screen.getByRole('button', { name: 'Chats' }))
    await waitFor(() =>
      expect(listed()).toEqual([
        expect.stringMatching(/^What is on the roadmap\?/),
        expect.stringMatching(/^Who owns the launch\?/),
      ]),
    )
    expect(JSON.stringify(browser.titles.calls)).not.toContain('launch')

    // Reopened, it shows the question and the page it read, without the reply that was cut off.
    await user.click(sessionList().getByRole('button', { name: /Who owns the launch\?/ }))
    expect(await conversation().findByText('Who owns the launch?')).toBeVisible()
    expect(toolsSaid()).toEqual(['Read Fixture page'])
    expect(screen.queryByText(/Alice owns/)).not.toBeInTheDocument()

    // A follow-up tells the model what the stopped question already did.
    browser.ai.script.push({ reply: 'Alice.' })
    await ask(user, 'So who is it?')
    expect(await screen.findByText('Alice.')).toBeVisible()
    await answered()
    expect(browser.sentToModel()).toMatchObject([
      { role: 'system' },
      { role: 'user', content: expect.stringContaining('Who owns the launch?') },
      { role: 'assistant', tool_calls: [{ function: { name: 'read_page' } }] },
      { role: 'tool', content: expect.stringContaining('Hello **bold**') },
      { role: 'user', content: expect.stringContaining('So who is it?') },
    ])
  })

  it('[UC-NOTICO-SESSION-001-S21] a new chat stops a question, which keeps the change it made in the session it was asked in', async () => {
    const { tab } = workspaceTab()
    const { browser, user } = await openPanel(tab)
    browser.ai.script.push(
      { toolCalls: [{ name: 'read_page', arguments: JSON.stringify({ page: PAGE }) }] },
      {
        toolCalls: [
          {
            name: 'edit_page',
            arguments: JSON.stringify({
              page: PAGE,
              edits: [{ action: 'insert', position: 'end', markdown: 'A new line' }],
            }),
          },
        ],
      },
    )
    const resume = pausedAfterTools(browser, 'Added the line to it.')
    await ask(user, 'Add a line')
    await screen.findByText(/^Added the/)

    await user.click(screen.getByRole('button', { name: 'New chat' }))

    // The new chat is empty and takes a question at once.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^New chat$/)
    expect(screen.queryByText('Add a line')).not.toBeInTheDocument()
    expect(toolsSaid()).toEqual([])
    resume()
    browser.ai.pause = undefined
    browser.ai.script.push({ reply: 'Fresh.' })
    await ask(user, 'Hello')
    expect(await screen.findByText('Fresh.')).toBeVisible()
    await answered()
    expect(browser.sentToModel().map((m) => m.role)).toEqual(['system', 'user'])
    expect(JSON.stringify(browser.sentToModel())).not.toContain('Add a line')

    // The session the user left is in the list, with the question and what it read and changed.
    await openSession(user, /Add a line/)
    expect(await conversation().findByText('Add a line')).toBeVisible()
    expect(toolsSaid()).toEqual(['Read Fixture page', 'Edited Fixture page'])
    expect(screen.queryByText(/Added the/)).not.toBeInTheDocument()

    // Continued, the model learns the line is already there.
    browser.ai.script.push({ reply: 'Yes, once.' })
    await ask(user, 'Did you add it?')
    expect(await screen.findByText('Yes, once.')).toBeVisible()
    await answered()
    expect(browser.sentToModel()).toMatchObject([
      { role: 'system' },
      { role: 'user', content: expect.stringContaining('Add a line') },
      { role: 'assistant', tool_calls: [{ function: { name: 'read_page' } }] },
      { role: 'tool' },
      { role: 'assistant', tool_calls: [{ function: { name: 'edit_page' } }] },
      { role: 'tool' },
      { role: 'user', content: expect.stringContaining('Did you add it?') },
    ])
  })

  it('[UC-NOTICO-SESSION-001-S22] a question that used no tool when the user leaves its session leaves that session as it was', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ reply: 'Three milestones.' })
    await ask(user, 'What is on the roadmap?')
    await screen.findByText('Three milestones.')
    await answered()

    // The first question of a new chat, left for a saved one: the chat it would have started is not kept.
    vi.setSystemTime(new Date(START.getTime() + 60_000))
    await user.click(screen.getByRole('button', { name: 'New chat' }))
    let resume = pausedReply(browser, 'Alice owns the launch')
    await ask(user, 'Who owns the launch?')
    await screen.findByText(/^Alice owns/)
    await openSession(user, /What is on the roadmap\?/)
    expect(await screen.findByText('Three milestones.')).toBeVisible()
    resume()

    // A follow-up in the saved chat, left for a new one: the chat keeps only what it had.
    resume = pausedReply(browser, 'In March or so')
    await ask(user, 'When is the first one?')
    await screen.findByText(/^In March/)
    await user.click(screen.getByRole('button', { name: 'New chat' }))
    resume()
    browser.ai.pause = undefined

    await user.click(screen.getByRole('button', { name: 'Chats' }))
    await waitFor(() => expect(listed()).toEqual([expect.stringMatching(/^What is on the roadmap\?/)]))
    await user.click(sessionList().getByRole('button', { name: /What is on the roadmap\?/ }))
    expect(await screen.findByText('Three milestones.')).toBeVisible()
    expect(screen.queryByText('When is the first one?')).not.toBeInTheDocument()
    browser.ai.script.push({ reply: 'Alice.' })
    await ask(user, 'Who leads it?')
    expect(await screen.findByText('Alice.')).toBeVisible()
    await answered()
    expect(browser.sentToModel().map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(JSON.stringify(browser.sentToModel())).not.toMatch(/launch|first one/)
  })

  it('a chat deleted while a question the user left it for is still stopping is not saved back', async () => {
    const { browser, user } = await openPanel()
    await askAboutPage(browser, user)

    // The follow-up reads the page again, and Notion has not answered yet when the user leaves.
    const release = browser.tab.hold('loadPageChunk')
    browser.ai.script.push({ toolCalls: [{ name: 'read_page', arguments: JSON.stringify({ part: 1 }) }] })
    const sent = browser.tab.sent.length
    await ask(user, 'Read it again')
    await waitFor(() => expect(browser.tab.sent.length).toBeGreaterThan(sent))
    await user.click(screen.getByRole('button', { name: 'New chat' }))

    await user.click(screen.getByRole('button', { name: 'Chats' }))
    await user.click(await screen.findByRole('button', { name: 'Delete chat' }))
    await user.click(screen.getByRole('button', { name: 'Delete?' }))
    await waitFor(() => expect(listed()).toEqual([]))
    await user.click(screen.getByRole('button', { name: 'Close' }))

    // Notion answers, the question ends, and the new chat is used meanwhile.
    await act(async () => release())
    vi.setSystemTime(new Date(START.getTime() + 60_000))
    browser.ai.script.push({ reply: 'Fresh.' })
    await ask(user, 'Hello')
    expect(await screen.findByText('Fresh.')).toBeVisible()
    await answered()
    await user.click(screen.getByRole('button', { name: 'Chats' }))
    await waitFor(() => expect(listed()).toEqual([expect.stringMatching(/^Hello/)]))
  })
})

describe('a saved session that can no longer be read', () => {
  /** Writes a record into the panel's saved sessions as it is, as an earlier version might have left it. */
  async function writeSaved(store: 'sessions' | 'messages', record: object) {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('notico-sessions-user_alice')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite')
      tx.objectStore(store).put(record)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  }

  /** Asks two questions, each in a session of its own; the second stays open. */
  async function twoSessions(browser: FakeBrowser, user: UserEvent) {
    browser.ai.script.push({ reply: 'Three milestones.' }, { reply: 'Alice.' })
    await ask(user, 'What is on the roadmap?')
    await screen.findByText('Three milestones.')
    await answered()
    vi.setSystemTime(new Date(START.getTime() + 60_000))
    await user.click(screen.getByRole('button', { name: 'New chat' }))
    await ask(user, 'Who owns the launch?')
    await screen.findByText('Alice.')
    await answered()
  }

  it('[UC-NOTICO-SESSION-001-S17] the others are listed as usual, and the unreadable one can be deleted but not opened', async () => {
    const { browser, user } = await openPanel()
    await twoSessions(browser, user)
    await writeSaved('sessions', { id: 'old', title: { text: 'Old chat' } })

    await user.click(screen.getByRole('button', { name: 'Chats' }))
    const list = sessionList()
    await list.findByRole('button', { name: /What is on the roadmap\?/ })
    expect(list.getByRole('button', { name: /Who owns the launch\?/ })).toBeVisible()
    const row = list.getByText('Unreadable chat').closest('li')!
    expect(within(row).getByText(/can't be opened/)).toBeVisible()
    // Its only button deletes it.
    expect(
      within(row)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Delete chat'])

    await user.click(within(row).getByRole('button', { name: 'Delete chat' }))
    await user.click(within(row).getByRole('button', { name: 'Delete?' }))
    await waitFor(() => expect(list.queryByText('Unreadable chat')).not.toBeInTheDocument())
    expect(list.getAllByRole('button', { name: /Fixture page/ })).toHaveLength(2)
  })

  it("[UC-NOTICO-SESSION-001-S18] a session whose conversation can't be read is not opened, nothing goes to the AI, and it can be deleted", async () => {
    const { browser, user } = await openPanel()
    await twoSessions(browser, user)
    // The first session's conversation, as this version can't read it.
    const first = await new Promise<IDBValidKey>((resolve, reject) => {
      const req = indexedDB.open('notico-sessions-user_alice')
      req.onsuccess = () => {
        const cursor = req.result.transaction('sessions').objectStore('sessions').openCursor()
        cursor.onsuccess = () => {
          const at = cursor.result!
          if (!JSON.stringify(at.value).includes('What is on the roadmap?')) return at.continue()
          req.result.close()
          resolve(at.key)
        }
      }
      req.onerror = () => reject(req.error)
    })
    await writeSaved('messages', { id: first, messages: [{ role: 'system', text: 'Be brief' }] })
    // A reply in the open chat is still coming in.
    const resume = pausedReply(browser, 'The launch is on Friday')
    await ask(user, 'When is the launch?')
    await conversation().findByText(/^The launch/)
    const calls = browser.ai.calls.length

    await user.click(screen.getByRole('button', { name: 'Chats' }))
    await user.click(await sessionList().findByRole('button', { name: /What is on the roadmap\?/ }))

    expect(await sessionList().findByRole('alert')).toHaveTextContent(/can't be opened/)
    // The list stays open over the chat that was open, and the session can no longer be opened from it.
    expect(sessionList().queryByRole('button', { name: /What is on the roadmap\?/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(conversation().getByText('Alice.')).toBeVisible()
    expect(conversation().queryByText('Three milestones.')).not.toBeInTheDocument()
    // The reply was not stopped: it comes in whole, in the chat it was asked in.
    resume()
    expect(await conversation().findByText('The launch is on Friday')).toBeVisible()
    await answered()
    expect(browser.ai.calls).toHaveLength(calls)

    await user.click(screen.getByRole('button', { name: 'Chats' }))
    const row = (await sessionList().findByText('What is on the roadmap?')).closest('li')!
    await user.click(within(row).getByRole('button', { name: 'Delete chat' }))
    await user.click(within(row).getByRole('button', { name: 'Delete?' }))
    await waitFor(() => expect(sessionList().queryByText('What is on the roadmap?')).not.toBeInTheDocument())
  })
})

describe('signing in and out', () => {
  it('[UC-NOTICO-AUTH-001-S04] signing out from the side panel returns it to the sign-in screen', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push({ reply: 'Three milestones.' })
    await ask(user, 'What is on the roadmap?')
    await screen.findByText('Three milestones.')
    await answered()

    await user.click(screen.getByRole('button', { name: 'Account' }))
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }))

    expect(await screen.findByText('Sign in to use Notico.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeVisible()
    // The chat is gone: nothing to type into, and the conversation is off the screen.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByText('Three milestones.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Account' })).not.toBeInTheDocument()
  })

  it('a signed-out panel offers only to sign in, on the sign-in page', async () => {
    const browser = await FakeBrowser.start(pageTab())
    await browser.openPanel()
    const user = userEvent.setup()

    expect(screen.getByText('Sign in to use Notico.')).toBeVisible()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(browser.openedTabs).toEqual(['https://copilot.test/login'])
    expect(browser.ai.calls).toEqual([])
  })
})
