// Buying credits: the packs on sale and Checkout (/v1/billing/*), the pages Checkout sends a buyer
// back to, and Stripe's webhook, which grants what was paid for. What each event does is in billing.ts.
import { Hono } from 'hono'
import * as z from '../zod'
import { reportPurchase } from '../analytics'
import { billingPage } from '../billing-page'
import { CREDITS_PER_UNIT, handleEvent, offerOf, type Offer } from '../billing'
import { stripeOverHttp, verifiedEvent, type StripeApi } from '../stripe'
import { HttpError, badRequest, errorSummary, parse, part, type App, type Deps, type Env } from '../http'

/** The largest event the Stripe webhook reads. Stripe's events about a Checkout Session or a charge are a few kB. */
const MAX_EVENT_BYTES = 256 * 1024

/** Stripe's API: the one tests pass, or Stripe's own with the secret key; none without a key. */
function stripeOf(env: Env): StripeApi | undefined {
  return env.STRIPE ?? (env.STRIPE_SECRET_KEY ? stripeOverHttp(env.STRIPE_SECRET_KEY) : undefined)
}

/** The routes Stripe sends buyers and events to. No Clerk session: they are not under /v1. */
export function stripeRoutes({ now, logError, logBilling }: Deps): App {
  const routes: App = new Hono()
  // Where Stripe's Checkout sends the buyer back: a page that says what happened and leads back to
  // the side panel. It holds nothing and changes nothing: credits are added by the webhook below.
  routes.get('/billing/paid', (c) => c.html(billingPage('paid')))
  routes.get('/billing/cancelled', (c) => c.html(billingPage('cancelled')))

  // Stripe's webhook. No Clerk session: the event is trusted only when it carries Stripe's
  // signature, made with the endpoint's signing secret. It answers 2xx once the event is handled or
  // is one the worker does not act on; anything else makes Stripe send the event again later, which
  // is safe, since a payment grants once and a purchase is taken back once.
  routes.post('/stripe/webhook', async (c) => {
    const secret = c.env.STRIPE_WEBHOOK_SECRET
    if (!secret) throw new HttpError(503, 'not_configured', 'STRIPE_WEBHOOK_SECRET is not set')
    const length = Number(c.req.header('content-length') ?? 0)
    if (length > MAX_EVENT_BYTES) throw new HttpError(413, 'too_large', 'event too large')
    const payload = await c.req.text()
    if (payload.length > MAX_EVENT_BYTES) throw new HttpError(413, 'too_large', 'event too large')
    const event = await verifiedEvent(payload, c.req.header('stripe-signature'), secret, now().getTime())
    if (event === undefined) throw new HttpError(400, 'bad_signature', 'not signed by Stripe')
    // Granting a purchase reads its line items from Stripe, so the webhook needs Stripe's API. It does
    // not need anything on sale: past purchases are still granted, refunded, and disputed after sales stop.
    const stripe = stripeOf(c.env)
    if (!stripe) throw new HttpError(503, 'not_configured', 'STRIPE_SECRET_KEY is not set')
    let handled
    try {
      handled = await handleEvent(c.env.DB, stripe, now().getTime(), event)
    } catch (err) {
      // An event the worker could not handle: the database failed, or the event is not what the
      // worker expects. Nothing is guessed; Stripe sends it again, and the log says why.
      logError(`stripe event failed: ${errorSummary(err)}`)
      throw new HttpError(500, 'internal', 'the event could not be handled')
    }
    if (handled.log) logBilling(handled.log)
    // Once per payment: only the event that added the credits reports the purchase, and only when
    // PostHog is set up (it is not in the tests, which send nothing).
    const { POSTHOG_KEY, POSTHOG_HOST } = c.env
    if (handled.purchase && POSTHOG_KEY && POSTHOG_HOST) {
      await reportPurchase(POSTHOG_KEY, POSTHOG_HOST, handled.purchase, logError)
    }
    return c.json({ received: true, done: handled.done })
  })

  return routes
}

/** What is on sale, and Stripe's API to sell it: or a refusal when buying is not set up. */
function billing(env: Env): { offer: Offer; stripe: StripeApi } {
  const offered = offerOf(env.CREDIT_PRICE, env.CREDIT_PACKS)
  if ('error' in offered) throw new HttpError(503, 'not_configured', `${offered.error}`)
  const stripe = stripeOf(env)
  if (!stripe || !offered.offer) throw new HttpError(503, 'not_configured', 'buying credits is not set up')
  return { offer: offered.offer, stripe }
}

/** Buying credits, mounted at /v1/billing. */
export function billingRoutes({ logError }: Deps): App {
  const routes: App = new Hono()
  // The packs of credits a signed-in user can buy, smallest first: each a quantity of the credit
  // price, US$1 for 1,000 credits, with its credits and its price in US cents. Checkout may show the
  // price in the buyer's currency, with tax.
  routes.get('/packs', (c) => {
    const { offer } = billing(c.env)
    return c.json({
      packs: offer.quantities.map((quantity) => ({
        quantity,
        credits: quantity * CREDITS_PER_UNIT,
        usdCents: quantity * 100,
      })),
    })
  })

  // Starts buying a pack: makes a Stripe Checkout Session for it, for the signed-in user, and gives
  // the URL of its page, which the side panel opens in a new tab. Nothing is granted here: the
  // webhook grants the credits once Stripe says the payment went through.
  routes.post('/checkout', async (c) => {
    const { offer, stripe } = billing(c.env)
    const { quantity } = parse(
      part(z.object({ quantity: z.int() }), 'body must be {"quantity": <a pack\'s quantity>}'),
      await c.req.json().catch(() => undefined),
    )
    if (!offer.quantities.includes(quantity)) {
      throw badRequest(`quantity must be one of the packs on sale: ${offer.quantities.join(', ')}`)
    }
    const origin = new URL(c.req.url).origin
    try {
      const { url } = await stripe.createCheckout({
        price: offer.price,
        quantity,
        userId: c.get('userId'),
        successUrl: `${origin}/billing/paid`,
        cancelUrl: `${origin}/billing/cancelled`,
      })
      return c.json({ url })
    } catch (err) {
      logError(`checkout failed: ${errorSummary(err)}`)
      throw new HttpError(502, 'payment_unavailable', 'Checkout is unavailable, try again in a moment.')
    }
  })

  return routes
}
