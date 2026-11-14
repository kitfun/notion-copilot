// Notion's internal API, as the signed-in Notion user: the only module that knows Notion's
// endpoints and request shapes. Tools call the typed methods of NotionClient, never fetch.
// The shapes come from the #64 spike (verified against Notion's web client, 2026-11).
// The worker's tests import this file too, so it uses no chrome APIs (see tab.ts for those).
import { z } from '../zod'
import { toUuid } from './hosts'

/** Why a Notion call failed, for the model and the user. */
export const NOTION_ERROR_CODES = [
  'no_notion_tab',
  'signed_out',
  'no_access',
  'in_trash',
  'notion_error',
  'outcome_unknown',
  'rate_limited',
  'over_budget',
] as const
export type NotionErrorCode = (typeof NOTION_ERROR_CODES)[number]

export class NotionError extends Error {
  /** The request may have reached Notion, but no answer came back (timeout, tab closed mid-request). */
  readonly unanswered: boolean
  /** Set when the question must stop here: what the user is told. The agent runs nothing more. */
  readonly stopsQuestion?: string
  /** The failed call may have changed the user's data anyway: always so when the outcome is unknown. */
  readonly mayHaveChanged: boolean

  constructor(
    readonly code: NotionErrorCode,
    message: string,
    options?: { cause?: unknown; unanswered?: boolean; stopsQuestion?: string; mayHaveChanged?: boolean },
  ) {
    super(message, options)
    this.name = 'NotionError'
    this.unanswered = options?.unanswered ?? false
    this.stopsQuestion = options?.stopsQuestion ?? unexpectedStop(code, message)
    this.mayHaveChanged = options?.mayHaveChanged ?? code === 'outcome_unknown'
  }
}

/**
 * For the user, when a Notion call fails in a way that isn't understood: the question stops there,
 * so the agent doesn't work around it. Failures with a known meaning (signed out, no access, in the
 * trash, no Notion tab) go to the model instead.
 */
function unexpectedStop(code: NotionErrorCode, message: string): string | undefined {
  if (code === 'outcome_unknown') return UNKNOWN_STOP
  if (code !== 'notion_error') return undefined
  const text = message.trim()
  return `${UNEXPECTED_STOP} ${/[.!?)]$/.test(text) ? text : `${text}.`}`
}

export const NO_NOTION_TAB =
  'The current tab is not a Notion page, so the Notion tools cannot be used. Tell the user to switch to a Notion page and ask again.'
export const SIGNED_OUT = 'Not signed in to Notion in this tab. Sign in to Notion and try again.'
export const NO_ACCESS = "The Notion page doesn't exist, or the signed-in Notion account has no access to it."
const IN_TRASH = 'The Notion page or block is in the trash.'
const DUPLICATE_UNKNOWN =
  'Notion did not say whether the copy was made: it may still appear. Look for it before trying again.'
export const NO_USER_MAP =
  "Notion's list of workspaces has nothing for the account signed in to this tab. Reload the Notion tab and try again."
const OUTCOME_UNKNOWN =
  'Notion did not answer, so the change may or may not have been saved. Read the page again before retrying.'
export const RATE_LIMITED = 'Notion turned this request away (too many requests, or too busy), so it was not done.'
export const BUSY_UNKNOWN =
  'Notion said it was too busy, without saying whether the change was saved, so it may or may not have been. Read the page again before retrying.'
export const NOT_SENT = 'Not sent: Notion turned an earlier request away (too many requests, or too busy).'
/** The longest wait a Retry-After can ask for; a longer one is cut to this. */
export const COOLDOWN_MAX_MS = 10 * 60_000

/**
 * A wait in words, for the user: "45 seconds", "a minute", "3 minutes". Rounded up, so it never
 * reads shorter than it is. Every message that names the wait takes its words from here.
 */
export function waitText(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000))
  if (seconds < 60) return seconds === 1 ? '1 second' : `${seconds} seconds`
  const minutes = Math.ceil(seconds / 60)
  return minutes === 1 ? 'a minute' : `${minutes} minutes`
}

/**
 * For the user, when Notion turns requests away: the question stops. With `ms`, the wait Notion
 * asked for, during which nothing more is sent; without, Notion didn't say, and a minute is only
 * advice. The agent adds a line when changes may already have been made.
 */
export function limitedStop(ms?: number): string {
  return `Notion is turning requests away right now (too many requests, or too busy), so Notico stopped. Wait ${ms ? waitText(ms) : 'a minute'}, then ask again.`
}

/** `limitedStop` when Notion doesn't say how long to wait. */
export const LIMITED_STOP = limitedStop()

/** For the user, when a question would send while the wait after Notion turned requests away is on. */
export function coolingStop(ms: number): string {
  return `Notion turned requests away a moment ago, so Notico is waiting before it sends more. Ask again in ${waitText(ms)}.`
}

/** Notion requests a question may make before the user is asked whether to go on, and how many more each yes allows. */
export const REQUEST_BUDGET = 100
/** For the model: the request was held at the budget, and the user chose to stop. */
export const OVER_BUDGET =
  'Not sent: this question reached its budget of Notion requests, and the user chose to stop. Do not work around the budget, ' +
  'for example with fewer or smaller requests; tell the user what was done so far instead.'
/** For the user, before what failed, when Notion fails in a way that isn't understood. */
export const UNEXPECTED_STOP = "Stopped after a Notion failure Notico doesn't understand:"
/** For the user, when Notion doesn't say whether a change was saved. */
export const UNKNOWN_STOP = 'Stopped: Notion did not say whether a change was saved.'
/** For the user, when they stop a question at its budget. */
export const BUDGET_STOP = 'Stopped: this question reached its budget of Notion requests.'

/** What the user is asked when a question reaches its budget. */
export function budgetQuestion(requests: number): string {
  return `This question has made ${requests} Notion requests. Continue?`
}

/**
 * The Notion requests of one question, across all its tool calls: how many were sent, and whether
 * one could have changed the user's data. Once the question has made `REQUEST_BUDGET` requests, the
 * next one waits until the user is asked whether to go on (`ask`); a yes allows as many again, and a
 * no (or nobody to ask) stops the question, with nothing more sent.
 */
export class NotionUsage {
  /** Requests that went out, or may have: failed ones included, not those known never to have left. */
  requests = 0
  /** A write (see WRITES) was sent, and Notion did not say it turned it away: it may have changed data. */
  wrote = false
  /** The people of each workspace (see workspacePeople), loaded once per question, by workspace id. */
  readonly people = new Map<string, Promise<{ id: string; name: string }[] | null>>()
  private budget = REQUEST_BUDGET
  private stopped = false
  /** The question to the user while one is open; requests sent meanwhile wait for the same answer. */
  private asking?: Promise<void>

  constructor(private readonly ask?: (question: string) => Promise<boolean>) {}

  /** Waits until another request may be sent, and counts it; throws when the user stopped at the budget. */
  async admit(): Promise<void> {
    while (!this.stopped && this.requests >= this.budget) await (this.asking ??= this.askToContinue())
    if (this.stopped) throw new NotionError('over_budget', OVER_BUDGET, { stopsQuestion: BUDGET_STOP })
    this.requests++
  }

  /** Takes back a request admitted but known never to have left (say, Chrome refused to run it). */
  unsent(): void {
    this.requests--
  }

  private async askToContinue(): Promise<void> {
    let yes = false
    try {
      yes = (await this.ask?.(budgetQuestion(this.requests))) === true
    } catch (err) {
      console.error('Could not ask whether to continue', err)
    }
    if (yes) this.budget = this.requests + REQUEST_BUDGET
    else this.stopped = true
    this.asking = undefined
  }
}

