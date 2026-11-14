// The account menu, the Credits page, and the Settings page, tested as a user meets them: the whole panel runs (see
// panel.ts) against the real worker, and the tests only type, click, and read what is on screen.
// The tests' clock is 5:30 ahead of UTC (vitest.config.ts): 12:00 UTC, when a test starts, is 5:30 PM.
import '@testing-library/jest-dom/vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usageCosting } from '../../../worker/test/fakes'
import { pageTab } from './notion-tab'
import { closeBrowser, FakeBrowser, START } from './panel'

afterEach(closeBrowser)

const DAY_MS = 24 * 60 * 60 * 1000

/** A browser signed in to Notico, with the side panel open. */
async function openPanel() {
  const browser = await FakeBrowser.start(pageTab(), { signedInAs: 'user_alice' })
  await browser.openPanel()
  return { browser, user: userEvent.setup() }
}

/** Asks a question whose reply costs `credits` (a multiple of 3), and waits for it to end. */
async function ask(browser: FakeBrowser, user: UserEvent, question: string, credits: number) {
  browser.ai.usage = usageCosting(credits)
  browser.ai.script.push({ reply: `Answer to: ${question}` })
  await user.type(screen.getByRole('textbox', { name: 'Message' }), `${question}{Enter}`)
  await screen.findByText(`Answer to: ${question}`)
  await screen.findByRole('button', { name: 'Send' })
}

const accountButton = () => screen.getByRole('button', { name: 'Account' })

/** Opens the account menu, once the credits in it have loaded. */
async function openMenu(user: UserEvent) {
  await user.click(accountButton())
  expect(await screen.findByRole('menu', { name: 'Account' })).toBeVisible()
}

/** The menu's Credits item, whatever balance it shows. */
const creditsItem = () => screen.getByRole('menuitem', { name: /^Credits/ })

async function openCredits(user: UserEvent) {
  await openMenu(user)
  await user.click(creditsItem())
  expect(await screen.findByRole('heading', { name: 'Credits' })).toBeVisible()
}

async function openSettings(user: UserEvent) {
  await openMenu(user)
  await user.click(screen.getByRole('menuitem', { name: 'Settings' }))
  expect(await screen.findByRole('heading', { name: 'Settings' })).toBeVisible()
}

/** A section of a page, by its heading. */
const section = (name: string) => screen.getByRole('region', { name })

/** The Credits page's balance by source, once the credits have loaded: the text of each line. */
async function bySource() {
  const list = await within(section('Balance')).findByRole('list', { name: 'Credits by source' })
  return within(list)
    .getAllByRole('listitem')
    .map((line) => line.textContent)
}

