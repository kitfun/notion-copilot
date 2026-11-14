// Buying credits: the packs, Checkout, and the Stripe webhook, tested through HTTP with the worker's
// real SQL on SQLite. Stripe is a fake (FakeStripe) that keeps the sessions the worker made and writes
// the events Stripe would send about them; the webhook gets them signed with a test signing secret,
// as Stripe signs them.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type Env } from '../src/app'
import { stripeOverHttp } from '../src/stripe'
import { FakeClerk } from './clerk'
import {
  FakeAiBinding,
  FakeD1Database,
  FakeExecutionContext,
  FakeUsageDataset,
  FakeRateLimiter,
  MODEL,
  usageCosting,
} from './fakes'
import { disputed, event, FakeStripe, refunded, signature, WEBHOOK_SECRET } from './stripe'

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
/** The origin the tests reach the worker on: the admin page's, and where Checkout sends buyers back to. */
const WORKER = 'http://localhost'
const START = Date.parse('2026-11-08T12:00:00Z')
const DAY_MS = 24 * 60 * 60 * 1000
const CREDIT = 1_000_000
/** What is on sale: the price of 1,000 credits for US$1, and the quantities of it sold as packs. */
const PRICE = 'price_credits'
const PACKS = [5, 10, 20, 50]

let clock = new Date(START)
let logged: string[] = []
let billingLog: string[] = []
const app = createApp({
  now: () => clock,
  logError: (line) => logged.push(line),
  logAdmin: () => {},
  logBilling: (line) => billingLog.push(line),
})

let clerk: FakeClerk
let ai: FakeAiBinding
let db: FakeD1Database
let stripe: FakeStripe
let env: Env
let alice: string
let bob: string
let admin: string

beforeAll(async () => {
  clerk = await FakeClerk.create()
})

beforeEach(async () => {
  ai = new FakeAiBinding()
  logged = []
  billingLog = []
  clock = new Date(START)
  env = {
    AI: ai,
    DB: (db = new FakeD1Database()),
    USAGE: new FakeUsageDataset(),
    CHAT_LIMIT: new FakeRateLimiter(),
    MODEL,
    CLERK_JWT_KEY: clerk.publicKeyPem,
    CLERK_AUTHORIZED_PARTIES: `${EXT}, ${WORKER}`,
    STRIPE: (stripe = new FakeStripe()),
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    CREDIT_PRICE: PRICE,
    CREDIT_PACKS: PACKS,
  }
  alice = await clerk.sessionToken({ userId: 'user_alice', azp: EXT })
  bob = await clerk.sessionToken({ userId: 'user_bob', azp: EXT })
  admin = await clerk.sessionToken({ userId: 'user_root', azp: WORKER, claims: { role: 'admin' } })
})

function req(method: string, path: string, bearer?: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (bearer) headers.authorization = `Bearer ${bearer}`
  const init = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }
  return app.request(path, init, env, new FakeExecutionContext())
}

/** What a request answers, which must be `status`. */
async function answer(res: Response | Promise<Response>, status = 200): Promise<any> {
  const response = await res
  const body = await response.json()
  expect(response.status, JSON.stringify(body)).toBe(status)
  return body
}

/**
 * Starts buying the pack of `credits` as the user signed in with `bearer` (a quantity of 1,000
 * credits), and gives the Checkout page's URL.
 */
async function checkout(bearer: string, credits: number): Promise<string> {
  const { url } = await answer(req('POST', '/v1/billing/checkout', bearer, { quantity: credits / 1000 }))
  return url
}

/** Stripe delivers `evt` to the webhook, signed now (or as `options` says). */
async function deliver(evt: unknown, options: { at?: number; secret?: string; header?: string | null } = {}) {
  const payload = JSON.stringify(evt)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const header =
    options.header === undefined
      ? await signature(payload, options.at ?? clock.getTime(), options.secret)
      : options.header
  if (header !== null) headers['stripe-signature'] = header
  return app.request('/stripe/webhook', { method: 'POST', headers, body: payload }, env, new FakeExecutionContext())
}

/** Buys the pack of `credits` as the user signed in with `bearer`: Checkout, then the payment goes through. */
async function buy(bearer: string, credits: number, payment?: string) {
  await checkout(bearer, credits)
  await answer(deliver(stripe.sessionEvent({ payment })))
}

/** Asks the AI something; the reply costs `credits` (a multiple of 3). */
async function ask(bearer: string, credits: number) {
  ai.usage = usageCosting(credits)
  const res = await req('POST', '/v1/chat/completions', bearer, { messages: [{ role: 'user', content: 'hi' }] })
  expect(res.status).toBe(200)
}