/** The endpoints under /api/v3/ the client uses. */
export type NotionEndpoint =
  | 'loadPageChunk'
  | 'syncRecordValuesMain'
  | 'saveTransactionsFanout'
  | 'search'
  | 'queryCollection'
  | 'getSpaces'
  | 'enqueueTask'
  | 'getTasks'
  | 'deleteContentRecords'
  | 'getTeamsV2'
  | 'getVisibleUsers'

/** What one request to Notion returned. `error` is set when no HTTP response came back. */
export interface NotionResponse {
  status: number
  json: unknown
  /** The tab's signed-in Notion user (the `notion_user_id` cookie), if it has one. */
  userId?: string
  error?: string
  /** Notion answered with a redirect (likely to a sign-in page), which was not followed. */
  redirected?: boolean
  /** Notion's Retry-After header, if it sent one. */
  retryAfter?: string
}

/** Sends one request to Notion as the user of a Notion tab (see tab.ts). */
export type NotionTransport = (
  endpoint: NotionEndpoint,
  body: unknown,
  options: { spaceId?: string },
) => Promise<NotionResponse>

const OTHER_TABLES = [
  'collection',
  'collection_view',
  'discussion',
  'comment',
  'notion_user',
  'space',
  'space_view',
  'team',
] as const
/** The tables whose records are read as plain records; a block has fields of its own. */
type OtherTable = (typeof OTHER_TABLES)[number]
type Table = 'block' | OtherTable

// What Notion answers, as far as this client reads it. Notion's internal API adds fields often and
// leaves others out, so the schemas are loose: fields they don't name pass through untouched, and a
// field that is not what is expected counts as missing (see #214 for stopping the question instead).
const text = z.string().optional().catch(undefined)
/** A list field's ids: the texts in it, in order; anything else in the list is left out. */
const idList = z
  .array(z.unknown())
  .transform((list) => list.filter((item): item is string => typeof item === 'string'))
  .optional()
  .catch(undefined)
const fields = z.record(z.string(), z.unknown()).optional().catch(undefined)

const RECORD = {
  id: z.string(),
  // Every record has one. One that came without is kept without: edit_page can't tell whether such
  // a block changed since it was read, and refuses to edit it.
  version: z.number().optional().catch(undefined),
  alive: z.boolean().optional().catch(undefined),
  space_id: text,
  parent_id: text,
  parent_table: text,
}
const NotionRecordSchema = z.looseObject(RECORD)
const BlockSchema = z.looseObject({
  ...RECORD,
  // A block without a type is no known type: every comparison with one fails, as before.
  type: z.string().catch(''),
  properties: fields,
  content: idList,
  format: fields,
})

/** One record, unwrapped from Notion's `{ spaceId, value: { role, value } }`. */
export type NotionRecord = z.output<typeof NotionRecordSchema>
export type Block = z.output<typeof BlockSchema>

/** Records by table, then by id. */
export type RecordMap = { block?: Record<string, Block> } & Partial<Record<OtherTable, Record<string, NotionRecord>>>

export interface Pointer {
  table: Table
  id: string
  spaceId?: string
}

/**
 * One write. Only these commands are used: `set` creates a record, `update` changes non-property
 * fields, the list commands edit child lists, and `updateBlockPropertyValue` changes property
 * values, text included. Notion rejects `set` on an existing block's properties. `moveToPrivate`
 * puts a new page at the top of the user's Private section. `insertChildrenAfter` moves existing
 * blocks into a parent: Notion takes them out of their old parent itself. `removeChild` on a
 * page's parent moves the page to the trash. `updateCollectionPropertySchema` and
 * `updateCollectionDeletedPropertySchema` change a database's properties (see collectionOps).
 */
export interface Operation {
  pointer: Pointer
  path: string[]
  command:
    | 'set'
    | 'update'
    | 'listAfter'
    | 'listBefore'
    | 'listRemove'
    | 'removeChild'
    | 'insertChildrenAfter'
    | 'updateBlockPropertyValue'
    | 'moveToPrivate'
    | 'updateCollectionPropertySchema'
    | 'updateCollectionDeletedPropertySchema'
  args: unknown
}

/** A signed-in user's own view of a workspace, which holds their Private section. */
export interface SpaceView {
  userId: string
  spaceId: string
  spaceViewId: string
}

/** A workspace's sidebar: page ids by section. */
export interface WorkspaceTree {
  name: string
  privatePages: string[]
  sharedPages: string[]
  workspacePages: string[]
  teams: { name: string; pages: string[] }[]
  /** Why the teamspaces could not be loaded, when they couldn't; the other sections still are. */
  teamsError?: string
}

/** One search hit as Notion returns it. Highlights mark matched words with a random tag per response. */
const SearchHit = z.looseObject({
  id: z.string(),
  score: z.number().optional().catch(undefined),
  // Loose too: the tag Notion marks matches with is found across every text a highlight holds.
  highlight: z.looseObject({ title: text, text: text, pathText: text }).optional().catch(undefined),
  highlightBlockId: text,
})
type RawSearchResult = z.output<typeof SearchHit>
/** A search response: hits that don't parse are left out, and a total that isn't a count is missing. */
const SearchResponse = z.looseObject({
  results: z
    .array(z.unknown())
    .catch([])
    .transform((hits) =>
      hits.flatMap((hit) => {
        const parsed = SearchHit.safeParse(hit)
        return parsed.success ? [parsed.data] : []
      }),
    ),
  // zod 4 numbers are finite.
  total: z.number().optional().catch(undefined),
  recordMap: z.unknown().optional(),
})

export interface SearchResults {
  results: RawSearchResult[]
  total: number
  /** The pages found, and their workspace. */
  recordMap: RecordMap
}

/** A page and everything loadPageChunk returns with it (descendants, databases, comments). */
export interface LoadedPage {
  page: Block
  spaceId: string
  recordMap: RecordMap
  /** False if the page had more chunks than `maxChunks`. */
  complete: boolean
  /** The Notion user it was loaded as: the tab's signed-in user. */
  userId?: string
}

/**
 * How a duplicate's progress is checked: first after `firstMs`, then twice as long each time up to
 * `maxMs`, `polls` times at most, so a slow copy costs Notion few requests.
 */
export const DUPLICATE_POLLING = { firstMs: 1_000, maxMs: 5_000, polls: 15 }
/** How many checks in a row may report an error on a running copy before giving up on it. */
const TASK_ERROR_POLLS = 3

const CHUNK_LIMIT = 100
/** Blocks a page lists but didn't send (closed toggles) that one read looks up at most. */
export const NESTED_MAX = 300
/** How many levels of nesting one read walks to find them: at most one lookup per level, or a few per level when many are missing. */
const NESTED_LEVELS = 8
/** Blocks whose children belong to another page: a page read doesn't look inside them. */
const NESTED_STOP = new Set(['page', 'collection_view_page', 'collection_view'])
/** Records asked for in one syncRecordValuesMain request at most. */
const RECORDS_BATCH = 100
/** Record lookups sent at once at most. */
const RECORDS_PARALLEL = 4

/**
 * The most people whose names a mention lookup loads: five requests' worth. A larger workspace would
 * cost a request per 100 people for every question that mentions someone.
 */
export const PEOPLE_MAX = 5 * RECORDS_BATCH

/** Endpoints that change the user's data: a request to one counts as a write (see NotionUsage.wrote). */
const WRITES = new Set<NotionEndpoint>(['saveTransactionsFanout', 'enqueueTask', 'deleteContentRecords'])

/** Statuses with which Notion says it gets too many requests (429) or is too busy (529). */
const LIMITED = new Set([429, 529])

/**
 * Where the end of the wait is kept, so that every side panel of the browser keeps to it, and one
 * opened later too (see tab.ts for the one over chrome.storage).
 */
