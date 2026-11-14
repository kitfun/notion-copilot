// The history of the user's credits, opened from the Credits page, tested as a user meets it: the
// whole panel runs (see panel.ts) against the real worker, and the tests only type, click, and read
// what is on screen.
// The tests' clock is 5:30 ahead of UTC (vitest.config.ts): 12:00 UTC, when a test starts, is 5:30 PM.
import '@testing-library/jest-dom/vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usageCosting } from '../../../worker/test/fakes'
import { pageTab } from './notion-tab'
import { closeBrowser, FakeBrowser, START } from './panel'

afterEach(closeBrowser)

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const DOWN = new Error('D1_ERROR: Network connection lost.')
/** What only the worker's read of a page of grants contains. */
const GRANTS_READ = 'ORDER BY granted_at DESC'

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

async function openCredits(user: UserEvent) {
  await user.click(screen.getByRole('button', { name: 'Account' }))
  await user.click(await screen.findByRole('menuitem', { name: /^Credits/ }))
  expect(await screen.findByRole('heading', { name: 'Credits' })).toBeVisible()
}

/** Opens the credit history from the Credits page's balance. */
async function openHistory(user: UserEvent) {
  await openCredits(user)
  await user.click(within(section('Balance')).getByRole('button', { name: 'Credit history' }))
  expect(screen.getByRole('heading', { name: 'Credit history' })).toBeVisible()
}

/** A section of the page, by its heading. */
const section = (name: string) => screen.getByRole('region', { name })

/** The lots of credits the history lists, once it has loaded some: the text of each. */
async function lots() {
  const list = await screen.findByRole('list', { name: 'Credits you were given' })
  return within(list)
    .getAllByRole('listitem')
    .map((lot) => lot.textContent)
}

/** How many credits each lot was: none were spent, so what is left of it is the same. */
const amounts = (lots: string[]) => lots.map((lot) => /\+(\d+)\1 left$/.exec(lot)?.[1])

