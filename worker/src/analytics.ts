// Product analytics, as the worker sends it: one event, when a payment adds credits. The extensions
// send their own usage events to PostHog themselves (extensions/notico/src/analytics.ts); a purchase
// is the one thing they never see happen, since the buyer pays on Stripe's page.
import { errorSummary } from './http'

/** A purchase that added credits: who bought, and which pack (its quantity, in units of 1,000 credits). */
export interface Purchase {
  userId: string
  pack: number
}

/** How long PostHog may take: a purchase is already granted, and Stripe is waiting for the webhook's answer. */
const TIMEOUT_MS = 3000

/**
 * Tells PostHog that a payment added credits, with the project's key (public by design). The event
 * holds the Clerk user id, so it joins the same person as the extension's events, and the pack: no
 * amount, currency, or payment reference. `$geoip_disable` keeps PostHog from working out a location
 * from the request's address, which is the worker's, not the buyer's.
 *
 * Never throws: the credits are already added, and an event that is lost must not make Stripe send
 * the payment again.
 */
export async function reportPurchase(
  key: string,
  host: string,
  { userId, pack }: Purchase,
  logError: (line: string) => void,
): Promise<void> {
  try {
    const res = await fetch(new URL('/i/v0/e/', host), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        event: 'purchase_completed',
        distinct_id: userId,
        properties: { pack, $geoip_disable: true },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`PostHog answered ${res.status}`)
  } catch (err) {
    logError(`purchase event not sent: ${errorSummary(err)}`)
  }
}