export interface CooldownStore {
  /** The end time kept, if any: whatever is there, checked by the cooldown. */
  load(): Promise<unknown>
  save(until: number): Promise<void>
  /** Calls `listener` with the end time whenever one is saved, by any side panel. */
  onChange(listener: (until: unknown) => void): void
}

/**
 * The wait Notion asks for when it turns a request away (Retry-After): until it is over, no
 * client sends anything, so asking again sooner doesn't press the account further. When Notion
 * doesn't say how long, there is no wait: the question has stopped, and only the user asking
 * again sends anything. A side panel has one for all its
 * clients, and with a `store` every side panel keeps to the same wait: another Notion tab's, and
 * one opened or reloaded later (see tab.ts). `now` is the clock, which tests set. The end is a
 * time of day, the only clock side panels share: a clock set forward ends the wait early.
 */
export class NotionCooldown {
  /** When the wait ends, by `now`'s clock; kept here so `left` needs no storage read. */
  private until = 0
  private loading?: Promise<void>
  /** Whether the store's changes are followed already. */
  private following = false

  constructor(
    public now: () => number = () => Date.now(),
    private readonly store?: CooldownStore,
  ) {}

  /**
   * Resolves once the wait kept in the store is known here, and later changes to it are followed.
   * Nothing may be sent before. A store that fails is logged, and the wait is this panel's only
   * until a later call loads it: each call tries again after a failure.
   */
  ready(): Promise<void> {
    return (this.loading ??= this.load().then((loaded) => {
      if (!loaded) this.loading = undefined
    }))
  }

  /** Whether the store's wait was loaded, and its changes are followed. */
  private async load(): Promise<boolean> {
    if (!this.store) return true
    try {
      if (!this.following) this.store.onChange((until) => this.changed(until))
      this.following = true
      this.adopt(await this.store.load())
      return true
    } catch (err) {
      console.error('Could not load the wait after Notion turned requests away', err)
      return false
    }
  }

  /**
   * The store's end time changed. Side panels turned away at the same moment each save their own
   * end, and the last one saved may be the earlier: the panel whose wait ends later saves it again,
   * so that a panel opened afterwards loads the later end.
   */
  private changed(until: unknown): void {
    this.adopt(until)
    // `left` first cuts an end here that is too far ahead, so that one is never saved back.
    if (this.left() > 0 && typeof until === 'number' && until < this.until) this.save()
  }

  /** Takes an end time from the store, unless the wait here ends later, or it isn't a time. */
  private adopt(until: unknown): void {
    if (typeof until === 'number' && Number.isFinite(until)) this.until = Math.max(this.until, until)
  }

  private save(): void {
    this.store?.save(this.until).catch((err: unknown) => {
      console.error('Could not keep the wait after Notion turned requests away', err)
    })
  }

  /**
   * Starts the wait Notion's Retry-After asks for (at most COOLDOWN_MAX_MS). Without one that is
   * understood, no wait starts.
   */
  start(retryAfter?: string): void {
    // First cuts an end kept from before that is too far ahead, so the new wait is not lost behind it.
    this.left()
    const now = this.now()
    const wait = waitFor(retryAfter, now)
    if (!wait) return
    this.until = Math.max(this.until, now + wait)
    this.save()
  }

  /**
   * For tests, as a browser started anew: ends the wait in this side panel and in the store, and
   * has the next `ready` load the store, and follow it, again.
   */
  clear(): void {
    this.until = 0
    this.loading = undefined
    this.following = false
    this.save()
  }

  /** How long until requests may be sent again; 0 when they may. Never more than COOLDOWN_MAX_MS. */
  left(): number {
    const now = this.now()
    // No wait is ever longer, so an end further ahead means the clock was set back since. It is
    // moved, not just reported shorter: the wait would otherwise last until the clock caught up.
    if (this.until - now > COOLDOWN_MAX_MS) {
      this.until = now + COOLDOWN_MAX_MS
      this.save()
    }
    return Math.max(0, this.until - now)
  }
}

/** Retry-After as a date, the only form HTTP still writes: `Tue, 10 Nov 2026 08:02:00 GMT`. */
const HTTP_DATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/

/**
 * The wait Retry-After asks for, in whole seconds or as an HTTP date, up to COOLDOWN_MAX_MS; 0
 * when there is none, it has passed, or it is anything else: that is not guessed at (Date.parse
 * alone would make a date of much that isn't one).
 */
function waitFor(retryAfter: string | undefined, now: number): number {
  const text = retryAfter?.trim() ?? ''
  const ms = /^\d+$/.test(text) ? Number(text) * 1000 : HTTP_DATE.test(text) ? Date.parse(text) - now : Number.NaN
  return Number.isNaN(ms) ? 0 : Math.min(Math.max(ms, 0), COOLDOWN_MAX_MS)
}

export class NotionClient {
  /**
   * Notion turned a request away: this client sends nothing more after it (requests already in
   * flight, such as parallel batches, still get their answers). A client serves one tool call; the
   * agent ending the question keeps later tools from sending, and the cooldown later questions
   * when Notion said how long to wait.
   */
  private limited = false

  /**
   * The Notion user this client's requests go as (the tab's signed-in user), from Notion's latest
   * answer; undefined before the first one. Writes name it as the creator or last editor.
   */
  userId?: string

  /** `usage`: the question this client's requests count toward, if any; `cooldown`: the wait it keeps to. */
  constructor(
    private readonly send: NotionTransport,
    private readonly usage?: NotionUsage,
    private readonly cooldown?: NotionCooldown,
  ) {}

  /** Loads a page with its content, following loadPageChunk's cursor until the page is complete. */
  async loadPage(id: string, { maxChunks = 50 } = {}): Promise<LoadedPage> {
    const pageId = notionId(id)
    const recordMap: RecordMap = {}
    let cursor: unknown = { stack: [] }
    let spaceId: string | undefined
    let user: string | undefined
    // Chunks overlap (the page and some parents repeat); merging de-duplicates them by id.
    for (let chunkNumber = 0; chunkNumber < Math.max(1, maxChunks); chunkNumber++) {
      const { json, userId } = await this.request(
        'loadPageChunk',
        { page: { id: pageId }, limit: CHUNK_LIMIT, cursor, chunkNumber, verticalColumns: false },
        spaceId,
      )
      mergeRecordMaps(recordMap, normalizeRecordMap(json.recordMap))
      const page = recordMap.block?.[pageId]
      user = userId
      if (!page) throw missingRecord(userId)
      if (page.alive === false) throw new NotionError('in_trash', IN_TRASH)
      if (!page.space_id) throw new NotionError('notion_error', 'Notion returned the page without its workspace.')
      spaceId = page.space_id
      // The cursor goes back to Notion as it came; only whether it holds more is read.
      if (!PageCursor.safeParse(json.cursor).data?.stack.length) {
        await this.loadNested(pageId, spaceId, recordMap)
        return { page, spaceId, recordMap, complete: true, userId: user }
      }
      cursor = json.cursor
    }
    return { page: recordMap.block![pageId], spaceId: spaceId!, recordMap, complete: false, userId: user }
  }

