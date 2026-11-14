// The history of a user's own credits, the grants they were given, as the side panel reads it when
// the user opens it (GET /v1/credits/grants): tested through HTTP, with a clock the tests
// move and the worker's real SQL on SQLite.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type Env } from '../src/app'
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

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const START = Date.parse('2026-11-08T12:00:00Z')
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS
/** A credit, in the micro-credits the worker answers in. */
const CREDIT = 1_000_000
/** How many grants one page holds. */
const PAGE = 20

let clock = new Date(START)
let logged: string[] = []
const app = createApp({ now: () => clock, logError: (line) => logged.push(line), logAdmin: () => {} })

let clerk: FakeClerk
let ai: FakeAiBinding
let db: FakeD1Database
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
  clock = new Date(START)
  env = {
    AI: ai,
    DB: (db = new FakeD1Database()),
    USAGE: new FakeUsageDataset(),
    CHAT_LIMIT: new FakeRateLimiter(),
    MODEL,
    CLERK_JWT_KEY: clerk.publicKeyPem,
    CLERK_AUTHORIZED_PARTIES: `${EXT}, http://localhost`,
  }
  alice = await clerk.sessionToken({ userId: 'user_alice', azp: EXT })
  bob = await clerk.sessionToken({ userId: 'user_bob', azp: EXT })
  admin = await clerk.sessionToken({ userId: 'user_root', azp: 'http://localhost', claims: { role: 'admin' } })
})

function req(method: string, path: string, bearer?: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (bearer) headers.authorization = `Bearer ${bearer}`
  const init = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }
  return app.request(path, init, env, new FakeExecutionContext())
}

/** Asks the AI something; the reply costs `credits` (a multiple of 3, so its tokens come to exactly that). */
async function ask(bearer: string, credits: number) {
  ai.usage = usageCosting(credits)
  const res = await req('POST', '/v1/chat/completions', bearer, { messages: [{ role: 'user', content: 'hi' }] })
  expect(res.status).toBe(200)
}

/** An operator grants `userId` credits by hand. */
async function grant(userId: string, credits: number, days: number) {
  const res = await req('POST', `/v1/admin/accounts/${userId}/grants`, admin, { credits, days })
  expect(res.status).toBe(200)
}

/** What a GET answers, which must be a success. */
async function get(path: string, bearer: string): Promise<any> {
  const res = await req('GET', path, bearer)
  expect(res.status).toBe(200)
  return res.json()
}

/** Every page of a user's grants, read to the end. */
async function allGrantPages(bearer: string): Promise<any[][]> {
  const pages = []
  let before: string | null = null
  do {
    const page = await get(`/v1/credits/grants${before ? `?before=${before}` : ''}`, bearer)
    pages.push(page.grants)
    before = page.next
  } while (before)
  return pages
}

const later = (ms: number) => {
  clock = new Date(clock.getTime() + ms)
}

