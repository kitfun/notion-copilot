// What every route of the worker shares: its bindings and options, the errors it answers with, and
// how a request's parts are parsed.
import type { Context, Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import * as z from './zod'
import type { Database } from './credits'
import type { priceOf } from './pricing'
import type { StripeApi } from './stripe'
import type { UsageDataset } from './usage'

/** The slice of the Workers AI binding this worker uses. */
export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>
}

/** The slice of a Workers rate limiting binding this worker uses: one count per key, over the binding's period. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

export interface Env {
  AI: AiBinding
  /**
   * Caps how many chat requests one user can start per period (`ratelimits` in wrangler.jsonc), keyed
   * by user id. Counted per Cloudflare location and approximate: a cap on what calls sent at once can
   * overspend, not an exact count.
   */
  CHAT_LIMIT: RateLimiter
  MODEL: string
  AI_GATEWAY_ID?: string
  /** Clerk publishable key, used by the sign-in page. */
  CLERK_PUBLISHABLE_KEY?: string
  /** Clerk JWT public key (PEM), from Clerk Dashboard > API keys. Verifies session tokens without a network call. */
  CLERK_JWT_KEY?: string
  /** Comma-separated origins allowed to call, e.g. chrome-extension://<id>. Checked against the token's azp claim. */
  CLERK_AUTHORIZED_PARTIES?: string
  /**
   * Which product each extension is, by its origin: `{"chrome-extension://<id>": "notico"}`. A JSON
   * object in wrangler.jsonc, so it arrives as an object; read through `Products`. A caller whose
   * origin is not listed (the admin page, a token with no azp) is the product `unknown`.
   */
  PRODUCTS?: unknown
  /** Every user's credits: their grants, and their model calls with what each cost (D1 database, schema in migrations/). */
  DB: Database
  /** Per-request usage records (Workers Analytics Engine dataset). Never holds message content. */
  USAGE: UsageDataset
  /** Stripe's API. Tests pass a fake; deployed, it is Stripe's own API with STRIPE_SECRET_KEY. */
  STRIPE?: StripeApi
  /** The Stripe account's secret key (a worker secret, never committed). Without it nothing can be bought. */
  STRIPE_SECRET_KEY?: string
  /** The signing secret of the Stripe webhook endpoint (a worker secret). Without it no event is accepted. */
  STRIPE_WEBHOOK_SECRET?: string
  /** The id of the Stripe price of 1,000 credits, US$1. A pack is a quantity of it. */
  CREDIT_PRICE?: string
  /** The quantities of CREDIT_PRICE on sale as packs: `[1, 5, 20, 100]` (see `offerOf` in billing.ts). */
  CREDIT_PACKS?: unknown
  /** The PostHog project's key (public by design). Without it, or without POSTHOG_HOST, no event is sent. */
  POSTHOG_KEY?: string
  /** PostHog's ingestion host, e.g. `https://us.i.posthog.com`. */
  POSTHOG_HOST?: string
}

export interface AppOptions {
  /** Clock used for credits: when they are granted and when they expire. Tests pass their own to move through the weeks. */
  now?: () => Date
  /** What a model's tokens cost: the price table by default. Tests pass their own to price a model it does not list. */
  priceOf?: typeof priceOf
  /** Where error lines go: Workers Logs by default. Tests pass their own to read what was logged. */
  logError?: (line: string) => void
  /** Where the record of what admins did goes: Workers Logs by default. Tests pass their own to read it. */
  logAdmin?: (line: string) => void
  /** Where the record of purchases granted and taken back goes: Workers Logs by default. Tests pass their own. */
  logBilling?: (line: string) => void
}

/** `claims` is the verified session token's payload, as Clerk wrote it: read it through a schema. */
type Vars = { userId: string; claims: unknown }
/** The bindings and variables of the worker's Hono app, and of each sub-app of routes. */
export type AppEnv = { Bindings: Env; Variables: Vars }
export type Ctx = Context<AppEnv>
/** The worker's Hono app, or one of the sub-apps of routes it is composed of. */
export type App = Hono<AppEnv>
/** AppOptions with every default filled in, as the routes use them. */
export type Deps = Required<AppOptions>

export class HttpError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

const MAX_LOGGED_NAME_CHARS = 60
const MAX_LOGGED_MESSAGE_CHARS = 200

/**
 * What the logs keep of an error the worker did not write: its name and the start of its message,
 * never the object. Such an error may carry anything, a quote of the request included, in its
 * message, its stack (which repeats the message), its cause, or other fields; this bounds how much
 * of that can reach Workers Logs.
 */
export function errorSummary(err: unknown): string {
  if (!(err instanceof Error)) return `non-error value of type ${typeof err}`
  const name = String(err.name).slice(0, MAX_LOGGED_NAME_CHARS)
  const message = String(err.message).slice(0, MAX_LOGGED_MESSAGE_CHARS)
  return `${name}: ${message}`
}

export const MAX_ID_CHARS = 256

export const badRequest = (message: string) => new HttpError(400, 'bad_request', message)

export const DAY_MS = 24 * 60 * 60 * 1000

/** A calendar date of this century written YYYY-MM-DD, as the UTC midnight that starts it. */
export const CalendarDate = z
  .string()
  .regex(/^20\d{2}-\d{2}-\d{2}$/)
  .transform((date, ctx) => {
    const ms = Date.parse(`${date}T00:00:00Z`)
    // A date that does not exist (02-30) is either not parsed or moved to another day.
    if (!Number.isNaN(ms) && new Date(ms).toISOString().startsWith(date)) return ms
    ctx.addIssue({ code: 'custom', message: 'not a date' })
    return z.NEVER
  })

/** A whole number as a query parameter carries it. */
export const WholeNumber = z
  .string()
  .regex(/^-?\d{1,6}$/)
  .transform(Number)

/** `schema`, refused with `message` whatever is wrong inside it. */
export function part<S extends z.ZodType>(schema: S, message: string) {
  return z.unknown().transform((value, ctx): z.output<S> => {
    const parsed = schema.safeParse(value)
    if (parsed.success) return parsed.data
    ctx.addIssue({ code: 'custom', message })
    return z.NEVER
  })
}

/** The value as `schema` gives it, or a 400 with the first thing wrong with it. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  throw badRequest(parsed.error.issues[0].message)
}