  /**
   * Loads the blocks a loaded page lists but loadPageChunk left out: Notion sends a closed
   * toggle's (or toggle heading's) children only once they were opened. Looks up the missing
   * ids level by level, as Notion's client does when a toggle opens, up to `NESTED_MAX` blocks and
   * `NESTED_LEVELS` levels, and never inside child pages or databases. What is still missing shows as not loaded.
   */
  private async loadNested(pageId: string, spaceId: string, recordMap: RecordMap): Promise<void> {
    // Every id is visited once, so a block listed twice, or a loop in `content`, can't repeat.
    const seen = new Set([pageId])
    let asked = 0
    let level = [pageId]
    for (let depth = 0; level.length && depth < NESTED_LEVELS && asked < NESTED_MAX; depth++) {
      const missing: string[] = []
      const next: string[] = []
      for (const id of level) {
        const block = recordMap.block?.[id]
        if (!block || (id !== pageId && NESTED_STOP.has(block.type))) continue
        for (const child of block.content ?? []) {
          if (seen.has(child)) continue
          seen.add(child)
          if (recordMap.block?.[child]) next.push(child)
          else missing.push(child)
        }
      }
      const ask = missing.slice(0, NESTED_MAX - asked)
      asked += ask.length
      if (ask.length) {
        mergeRecordMaps(recordMap, await this.findRecords(ask.map((id) => ({ table: 'block', id, spaceId }))))
        next.push(...ask.filter((id) => recordMap.block?.[id]))
      }
      level = next
    }
  }

  /** Loads specific records of any table. Every requested record must come back. */
  async getRecords(pointers: Pointer[]): Promise<RecordMap> {
    if (pointers.length === 0) return {}
    const requested = pointers.map((p) => ({
      ...p,
      id: notionId(p.id),
      spaceId: p.spaceId ? notionId(p.spaceId) : undefined,
    }))
    const spaces = new Set(requested.flatMap((p) => (p.spaceId ? [p.spaceId] : [])))
    const { json, userId } = await this.request(
      'syncRecordValuesMain',
      { requests: requested.map((pointer) => ({ pointer, version: -1 })) },
      spaces.size === 1 ? [...spaces][0] : undefined,
    )
    const recordMap = normalizeRecordMap(json.recordMap)
    if (requested.some((p) => !recordMap[p.table]?.[p.id])) throw missingRecord(userId)
    if (requested.some((p) => recordMap[p.table]![p.id].alive === false)) throw new NotionError('in_trash', IN_TRASH)
    return recordMap
  }