const credits = (bearer: string): Promise<any> => answer(req('GET', '/v1/credits', bearer))

/** One year after `ms`, on the same day and time. */
const yearAfter = (ms: number) => Date.parse(new Date(ms).toISOString().replace(/^2026/, '2027'))

describe('UC-COFUN-BILLING-001 Buy credits: the packs and Checkout', () => {
  it('[UC-COFUN-BILLING-001-S01] a signed-in user who chooses a pack gets the Checkout page for it, for their account', async () => {
    expect(await answer(req('GET', '/v1/billing/packs', alice))).toEqual({
      packs: [
        { quantity: 5, credits: 5000, usdCents: 500 },
        { quantity: 10, credits: 10_000, usdCents: 1000 },
        { quantity: 20, credits: 20_000, usdCents: 2000 },
        { quantity: 50, credits: 50_000, usdCents: 5000 },
      ],
    })

    expect(await checkout(alice, 5000)).toBe('https://checkout.stripe.com/c/pay/cs_test_1')

    expect(stripe.sessions).toEqual([
      {
        id: 'cs_test_1',
        price: PRICE,
        quantity: 5,
        userId: 'user_alice',
        successUrl: `${WORKER}/billing/paid`,
        cancelUrl: `${WORKER}/billing/cancelled`,
      },
    ])
    // Nothing is granted until Stripe says the payment went through.
    expect(db.rows('grants')).toEqual([])
  })

  it('[UC-COFUN-BILLING-001-S09] a pack that is not on offer is refused, and no Checkout Session is made', async () => {
    for (const body of [
      { quantity: 7 },
      { quantity: 1 },
      { quantity: 5.5 },
      { quantity: '5' },
      { credits: 5000 },
      null,
    ]) {
      const { error } = await answer(req('POST', '/v1/billing/checkout', alice, body), 400)
      expect(error.code).toBe('bad_request')
    }
    const { error } = await answer(req('POST', '/v1/billing/checkout', alice, { quantity: 7 }), 400)
    expect(error.message).toBe('quantity must be one of the packs on sale: 5, 10, 20, 50')
    expect(stripe.sessions).toEqual([])
  })

  it('needs a session, like every /v1 route', async () => {
    await answer(req('GET', '/v1/billing/packs'), 401)
    await answer(req('POST', '/v1/billing/checkout', undefined, { quantity: 5 }), 401)
    expect(stripe.sessions).toEqual([])
  })

  it('is not configured without packs or a Stripe key, or with packs that are wrong', async () => {
    const refused = async () => {
      const { error } = await answer(req('GET', '/v1/billing/packs', alice), 503)
      await answer(req('POST', '/v1/billing/checkout', alice, { quantity: 5 }), 503)
      return error
    }
    env.CREDIT_PRICE = undefined
    env.CREDIT_PACKS = undefined
    expect((await refused()).message).toBe('buying credits is not set up')
    env.CREDIT_PRICE = PRICE
    env.CREDIT_PACKS = PACKS
    env.STRIPE = undefined
    expect((await refused()).message).toBe('buying credits is not set up')
    env.STRIPE = stripe
    for (const price of [undefined, 'prod_x', '']) {
      env.CREDIT_PRICE = price
      expect((await refused()).message).toMatch(/^CREDIT_PRICE must be a Stripe price id/)
    }
    env.CREDIT_PRICE = PRICE
    for (const packs of [undefined, [], [5, 5], [0], [2.5], [5000], '[5]', { five: 5 }]) {
      env.CREDIT_PACKS = packs
      expect((await refused()).message).toMatch(/^CREDIT_PACKS /)
    }
    // The order they are listed in does not matter: smallest first.
    env.CREDIT_PACKS = [20, 5]
    expect((await answer(req('GET', '/v1/billing/packs', alice))).packs.map((p: any) => p.quantity)).toEqual([5, 20])
    expect(stripe.sessions).toEqual([])
  })

  it('a Checkout Session that Stripe does not make is a refusal the user can try again after', async () => {
    stripe.failWith = new Error('Stripe answered 500: something broke')
    const { error } = await answer(req('POST', '/v1/billing/checkout', alice, { quantity: 5 }), 502)
    expect(error).toEqual({ code: 'payment_unavailable', message: 'Checkout is unavailable, try again in a moment.' })
    expect(logged).toEqual(['checkout failed: Error: Stripe answered 500: something broke'])
  })

  it('serves the pages Checkout sends the buyer back to', async () => {
    const paid = await app.request('/billing/paid', {}, env)
    expect(paid.status).toBe(200)
    expect(await paid.text()).toContain('Go back to the side panel')
    const cancelled = await app.request('/billing/cancelled', {}, env)
    expect(await cancelled.text()).toContain('Nothing was bought')
  })
})

