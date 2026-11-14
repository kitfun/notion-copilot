// The signed-in user's own credits, for the side panel (/v1/credits…): what is left, and the grants they were given.
import { Hono } from 'hono'
import * as z from '../zod'
import { CREDITS_PER_UNIT } from '../billing'
import { FREE_PERIOD_MS, Ledger, MICRO_CREDITS, type GrantsCursor, type Standing } from '../credits'
import { DAY_MS, HttpError, errorSummary, parse, part, type App, type Ctx, type Deps } from '../http'

/** How many recent days of spending a user is shown, today included. */
const USAGE_DAYS = 30
const MINUTE_MS = 60 * 1000

/**
 * How far the user's clock is ahead of UTC, in minutes, as the side panel sends it: the worker does
 * not know the user's time zone, and a day of usage should be the user's own day. Bounded to the
 * offsets that exist (UTC-12:00 to UTC+14:00). Without it, days are UTC days.
 */
const UtcOffset = part(
  z
    .string()
    .regex(/^-?\d{1,3}$/)
    .transform(Number)
    .pipe(z.int().min(-720).max(840))
    .default(0),
  'utc_offset must be a whole number of minutes from -720 to 840',
)

/** A day counted from 1970-01-01, as a date: YYYY-MM-DD. */
const dateOf = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10)

/**
 * Where a page of grants starts, as the page before it gave it in `next`: a time in ms, and how
 * many grants of that millisecond were shown already. Both bounded, so the query is.
 */
const GrantsBefore = part(
  z
    .string()
    .regex(/^\d{1,15}\.\d{1,4}$/)
    .transform((cursor): GrantsCursor => {
      const [at, skip] = cursor.split('.').map(Number)
      return { at, skip }
    })
    .optional(),
  'before must be the next of an earlier page',
)
const cursorText = ({ at, skip }: GrantsCursor) => `${at}.${skip}`

/**
 * What a purchase of `amount` micro-credits cost, in US cents: its list price, at 1000 credits a
 * dollar, which is what a purchase's credits are worked out from (see billing.ts). Checkout may
 * have charged it in the buyer's currency, with tax; the worker does not keep that.
 */
const usdCentsOf = (amount: number) => Math.round((amount / MICRO_CREDITS / CREDITS_PER_UNIT) * 100)

/**
 * A user's credits as the side panel shows them. Amounts stay in micro-credits; the panel rounds
 * them. Only what is the user's to see: a grant made by hand does not name the admin who made it.
 */
const creditsJson = ({ balance, free, grants, usage }: Standing) => ({
  balance,
  free: free.started ? free : { ...free, lastsMs: FREE_PERIOD_MS },
  grants: grants.map(({ source, left, expiresAt }) => ({ source, left, expiresAt })),
  usage: {
    days: USAGE_DAYS,
    byDay: usage.map(({ day, microCredits }) => ({ day: dateOf(day), microCredits })),
  },
})

/** The signed-in user's own credits, mounted at /v1/credits. */
export function creditsRoutes({ now, logError }: Deps): App {
  const routes: App = new Hono()
  // The signed-in user's own credits, for the side panel: what is left, when it expires and when
  // more arrive, and what was spent per day. It only reads: the weekly free grant still waits for
  // the user's next question, and is reported as not started until then.
  routes.get('/', async (c) => {
    const offsetMs = parse(UtcOffset, c.req.query('utc_offset')) * MINUTE_MS
    const period = { days: USAGE_DAYS, offsetMs }
    return c.json(creditsJson(await onOwnLedger(c, (ledger) => ledger.look(now().getTime(), period))))
  })

  /** Runs a read of the caller's own credits, or refuses the request when it fails. */
  async function onOwnLedger<T>(c: Ctx, read: (ledger: Ledger) => Promise<T>): Promise<T> {
    try {
      return await read(new Ledger(c.env.DB, c.get('userId')))
    } catch (err) {
      logError(`credit read failed: ${errorSummary(err)}`)
      throw new HttpError(503, 'credits_unavailable', 'Credits are unavailable, try again in a moment.')
    }
  }

  // The history of the signed-in user's credits: every grant they were given, newest first, the
  // expired ones included, with what is left of each (for an expired one: what went unspent), and
  // for a purchase what it cost. Never the admin who made a grant by hand. Read by the side panel
  // only when the user opens it, a page at a time, so the read above stays small. It only reads,
  // for the caller only.
  routes.get('/grants', async (c) => {
    const from = parse(GrantsBefore, c.req.query('before'))
    const { grants, next } = await onOwnLedger(c, (ledger) => ledger.grantsPage(from))
    return c.json({
      grants: grants.map(({ source, amount, left, grantedAt, expiresAt, revoked }) => ({
        source,
        amount,
        left,
        grantedAt,
        expiresAt,
        ...(source === 'purchase' ? { usdCents: usdCentsOf(amount) } : {}),
        // A purchase taken back ended at `expiresAt`, and `left` is what was taken back.
        ...(revoked ? { revoked } : {}),
      })),
      next: next ? cursorText(next) : null,
    })
  })

  return routes
}