  /**
   * The rows of a database, at most `limit` of them, through one of its views. The view's own
   * filters and sorts are not applied: every row comes back, in Notion's default order, or ordered
   * by `sort` (a property's schema key), so the `limit` read are the first in that order. Notion
   * only returns rows the signed-in account can open.
   */
  async queryCollection(
    collectionId: string,
    viewId: string,
    spaceId: string,
    limit: number,
    { sort }: { sort?: { property: string; direction: 'ascending' | 'descending' } } = {},
  ): Promise<{ rowIds: string[]; hasMore: boolean; recordMap: RecordMap }> {
    const space = notionId(spaceId)
    const { json } = await this.request(
      'queryCollection',
      {
        source: { type: 'collection', id: notionId(collectionId), spaceId: space },
        collectionView: { id: notionId(viewId), spaceId: space },
        loader: {
          type: 'reducer',
          reducers: { collection_group_results: { type: 'results', limit } },
          sort: sort ? [sort] : [],
          searchQuery: '',
          // The user's own zone, as the tool's `Today:` uses.
          userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      },
      space,
    )
    const group = QueryResult.safeParse(json).data?.result.reducerResults.collection_group_results
    return {
      rowIds: ids(group?.blockIds),
      hasMore: group?.hasMore === true,
      recordMap: normalizeRecordMap(json.recordMap),
    }
  }

  /** Like getRecords, but records that are missing, out of reach, or in the trash are just left out. */
  async findRecords(pointers: Pointer[]): Promise<RecordMap> {
    if (!pointers.length) return {}
    // Large lists go in batches, so no single request grows without bound.
    if (pointers.length > RECORDS_BATCH) {
      const batches: Pointer[][] = []
      for (let at = 0; at < pointers.length; at += RECORDS_BATCH) batches.push(pointers.slice(at, at + RECORDS_BATCH))
      // A few batches at a time, so a long list doesn't flood the user's tab with requests.
      const out: RecordMap = {}
      for (let at = 0; at < batches.length; at += RECORDS_PARALLEL) {
        const maps = await settleAll(batches.slice(at, at + RECORDS_PARALLEL).map((b) => this.findRecords(b)))
        for (const map of maps) mergeRecordMaps(out, map)
      }
      return out
    }
    const requested = pointers.map((p) => ({
      ...p,
      id: notionId(p.id),
      spaceId: p.spaceId ? notionId(p.spaceId) : undefined,
    }))
    const spaces = new Set(requested.flatMap((p) => (p.spaceId ? [p.spaceId] : [])))
    const { json } = await this.request(
      'syncRecordValuesMain',
      { requests: requested.map((pointer) => ({ pointer, version: -1 })) },
      spaces.size === 1 ? [...spaces][0] : undefined,
    )
    const recordMap = normalizeRecordMap(json.recordMap)
    for (const records of Object.values(recordMap)) {
      for (const [id, record] of Object.entries(records ?? {})) if (record.alive === false) delete records![id]
    }
    return recordMap
  }

  /** Every signed-in user's views of their workspaces, from each user's root record. */
  async spaceViews(): Promise<SpaceView[]> {
    const { json } = await this.request('getSpaces', {})
    const views: SpaceView[] = []
    for (const [userId, raw] of Object.entries(json)) {
      const root = unwrap(NotionRecordSchema, UserRoots.safeParse(raw).data?.user_root[userId])
      const pointers = Array.isArray(root?.space_view_pointers) ? root.space_view_pointers : []
      for (const pointer of pointers) {
        const p = SpaceViewPointer.safeParse(pointer).data
        if (p) views.push({ userId, spaceId: p.spaceId, spaceViewId: p.id })
      }
    }
    return views
  }

  /**
   * How a workspace is organized in the sidebar for the signed-in user: its name, their private
   * pages, pages shared with them, the workspace's own top-level pages, and the teamspaces they
   * joined, in the sidebar's order.
   */
  async getSpace(spaceId: string): Promise<WorkspaceTree> {
    const space = notionId(spaceId)
    const { json, userId } = await this.request('getSpaces', {}, space)
    // One record map per signed-in user, keyed by user id; only the tab's active user's counts. No
    // fallback to the others: another account's map would list that account's private pages, and
    // every later request runs as the active user anyway.
    if (!userId) throw new NotionError('signed_out', SIGNED_OUT)
    // The cookie's id, with or without hyphens, as getSpaces may key it.
    const key = [userId, toUuid(userId), toUuid(userId)?.replace(/-/g, '')].find((k) => k && json[k])
    if (!key) throw new NotionError('notion_error', NO_USER_MAP)
    const map = normalizeRecordMap(json[key])
    if (!map.space?.[space]) throw new NotionError('no_access', NO_ACCESS)
    const record = map.space[space]
    const view = Object.values(map.space_view ?? {}).find((v) => v.space_id === space)
    const settings = SpaceSettings.safeParse(record.settings).data
    let teams: WorkspaceTree['teams'] = []
    let teamsError: string | undefined
    // Teamspaces come from a request of their own, unless the workspace has them turned off; if it
    // fails, the rest of the sidebar still lists.
    if (settings?.is_teams_enabled !== false) {
      try {
        teams = await this.joinedTeams(space)
      } catch (err) {
        // A failure that stops the question is passed on, not shown as missing teamspaces.
        if (!(err instanceof NotionError) || err.stopsQuestion) throw err
        teamsError = err.message
      }
    }
    return {
      name: typeof record.name === 'string' ? record.name : 'Workspace',
      privatePages: ids(view?.private_pages),
      sharedPages: ids(view?.shared_pages_manual_sort),
      workspacePages: ids(record.pages),
      teams,
      ...(teamsError ? { teamsError } : {}),
    }
  }

  /**
   * The teamspaces of a workspace the signed-in user joined, in the sidebar's order, with their
   * top-level pages. getSpaces doesn't hold them; Notion's sidebar loads them like this.
   */
  private async joinedTeams(space: string): Promise<WorkspaceTree['teams']> {
    const { json } = await this.request('getTeamsV2', { spaceId: space, teamTypes: ['Joined'] }, space)
    const records = normalizeRecordMap(json.recordMap).team ?? {}
    const teams = Array.isArray(json.teams) ? json.teams : []
    return teams.flatMap((listed: unknown) => {
      const joined = JoinedTeam.safeParse(listed).data
      const team = joined ? records[joined.id] : undefined
      // Archived teamspaces leave the sidebar.
      if (!team || team.alive === false || team.archived_by || team.space_id !== space) return []
      return [
        { name: typeof team.name === 'string' && team.name ? team.name : 'Teamspace', pages: ids(team.team_pages) },
      ]
    })
  }

  /**
   * The people of a workspace the signed-in user can see (members and guests) who have a name: the
   * people Notion's own @ menu offers. One request lists them, then one per 100 people loads their
   * names; once per question, so later tools in it send none. Null for a workspace with more than
   * `PEOPLE_MAX` people, whose names are not loaded: that would take too many requests.
   */
  async workspacePeople(spaceId: string): Promise<{ id: string; name: string }[] | null> {
    const space = notionId(spaceId)
    const known = this.usage?.people.get(space)
    if (known) return known
    const loading = this.loadPeople(space)
    // A lookup that failed is not kept: the question stops, or a later tool may try again.
    this.usage?.people.set(space, loading)
    loading.catch(() => this.usage?.people.delete(space))
    return loading
  }

  private async loadPeople(space: string): Promise<{ id: string; name: string }[] | null> {
    const { json } = await this.request('getVisibleUsers', { spaceId: space }, space)
    if (!Array.isArray(json.users))
      throw new NotionError('notion_error', 'Notion returned no list of workspace members.')
    const userIds = [
      ...new Set(
        json.users.flatMap((listed: unknown) => {
          const user = VisibleUser.safeParse(listed).data
          return user ? [notionId(user.userId)] : []
        }),
      ),
    ]
    if (userIds.length > PEOPLE_MAX) return null
    const users =
      (await this.findRecords(userIds.map((id) => ({ table: 'notion_user' as const, id })))).notion_user ?? {}
    return userIds.flatMap((id) => {
      const name = users[id]?.name
      return typeof name === 'string' && name.trim() ? [{ id, name: name.trim() }] : []
    })
  }

  /** Applies operations in one transaction: Notion applies all of them or none. */
  async submitTransaction(space: string, operations: Operation[], userAction: string): Promise<void> {
    const spaceId = notionId(space)
    // Text lives in CRDT form too; the server keeps it in sync with `properties`. Writing it
    // directly would corrupt the block.
    if (operations.some((op) => op.path.includes('crdt_data') || hasCrdtData(op.args))) {
      throw new NotionError('notion_error', 'Operations must not write crdt_data.')
    }
    // Records are keyed by dashed, lowercase ids; Notion's own client also names the space on each pointer.
    const ops = operations.map((op) => ({
      ...op,
      pointer: {
        ...op.pointer,
        id: notionId(op.pointer.id),
        spaceId: op.pointer.spaceId ? notionId(op.pointer.spaceId) : spaceId,
      },
    }))
    try {
      await this.request(
        'saveTransactionsFanout',
        {
          requestId: crypto.randomUUID(),
          transactions: [{ id: crypto.randomUUID(), spaceId, debug: { userAction }, operations: ops }],
        },
        spaceId,
      )
    } catch (err) {
      // Notion may have applied it; a blind retry could apply it twice (say, a duplicated block).
      if (err instanceof NotionError && err.unanswered) {
        throw new NotionError('outcome_unknown', OUTCOME_UNKNOWN, { cause: err })
      }
      throw err
    }
  }

  /**
   * Copies a page with everything in it (content, child pages, databases), as Notion's Duplicate
   * does: Notion copies it on its side, puts the copy right after the page in `parentId`, and adds
   * a number to its title. Resolves with the copy's id once Notion has finished.
   */
  async duplicatePage(
    space: string,
    pageId: string,
    parentId: string,
    { signal }: DuplicateOptions = {},
  ): Promise<string> {
    const spaceId = notionId(space)
    const page = notionId(pageId)
    const parent = notionId(parentId)
    let taskId: unknown
    try {
      // Without the workspace on the request, Notion routes the task where the page isn't, and it fails.
      // Stopped while it is sent, the task may have reached Notion: the outcome is unknown.
      const { json } = await cutShort(
        this.request(
          'enqueueTask',
          {
            task: {
              eventName: 'duplicateSubtree',
              request: {
                source: { ids: [page], spaceId },
                destination: { type: 'block', parent: { table: 'block', id: parent, spaceId }, siblingId: page },
                options: { appendNumericTitleSuffix: true },
                userAction: 'Notico: duplicate_page',
              },
              cellRouting: { spaceIds: [spaceId] },
            },
          },
          spaceId,
        ),
        undefined,
        signal,
      )
      taskId = json.taskId
    } catch (err) {
      if (err instanceof NotionError && (err.unanswered || err.code === 'outcome_unknown'))
        throw new NotionError('outcome_unknown', DUPLICATE_UNKNOWN, { cause: err, stopsQuestion: err.stopsQuestion })
      throw err
    }
    if (typeof taskId !== 'string') throw new NotionError('notion_error', 'Notion did not start copying the page.')
    const { firstMs, maxMs, polls } = DUPLICATE_POLLING
    // Only a check that stalls meets this: all of them, at their longest wait, with room to answer.
    const deadline = Date.now() + 2 * polls * maxMs
    let delay = firstMs
    // Polls in a row on which Notion said the task hit an error while still running.
    let erroring = 0
    // Once Notion has the task, it copies the page whatever happens here: stopping or failing to
    // hear back leaves the outcome unknown, never undone.
    for (let poll = 0; poll < polls; poll++) {
      // A small page is copied at once; a big one takes a while.
      await wait(delay, signal).catch(() => {
        throw new NotionError('outcome_unknown', DUPLICATE_UNKNOWN)
      })
      delay = Math.min(delay * 2, maxMs)
      let task: z.output<typeof Task> | undefined
      try {
        // A stalled check gives way to Stop and to the deadline.
        const { json } = await cutShort(
          this.request('getTasks', { taskIds: [taskId] }, spaceId),
          Math.max(0, deadline - Date.now()),
          signal,
        )
        task = Task.safeParse(first(json.results)).data
      } catch (err) {
        if (err instanceof NotionError && err.code === 'outcome_unknown') throw err
        // A failed check says nothing about the copy, which goes on regardless. It isn't checked
        // again: the question stops, and the user is told the copy may still appear.
        throw new NotionError('outcome_unknown', DUPLICATE_UNKNOWN, {
          cause: err,
          stopsQuestion: err instanceof NotionError ? err.stopsQuestion : undefined,
        })
      }
      if (task?.state === 'success') {
        const [copy] = Array.isArray(task.status?.targetIds) ? task.status.targetIds : []
        if (typeof copy !== 'string') throw new NotionError('outcome_unknown', DUPLICATE_UNKNOWN)
        return copy
      }
      if (task?.state === 'failure') {
        const why = typeof task.error === 'string' ? task.error : JSON.stringify(task.error ?? 'no details')
        throw new NotionError('notion_error', `Notion could not copy the page: ${why}`)
      }
      // A task still running with an error may be retried by Notion, so it's not a failure for sure;
      // but one that keeps reporting it is unlikely to finish soon: say so instead of waiting it out.
      erroring = task?.state === 'in_progress' && typeof task.error === 'string' && task.error ? erroring + 1 : 0
      if (erroring >= TASK_ERROR_POLLS)
        throw new NotionError(
          'outcome_unknown',
          `Notion reports an error while copying the page: ${String(task!.error)} ${DUPLICATE_UNKNOWN}`,
        )
      if (Date.now() >= deadline) throw new NotionError('outcome_unknown', DUPLICATE_UNKNOWN)
    }
    // Still not done after every check allowed: what became of the copy is unknown.
    throw new NotionError('outcome_unknown', DUPLICATE_UNKNOWN)
  }

  /**
   * Moves pages to Notion's trash, as its "Move to Trash" does: each is taken out of its parent's
   * list in one transaction, then Notion is told they are trashed. Never deletes for good: they
   * stay in the trash, where they can be restored.
   */
  async trashPages(space: string, pages: { id: string; parentId: string; parentTable: 'block' | 'space' }[]) {
    const spaceId = notionId(space)
    const op = blockOps(spaceId, Date.now(), this.userId)
    const operations: Operation[] = []
    for (const p of pages) {
      // A page in a page is listed in its `content`; a top-level page in its workspace's `pages`.
      operations.push({
        pointer: { table: p.parentTable, id: p.parentId, spaceId },
        path: [p.parentTable === 'block' ? 'content' : 'pages'],
        command: 'removeChild',
        args: { id: notionId(p.id) },
      })
      operations.push(op.touch(p.id))
    }
    await this.submitTransaction(spaceId, operations, 'Notico: trash_page')
    try {
      // What Notion's own client sends after trashing; `permanentlyDelete` stays false, always.
      await this.request(
        'deleteContentRecords',
        { records: pages.map((p) => ({ id: notionId(p.id), table: 'block', spaceId })), permanentlyDelete: false },
        spaceId,
      )
    } catch (err) {
      // The pages are in the trash already: the transaction did that. This call only matches
      // what Notion's own client sends after it. A failure that stops the question still does.
      if (err instanceof NotionError && err.stopsQuestion)
        throw new NotionError('notion_error', "The pages were moved to Notion's trash.", {
          cause: err,
          stopsQuestion: `The pages were moved to Notion's trash. ${err.stopsQuestion}`,
          mayHaveChanged: true,
        })
      console.warn('Notion did not take the trashed pages’ deleteContentRecords', err)
    }
  }

  /**
   * Searches a workspace's pages by title and content, as Notion's quick find does. Notion only
   * returns what the signed-in account can open.
   */
  async search(spaceId: string, query: string, limit: number): Promise<SearchResults> {
    const space = notionId(spaceId)
    const { json } = await this.request(
      'search',
      {
        type: 'BlocksInSpace',
        query,
        spaceId: space,
        limit,
        source: 'quick_find',
        sort: { field: 'relevance' },
        filters: {
          isDeletedOnly: false,
          excludeTemplates: false,
          navigableBlockContentOnly: false,
          requireEditPermissions: false,
          includePublicPagesWithoutExplicitAccess: false,
          ancestors: [],
          createdBy: [],
          editedBy: [],
          lastEditedTime: {},
          createdTime: {},
          inTeams: [],
        },
      },
      space,
    )
    const { results, total = results.length, recordMap } = SearchResponse.parse(json)
    return { results, total: Math.max(total, results.length), recordMap: normalizeRecordMap(recordMap) }
  }

  /**
   * Every request to Notion goes through here. `spaceId`, when known, goes along as
   * `x-notion-space-id`. When Notion turns a request away for coming too fast, nothing is retried:
   * the client sends nothing more, and the question stops (see CLAUDE.md, calling Notion). Each
   * request sent counts toward the question's usage, and may first wait for the user at its budget.
   */
  private async request(
    endpoint: NotionEndpoint,
    body: unknown,
    spaceId?: string,
  ): Promise<{ json: Record<string, unknown>; userId?: string }> {
    this.checkNotLimited()
    await this.usage?.admit()
    // Notion may have turned another request away while this one waited for the user: not sent, so not counted.
    try {
      this.checkNotLimited()
    } catch (err) {
      this.usage?.unsent()
      throw err
    }
    const write = WRITES.has(endpoint)
    let res: NotionResponse
    try {
      res = await this.send(endpoint, body, { spaceId })
    } catch (err) {
      // The transport says when nothing went out; otherwise the request, and a write, may have reached Notion.
      if (err instanceof NotionError && !err.unanswered) this.usage?.unsent()
      else if (write && this.usage) this.usage.wrote = true
      throw err
    }
    if (res.userId) this.userId = res.userId
    const turnedAway = res.error === undefined && !res.redirected && LIMITED.has(res.status)
    // Only a 429 says the write was not applied; anything else may have changed data, so err on that side.
    if (write && this.usage && !(turnedAway && res.status === 429)) this.usage.wrote = true
    if (turnedAway) {
      this.limited = true
      this.cooldown?.start(res.retryAfter)
      const stopsQuestion = limitedStop(this.cooldown?.left())
      // A 529 to a write may come after Notion applied it, so its outcome stays unknown. A 429
      // means Notion turned it away before doing anything with it.
      // Starting a copy is a write too.
      if ((endpoint === 'saveTransactionsFanout' || endpoint === 'enqueueTask') && res.status === 529) {
        throw new NotionError('outcome_unknown', BUSY_UNKNOWN, { stopsQuestion })
      }
      throw new NotionError('rate_limited', RATE_LIMITED, { stopsQuestion })
    }
    return { json: checkResponse(res), userId: res.userId }
  }

  /**
   * Throws, sending nothing, when Notion turned this client's request away, or an earlier one and
   * the wait isn't over.
   */
  private checkNotLimited(): void {
    if (this.limited)
      throw new NotionError('rate_limited', NOT_SENT, { stopsQuestion: limitedStop(this.cooldown?.left()) })
    const left = this.cooldown?.left() ?? 0
    if (left) throw new NotionError('rate_limited', NOT_SENT, { stopsQuestion: coolingStop(left) })
  }
}

/**
 * Like Promise.all, but waits for every request, so a failure that stops the question is never
 * hidden behind another one that came first. Notion turning requests away comes first of all: the
 * user is told to wait.
 */
async function settleAll<T>(promises: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(promises)
  const failures = settled.flatMap((s) => (s.status === 'rejected' ? [s.reason as unknown] : []))
  const stops = failures.filter((e): e is NotionError => e instanceof NotionError && !!e.stopsQuestion)
  if (failures.length) throw stops.find((e) => e.code === 'rate_limited') ?? stops[0] ?? failures[0]
  return settled.map((s) => (s as PromiseFulfilledResult<T>).value)
}

/** The ids in a record's list field. */
function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** The JSON of a successful response, or a NotionError explaining the failure. */
export function checkResponse(res: NotionResponse): Record<string, unknown> {
  if (res.error !== undefined) {
    throw new NotionError('notion_error', `Could not reach Notion: ${res.error}`, { unanswered: true })
  }
  if (res.redirected) {
    if (!res.userId) throw new NotionError('signed_out', SIGNED_OUT)
    throw new NotionError('notion_error', 'Notion redirected the request instead of answering it.')
  }
  const answered = isObject(res.json)
  const json = isObject(res.json) ? res.json : {}
  if (res.status >= 200 && res.status < 300) {
    // Every endpoint answers with a JSON object; anything else (say, an HTML page) is not a success.
    if (!answered) throw new NotionError('notion_error', `Notion returned an unexpected response (${res.status}).`)
    return json
  }
  if (res.status === 401 || json.name === 'UnauthorizedError') throw new NotionError('signed_out', SIGNED_OUT)
  if (res.status === 403) throw new NotionError('no_access', NO_ACCESS)
  const name = typeof json.name === 'string' ? ` ${json.name}` : ''
  const detail = json.debugMessage ?? json.message ?? 'no details'
  // A 5xx (often a gateway timeout) can come after Notion already applied the request.
  throw new NotionError('notion_error', `Notion returned an error (${res.status}${name}): ${String(detail)}`, {
    unanswered: res.status >= 500,
  })
}

/**
 * Notion answers 200 with an empty recordMap, not an error, for a record the user can't see,
 * including when no one is signed in.
 */
function missingRecord(userId: string | undefined): NotionError {
  return userId ? new NotionError('no_access', NO_ACCESS) : new NotionError('signed_out', SIGNED_OUT)
}

/**
 * Unwraps Notion's recordMap. Each entry is `{ spaceId, value: { role, value: <record> } }`; older
 * responses had `{ role, value: <record> }`. Entries without a record are left out, as are tables
 * this client reads nothing from.
 */
export function normalizeRecordMap(raw: unknown): RecordMap {
  const out: RecordMap = {}
  const tables = isObject(raw) ? raw : {}
  for (const [id, entry] of entriesOf(tables.block)) {
    const block = unwrap(BlockSchema, entry)
    if (block) (out.block ??= {})[id] = block
  }
  for (const table of OTHER_TABLES) {
    for (const [id, entry] of entriesOf(tables[table])) {
      const record = unwrap(NotionRecordSchema, entry)
      if (record) (out[table] ??= {})[id] = record
    }
  }
  return out
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** A table's entries by id; none when the table is not there. */
function entriesOf(table: unknown): [string, unknown][] {
  return table && typeof table === 'object' ? Object.entries(table) : []
}

const Wrapped = z.object({ value: z.unknown().optional() })

/** The record inside an entry of a record map, as `schema` reads it; undefined when it holds none. */
function unwrap<S extends z.ZodType>(schema: S, entry: unknown): z.output<S> | undefined {
  const outer = Wrapped.safeParse(entry).data?.value
  const inner = Wrapped.safeParse(outer).data?.value
  for (const candidate of [inner, outer]) {
    const record = schema.safeParse(candidate)
    if (record.success) return record.data
  }
  return undefined
}

/** A pointer to another record, as a block's format holds one. */
const PointerField = z.object({ id: text, spaceId: text })

/** The pointer a block's format holds under `name`, as far as it is read; a part that is not text is missing. */
export function pointerIn(
  format: Record<string, unknown> | undefined,
  name: string,
): z.output<typeof PointerField> | undefined {
  return PointerField.safeParse(format?.[name]).data
}

/** The texts in a list field of a record, in order: ids, or property keys. None when it is not a list. */
export function textList(value: unknown): string[] {
  return ids(value)
}

/** A record's field that holds fields of its own, such as a view's format; undefined when it holds none. */
export function fieldsOf(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined
}

/** The first of a list Notion answered with, as `list[0]` reads it. */
function first(list: unknown): unknown {
  return Array.isArray(list) ? list[0] : isObject(list) ? list['0'] : undefined
}

/** Whether a page chunk's cursor holds more of the page. */
const PageCursor = z.object({ stack: z.array(z.unknown()) })
/** Where queryCollection lists the rows it found. */
const QueryResult = z.object({
  result: z.object({
    reducerResults: z.object({
      collection_group_results: z.object({ blockIds: z.unknown().optional(), hasMore: z.unknown().optional() }),
    }),
  }),
})
/** One signed-in user's part of getSpaces: their root record, by user id. */
const UserRoots = z.object({ user_root: z.record(z.string(), z.unknown()) })
const SpaceViewPointer = z.object({ id: z.string(), spaceId: z.string() })
const SpaceSettings = z.object({ is_teams_enabled: z.unknown().optional() })
/** A teamspace getTeamsV2 lists as joined. */
const JoinedTeam = z.object({ id: z.string(), type: z.literal('Joined') })
const VisibleUser = z.object({ userId: z.string() })
/** A task as getTasks reports it. */
const Task = z.object({
  state: z.unknown().optional(),
  error: z.unknown().optional(),
  status: z.object({ targetIds: z.unknown().optional() }).optional().catch(undefined),
})

/** Adds `source` to `target`, keeping the newer version of a record both have. */
export function mergeRecordMaps(target: RecordMap, source: RecordMap): RecordMap {
  if (source.block) mergeRecords((target.block ??= {}), source.block)
  for (const table of OTHER_TABLES) {
    const records = source[table]
    if (records) mergeRecords((target[table] ??= {}), records)
  }
  return target
}

function mergeRecords<R extends NotionRecord>(into: Record<string, R>, records: Record<string, R>) {
  for (const [id, record] of Object.entries(records)) {
    if (!into[id] || (record.version ?? 0) >= (into[id].version ?? 0)) into[id] = record
  }
}

export interface DuplicateOptions {
  signal?: AbortSignal
}

/**
 * `promise`, unless `signal` aborts or `ms` pass first: then an `outcome_unknown` error, since
 * the request may still reach Notion. The request itself is left to finish or time out.
 */
function cutShort<T>(promise: Promise<T>, ms: number | undefined, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const unknown = () => reject(new NotionError('outcome_unknown', DUPLICATE_UNKNOWN))
    if (signal?.aborted) return unknown()
    const timer = ms === undefined ? undefined : setTimeout(unknown, ms)
    signal?.addEventListener('abort', unknown, { once: true })
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', unknown)
    })
  })
}

