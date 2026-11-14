// Buying credits from the side panel, tested as a user meets it: the whole panel runs (see panel.ts)
// against the real worker, with Stripe a fake behind the worker. The user pays in a tab the panel
// opens; the tests stand for that by having Stripe tell the worker's webhook that the payment went
// through. The tests' clock is 5:30 ahead of UTC (vitest.config.ts): 12:00 UTC is 5:30 PM.
import '@testing-library/jest-dom/vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usageCosting } from '../../../worker/test/fakes'
import { refunded } from '../../../worker/test/stripe'
import { pageTab } from './notion-tab'
import { closeBrowser, FakeBrowser } from './panel'

afterEach(closeBrowser)

/** A browser signed in to Notico, with the side panel open. */
async function openPanel() {
  const browser = await FakeBrowser.start(pageTab(), { signedInAs: 'user_alice' })
  await browser.openPanel()
  return { browser, user: userEvent.setup() }
}

async function openCredits(user: UserEvent) {
  await user.click(screen.getByRole('button', { name: 'Account' }))
  await user.click(await screen.findByRole('menuitem', { name: /^Credits/ }))
  expect(await screen.findByRole('heading', { name: 'Credits' })).toBeVisible()
}

/** The Credits page's balance by source, once the credits have loaded: the text of each line. */
async function bySource() {
  const list = await within(section('Balance')).findByRole('list', { name: 'Credits by source' })
  return within(list)
    .getAllByRole('listitem')
    .map((line) => line.textContent)
}

/** A section of the Credits page, by its heading. */
const section = (name: string) => screen.getByRole('region', { name })

/** The user comes back to the side panel from another tab. */
const comeBack = () => fireEvent.focus(window)

