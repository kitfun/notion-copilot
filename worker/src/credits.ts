import * as z from './zod'

/**
 * Credits are money: 1 US dollar = 1000 credits. Every amount is an integer number of
 * micro-credits, so the cost of a single model call is exact; amounts are rounded only when shown.
 */
export const MICRO_CREDITS = 1_000_000

/** What every user gets free each week, and how long it lasts. */
export const FREE_CREDITS = 200
const FREE_GRANT = FREE_CREDITS * MICRO_CREDITS
export const FREE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** A value bound to a statement. */
type Value = string | number | null

/** The slice of a D1 prepared statement the ledger uses. Rows read back are checked, so they are `unknown` here. */
export interface Statement {
  bind(...values: Value[]): Statement
  all(): Promise<{ results: unknown[] }>
}

/**
 * The slice of the D1 binding the ledger uses. `batch` runs its statements as one transaction, one
 * batch at a time: what a batch reads, it reads as it is when the batch runs, with no other write in
 * between. Every change to the ledger is one batch, so requests that arrive together cannot both act
 * on the same state they read.
 */
export interface Database {
  prepare(query: string): Statement
  batch(statements: Statement[]): Promise<{ results: unknown[] }[]>
}

/**
 * Credits a user was given: how many, how many are left, and when they stop counting. Times are in
 * ms. A grant is never removed: once it has expired it counts for nothing, and stays as the record
 * of what the user was given, with `left` what went unspent.
 */
interface Grant {
  /** Where the credits came from: the weekly free grant, an admin who granted them by hand, or a purchase. */
  source: z.output<typeof GrantSource>
  amount: number
  left: number
  grantedAt: number
  expiresAt: number
  /** For a grant made by hand: the Clerk user id of the admin who made it. */
  by?: string
  /** For a purchase: the Stripe payment it came from. */
  payment?: string
  /** For a purchase that was taken back: why. It ended at `expiresAt`, and `left` is what was taken back. */
  revoked?: z.output<typeof Revoked>
}

/** Where a grant's credits came from, as `grants.source` holds it. */
export const GrantSource = z.enum(['free', 'manual', 'purchase'])

/** Why a purchase was taken back, as `grants.revoked` holds it. */
export const Revoked = z.enum(['refund', 'dispute'])

/** A row of `grants` as the ledger reads it. */
const GrantRow = z
  .object({
    source: GrantSource,
    amount: z.int().min(0),
    left: z.int().min(0),
    granted_at: z.int(),
    expires_at: z.int(),
    granted_by: z.string().nullable(),
    payment: z.string().nullable(),
    revoked: Revoked.nullable(),
  })
  .transform((row): Grant => ({
    source: row.source,
    amount: row.amount,
    left: row.left,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    ...(row.granted_by === null ? {} : { by: row.granted_by }),
    ...(row.payment === null ? {} : { payment: row.payment }),
    ...(row.revoked === null ? {} : { revoked: row.revoked }),
  }))

/** The columns a grant is read with. */
const GRANT_COLUMNS = 'source, amount, left, granted_at, expires_at, granted_by, payment, revoked'

const DebtRow = z.object({ debt: z.int().min(0) })
const BalanceRow = z.object({ balance: z.int(), free_until: z.int().nullable() })
const UsageRow = z
  .object({ day: z.int(), micro_credits: z.int().min(0) })
  .transform((row) => ({ day: row.day, microCredits: row.micro_credits }))
const CountRow = z.object({ n: z.int().min(0) })