/** Resolves after `ms`, or rejects when `signal` aborts. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Whether `value` has a `crdt_data` key at any depth. */
function hasCrdtData(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, v]) => key === 'crdt_data' || hasCrdtData(v))
}

/** A record id as Notion keys records by; ids from URLs or the model may be undashed or uppercase. */
function notionId(id: string): string {
  const uuid = toUuid(id)
  // The model gave it: it can give another, so this doesn't stop the question.
  if (!uuid) throw new Error(`Not a Notion id: ${id}`)
  return uuid
}

/**
 * Builders for the operations a transaction is made of, so Notion's wire format for writes lives
 * here with the rest of the API. All act on blocks in one workspace. With `userId` (the tab's
 * signed-in user), blocks created, changed, and
 * deleted name that user as their creator and last editor, as Notion's own editor does; Notion
 * doesn't fill those in itself.
 */
export function blockOps(spaceId: string, now: number, userId: string | undefined) {
  const pointer = (id: string): Pointer => ({ table: 'block', id, spaceId })
  const editedBy = userId ? { last_edited_by_id: userId, last_edited_by_table: 'notion_user' } : {}
  const createdBy = userId ? { created_by_id: userId, created_by_table: 'notion_user', ...editedBy } : {}
  return {
    /**
     * A new block under `parentId`; it still has to be listed in its parent's content. Without a
     * parent, a later operation must give it one.
     */
    create(
      id: string,
      type: string,
      parentId: string | undefined,
      fields: { properties?: object; format?: object; parent_table?: 'block' | 'collection' } = {},
    ): Operation {
      return {
        pointer: pointer(id),
        path: [],
        command: 'set',
        args: {
          id,
          type,
          version: 1,
          alive: true,
          ...(parentId === undefined ? {} : { parent_id: parentId, parent_table: 'block' }),
          space_id: spaceId,
          created_time: now,
          last_edited_time: now,
          ...createdBy,
          ...fields,
        },
      }
    },
    /** Lists `id` in `parentId`'s content after `after`, or at the end without it. */
    listAfter(parentId: string, id: string, after?: string): Operation {
      return {
        pointer: pointer(parentId),
        path: ['content'],
        command: 'listAfter',
        args: after ? { after, id } : { id },
      }
    },
    listBefore(parentId: string, id: string, before: string): Operation {
      return { pointer: pointer(parentId), path: ['content'], command: 'listBefore', args: { before, id } }
    },
    /** Deletes a block the way Notion does: marked not alive, and taken out of its parent's list. */
    remove(parentId: string, id: string): Operation[] {
      return [
        {
          pointer: pointer(id),
          path: [],
          command: 'update',
          args: { alive: false, last_edited_time: now, ...editedBy },
        },
        { pointer: pointer(parentId), path: ['content'], command: 'listRemove', args: { id } },
      ]
    },
    /** Changes property values, text included; the only way Notion accepts for existing blocks. */
    setProperties(id: string, values: object): Operation {
      return {
        pointer: pointer(id),
        path: ['properties'],
        command: 'updateBlockPropertyValue',
        args: { primitiveOp: { command: 'update', args: values } },
      }
    },
    setFormat(id: string, format: object): Operation {
      return { pointer: pointer(id), path: ['format'], command: 'update', args: format }
    },
    /**
     * Moves pages to the end of `parentId`, as Notion's "Move to" does. Notion takes each out of
     * its old parent itself, and refuses to move a page into one of its own pages.
     */
    moveInto(parentId: string, ids: string[]): Operation {
      return { pointer: pointer(parentId), path: ['content'], command: 'insertChildrenAfter', args: { ids } }
    },
    /**
     * A new full-page database: the page, its collection with `schema`, and one table view showing
     * every property in the schema's order. Without `parentId` it has no parent yet, and a later
     * operation must give it one; with it, it still has to be listed in that page's content. Its
     * rows are pages created under the collection (`create` with `parent_table: 'collection'`).
     */
    createDatabase(
      ids: { page: string; collection: string; view: string },
      name: string,
      schema: object,
      parentId?: string,
    ): Operation[] {
      const base = { version: 1, alive: true, space_id: spaceId }
      const set = (table: 'block' | 'collection' | 'collection_view', id: string, args: object): Operation => ({
        pointer: { table, id, spaceId },
        path: [],
        command: 'set',
        args: { id, ...base, ...args },
      })
      const collectionPointer = { id: ids.collection, table: 'collection', spaceId }
      return [
        set('block', ids.page, {
          type: 'collection_view_page',
          collection_id: ids.collection,
          view_ids: [ids.view],
          format: { collection_pointer: collectionPointer },
          ...(parentId === undefined ? {} : { parent_id: parentId, parent_table: 'block' }),
          created_time: now,
          last_edited_time: now,
          ...createdBy,
        }),
        set('collection', ids.collection, {
          parent_id: ids.page,
          parent_table: 'block',
          name: [[name]],
          schema,
          created_time: now,
          last_edited_time: now,
          ...createdBy,
        }),
        set('collection_view', ids.view, {
          type: 'table',
          name: 'Table',
          parent_id: ids.page,
          parent_table: 'block',
          format: {
            collection_pointer: collectionPointer,
            table_properties: Object.keys(schema).map((property) => ({ property, visible: true })),
          },
        }),
      ]
    },
    /** Puts a new page, created without a parent, at the top of `view`'s Private section. */
    moveToPrivate(id: string, view: SpaceView): Operation {
      return {
        pointer: pointer(id),
        path: [],
        command: 'moveToPrivate',
        args: { spaceViewPointer: { id: view.spaceViewId, table: 'space_view', spaceId }, userId: view.userId },
      }
    },
    /** Marks a block as edited now; Notion doesn't do it itself. */
    touch(id: string): Operation {
      return { pointer: pointer(id), path: [], command: 'update', args: { last_edited_time: now, ...editedBy } }
    },
  }
}