describe('UC-NOTICO-CHAT-003 the history of the credits a user was given, and UC-COFUN-CREDITS-002 read only one’s own', () => {
  it('[UC-NOTICO-CHAT-003-S10] a user sees every grant they were given, newest first, with what went unspent of the expired ones', async () => {
    // Week one: 60 of the free credits are spent, and 140 expire unspent.
    await ask(alice, 60)
    // Week two: a new free week, and an hour later credits granted by hand for 30 days.
    later(WEEK_MS)
    await ask(alice, 30)
    later(HOUR_MS)
    await grant('user_alice', 100, 30)
    // Week three: the second free week has expired too, and the user has not come back.
    later(WEEK_MS)

    expect(await get('/v1/credits/grants', alice)).toEqual({
      grants: [
        // Whose hand it was is not the user's to see.
        {
          source: 'manual',
          amount: 100 * CREDIT,
          left: 100 * CREDIT,
          grantedAt: START + WEEK_MS + HOUR_MS,
          expiresAt: START + WEEK_MS + HOUR_MS + 30 * DAY_MS,
        },
        {
          source: 'free',
          amount: 200 * CREDIT,
          left: 170 * CREDIT,
          grantedAt: START + WEEK_MS,
          expiresAt: START + 2 * WEEK_MS,
        },
        { source: 'free', amount: 200 * CREDIT, left: 140 * CREDIT, grantedAt: START, expiresAt: START + WEEK_MS },
      ],
      next: null,
    })
  })

  it('[UC-NOTICO-CHAT-003-S10] a grant spent to the end, and one that paid back what was overspent, are in the history', async () => {
    await ask(alice, 150)
    // 50 credits are left: the call goes ahead, and overspends by 100.
    await ask(alice, 150)
    later(WEEK_MS)
    await ask(alice, 30)

    expect((await get('/v1/credits/grants', alice)).grants).toEqual([
      // 100 of the 200 paid back what was overspent, and 30 were spent.
      {
        source: 'free',
        amount: 200 * CREDIT,
        left: 70 * CREDIT,
        grantedAt: START + WEEK_MS,
        expiresAt: START + 2 * WEEK_MS,
      },
      { source: 'free', amount: 200 * CREDIT, left: 0, grantedAt: START, expiresAt: START + WEEK_MS },
    ])
  })

  it('[UC-NOTICO-CHAT-003-S10] grants are read a page at a time, to the end, each once and in order', async () => {
    // 45 grants, told apart by their amounts: 20 given an hour apart, then 25 in the same millisecond.
    for (let credits = 1; credits <= 45; credits++) {
      await grant('user_alice', credits, 30)
      if (credits <= 20) later(HOUR_MS)
    }

    const pages = await allGrantPages(alice)

    expect(pages.map((page) => page.length)).toEqual([PAGE, PAGE, 5])
    // Newest first; of grants given at the same moment, the one made last first.
    expect(pages.flat().map((g) => g.amount / CREDIT)).toEqual(Array.from({ length: 45 }, (_, i) => 45 - i))
  })

  it('a last page that is exactly full has nothing after it', async () => {
    for (let credits = 1; credits <= PAGE; credits++) await grant('user_alice', credits, 30)

    const page = await get('/v1/credits/grants', alice)

    expect(page.grants).toHaveLength(PAGE)
    expect(page.next).toBeNull()
  })

  it('a grant made while the user pages through the history does not shift the pages after it', async () => {
    for (let credits = 1; credits <= 25; credits++) await grant('user_alice', credits, 30)
    const first = await get('/v1/credits/grants', alice)

    later(HOUR_MS)
    await grant('user_alice', 99, 30)
    const second = await get(`/v1/credits/grants?before=${first.next}`, alice)

    expect(second.grants.map((g: any) => g.amount / CREDIT)).toEqual([5, 4, 3, 2, 1])
    expect(second.next).toBeNull()
  })

  it('a user who was given nothing and used nothing has an empty history, and reading it writes nothing', async () => {
    expect(await get('/v1/credits/grants', alice)).toEqual({ grants: [], next: null })
    // Looking at the history does not start the week of free credits.
    expect(db.rows('grants')).toEqual([])
    expect(db.rows('model_calls')).toEqual([])
  })

  it('reading the history writes nothing, however often', async () => {
    await ask(alice, 60)
    const before = [db.rows('grants'), db.rows('model_calls')]

    later(WEEK_MS + HOUR_MS)
    await get('/v1/credits/grants', alice)
    await get(`/v1/credits/grants?before=${START}.0`, alice)

    expect([db.rows('grants'), db.rows('model_calls')]).toEqual(before)
  })

  it('[UC-COFUN-CREDITS-002-S01] a user sees only their own history', async () => {
    for (let credits = 1; credits <= 25; credits++) await grant('user_alice', credits, 30)
    await ask(alice, 150)
    await ask(bob, 30)
    later(40 * DAY_MS)
    await ask(bob, 6)

    const free = { source: 'free', amount: 200 * CREDIT }
    expect((await get('/v1/credits/grants', bob)).grants).toMatchObject([
      { ...free, left: 194 * CREDIT, grantedAt: START + 40 * DAY_MS },
      { ...free, left: 170 * CREDIT, grantedAt: START },
    ])

    // A place in another user's history leads into the caller's own, and there is no way to name another account.
    const { next } = await get('/v1/credits/grants', alice)
    expect(next).not.toBeNull()
    // Alice's place is past her 20 newest grants of that moment; Bob has one, so nothing of his is left, and nothing of hers shows.
    expect(await get(`/v1/credits/grants?before=${next}`, bob)).toEqual({ grants: [], next: null })
    expect((await get('/v1/credits/grants?user_id=user_alice', bob)).grants).toHaveLength(2)
    // Nobody's history without a session.
    expect((await req('GET', '/v1/credits/grants')).status).toBe(401)
  })

  it('a place in the grants that no page gave is refused', async () => {
    for (const bad of ['abc', '', '12', '1.', '.1', '-1.0', '1.5.2', '1762603200000.12345', '1e3.0', '1762603200000']) {
      const res = await req('GET', `/v1/credits/grants?before=${bad}`, alice)
      const body: any = await res.json()
      expect([bad, res.status, body.error?.message]).toEqual([bad, 400, 'before must be the next of an earlier page'])
    }
    expect((await req('GET', '/v1/credits/grants?before=1762603200000.0', alice)).status).toBe(200)
  })

  it('a history that cannot be read is reported as unavailable, and the failure is logged', async () => {
    db.failWith = new Error('D1_ERROR: Network connection lost.')

    const res = await req('GET', '/v1/credits/grants', alice)
    expect(res.status).toBe(503)
    expect(((await res.json()) as any).error.code).toBe('credits_unavailable')
    expect(logged).toEqual(['credit read failed: Error: D1_ERROR: Network connection lost.'])
  })

  it('each page of grants is read through an index, without sorting or reading the whole table', async () => {
    const plan = (sql: string, ...values: (string | number)[]) =>
      db.sqlite
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...values)
        .map((row) => String(row.detail))
        .join('; ')

    const grants = plan(
      `SELECT source FROM grants WHERE user_id = ? AND granted_at <= ? ORDER BY granted_at DESC, id DESC LIMIT 21 OFFSET ?`,
      'user_alice',
      START,
      0,
    )
    expect(grants).toContain('USING INDEX grants_by_user_granted (user_id=? AND granted_at<?)')
    expect(grants).not.toMatch(/TEMP B-TREE|SCAN/)
  })
})