describe('the account menu', () => {
  it('[UC-NOTICO-CHAT-003-S12] shows who is signed in, then Credits with the balance and Settings, and Sign out, and nothing to manage the account', async () => {
    const { user } = await openPanel()

    await openMenu(user)

    expect(screen.getByText('Alice Example')).toBeVisible()
    expect(screen.getByText('alice@example.com')).toBeVisible()
    await waitFor(() =>
      expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
        'Credits200',
        'Settings',
        'Sign out',
      ]),
    )
    expect(creditsItem()).toHaveAccessibleName('Credits, 200 left')
    expect(screen.queryByText(/manage account/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/clerk/i)).not.toBeInTheDocument()

    // Each item opens its own page, over the chat's header, and Back leads to the chat.
    await user.click(creditsItem())
    expect(await screen.findByRole('heading', { name: 'Credits' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.queryByRole('heading', { name: 'Credits' })).not.toBeInTheDocument()
    await openSettings(user)
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.queryByRole('heading', { name: 'Settings' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeVisible()
  })

  it('[UC-NOTICO-CHAT-003-S01] shows the credits that are left', async () => {
    const { browser, user } = await openPanel()

    await ask(browser, user, 'What is on the roadmap?', 60)
    await openMenu(user)

    await waitFor(() => expect(creditsItem()).toHaveAccessibleName('Credits, 140 left'))
  })

  it('[UC-NOTICO-CHAT-003-S06] shows what is left after each question, without the panel being opened again', async () => {
    const { browser, user } = await openPanel()
    await openMenu(user)
    await waitFor(() => expect(creditsItem()).toHaveAccessibleName('Credits, 200 left'))
    await user.keyboard('{Escape}')

    await ask(browser, user, 'What is on the roadmap?', 60)
    await openMenu(user)
    await waitFor(() => expect(creditsItem()).toHaveAccessibleName('Credits, 140 left'))
    await user.keyboard('{Escape}')

    await ask(browser, user, 'Who owns the launch?', 30)
    await openMenu(user)
    await waitFor(() => expect(creditsItem()).toHaveAccessibleName('Credits, 110 left'))
  })

  it('works with the keyboard', async () => {
    const { user } = await openPanel()
    // Closing the menu with Escape leaves the focus on the avatar: the keyboard takes over from there.
    await user.click(accountButton())
    await user.keyboard('{Escape}')
    expect(accountButton()).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(creditsItem()).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(creditsItem()).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toHaveFocus()

    // Escape closes the menu and gives the focus back to the avatar.
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(accountButton()).toHaveFocus()
    expect(accountButton()).toHaveAttribute('aria-expanded', 'false')

    // A page opens from the keyboard, with the focus on Back, and Escape leads back to the chat, with the focus on the avatar again.
    await user.keyboard('{Enter}{ArrowDown}{Enter}')
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Back' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('heading', { name: 'Settings' })).not.toBeInTheDocument()
    expect(accountButton()).toHaveFocus()
    await user.keyboard('{Enter}{Enter}')
    expect(await screen.findByRole('heading', { name: 'Credits' })).toBeVisible()
    await user.keyboard('{Escape}')
    expect(accountButton()).toHaveFocus()
  })

  it('reads the credits again each time it opens, and tells a screen reader who is signed in', async () => {
    const browser = await FakeBrowser.start(pageTab(), { signedInAs: 'user_alice' })
    // The read made when the panel loads fails.
    browser.db.failOn = { sql: 'GROUP BY day', error: new Error('D1_ERROR: Network connection lost.') }
    await browser.openPanel()
    const user = userEvent.setup()
    await openMenu(user)
    await waitFor(() => expect(creditsItem()).toHaveAccessibleName('Credits, unavailable'))
    await user.keyboard('{Escape}')

    browser.db.failOn = undefined
    await openMenu(user)

    await waitFor(() => expect(creditsItem()).toHaveAccessibleName('Credits, 200 left'))
    expect(screen.getByRole('menu', { name: 'Account' })).toHaveAccessibleDescription('Alice Example alice@example.com')
  })

  it('opened over the session list, Escape closes only the menu, and the next Escape the list', async () => {
    const { user } = await openPanel()
    await user.click(screen.getByRole('button', { name: 'Chats' }))
    await openMenu(user)

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Chats' })).toBeVisible()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Chats' })).not.toBeInTheDocument()
  })

  it('closes when the user clicks elsewhere', async () => {
    const { user } = await openPanel()
    await openMenu(user)

    await user.click(screen.getByRole('textbox', { name: 'Message' }))

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})

describe('the Credits page', () => {
  it('[UC-NOTICO-CHAT-003-S01] shows what is left, by source, and when new free credits can arrive', async () => {
    const { browser, user } = await openPanel()
    await ask(browser, user, 'What is on the roadmap?', 60)

    await openCredits(user)

    expect(await bySource()).toEqual(['Free this week140 · renew after Nov 15, 5:30 PM', 'Bought0'])
    expect(within(section('Balance')).getByText('140')).toBeVisible()
  })

  it('[UC-NOTICO-CHAT-003-S02] shows free credits that have not started as such, and looking does not start the week', async () => {
    const { browser, user } = await openPanel()

    await openCredits(user)

    expect(await bySource()).toEqual(['Free this week200 · valid for 7 days from your next question', 'Bought0'])
    expect(within(section('Usage')).getByText('No credits used in the last 30 days.')).toBeInTheDocument()
    await user.keyboard('{Escape}')

    // Two days later the first question starts the week: 200 credits, less what it cost, for 7 days from now.
    vi.setSystemTime(START.getTime() + 2 * DAY_MS)
    await ask(browser, user, 'What is on the roadmap?', 60)
    await openCredits(user)
    expect(await bySource()).toEqual(['Free this week140 · renew after Nov 17, 5:30 PM', 'Bought0'])
  })

  it('[UC-NOTICO-CHAT-003-S03] shows a user who overspent that no credits are left, and then the next free credits less what they owe', async () => {
    const { browser, user } = await openPanel()
    await ask(browser, user, 'First', 150)
    // 50 credits are left: the question goes ahead, and overspends by 100.
    await ask(browser, user, 'Second', 150)

    await openMenu(user)
    await waitFor(() => expect(creditsItem()).toHaveAccessibleName('Credits, 0 left'))
    await user.click(creditsItem())
    const balance = within(section('Balance'))
    expect(
      await balance.findByText('You overspent 100 credits. They come out of the next credits you get.'),
    ).toBeVisible()
    expect(await bySource()).toEqual(['Free this week0 · renew after Nov 15, 5:30 PM', 'Bought0'])

    // The week has ended: the panel is opened again.
    vi.setSystemTime(START.getTime() + 7 * DAY_MS)
    await browser.openPanel()
    await openCredits(user)
    expect(await bySource()).toEqual(['Free this week100 · valid for 7 days from your next question', 'Bought0'])
  })

  it('[UC-NOTICO-CHAT-003-S04] shows the credits used on each of the last 30 days, by the days of the user’s own clock, with the total and today’s', async () => {
    const { browser, user } = await openPanel()
    // 5:30 PM on Nov 8, on the user's clock.
    await ask(browser, user, 'First', 30)
    // 12:30 AM on Nov 9 on the user's clock, though still Nov 8 in UTC.
    vi.setSystemTime(new Date('2026-11-08T19:00:00Z'))
    await ask(browser, user, 'Second', 60)
    await ask(browser, user, 'Third', 6)

    await openCredits(user)

    const usage = within(section('Usage'))
    const table = await usage.findByRole('table', { name: 'Credits used per day, last 30 days' })
    expect(
      within(table)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual(['Mon, Nov 966', 'Sun, Nov 830'])
    // Above the chart: the total and today's, and in their place the day the keyboard or the pointer is on.
    const sum = usage.getByRole('status')
    expect(sum).toHaveTextContent('96 credits in the last 30 daysToday 66')
    // The chart runs from 29 days ago to today.
    expect(usage.getByText('Oct 11')).toBeVisible()
    expect(usage.getByText('Nov 9')).toBeVisible()
    await user.click(usage.getByRole('group', { name: /Credits used per day/ }))
    expect(sum).toHaveTextContent('Mon, Nov 966 credits')
    await user.keyboard('{ArrowLeft}')
    expect(sum).toHaveTextContent('Sun, Nov 830 credits')
    await user.keyboard('{Home}')
    expect(sum).toHaveTextContent('Sun, Oct 110 credits')
    await user.tab()
    expect(sum).toHaveTextContent('96 credits in the last 30 daysToday 66')
  })

  it('[UC-NOTICO-CHAT-003-S08] when credits cannot be read, the user can still ask, and the panel says credits are unavailable', async () => {
    const browser = await FakeBrowser.start(pageTab(), { signedInAs: 'user_alice' })
    // Only reading the usage fails; the worker can still check and charge credits for a question.
    browser.db.failOn = { sql: 'GROUP BY day', error: new Error('D1_ERROR: Network connection lost.') }
    await browser.openPanel()
    const user = userEvent.setup()

    await ask(browser, user, 'What is on the roadmap?', 60)
    await openMenu(user)
    await waitFor(() => expect(creditsItem()).toHaveAccessibleName('Credits, unavailable'))

    await user.click(creditsItem())
    const balance = within(section('Balance'))
    expect(await balance.findByRole('alert')).toHaveTextContent(
      'Your credits could not be loaded. You can still ask questions.',
    )

    // Once the worker can read them again, trying again shows them.
    browser.db.failOn = undefined
    await user.click(balance.getByRole('button', { name: 'Try again' }))
    expect(await bySource()).toEqual(['Free this week140 · renew after Nov 15, 5:30 PM', 'Bought0'])
  })
})

describe('the Settings page', () => {
  it('[UC-NOTICO-CHAT-003-S16] shows which model answers and the account, with Sign out, and nothing about credits', async () => {
    const { user } = await openPanel()

    await openSettings(user)

    expect(within(section('Model')).getByLabelText('Model in use')).toBeVisible()
    const account = within(section('Account'))
    expect(account.getByText('Alice Example')).toBeVisible()
    expect(account.getByText('alice@example.com')).toBeVisible()
    expect(account.getByRole('button', { name: 'Sign out' })).toBeVisible()
    expect(screen.queryByRole('region', { name: 'Balance' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Buy credits' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Plan' })).not.toBeInTheDocument()
  })
})

describe('a question refused for lack of credits', () => {
  it('[UC-NOTICO-CHAT-003-S07] says when credits arrive and leads to the Credits page', async () => {
    const { browser, user } = await openPanel()
    await ask(browser, user, 'First', 210)

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Second{Enter}')

    expect(
      await screen.findByText(
        /You have no credits left\. Your next 200 free credits arrive on 2026-11-15 at 12:00 UTC, or you can buy credits\./,
      ),
    ).toBeVisible()
    expect(browser.ai.calls).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Buy credits' }))

    expect(await screen.findByRole('heading', { name: 'Credits' })).toBeVisible()
    expect(await bySource()).toEqual(['Free this week0 · renew after Nov 15, 5:30 PM', 'Bought0'])
  })
})