/** An option of a select, multi-select, or status property, as a database's schema keeps it. */
export interface SchemaOption {
  id: string
  value: string
  color?: string
}

/**
 * Builders for changes to a database's properties, as Notion's web client makes them (checked
 * against it, 2026-11). Rows keep an option's text, not its id: renaming an option takes a change
 * to each row that has it too (blockOps' setProperties), as Notion's client does.
 */
export function collectionOps(spaceId: string, collectionId: string, userId: string | undefined) {
  const pointer: Pointer = { table: 'collection', id: collectionId, spaceId }
  const editedBy = userId ? { last_edited_by_id: userId, last_edited_by_table: 'notion_user' } : {}
  const schema = (path: string[], command: string, args: unknown): Operation => ({
    pointer,
    path: ['schema', ...path],
    command: 'updateCollectionPropertySchema',
    args: { primitiveOp: { command, args } },
  })
  return {
    /** A new property under a key the schema doesn't use yet. */
    addProperty(key: string, def: object): Operation {
      return schema([], 'update', { [key]: def })
    },
    renameProperty(key: string, name: string): Operation {
      return schema([key, 'name'], 'set', name)
    },
    /**
     * Removes a property as Notion's "Delete property" does: it moves to the database's deleted
     * properties, and rows keep their values for it, but they no longer show.
     */
    removeProperty(key: string, def: object): Operation[] {
      return [
        {
          pointer,
          path: ['deleted_schema'],
          command: 'updateCollectionDeletedPropertySchema',
          args: { primitiveOp: { command: 'update', args: { [key]: def } } },
        },
        schema([], 'update', { [key]: null }),
      ]
    },
    /** Adds an option at the end of a property's options. */
    addOption(key: string, option: SchemaOption): Operation {
      return schema([key, 'options'], 'keyedObjectListAfter', { value: option })
    },
    /** Changes an option, found by its id: its name, say. */
    updateOption(key: string, option: SchemaOption): Operation {
      return schema([key, 'options'], 'keyedObjectListUpdate', { value: option })
    },
    /** Removes an option; rows that have it keep its text, but no longer show it. */
    removeOption(key: string, optionId: string): Operation {
      return schema([key, 'options'], 'keyedObjectListRemove', { remove: { id: optionId } })
    },
    /** Marks the database as edited now, by the signed-in user. */
    touch(now: number): Operation {
      return { pointer, path: [], command: 'update', args: { last_edited_time: now, ...editedBy } }
    },
  }
}