/** The one row a statement returns, checked against `schema`. */
function only<S extends z.ZodType>(schema: S, result: { results: unknown[] } | undefined): z.output<S> {
  const rows = result?.results ?? []
  if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`)
  return schema.parse(rows[0])
}

/** What a user can spend now, in micro-credits (below zero after an overdraft), and when their next free grant can arrive. */
export interface Balance {
  balance: number
  nextGrantAt: number
}

/** Which days to total a user's spending over: the last `days` days, today included, of a clock `offsetMs` ahead of UTC. */
export interface UsagePeriod {
  days: number
  offsetMs: number
}

/** What a user's model calls cost on one day. `day` counts days since 1970-01-01 on the period's clock. */
interface DayUsage {
  day: number
  microCredits: number
}

/**
 * The moments a period spans. The one definition of a user's own day: a moment belongs to the day
 * `floor((moment + offsetMs) / a day)`, here and in READ_USAGE.
 */
function spanOf(now: number, { days, offsetMs }: UsagePeriod) {
  const last = Math.floor((now + offsetMs) / DAY_MS)
  const first = last - (days - 1)
  return { from: first * DAY_MS - offsetMs, to: (last + 1) * DAY_MS - offsetMs }
}

/** Where a page of a user's grants starts: the grants given at `at` or before, without the `skip` newest of them, which an earlier page showed. */
export interface GrantsCursor {
  at: number
  skip: number
}

/** How many grants one page of a user's history holds. */
const GRANTS_PAGE = 20

/**
 * A user's credits as they see them. Amounts are in micro-credits. Unlike an `Account`, it looks
 * ahead: for a user with no free grant that still counts, it says what their next call starts with.
 */
export interface Standing {
  /** What the user's next call starts with: exactly the balance `open` gives at the same moment. */
  balance: number
  /**
   * The weekly free grant. One that still counts ends at `until`, and the next one can arrive from
   * then on. With none, the next call brings one: `toCome` is what it adds to spend, its amount
   * less what the user owes, and it is already part of `balance`. Nothing is written until that call.
   */
  free: { started: true; until: number } | { started: false; toCome: number }
  /** The grants that still count, in the order they are spent. */
  grants: Grant[]
  /** What the user's model calls cost per day, newest first; days that cost nothing are left out. */
  usage: DayUsage[]
}

/** A user's account at one moment. Amounts are in micro-credits. */
export interface Account {
  /** What the user can spend: what is left of the grants that have not expired, less the debt. */
  balance: number
  /** What the user spent beyond their grants. The next grant pays it back first. */
  debt: number
  /** Every grant the user was given, oldest first, the expired ones included. */
  grants: Grant[]
}

/** Credits bought: how many micro-credits, until when, and the Stripe payment they were bought with. */
export interface Purchase {
  amount: number
  expiresAt: number
  payment: string
}

/** Credits granted by hand: how many micro-credits, until when, and the Clerk user id of the admin granting them. */
export interface ManualGrant {
  amount: number
  expiresAt: number
  by: string
}

/**
 * A model call that ended, to record with what it cost: when it started and ended, how it ended,
 * its tokens (`estimated` when the call was cut short before the model reported them), and its cost
 * in micro-credits, 0 when it cost nothing.
 */
export interface ModelCall {
  /** The product the call came from: see `productOf` in routes/chat.ts. */
  product: string
  model: string
  startedAt: number
  endedAt: number
  stream: boolean
  outcome: string
  finishReason: string
  promptTokens: number
  cachedTokens: number
  completionTokens: number
  estimated: boolean
  cost: number
}

// How the tables hold a ledger (worker/migrations/): `grants` has one row per grant with what is
// left of it, and `model_calls` one row per model call with what it cost. What a user owes is not a
// number of its own: it is what calls cost beyond the grants (`model_calls.owed`) less what grants
// paid back (`grants.repaid`). In every statement below, ?1 is the user id and ?2 the time.

/** What a user owes, as SQL. `user` is the SQL that names the user: a parameter, or a column of an outer query. */
const debtOf = (user: string) =>
  `((SELECT coalesce(sum(owed), 0) FROM model_calls WHERE user_id = ${user} AND owed > 0)
  - (SELECT coalesce(sum(repaid), 0) FROM grants WHERE user_id = ${user} AND revoked IS NULL))`

/**
 * What a user can spend at the time `now`, as SQL: what is left of the grants that still count,
 * less the debt. The one definition of a balance in SQL, for one user (below) and for a list of
 * them (overview.ts). `user` and `now` are SQL: parameters, or columns of an outer query.
 */
export const balanceOf = (user: string, now: string) =>
  `((SELECT coalesce(sum(left), 0) FROM grants WHERE user_id = ${user} AND expires_at > ${now}) - ${debtOf(user)})`

/** What the user ?1 owes. */
const DEBT = debtOf('?1')

/**
 * The weekly free grant, given lazily when a user shows up and has no free grant that still counts:
 * no schedule runs, nothing is written for users who don't come back, and a user who returns after
 * a month gets one grant, not four. A free grant with nothing left still marks the user's week.
 * Only free grants are looked at: credits granted by hand never stand in for the free week. It is
 * one statement, so two requests arriving together cannot both grant the week. Like any grant, it
 * pays back debt first. ?3 is the amount, ?4 how long it lasts.
 */
const GIVE_FREE_GRANT = `INSERT INTO grants (user_id, source, amount, repaid, left, granted_at, expires_at)
SELECT ?1, 'free', ?3, min(?3, debt), ?3 - min(?3, debt), ?2, ?2 + ?4
FROM (SELECT ${DEBT} AS debt)
WHERE NOT EXISTS (SELECT 1 FROM grants WHERE user_id = ?1 AND source = 'free' AND expires_at > ?2)`

/** A grant by hand. ?3 is the amount, ?4 when it expires, ?5 the admin's user id. */
const GIVE_MANUAL_GRANT = `INSERT INTO grants (user_id, source, amount, repaid, left, granted_at, expires_at, granted_by)
SELECT ?1, 'manual', ?3, min(?3, debt), ?3 - min(?3, debt), ?2, ?4, ?5
FROM (SELECT ${DEBT} AS debt)`

/**
 * Credits bought. ?3 is the amount, ?4 when it expires, ?5 the payment. A payment grants once: the
 * unique index on `payment` makes the insert of a payment already granted do nothing, so a payment
 * Stripe reports twice, or two reports handled at once, add one grant. (`WHERE true` is SQLite's
 * way to put an upsert after a SELECT.)
 */
const GIVE_PURCHASE = `INSERT INTO grants (user_id, source, amount, repaid, left, granted_at, expires_at, payment)
SELECT ?1, 'purchase', ?3, min(?3, debt), ?3 - min(?3, debt), ?2, ?4, ?5
FROM (SELECT ${DEBT} AS debt)
WHERE NOT EXISTS (SELECT 1 FROM revoked_payments WHERE payment = ?5)
ON CONFLICT (payment) DO NOTHING`

/**
 * Records that the payment ?1 was refunded or disputed (?3) at ?2 before it made a grant, so it never
 * makes one. Only when it has no grant: one that has is taken back instead (TAKE_BACK). A payment
 * recorded already keeps its first reason.
 */
const REVOKE_PAYMENT = `INSERT INTO revoked_payments (payment, revoked, at)
SELECT ?1, ?3, ?2 WHERE NOT EXISTS (SELECT 1 FROM grants WHERE payment = ?1)
ON CONFLICT (payment) DO NOTHING`

/** Whether the payment ?1 was refunded or disputed before it made a grant. */
const COUNT_REVOKED_PAYMENT = `SELECT count(*) AS n FROM revoked_payments WHERE payment = ?1`

/**
 * Takes back what is left of the purchase made with the payment ?1, for the reason ?3. What it paid
 * back of the user's debt is owed again: a grant taken back no longer counts in what grants repaid
 * (see `debtOf`), since the money that paid it was returned. It ends at
 * the time ?2 (never at or before the moment it was granted, which the table does not allow), and
 * `left` stays as the record of what was taken back. One that expired already only records why.
 * A purchase taken back once is not taken back again, so a second report changes nothing and the
 * first reason stays.
 */
const TAKE_BACK = `UPDATE grants SET revoked = ?3,
  expires_at = CASE WHEN expires_at > ?2 THEN max(?2, granted_at + 1) ELSE expires_at END
WHERE payment = ?1 AND revoked IS NULL`

/** How many grants the payment ?1 made: one, or none when it was not granted (yet). */
const COUNT_PAYMENT = `SELECT count(*) AS n FROM grants WHERE payment = ?1`

/**
 * What the user's next call starts with, and until when their free week runs (null when no free
 * grant still counts). With a free grant that counts, the balance is what is stored: the grants
 * that still count, less the debt. With none, it is that plus the free grant ?3 the next call
 * brings: a grant pays back debt out of its amount, so the balance after it is the balance before
 * it plus its amount, whatever is owed. `open` reads this right after giving the grant and `look`
 * reads it without, so what a user is shown and what their next call gets are one definition.
 */
const READ_BALANCE = `SELECT stored + CASE WHEN free_until IS NULL THEN ?3 ELSE 0 END AS balance, free_until
FROM (SELECT
  ${balanceOf('?1', '?2')} AS stored,
  (SELECT max(expires_at) FROM grants WHERE user_id = ?1 AND source = 'free' AND expires_at > ?2) AS free_until)`

/** The grants that still count, in the order they are spent. */
const READ_CURRENT_GRANTS = `SELECT ${GRANT_COLUMNS}
FROM grants WHERE user_id = ?1 AND expires_at > ?2 ORDER BY expires_at, id`

/**
 * What the user's model calls cost per day from ?2 up to ?3, newest first. A call belongs to the
 * day it started on, on a clock ?4 ms ahead of UTC. Totalled from the calls themselves each time
 * (the `model_calls_by_user` index bounds it to the period): no totals are stored. The cast keeps
 * the day a whole number however the database binds ?4.
 */
const READ_USAGE = `SELECT CAST((started_at + ?4) / ${DAY_MS} AS INTEGER) AS day, sum(micro_credits) AS micro_credits
FROM model_calls WHERE user_id = ?1 AND started_at >= ?2 AND started_at < ?3
GROUP BY day HAVING sum(micro_credits) > 0 ORDER BY day DESC`

/**
 * One page of the user's grants, newest first: those given at ?2 or before, without the first ?3
 * of them, and one more than a page holds, to tell whether more follow. The
 * `grants_by_user_granted` index gives them in this order, so a page reads only its own rows. The
 * casts keep the numbers whole however the database binds them.
 */
const READ_GRANTS_PAGE = `SELECT ${GRANT_COLUMNS}
FROM grants WHERE user_id = ?1 AND granted_at <= ?2
ORDER BY granted_at DESC, id DESC LIMIT ${GRANTS_PAGE + 1} OFFSET CAST(?3 AS INTEGER)`

const READ_GRANTS = `SELECT ${GRANT_COLUMNS}
FROM grants WHERE user_id = ?1 ORDER BY granted_at, id`

const READ_DEBT = `SELECT ${DEBT} AS debt`

/**
 * The record of a model call, with the part of its cost the grants that still count do not cover:
 * what the user owes. It runs before SPEND, in the same batch, so both see the same grants. ?2 is
 * when the call ended, ?3 the model, ?4 when it started, ?5 whether it streamed, ?6 its outcome, ?7
 * its finish reason, ?8 to ?10 the prompt, cached, and completion tokens, ?11 whether they are
 * estimated, ?12 the cost, ?13 the product it came from.
 */
const RECORD_CALL = `INSERT INTO model_calls (user_id, ended_at, model, started_at, stream, outcome, finish_reason,
  prompt_tokens, cached_tokens, completion_tokens, estimated, micro_credits, owed, product)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, max(0, ?12 - coalesce(sum(left), 0)), ?13
FROM grants WHERE user_id = ?1 AND expires_at > ?2`

/**
 * Takes the cost ?3 from the grants that still count, from the one that expires first: each takes
 * what the grants before it did not cover, up to what it has left. A relative update, so calls that
 * end together each take their own cost and none is lost.
 */
const SPEND = `UPDATE grants SET left = grants.left - spend.take
FROM (
  SELECT id, min(left, ?3 - before) AS take
  FROM (
    SELECT id, left,
      coalesce(sum(left) OVER (ORDER BY expires_at, id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before
    FROM grants WHERE user_id = ?1 AND expires_at > ?2 AND left > 0
  )
  WHERE before < ?3
) AS spend
WHERE grants.id = spend.id`

/** One user's credits, over the database. Callers pass the time, in ms, so every decision uses the request's own clock. */
export class Ledger {
  constructor(
    private readonly db: Database,
    private readonly userId: string,
  ) {}

  /**
   * What the user can spend before a model call, after giving them the weekly free grant if they
   * have none. A call may go ahead while the balance is above zero; calls that start together all
   * see the same balance.
   */
  async open(now: number): Promise<Balance> {
    const [, balance] = await this.db.batch([
      this.statement(GIVE_FREE_GRANT, now, FREE_GRANT, FREE_PERIOD_MS),
      this.statement(READ_BALANCE, now, FREE_GRANT),
    ])
    const row = only(BalanceRow, balance)
    // The batch has just made sure there is a free grant.
    if (row.free_until === null) throw new Error('no free grant after granting one')
    return { balance: row.balance, nextGrantAt: row.free_until }
  }

  /**
   * The user's credits as they see them: what their next call starts with, the grants that still
   * count, and what they spent per day over `period`. Looking changes nothing: it never gives the
   * weekly free grant, so it does not start the user's week.
   */
  async look(now: number, period: UsagePeriod): Promise<Standing> {
    const { from, to } = spanOf(now, period)
    const [balanceRow, grantRows, usageRows] = await this.db.batch([
      this.statement(READ_BALANCE, now, FREE_GRANT),
      this.statement(READ_CURRENT_GRANTS, now),
      this.statement(READ_USAGE, from, to, period.offsetMs),
    ])
    const { balance, free_until: until } = only(BalanceRow, balanceRow)
    const grants = z.array(GrantRow).parse(grantRows?.results ?? [])
    const left = grants.reduce((sum, grant) => sum + grant.left, 0)
    return {
      balance,
      // Without a free grant, what the balance holds beyond the grants is what the next one adds.
      free: until === null ? { started: false, toCome: balance - left } : { started: true, until },
      grants,
      usage: z.array(UsageRow).parse(usageRows?.results ?? []),
    }
  }

  /**
   * One page of every grant the user was given, newest first, the expired ones included: the first
   * page, or the one `from` starts. `next` starts the page after it, and is absent on the last
   * one. Reading changes nothing.
   *
   * A page starts at a time, not at a grant: two grants can be given in the same millisecond, so
   * the cursor also counts how many grants of that millisecond earlier pages showed.
   */
  async grantsPage(from?: GrantsCursor): Promise<{ grants: Grant[]; next?: GrantsCursor }> {
    const { results } = await this.statement(
      READ_GRANTS_PAGE,
      from?.at ?? Number.MAX_SAFE_INTEGER,
      from?.skip ?? 0,
    ).all()
    const rows = z.array(GrantRow).parse(results)
    const grants = rows.slice(0, GRANTS_PAGE)
    const following = rows[GRANTS_PAGE]
    if (!following) return { grants }
    const shown = grants.filter((grant) => grant.grantedAt === following.grantedAt).length
    return {
      grants,
      next: { at: following.grantedAt, skip: shown + (from?.at === following.grantedAt ? from.skip : 0) },
    }
  }

  /**
   * Records a model call that ended, and takes what it cost from the user, from the grant that
   * expires first, in one batch: both are written, or neither. What the grants don't cover is
   * owed, and comes out of the next grant. The time is when the call ended.
   */
  async endCall(call: ModelCall): Promise<void> {
    const { promptTokens, cachedTokens, completionTokens, cost, startedAt, endedAt } = call
    for (const n of [promptTokens, cachedTokens, completionTokens, cost, startedAt, endedAt]) {
      if (!Number.isSafeInteger(n) || n < 0) throw new Error('a model call needs non-negative integers')
    }
    const record = this.statement(
      RECORD_CALL,
      endedAt,
      call.model,
      startedAt,
      call.stream ? 1 : 0,
      call.outcome,
      call.finishReason,
      promptTokens,
      cachedTokens,
      completionTokens,
      call.estimated ? 1 : 0,
      cost,
      call.product,
    )
    await this.db.batch(cost === 0 ? [record] : [record, this.statement(SPEND, endedAt, cost)])
  }

  /**
   * The account as it stands. Reading changes nothing: in particular it does not give the user
   * their weekly free grant, which waits for the user's own next call.
   */
  async read(now: number): Promise<Account> {
    return this.account(now, await this.db.batch(this.reads()))
  }

  /**
   * Grants credits by hand, beside the weekly free grant. Like any grant it pays back debt first.
   * It does not give the user their weekly free grant either: that still starts with their own
   * next call, so a grant by hand never uses up part of a user's free week.
   */
  async grant(now: number, { amount, expiresAt, by }: ManualGrant): Promise<Account> {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('a grant must be a positive integer')
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new Error('a grant must expire after it is made')
    const [, ...reads] = await this.db.batch([
      this.statement(GIVE_MANUAL_GRANT, now, amount, expiresAt, by),
      ...this.reads(),
    ])
    return this.account(now, reads)
  }

  /**
   * Adds credits bought with a payment, beside the other grants. Like any grant it pays back debt
   * first. A payment that was granted already adds nothing, and is not an error: Stripe reports a
   * payment more than once. Nor does one that was refunded or disputed before it was granted. Says
   * which of these it was.
   */
  async purchase(
    now: number,
    { amount, expiresAt, payment }: Purchase,
  ): Promise<'granted' | 'granted already' | 'revoked before'> {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('a grant must be a positive integer')
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new Error('a grant must expire after it is made')
    const [before, , after, revoked] = await this.db.batch([
      this.db.prepare(COUNT_PAYMENT).bind(payment),
      this.statement(GIVE_PURCHASE, now, amount, expiresAt, payment),
      this.db.prepare(COUNT_PAYMENT).bind(payment),
      this.db.prepare(COUNT_REVOKED_PAYMENT).bind(payment),
    ])
    if (only(CountRow, after).n === 0 && only(CountRow, revoked).n > 0) return 'revoked before'
    return only(CountRow, before).n === 0 ? 'granted' : 'granted already'
  }

  private reads(): Statement[] {
    return [this.statement(READ_GRANTS), this.statement(READ_DEBT)]
  }

  private account(now: number, [grantRows, debtRow]: { results: unknown[] }[]): Account {
    const grants = z.array(GrantRow).parse(grantRows?.results ?? [])
    const { debt } = only(DebtRow, debtRow)
    const left = grants.reduce((sum, grant) => sum + (grant.expiresAt > now ? grant.left : 0), 0)
    return { balance: left - debt, debt, grants }
  }

  /** A statement for this user: ?1 is the user id, and the values after it ?2, ?3, …. */
  private statement(query: string, ...values: Value[]): Statement {
    return this.db.prepare(query).bind(this.userId, ...values)
  }
}

/** How many of the payment ?1's grants have not been taken back. */
const COUNT_KEPT = `SELECT count(*) AS n FROM grants WHERE payment = ?1 AND revoked IS NULL`

/**
 * Takes back what is left of the purchase made with `payment`, after a refund or a dispute: see
 * TAKE_BACK. What was spent stays spent, and the user's other grants are untouched. A payment with
 * no grant yet is recorded instead (REVOKE_PAYMENT), so a grant that comes later is never made: both
 * happen in one batch, so a grant handled at the same moment either comes first and is taken back,
 * or comes after and is not made. Says what it found: a purchase it took back now, one taken back
 * already (nothing changes), or no grant.
 */
export async function takeBack(
  db: Database,
  now: number,
  payment: string,
  why: z.output<typeof Revoked>,
): Promise<'taken back' | 'taken back already' | 'no grant'> {
  const [kept, , , count] = await db.batch([
    db.prepare(COUNT_KEPT).bind(payment),
    db.prepare(TAKE_BACK).bind(payment, now, why),
    db.prepare(REVOKE_PAYMENT).bind(payment, now, why),
    db.prepare(COUNT_PAYMENT).bind(payment),
  ])
  if (only(CountRow, count).n === 0) return 'no grant'
  return only(CountRow, kept).n > 0 ? 'taken back' : 'taken back already'
}