describe('buying credits on the Credits page', () => {
  it('[UC-NOTICO-BILLING-001-S01] choosing a pack opens its Checkout page in a new tab, for the signed-in account', async () => {
    const { browser, user } = await openPanel()
    await openCredits(user)

    const buy = within(section('Buy credits'))
    const packs = within(await buy.findByRole('list', { name: 'Packs of credits' })).getAllByRole('button', {
      name: /^Buy/,
    })
    expect(packs.map((pack) => pack.getAttribute('aria-label'))).toEqual([
      'Buy 5,000 credits for US$5',
      'Buy 10,000 credits for US$10',
      'Buy 20,000 credits for US$20',
      'Buy 50,000 credits for US$50',
    ])

    await user.click(buy.getByRole('button', { name: 'Buy 5,000 credits for US$5' }))

    expect(await buy.findByRole('status')).toHaveTextContent(
      'Checkout opened in a new tab. Your credits show here once the payment goes through.',
    )
    expect(browser.openedTabs).toEqual(['https://checkout.stripe.com/c/pay/cs_test_1'])
    expect(browser.stripe.sessions).toMatchObject([{ userId: 'user_alice', quantity: 5, price: 'price_credits' }])
  })

  it('[UC-NOTICO-BILLING-001-S15] the packs on offer say bought credits last one year, nothing renews, and questions answered with the user’s own key spend none', async () => {
    const { user } = await openPanel()
    await openCredits(user)

    const buy = within(section('Buy credits'))
    await buy.findByRole('list', { name: 'Packs of credits' })
    expect(
      buy.getByText(
        'One-time purchase, not a subscription, valid for a year, spent after your free credits. Questions answered with your own key (OpenRouter, DeepSeek) spend no credits. Tax may be added at checkout.',
      ),
    ).toBeVisible()
  })

  it('[UC-NOTICO-BILLING-001-S10] coming back to the panel after paying shows the new credits', async () => {
    const { browser, user } = await openPanel()
    await openCredits(user)
    expect(await bySource()).toEqual(['Free this week200 · valid for 7 days from your next question', 'Bought0'])
    await user.click(await screen.findByRole('button', { name: 'Buy 10,000 credits for US$10' }))
    await within(section('Buy credits')).findByRole('status')

    // The user pays in the Checkout tab, and Stripe tells the worker.
    await browser.stripeSends()
    comeBack()

    expect(await within(section('Balance')).findByText('10,200')).toBeVisible()
    expect(await bySource()).toEqual([
      'Free this week200 · valid for 7 days from your next question',
      'Bought10,000 · expire Nov 8, 2027, 5:30 PM',
    ])
    // The account menu has them too, with no sign-in again.
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await user.click(screen.getByRole('button', { name: 'Account' }))
    expect(await screen.findByRole('menuitem', { name: 'Credits, 10,200 left' })).toBeVisible()
  })

  it('[UC-NOTICO-BILLING-001-S11] the history shows a purchase as such, with what was paid, and what a refund took back', async () => {
    const { browser, user } = await openPanel()
    await openCredits(user)
    await user.click(await screen.findByRole('button', { name: 'Buy 5,000 credits for US$5' }))
    await within(section('Buy credits')).findByRole('status')
    await browser.stripeSends(browser.stripe.sessionEvent({ payment: 'pi_kept' }))
    await user.click(screen.getByRole('button', { name: 'Buy 10,000 credits for US$10' }))
    // The second Checkout tab is open before the user pays in it.
    await waitFor(() => expect(browser.openedTabs).toHaveLength(2))
    await browser.stripeSends(browser.stripe.sessionEvent({ payment: 'pi_refunded' }))
    // A day later, a third: the Credits page says how many of the credits bought expire first.
    vi.setSystemTime(new Date('2026-11-09T12:00:00Z'))
    await user.click(screen.getByRole('button', { name: 'Buy 5,000 credits for US$5' }))
    await waitFor(() => expect(browser.openedTabs).toHaveLength(3))
    await browser.stripeSends(browser.stripe.sessionEvent({ payment: 'pi_later' }))
    comeBack()
    await waitFor(async () =>
      expect((await bySource()).at(-1)).toBe('Bought20,000 · 15,000 expire Nov 8, 2027, 5:30 PM'),
    )
    await browser.stripeSends(refunded('pi_refunded'))

    await user.click(within(section('Balance')).getByRole('button', { name: 'Credit history' }))

    const given = await screen.findByRole('list', { name: 'Credits you were given' })
    const lots = within(given).getAllByRole('listitem')
    expect(lots.map((lot) => lot.textContent)).toEqual([
      'Bought 5,000 creditsNov 9 · Paid US$5 · expire Nov 9, 2027+5,0005,000 left',
      'Bought 10,000 creditsNov 8 · Paid US$10 · refunded Nov 9+10,00010,000 taken back',
      'Bought 5,000 creditsNov 8 · Paid US$5 · expire Nov 8, 2027+5,0005,000 left',
    ])
  })

  it('says when the packs cannot be read, and reads them again on request', async () => {
    const { browser, user } = await openPanel()
    // Buying is not set up on the worker for a moment.
    const packs = browser.env.CREDIT_PACKS
    browser.env.CREDIT_PACKS = undefined
    browser.env.CREDIT_PRICE = undefined
    await openCredits(user)

    const buy = within(section('Buy credits'))
    expect(await buy.findByRole('alert')).toHaveTextContent('Buying credits is unavailable right now.')

    browser.env.CREDIT_PACKS = packs
    browser.env.CREDIT_PRICE = 'price_credits'
    await user.click(buy.getByRole('button', { name: 'Try again' }))
    expect(await buy.findByRole('button', { name: 'Buy 5,000 credits for US$5' })).toBeVisible()
  })

  it('says when Checkout cannot be opened, and opens no tab', async () => {
    const { browser, user } = await openPanel()
    await openCredits(user)
    browser.stripe.failWith = new Error('Stripe answered 500')

    const buy = within(section('Buy credits'))
    await user.click(await buy.findByRole('button', { name: 'Buy 5,000 credits for US$5' }))

    expect(await buy.findByRole('alert')).toHaveTextContent('Checkout could not be opened. Try again in a moment.')
    expect(browser.openedTabs).toEqual([])
  })
})

describe('a question refused for lack of credits', () => {
  it('[UC-NOTICO-BILLING-001-S12] offers to buy credits beside saying when the free ones return', async () => {
    const { browser, user } = await openPanel()
    browser.ai.usage = usageCosting(210)
    browser.ai.script.push({ reply: 'Answer' })
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'First{Enter}')
    await screen.findByText('Answer')
    await screen.findByRole('button', { name: 'Send' })

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Second{Enter}')

    expect(
      await screen.findByText(/Your next 200 free credits arrive on 2026-11-15 at 12:00 UTC, or you can buy credits\./),
    ).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Buy credits' }))
    expect(
      await within(section('Buy credits')).findByRole('button', { name: 'Buy 5,000 credits for US$5' }),
    ).toBeVisible()
  })
})