/**
 * Builders for comments: a comment lives in a discussion (a thread), which hangs off a block or a
 * page. The records are the ones Notion's web client writes for a comment on a page (checked
 * against it, 2026-11); on a block the same records show as a comment on the whole block. Notion's
 * own comments on a block's text also mark that text, a CRDT edit this never makes.
 */
export function commentOps(spaceId: string, now: number) {
  return {
    /** A new thread on `blockId` (a page is a block too) holding one comment by `userId`. */
    newThread(blockId: string, discussionId: string, commentId: string, userId: string, text: unknown[]): Operation[] {
      return [
        {
          pointer: { table: 'discussion', id: discussionId, spaceId },
          path: [],
          command: 'set',
          args: {
            id: discussionId,
            version: 1,
            type: 'default',
            parent_id: blockId,
            parent_table: 'block',
            resolved: false,
            space_id: spaceId,
            comments: [commentId],
          },
        },
        {
          pointer: { table: 'comment', id: commentId, spaceId },
          path: [],
          command: 'set',
          args: {
            id: commentId,
            version: 1,
            parent_id: discussionId,
            parent_table: 'discussion',
            alive: true,
            space_id: spaceId,
            text,
            created_time: now,
            last_edited_time: now,
            created_by_id: userId,
            created_by_table: 'notion_user',
          },
        },
        {
          pointer: { table: 'block', id: blockId, spaceId },
          path: ['discussions'],
          command: 'listAfter',
          args: { id: discussionId },
        },
      ]
    },
  }
}
