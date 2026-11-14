// Buying credits: the packs on sale, and what the Stripe webhook does with the events it is sent.
// Stripe sells one product, 1,000 credits for US$1 (1 US dollar = 1000 credits, as everywhere), and a
// pack is a quantity of it. A paid purchase adds one grant of the paid quantity's credits, valid for a
// year; a refund or a dispute takes back what is left of it. The routes are in routes/billing.ts.
import * as z from './zod'
import { Ledger, MICRO_CREDITS, takeBack, type Database } from './credits'
import {
  AboutPayment,
  CheckoutSession,
  META_PRICE,
  META_QUANTITY,
  META_USER,
  StripeEvent,
  type StripeApi,
} from './stripe'

/** The credits one unit of the credit price buys: its price, one US dollar, at 1000 credits a dollar. */
export const CREDITS_PER_UNIT = 1000

/** The largest quantity a pack may be: a typo in the configuration must not put a fortune on sale. */
const MAX_QUANTITY = 1000

/** What is on sale: the Stripe price of 1,000 credits, and the quantities of it sold as packs, smallest first. */
export interface Offer {
  price: string
  quantities: number[]
}

/** CREDIT_PRICE: the id of the Stripe price of one unit, 1,000 credits for US$1. */
const PRICE_ID = 'must be a Stripe price id (price_…)'
const CreditPrice = z.string({ error: PRICE_ID }).regex(/^price_[A-Za-z0-9]{1,64}$/, { error: PRICE_ID })

/** CREDIT_PACKS: the quantities on sale, `[1, 5, 20, 100]`. A JSON array in wrangler.jsonc, so it arrives as one. */
const CreditPacks = z
  .array(z.int().min(1).max(MAX_QUANTITY), { error: `must be an array of quantities from 1 to ${MAX_QUANTITY}` })
  .min(1, { error: 'must list at least one quantity' })
  .refine((quantities) => new Set(quantities).size === quantities.length, { error: 'lists a quantity twice' })
  .transform((quantities) => quantities.toSorted((a, b) => a - b))

/**
 * What is on sale, as CREDIT_PRICE and CREDIT_PACKS say: nothing when neither is set, or a message
 * saying what is wrong with them.
 */
export function offerOf(price: unknown, packs: unknown): { offer?: Offer } | { error: string } {
  if (price === undefined && packs === undefined) return {}
  const parsedPrice = CreditPrice.safeParse(price)
  if (!parsedPrice.success) return { error: `CREDIT_PRICE ${parsedPrice.error.issues[0].message}` }
  const parsedPacks = CreditPacks.safeParse(packs)
  if (!parsedPacks.success) return { error: `CREDIT_PACKS ${parsedPacks.error.issues[0].message}` }
  return { offer: { price: parsedPrice.data, quantities: parsedPacks.data } }
}

/** When purchased credits stop counting: one year after the purchase, on the same day and time (UTC). */
function purchaseExpiry(now: number): number {
  const at = new Date(now)
  at.setUTCFullYear(at.getUTCFullYear() + 1)
  return at.getTime()
}

/**
 * Whom a Checkout Session is for and what it sells (a quantity of the credit price it was made with),
 * as the worker wrote it when it made the session.
 */
const Granting = z.object({
  [META_USER]: z.string().regex(/^user_[A-Za-z0-9]{1,64}$/),
  [META_PRICE]: CreditPrice,
  [META_QUANTITY]: z
    .string()
    .regex(/^\d{1,4}$/)
    .transform(Number)
    .pipe(z.int().min(1).max(MAX_QUANTITY)),
})

/** What the webhook did with an event, for the response and the log. */
export interface Handled {
  done: 'granted' | 'granted already' | 'taken back' | 'taken back already' | 'recorded' | 'ignored'
  log?: string
  /** Set when this event added a purchase's credits, and only then: who bought, and the pack's quantity. */
  purchase?: { userId: string; pack: number }
}

/**
 * Handles one event Stripe sent and signed. Events may arrive more than once and in any order, and
 * each step is safe to repeat: a payment grants once, and a purchase is taken back once. A refund or
 * a dispute can only follow a payment, but its event can arrive first: then the refund is recorded
 * against the payment, and the payment never makes a grant. Events the worker does not act on are
 * acknowledged and ignored.
 */