describe('UC-COFUN-BILLING-001 Buy credits: the webhook', () => {
  it('[UC-COFUN-BILLING-001-S02] a paid pack adds its credits for a year, spent after the free credits, and the free week still comes', async () => {
    await buy(alice, 5000)

    // The free week has not started: the next question brings it, beside the purchase.
    expect(await credits(alice)).toMatchObject({
      balance: 5200 * CREDIT,
      grants: [{ source: 'purchase', left: 5000 * CREDIT, expiresAt: yearAfter(START) }],
    })
    expect(billingLog).toEqual(['purchase: user=user_alice credits=5000 payment=pi_for_cs_test_1'])

    // Free credits expire first, so they are spent first.
    await ask(alice, 60)
    expect((await credits(alice)).grants).toEqual([
      { source: 'free', left: 140 * CREDIT, expiresAt: START + 7 * DAY_MS },
      { source: 'purchase', left: 5000 * CREDIT, expiresAt: yearAfter(START) },
    ])

    // A buyer keeps the weekly free credits: the next week brings them as it does for everyone.
    clock = new Date(START + 8 * DAY_MS)
    await ask(alice, 30)
    const { grants } = await credits(alice)
    expect(grants).toEqual([
      { source: 'free', left: 170 * CREDIT, expiresAt: START + 15 * DAY_MS },
      { source: 'purchase', left: 5000 * CREDIT, expiresAt: yearAfter(START) },
    ])
    // Only the buyer has them.
    expect((await credits(bob)).grants).toEqual([])
  })

  it('[UC-COFUN-BILLING-001-S03] a payment reported more than once adds its credits once', async () => {
    await checkout(alice, 5000)
    const completed = stripe.sessionEvent()
    for (const evt of [
      completed,
      completed,
      stripe.sessionEvent({ type: 'checkout.session.async_payment_succeeded' }),
    ]) {
      await answer(deliver(evt))
    }
    // Two reports handled at once grant once too: the database refuses a second grant for a payment.
    await Promise.all([answer(deliver(completed)), answer(deliver(completed))])

    expect(db.rows('grants')).toHaveLength(1)
    expect((await credits(alice)).balance).toBe(5200 * CREDIT)
    expect(billingLog).toHaveLength(1)

    // Another purchase of the same pack is a payment of its own.
    await buy(alice, 5000)
    expect((await credits(alice)).balance).toBe(10_200 * CREDIT)
  })

  it('[UC-COFUN-BILLING-001-S04] an event that Stripe did not sign adds nothing', async () => {
    await checkout(alice, 5000)
    const evt = stripe.sessionEvent()
    const payload = JSON.stringify(evt)
    const otherPayload = JSON.stringify({ ...evt, id: 'evt_other' })
    for (const header of [
      null,
      '',
      'garbage',
      await signature(payload, clock.getTime(), 'whsec_someone_else'),
      // Signed for another body.
      await signature(otherPayload, clock.getTime()),
      // Signed long ago, and sent again.
      await signature(payload, clock.getTime() - 6 * 60 * 1000),
      // Only the old scheme.
      (await signature(payload, clock.getTime())).replace('v1=', 'v0='),
    ]) {
      const { error } = await answer(deliver(evt, { header }), 400)
      expect(error.code).toBe('bad_signature')
    }
    expect(db.rows('grants')).toEqual([])

    // Without its signing secret the worker takes no event at all.
    env.STRIPE_WEBHOOK_SECRET = undefined
    await answer(deliver(evt), 503)
    expect(db.rows('grants')).toEqual([])
  })

  it('takes a signature among several, and allows for some clock skew', async () => {
    await checkout(alice, 5000)
    const evt = stripe.sessionEvent()
    const payload = JSON.stringify(evt)
    const good = await signature(payload, clock.getTime() + 60_000)
    const header = `${good.replace(/,v1=/, ',v1=0000,v1=')}`
    await answer(deliver(evt, { header }))
    expect(db.rows('grants')).toHaveLength(1)
  })

  it('[UC-COFUN-BILLING-001-S05] the credits are the pack’s, whatever currency the buyer paid in and whatever tax was added', async () => {
    await checkout(alice, 10_000)
    // Adaptive Pricing showed euros, and VAT was added.
    await answer(deliver(stripe.sessionEvent({ currency: 'eur', amountTotal: 1105 })))

    expect((await credits(alice)).grants).toEqual([
      { source: 'purchase', left: 10_000 * CREDIT, expiresAt: yearAfter(START) },
    ])
  })

  it('[UC-COFUN-BILLING-001-S06] a payment that completes later adds its credits when it goes through, and none when it fails', async () => {
    await checkout(alice, 5000)
    await answer(deliver(stripe.sessionEvent({ paymentStatus: 'unpaid' })))
    expect(db.rows('grants')).toEqual([])

    clock = new Date(START + 2 * DAY_MS)
    await answer(deliver(stripe.sessionEvent({ type: 'checkout.session.async_payment_succeeded' })))
    // The year starts when the credits arrive.
    expect((await credits(alice)).grants).toEqual([
      { source: 'purchase', left: 5000 * CREDIT, expiresAt: yearAfter(START + 2 * DAY_MS) },
    ])

    await checkout(bob, 5000)
    await answer(deliver(stripe.sessionEvent({ paymentStatus: 'unpaid' })))
    await answer(
      deliver(stripe.sessionEvent({ type: 'checkout.session.async_payment_failed', paymentStatus: 'unpaid' })),
    )
    expect((await credits(bob)).grants).toEqual([])
  })

  it('[UC-COFUN-BILLING-001-S07] what the user overspent is taken out of the purchase first', async () => {
    // 210 credits from the 200 free ones: 10 overspent.
    await ask(alice, 210)
    expect((await credits(alice)).balance).toBe(-10 * CREDIT)

    await buy(alice, 5000)

    const { balance, grants } = await credits(alice)
    expect(balance).toBe(4990 * CREDIT)
    expect(grants).toEqual([
      { source: 'free', left: 0, expiresAt: START + 7 * DAY_MS },
      { source: 'purchase', left: 4990 * CREDIT, expiresAt: yearAfter(START) },
    ])
  })

  it('[UC-COFUN-BILLING-001-S08] a refund or a dispute takes back what is left of the purchase, and nothing else', async () => {
    await answer(req('POST', '/v1/admin/accounts/user_alice/grants', admin, { credits: 300, days: 30 }))
    await buy(alice, 5000, 'pi_refunded')
    await buy(alice, 10_000, 'pi_disputed')
    // 270 credits: the 200 free ones, then 70 of the grant by hand, which expires first.
    await ask(alice, 270)
    // And 300: the rest of the grant by hand, then 70 of the first purchase.
    await ask(alice, 300)
    expect((await credits(alice)).balance).toBe(14_930 * CREDIT)

    clock = new Date(START + DAY_MS)
    await answer(deliver(refunded('pi_refunded')))
    expect((await credits(alice)).balance).toBe(10_000 * CREDIT)
    await answer(deliver(disputed('pi_disputed')))

    const { balance, grants } = await credits(alice)
    expect(balance).toBe(0)
    expect(grants).toEqual([
      { source: 'free', left: 0, expiresAt: START + 7 * DAY_MS },
      { source: 'manual', left: 0, expiresAt: START + 30 * DAY_MS },
    ])
    // The purchases ended when they were taken back, and keep what was taken back as what was left.
    const purchases = async () =>
      (await answer(req('GET', '/v1/credits/grants', alice))).grants.filter((g: any) => g.source === 'purchase')
    const history = await purchases()
    expect(history).toEqual([
      {
        source: 'purchase',
        amount: 10_000 * CREDIT,
        left: 10_000 * CREDIT,
        grantedAt: START,
        expiresAt: START + DAY_MS,
        usdCents: 1000,
        revoked: 'dispute',
      },
      {
        source: 'purchase',
        amount: 5000 * CREDIT,
        left: 4930 * CREDIT,
        grantedAt: START,
        expiresAt: START + DAY_MS,
        usdCents: 500,
        revoked: 'refund',
      },
    ])
    expect(billingLog.slice(2)).toEqual([
      'purchase taken back: payment=pi_refunded reason=refund',
      'purchase taken back: payment=pi_disputed reason=dispute',
    ])

    // Reported again, or disputed after a refund, it is taken back once, for the first reason.
    clock = new Date(START + 2 * DAY_MS)
    expect(await answer(deliver(refunded('pi_refunded')))).toMatchObject({ done: 'taken back already' })
    expect(await answer(deliver(disputed('pi_refunded')))).toMatchObject({ done: 'taken back already' })
    expect(await purchases()).toEqual(history)
    expect(billingLog.slice(4)).toEqual([
      'purchase taken back already: payment=pi_refunded',
      'purchase taken back already: payment=pi_refunded',
    ])

    // What was spent stays spent: the next question finds no credits.
    const res = await req('POST', '/v1/chat/completions', alice, { messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(402)
  })

  it('[UC-COFUN-BILLING-001-S10] a payment for anything but the pack the checkout was made for adds nothing, and is logged', async () => {
    for (const items of [
      [{ price: 'price_other', quantity: 5 }],
      [{ price: PRICE, quantity: 50 }],
      [
        { price: PRICE, quantity: 5 },
        { price: PRICE, quantity: 5 },
      ],
      [],
    ]) {
      await checkout(alice, 5000)
      const session = stripe.sessions.at(-1)!.id
      stripe.paidFor.set(session, items)
      expect(await answer(deliver(stripe.sessionEvent()))).toMatchObject({ done: 'ignored' })
    }
    // Metadata that says another quantity than the one paid for.
    await checkout(alice, 5000)
    const evt = stripe.sessionEvent()
    const metadata = { cofun_user_id: 'user_alice', cofun_quantity: '50', cofun_price: PRICE }
    const object = { ...(evt.data as any).object, metadata }
    expect(await answer(deliver({ ...evt, data: { object } }))).toMatchObject({ done: 'ignored' })

    expect(db.rows('grants')).toEqual([])
    expect(billingLog).toEqual([
      'checkout session cs_test_1 paid for 5xprice_other, not 5xprice_credits: nothing granted',
      'checkout session cs_test_2 paid for 50xprice_credits, not 5xprice_credits: nothing granted',
      'checkout session cs_test_3 paid for 5xprice_credits,5xprice_credits, not 5xprice_credits: nothing granted',
      'checkout session cs_test_4 paid for nothing, not 5xprice_credits: nothing granted',
      'checkout session cs_test_5 paid for 5xprice_credits, not 50xprice_credits: nothing granted',
    ])
  })

  it('a session made before the credit price changed still grants what it sold', async () => {
    await checkout(alice, 5000)
    // A later deploy sells credits at another price; the open session was made with the old one.
    env.CREDIT_PRICE = 'price_new'
    await answer(deliver(stripe.sessionEvent()))
    expect((await credits(alice)).grants).toEqual([
      { source: 'purchase', left: 5000 * CREDIT, expiresAt: yearAfter(START) },
    ])
  })

  it('takes no event without Stripe’s API, so Stripe sends it again later', async () => {
    await checkout(alice, 5000)
    env.STRIPE = undefined
    await answer(deliver(stripe.sessionEvent()), 503)
    env.STRIPE = stripe
    await answer(deliver(stripe.sessionEvent()))
    expect(db.rows('grants')).toHaveLength(1)
  })

  it('still grants, refunds, and disputes past purchases after sales stop', async () => {
    await checkout(alice, 5000)
    await checkout(bob, 10_000)
    // An operator takes the packs off sale.
    env.CREDIT_PRICE = undefined
    env.CREDIT_PACKS = undefined
    await answer(req('GET', '/v1/billing/packs', alice), 503)

    await answer(deliver(stripe.sessionEvent({ session: 0, payment: 'pi_alice' })))
    await answer(deliver(stripe.sessionEvent({ session: 1, payment: 'pi_bob' })))
    clock = new Date(START + DAY_MS)
    await answer(deliver(refunded('pi_alice')))

    expect((await credits(alice)).grants).toEqual([])
    expect((await credits(bob)).grants).toEqual([
      { source: 'purchase', left: 10_000 * CREDIT, expiresAt: yearAfter(START) },
    ])
  })

  it('[UC-COFUN-BILLING-001-S12] a refund that arrives before its payment is granted keeps the payment from granting', async () => {
    await checkout(alice, 5000)
    // The payment's own event fails for a while (the database is down), and the refund comes first.
    db.failWith = new Error('D1_ERROR: Network connection lost.')
    await answer(deliver(stripe.sessionEvent()), 500)
    db.failWith = undefined
    expect(await answer(deliver(refunded('pi_for_cs_test_1')))).toMatchObject({ done: 'recorded' })

    // Stripe sends the payment's event again, hours later: it grants nothing.
    clock = new Date(START + 3 * 60 * 60 * 1000)
    expect(await answer(deliver(stripe.sessionEvent()))).toMatchObject({ done: 'ignored' })
    expect(db.rows('grants')).toEqual([])
    expect(billingLog).toEqual([
      'refund for payment=pi_for_cs_test_1, which has no grant: recorded',
      'purchase: user=user_alice payment=pi_for_cs_test_1 was refunded or disputed before it was granted: nothing granted',
    ])
    // The same refund, or a dispute after it, records nothing more.
    expect(await answer(deliver(refunded('pi_for_cs_test_1')))).toMatchObject({ done: 'recorded' })
    expect(await answer(deliver(disputed('pi_for_cs_test_1')))).toMatchObject({ done: 'recorded' })
    expect(db.sqlite.prepare('SELECT * FROM revoked_payments').all()).toEqual([
      { payment: 'pi_for_cs_test_1', revoked: 'refund', at: START },
    ])
  })

  it('a refund or dispute of a payment that made no grant is acknowledged, and takes nothing', async () => {
    await buy(alice, 5000)
    for (const evt of [refunded('pi_from_the_dashboard'), disputed('pi_from_the_dashboard')]) {
      expect(await answer(deliver(evt))).toMatchObject({ done: 'recorded' })
    }
    expect((await credits(alice)).balance).toBe(5200 * CREDIT)
  })

  it('[UC-COFUN-BILLING-001-S11] what a purchase paid back of an overspend is owed again when the purchase is taken back', async () => {
    // 10 credits overspent, which the purchase pays back first.
    await ask(alice, 210)
    await buy(alice, 5000)
    expect((await credits(alice)).balance).toBe(4990 * CREDIT)

    clock = new Date(START + DAY_MS)
    await answer(deliver(disputed('pi_for_cs_test_1')))

    expect((await credits(alice)).balance).toBe(-10 * CREDIT)
    const account = await answer(req('GET', '/v1/admin/accounts/user_alice', admin))
    expect(account.debt).toBe(10 * CREDIT)
    // The next grant pays it back, like any debt.
    await answer(req('POST', '/v1/admin/accounts/user_alice/grants', admin, { credits: 100, days: 30 }))
    expect((await credits(alice)).balance).toBe(90 * CREDIT)
  })

  it('a purchase taken back the moment it was granted ends the millisecond after it began', async () => {
    await buy(alice, 5000)
    await answer(deliver(refunded('pi_for_cs_test_1')))
    // A grant must end after it begins.
    expect(db.rows('grants')).toMatchObject([{ granted_at: START, expires_at: START + 1, revoked: 'refund' }])
    clock = new Date(START + 1)
    expect((await credits(alice)).grants).toEqual([])
  })

  it('acknowledges the events it does not act on, and sessions it did not make', async () => {
    expect(await answer(deliver(event('customer.created', { id: 'cus_1', object: 'customer' })))).toEqual({
      received: true,
      done: 'ignored',
    })
    expect(await answer(deliver(event('charge.refunded', { object: 'charge', payment_intent: null })))).toMatchObject({
      done: 'ignored',
    })
    const notOurs = event('checkout.session.completed', {
      id: 'cs_other',
      object: 'checkout.session',
      mode: 'payment',
      payment_status: 'paid',
      payment_intent: 'pi_other',
      client_reference_id: null,
      metadata: {},
    })
    expect(await answer(deliver(notOurs))).toMatchObject({ done: 'ignored' })
    expect(billingLog).toEqual(['checkout session cs_other grants nothing'])
    expect(db.rows('grants')).toEqual([])
  })

  it('a paid session that can never grant is acknowledged and logged, not sent again', async () => {
    await checkout(alice, 5000)
    const evt = stripe.sessionEvent()
    // A session whose user and metadata disagree is not one the worker made.
    const mixed = { ...evt, data: { object: { ...(evt.data as any).object, client_reference_id: 'user_bob' } } }
    expect(await answer(deliver(mixed))).toMatchObject({ done: 'ignored' })
    // A paid session with no payment to record.
    const noPayment = { ...evt, data: { object: { ...(evt.data as any).object, payment_intent: null } } }
    expect(await answer(deliver(noPayment))).toMatchObject({ done: 'ignored' })
    expect(db.rows('grants')).toEqual([])
    expect(billingLog).toEqual([
      'checkout session cs_test_1 names two users: nothing granted',
      'checkout session cs_test_1 is paid with no payment intent: nothing granted',
    ])
  })

  it('an event it cannot handle fails, so Stripe sends it again, and the log says why', async () => {
    await checkout(alice, 5000)
    const evt = stripe.sessionEvent()
    // The database is unreachable: Stripe sends it again, and then it grants.
    db.failWith = new Error('D1_ERROR: Network connection lost.')
    await answer(deliver(evt), 500)
    db.failWith = undefined
    await answer(deliver(evt))
    expect(db.rows('grants')).toHaveLength(1)
    expect(logged).toEqual(['stripe event failed: Error: D1_ERROR: Network connection lost.'])
  })

  it('refuses an event too large to be Stripe’s', async () => {
    const big = event('customer.created', { id: 'cus_1', object: 'customer', note: 'x'.repeat(300 * 1024) })
    await answer(deliver(big), 413)
  })
})

describe('UC-NOTICO-BILLING-001 buy credits: purchases in the history and on the admin page', () => {
  it('[UC-NOTICO-BILLING-001-S11] a purchase shows as such in the credits and the history, with the day it expires and what it cost', async () => {
    await buy(alice, 5000)
    expect((await credits(alice)).grants).toEqual([
      { source: 'purchase', left: 5000 * CREDIT, expiresAt: yearAfter(START) },
    ])
    expect(await answer(req('GET', '/v1/credits/grants', alice))).toEqual({
      grants: [
        {
          source: 'purchase',
          amount: 5000 * CREDIT,
          left: 5000 * CREDIT,
          grantedAt: START,
          expiresAt: yearAfter(START),
          usdCents: 500,
        },
      ],
      next: null,
    })
  })

  it('[UC-COFUN-ADMIN-001-S08] an operator sees purchases in an account’s record, with their payment, and what a refund took back', async () => {
    await buy(alice, 5000, 'pi_kept')
    await buy(alice, 10_000, 'pi_refunded')
    clock = new Date(START + DAY_MS)
    await answer(deliver(refunded('pi_refunded')))

    const account = await answer(req('GET', '/v1/admin/accounts/user_alice', admin))
    expect(account).toEqual({
      userId: 'user_alice',
      balance: 5000 * CREDIT,
      debt: 0,
      grants: [
        {
          source: 'purchase',
          amount: 5000 * CREDIT,
          left: 5000 * CREDIT,
          grantedAt: START,
          expiresAt: yearAfter(START),
          payment: 'pi_kept',
        },
        {
          source: 'purchase',
          amount: 10_000 * CREDIT,
          left: 10_000 * CREDIT,
          grantedAt: START,
          expiresAt: START + DAY_MS,
          payment: 'pi_refunded',
          revoked: 'refund',
        },
      ],
    })
  })

  it('[UC-COFUN-ADMIN-002-S11] the overview counts the credits bought on their own', async () => {
    await buy(alice, 5000)
    await ask(alice, 30)
    clock = new Date(START + DAY_MS)
    await buy(bob, 10_000)

    const overview = await answer(req('GET', '/v1/admin/overview?from=2026-11-08&to=2026-11-09', admin))
    expect(overview.totals.granted).toEqual({ free: 200 * CREDIT, manual: 0, purchase: 15_000 * CREDIT })
    expect(overview.days.map((day: any) => day.granted)).toEqual([
      { free: 200 * CREDIT, manual: 0, purchase: 5000 * CREDIT },
      { free: 0, manual: 0, purchase: 10_000 * CREDIT },
    ])
  })
})

describe('Stripe over HTTP', () => {
  /** A fake of `fetch` that answers as Stripe would, and keeps what it was sent. */
  function fakeSend(status: number, body: unknown) {
    const sent: { url: string; init: RequestInit }[] = []
    const send = async (url: string, init: RequestInit) => {
      sent.push({ url, init })
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }
    return { sent, send }
  }
  const request = {
    price: 'price_credits',
    quantity: 10,
    userId: 'user_alice',
    successUrl: 'https://api.example.test/billing/paid',
    cancelUrl: 'https://api.example.test/billing/cancelled',
  }

  it('makes a one-time Checkout Session with Managed Payments, for the user and the quantity of credits', async () => {
    const { sent, send } = fakeSend(200, { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' })

    expect(await stripeOverHttp('sk_test_key', send).createCheckout(request)).toEqual({
      url: 'https://checkout.stripe.com/c/pay/cs_1',
    })

    const [{ url, init }] = sent
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      authorization: 'Bearer sk_test_key',
      'content-type': 'application/x-www-form-urlencoded',
      'stripe-version': '2025-03-31.basil',
    })
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      mode: 'payment',
      'managed_payments[enabled]': 'true',
      'line_items[0][price]': 'price_credits',
      'line_items[0][quantity]': '10',
      client_reference_id: 'user_alice',
      'metadata[cofun_user_id]': 'user_alice',
      'metadata[cofun_quantity]': '10',
      'metadata[cofun_price]': 'price_credits',
      success_url: 'https://api.example.test/billing/paid',
      cancel_url: 'https://api.example.test/billing/cancelled',
    })
  })

  it('reads what a Checkout Session sells', async () => {
    const { sent, send } = fakeSend(200, {
      object: 'list',
      data: [{ id: 'li_1', object: 'item', price: { id: 'price_credits', unit_amount: 100 }, quantity: 10 }],
      has_more: false,
    })

    expect(await stripeOverHttp('sk_test_key', send).lineItems('cs_1')).toEqual([
      { price: 'price_credits', quantity: 10 },
    ])
    expect(sent[0].url).toBe('https://api.stripe.com/v1/checkout/sessions/cs_1/line_items?limit=100')
    expect(sent[0].init).toEqual({
      method: 'GET',
      headers: { authorization: 'Bearer sk_test_key', 'stripe-version': '2025-03-31.basil' },
    })
  })

  it('fails with what Stripe said, and on an answer it does not expect', async () => {
    const refused = fakeSend(400, { error: { message: 'No such price' } })
    await expect(stripeOverHttp('sk', refused.send).createCheckout(request)).rejects.toThrow(
      'Stripe answered 400: No such price',
    )
    await expect(stripeOverHttp('sk', refused.send).lineItems('cs_1')).rejects.toThrow('Stripe answered 400')
    const odd = fakeSend(200, { id: 'cs_1', url: 'javascript:alert(1)' })
    await expect(stripeOverHttp('sk', odd.send).createCheckout(request)).rejects.toThrow('without a URL')
    const oddItems = fakeSend(200, { data: [{ price: null, quantity: 1 }], has_more: false })
    await expect(stripeOverHttp('sk', oddItems.send).lineItems('cs_1')).rejects.toThrow('does not understand')
    const many = fakeSend(200, { data: [], has_more: true })
    await expect(stripeOverHttp('sk', many.send).lineItems('cs_1')).rejects.toThrow('more than 100 line items')
  })
})