describe('the credit history', () => {
  it('[UC-NOTICO-CHAT-003-S10] lists every lot of credits the user was given, newest first, with its dates and what is left or went unspent, and no usage', async () => {
    const { browser, user } = await openPanel()
    // Week one: 60 of the free credits are used, and 140 expire unspent.
    await ask(browser, user, 'First', 60)
    // Week two: new free credits, and an hour later 100 credits added by hand, for 30 days.
    vi.setSystemTime(START.getTime() + 7 * DAY_MS)
    await ask(browser, user, 'Second', 30)
    vi.setSystemTime(START.getTime() + 7 * DAY_MS + HOUR_MS)
    await browser.grantCredits('user_alice', 100, 30)
    // Week three: the second week has ended too.
    vi.setSystemTime(START.getTime() + 14 * DAY_MS + HOUR_MS)

    await openHistory(user)

    expect(await lots()).toEqual([
      'Credits from CofunNov 15 · expire Dec 15+100100 left',
      'Free weekly creditsNov 15 · expired Nov 22+200170 unspent',
      'Free weekly creditsNov 8 · expired Nov 15+200140 unspent',
    ])
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByText(/used/i)).not.toBeInTheDocument()
    // The Credits page itself shows only the credits that still count.
    await user.click(screen.getByRole('button', { name: 'Back' }))
    const lines = within(section('Balance')).getByRole('list', { name: 'Credits by source' })
    expect(within(lines).getAllByRole('listitem').at(-1)).toHaveTextContent('From Cofun100 · expire Dec 15')
  })

  it('[UC-NOTICO-CHAT-003-S10] shows credits that were used to the end, before and after they expire', async () => {
    const { browser, user } = await openPanel()
    await ask(browser, user, 'First', 210)

    await openHistory(user)
    expect(await lots()).toEqual(['Free weekly creditsNov 8 · expire Nov 15+200All used'])

    vi.setSystemTime(START.getTime() + 7 * DAY_MS)
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Credit history' }))
    expect(await lots()).toEqual(['Free weekly creditsNov 8 · expired Nov 15+200All used'])
  })

  it('[UC-NOTICO-CHAT-003-S10] shows the newest lots first, and earlier ones when asked, to the end', async () => {
    const { browser, user } = await openPanel()
    // 25 lots, told apart by how many credits each was.
    for (let credits = 1; credits <= 25; credits++) {
      await browser.grantCredits('user_alice', credits, 30)
      vi.setSystemTime(START.getTime() + credits * HOUR_MS)
    }

    await openHistory(user)

    expect(amounts(await lots())).toEqual(Array.from({ length: 20 }, (_, i) => `${25 - i}`))
    await user.click(screen.getByRole('button', { name: 'Show earlier' }))
    await waitFor(async () => expect(await lots()).toHaveLength(25))
    expect(amounts(await lots())).toEqual(Array.from({ length: 25 }, (_, i) => `${25 - i}`))
    // That was the last of them.
    expect(screen.queryByRole('button', { name: 'Show earlier' })).not.toBeInTheDocument()
  })

  it('[UC-NOTICO-CHAT-003-S11] shows the credits used longer ago than 30 days nowhere', async () => {
    const { browser, user } = await openPanel()
    await ask(browser, user, 'First', 30)
    // 31 days later, on the user's clock.
    vi.setSystemTime(START.getTime() + 31 * DAY_MS)
    await ask(browser, user, 'Second', 6)

    await openCredits(user)
    const usage = within(section('Usage'))
    const table = await usage.findByRole('table', { name: 'Credits used per day, last 30 days' })
    expect(
      within(table)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual(['Wed, Dec 96'])
    expect(usage.getByRole('status')).toHaveTextContent('6 credits in the last 30 days')

    await user.click(screen.getByRole('button', { name: 'Credit history' }))
    await lots()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /usage/i })).not.toBeInTheDocument()
  })

  it('tells a user who was given nothing so, and opening it does not start their free credits', async () => {
    const { user } = await openPanel()

    await openHistory(user)

    expect(await screen.findByText('No credits yet. Your free credits start with your next question.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Show earlier' })).not.toBeInTheDocument()

    await user.keyboard('{Escape}')
    const lines = await within(section('Balance')).findByRole('list', { name: 'Credits by source' })
    expect(within(lines).getAllByRole('listitem')[0]).toHaveTextContent(
      'Free this week200 · valid for 7 days from your next question',
    )
  })

  it('when the history cannot be read, it says so and offers to try again, and the Credits page and the chat still work', async () => {
    const browser = await FakeBrowser.start(pageTab(), { signedInAs: 'user_alice' })
    // Only the reads of the history fail.
    browser.db.failOn = { sql: GRANTS_READ, error: DOWN }
    await browser.openPanel()
    const user = userEvent.setup()
    await ask(browser, user, 'What is on the roadmap?', 60)

    await openHistory(user)
    expect(await screen.findByRole('alert')).toHaveTextContent('Your credits could not be loaded.')

    // Once the worker can read them again, trying again shows them.
    browser.db.failOn = undefined
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await lots()).toEqual(['Free weekly creditsNov 8 · expire Nov 15+200140 left'])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(await within(section('Balance')).findByText('140')).toBeVisible()
    await user.keyboard('{Escape}')
    await ask(browser, user, 'Who owns the launch?', 30)
  })

  it('when earlier lots cannot be read, the ones already shown stay, and trying again adds the rest', async () => {
    const { browser, user } = await openPanel()
    for (let credits = 1; credits <= 25; credits++) await browser.grantCredits('user_alice', credits, 30)
    await openHistory(user)
    expect(await lots()).toHaveLength(20)

    browser.db.failOn = { sql: GRANTS_READ, error: DOWN }
    await user.click(screen.getByRole('button', { name: 'Show earlier' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Your credits could not be loaded.')
    expect(await lots()).toHaveLength(20)

    browser.db.failOn = undefined
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(async () => expect(await lots()).toHaveLength(25))
  })

  it('works with the keyboard: it opens from the Credits page, and Escape leads back a step at a time', async () => {
    const { user } = await openPanel()
    await openCredits(user)

    screen.getByRole('button', { name: 'Credit history' }).focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('heading', { name: 'Credit history' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Back' })).toHaveFocus()

    // Escape leads back to the Credits page, with the focus on what opened the history.
    await user.keyboard('{Escape}')
    expect(screen.getByRole('heading', { name: 'Credits' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Credit history' })).toHaveFocus()

    // Back does the same, and from the Credits page it leads to the chat.
    await user.keyboard('{Enter}')
    await user.keyboard('{Enter}')
    expect(screen.getByRole('heading', { name: 'Credits' })).toBeVisible()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('heading', { name: 'Credits' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeVisible()
  })
})