export async function handleEvent(db: Database, stripe: StripeApi, now: number, payload: unknown): Promise<Handled> {
  const event = StripeEvent.parse(payload)
  switch (event.type) {
    // A payment that went through at once, or one that completes later: Checkout says `unpaid` at
    // first and sends `async_payment_succeeded` when the money arrives (or `…_failed`, which grants
    // nothing).
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = CheckoutSession.parse(event.data.object)
      if (session.mode !== 'payment' || session.payment_status !== 'paid') return { done: 'ignored' }
      const granting = Granting.safeParse(session.metadata ?? {})
      // Every session the worker makes says whom it is for: one that doesn't was not made for credits.
      if (!granting.success) return { done: 'ignored', log: `checkout session ${session.id} grants nothing` }
      const userId = granting.data[META_USER]
      const quantity = granting.data[META_QUANTITY]
      const price = granting.data[META_PRICE]
      // Neither of these changes when the event is sent again, so neither is retried: each grants
      // nothing and is logged for an operator, who can grant the credits by hand.
      if (session.client_reference_id !== userId) {
        return { done: 'ignored', log: `checkout session ${session.id} names two users: nothing granted` }
      }
      // A paid session in payment mode has its PaymentIntent: without one there is nothing that a
      // refund could name later.
      if (!session.payment_intent) {
        return {
          done: 'ignored',
          log: `checkout session ${session.id} is paid with no payment intent: nothing granted`,
        }
      }
      // The credits are what was paid for: the quantity of the credit price on the session's one
      // line item, which must be the price and quantity the worker made the session for. The price is
      // the session's own, not the one on sale now: a session made before CREDIT_PRICE changed (open
      // for up to a day, or paid days later) still grants what it sold. Never worked out from
      // the amount charged, which is in the buyer's currency (Adaptive Pricing) and may include tax.
      // Anything else grants nothing: sending the event again would not change it, so it is logged
      // for an operator, not retried.
      const items = await stripe.lineItems(session.id)
      const [item] = items
      if (items.length !== 1 || item.price !== price || item.quantity !== quantity) {
        const paid = items.map((each) => `${each.quantity}x${each.price}`).join(',') || 'nothing'
        return {
          done: 'ignored',
          log: `checkout session ${session.id} paid for ${paid}, not ${quantity}x${price}: nothing granted`,
        }
      }
      const credits = quantity * CREDITS_PER_UNIT
      const added = await new Ledger(db, userId).purchase(now, {
        amount: credits * MICRO_CREDITS,
        expiresAt: purchaseExpiry(now),
        payment: session.payment_intent,
      })
      if (added === 'revoked before') {
        return {
          done: 'ignored',
          log: `purchase: user=${userId} payment=${session.payment_intent} was refunded or disputed before it was granted: nothing granted`,
        }
      }
      if (added === 'granted already') return { done: added }
      return {
        done: 'granted',
        log: `purchase: user=${userId} credits=${credits} payment=${session.payment_intent}`,
        purchase: { userId, pack: quantity },
      }
    }
    // A refund, full or partial, takes back all that is left of the purchase: purchases are final,
    // and a refund is the exception (a billing error, the law, or Stripe as the seller of record).
    // A dispute does the same as soon as it is opened; a dispute that is won gives nothing back
    // (an operator can grant the credits by hand).
    case 'charge.refunded':
    case 'charge.dispute.created': {
      const why = event.type === 'charge.refunded' ? 'refund' : 'dispute'
      const payment = AboutPayment.parse(event.data.object).payment_intent
      if (!payment) return { done: 'ignored' }
      const taken = await takeBack(db, now, payment, why)
      if (taken === 'taken back already') return { done: taken, log: `purchase taken back already: payment=${payment}` }
      if (taken === 'no grant') {
        // Nothing to take back: the payment's own event has not been handled yet, or the payment was
        // never one that grants (another charge on the account, or a session that granted nothing).
        // Either way it is recorded, so a grant that comes later is not made.
        return { done: 'recorded', log: `${why} for payment=${payment}, which has no grant: recorded` }
      }
      return { done: 'taken back', log: `purchase taken back: payment=${payment} reason=${why}` }
    }
    default:
      return { done: 'ignored' }
  }
}