describe('the migration that adds purchases (0004)', () => {
  it('copies every grant as it was, with its id, and keeps the indexes', () => {
    const dir = join(import.meta.dirname, '../migrations')
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.sql'))
      .toSorted()
    const before = files.filter((name) => name < '0004')
    const sqlite = new DatabaseSync(':memory:')
    for (const file of before) sqlite.exec(readFileSync(join(dir, file), 'utf8'))
    sqlite.exec(`INSERT INTO grants (id, user_id, source, amount, repaid, left, granted_at, expires_at, granted_by) VALUES
      (1, 'user_a', 'free', 200000000, 0, 150000000, 1000, 2000, NULL),
      (7, 'user_a', 'manual', 50000000, 10000000, 40000000, 1500, 9000, 'user_root'),
      (9, 'user_b', 'free', 200000000, 200000000, 0, 3000, 4000, NULL)`)
    sqlite.exec(`INSERT INTO model_calls (user_id, model, started_at, ended_at, stream, outcome, finish_reason,
      prompt_tokens, cached_tokens, completion_tokens, estimated, micro_credits, owed) VALUES
      ('user_b', 'm', 10, 20, 0, 'ok', 'stop', 1, 0, 1, 0, 5, 5)`)
    const rows = sqlite.prepare('SELECT * FROM grants ORDER BY id').all()

    sqlite.exec(readFileSync(join(dir, '0004_grants_purchases.sql'), 'utf8'))

    expect(sqlite.prepare('SELECT * FROM grants ORDER BY id').all()).toEqual(
      rows.map((row) => ({ ...row, payment: null, revoked: null })),
    )
    expect(sqlite.prepare('SELECT count(*) AS n FROM model_calls').get()).toEqual({ n: 1 })
    const indexes = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'grants' ORDER BY name")
      .all()
      .map((row) => row.name)
    expect(indexes).toEqual(['grants_by_payment', 'grants_by_time', 'grants_by_user', 'grants_by_user_granted'])
    // New ids follow the copied ones.
    sqlite.exec(
      `INSERT INTO grants (user_id, source, amount, repaid, left, granted_at, expires_at) VALUES ('user_c', 'free', 1, 0, 1, 1, 2)`,
    )
    expect(sqlite.prepare("SELECT id FROM grants WHERE user_id = 'user_c'").get()).toEqual({ id: 10 })
    // A source the CHECK did not list before is now the worker's schema to check, not the table's;
    // the pairings still hold.
    expect(() =>
      sqlite.exec(
        `INSERT INTO grants (user_id, source, amount, repaid, left, granted_at, expires_at) VALUES ('user_c', 'purchase', 1, 0, 1, 1, 2)`,
      ),
    ).toThrow(/CHECK/)
    expect(() =>
      sqlite.exec(
        `INSERT INTO grants (user_id, source, amount, repaid, left, granted_at, expires_at, revoked) VALUES ('user_c', 'free', 1, 0, 1, 1, 2, 'refund')`,
      ),
    ).toThrow(/CHECK/)
  })
})
