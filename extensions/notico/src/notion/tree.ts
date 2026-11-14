// Listing pages as Notion's sidebar shows them: titles and ids, level by level, without content.
// Like Notion's own sidebar, it finds which children are pages by looking up the blocks a page
// holds, so it asks for as few of them as it can: in order, only until the list is full, each at
// most once, and only so many lookups per tool call.
import { mergeRecordMaps, type Block, type NotionClient, type RecordMap } from './api'
import { LAYOUT_TYPES, PAGE_TYPES, collectionId, hexId } from './markdown'

export interface TreeNode {
  id: string
  title: string
  database: boolean
  children: TreeNode[]
}

/** Ids one lookup asks for at most: one request. */
const LOOKUP_BATCH = 100
/** How deep layout blocks (columns) are looked through. */
const LAYOUT_HOPS = 3

/**
 * What one tool call learned from Notion, shared by the lists it builds: the records found, and
 * the ids already asked for, so ones that didn't come back (no access, in the trash) aren't asked
 * for again.
 */
export class PageLookups {
  private readonly asked = new Set<string>()

  constructor(
    readonly client: NotionClient,
    readonly records: RecordMap = {},
  ) {}

  block(id: string): Block | undefined {
    return this.records.block?.[id]
  }

  /** Whether a lookup could still tell something about this block. */
  unknown(id: string): boolean {
    return !this.records.block?.[id] && !this.asked.has(id)
  }

  /** Looks up, in one request, the blocks among `ids` not known or asked for yet. */
  async blocks(ids: string[]): Promise<void> {
    await this.find('block', ids.filter((id) => this.unknown(id)).slice(0, LOOKUP_BATCH))
  }

  /** Looks up the collections that name the databases among `blocks`. */
  async collections(blocks: Block[]): Promise<void> {
    const ids = blocks.map(collectionId).filter((id): id is string => !!id && !this.records.collection?.[id])
    await this.find('collection', ids)
  }

  private async find(table: 'block' | 'collection', ids: string[]): Promise<void> {
    const wanted = [...new Set(ids)].filter((id) => !this.asked.has(id))
    if (!wanted.length) return
    for (const id of wanted) this.asked.add(id)
    mergeRecordMaps(this.records, await this.client.findRecords(wanted.map((id) => ({ table, id }))))
  }
}

/** How many block lookups (one request each) a tool call may still make; lists can share one. */
export interface Lookups {
  left: number
}

export interface PageTree {
  nodes: TreeNode[]
  /** The entry of the top level the ones not listed start at, when it stopped before its end. */
  next?: number
  /** Whether pages are known to follow `next`, rather than maybe. */
  nextKnown: boolean
  /**
   * Pages under the listed ones that the list leaves out: `cut` when some are known to be left
   * out, `unchecked` when some listed pages weren't looked into.
   */
  deeper?: 'cut' | 'unchecked'
}

/**
 * Builds the tree under `ids` (the blocks of the top level, in order: layout blocks are looked
 * through, so their blocks are entries in their place), `depth` levels deep, with at most `limit`
 * entries, from entry `skip` of the top level on. Besides the lookups that skipping takes, its
 * block lookups come out of `budget`; where it stops for lack of them, the result says what wasn't
 * looked into.
 */
export async function pageTree(
  cache: PageLookups,
  ids: string[],
  { depth, limit, budget, skip = 0 }: { depth: number; limit: number; budget: Lookups; skip?: number },
): Promise<PageTree> {
  const top = await walk(cache, [ids], limit, budget, skip)
  const nodes = await nodesFor(cache, top.pages[0])
  let count = nodes.length
  const stopped = top.rest !== 'none'
  let deeper: PageTree['deeper']
  let level = nodes
  for (let d = 1; d < depth; d++) {
    // Children of pages only: a database's rows aren't sidebar pages.
    const parents = level.filter((n) => !n.database && contentOf(cache, n.id).length)
    if (!parents.length) break
    if (count >= limit) {
      deeper ??= 'unchecked'
      break
    }
    const found = await walk(
      cache,
      parents.map((p) => contentOf(cache, p.id)),
      limit - count,
      budget,
    )
    // Every child of this level at once, so database names cost one request per level.
    const byId = new Map((await nodesFor(cache, found.pages.flat())).map((n) => [n.id, n]))
    level = []
    parents.forEach((parent, i) => {
      parent.children = found.pages[i].map((id) => ({ ...byId.get(id)!, children: [] }))
      level.push(...parent.children)
    })
    count += level.length
    if (found.rest === 'pages') deeper = 'cut'
    else if (found.rest === 'unchecked') deeper ??= 'unchecked'
  }
  return {
    nodes,
    next: stopped ? top.resume : undefined,
    nextKnown: top.rest === 'pages',
    ...(deeper ? { deeper } : {}),
  }
}

/**
 * The first `room` pages among the entries of `lists` (one per parent, in the parents' order),
 * looking through layout blocks, from entry `skip` of the first list on. Blocks are looked up only
 * as the walk reaches them, a batch at a time. Once the room is full, one more lookup at most
 * tells whether more pages follow.
 */
async function walk(
  cache: PageLookups,
  lists: string[][],
  room: number,
  budget: { left: number },
  skip = 0,
): Promise<{
  /** The page ids found, per list. */
  pages: string[][]
  /** What follows the last page found: nothing, more pages, or blocks not looked up. */
  rest: 'none' | 'pages' | 'unchecked'
  /** The entry of the first list the walk stopped at. */
  resume: number
}> {
  const pages = lists.map((): string[] => [])
  let found = 0
  let settling = false
  for (let l = 0; l < lists.length; l++) {
    // Each list is walked depth first, so a layout block's entries stand in its place.
    const stack = [{ ids: lists[l], at: 0, hop: 0 }]
    let entry = 0
    const stop = (rest: 'pages' | 'unchecked') => ({ pages, rest, resume: l ? 0 : entry })
    while (stack.length) {
      const frame = stack[stack.length - 1]
      if (frame.at >= frame.ids.length) {
        stack.pop()
        continue
      }
      const id = frame.ids[frame.at]
      // Skipped entries are looked up only to see through layouts, and don't count against the
      // lookups, so every next list gets further than the one before.
      const skipping = l === 0 && entry < skip
      if (cache.unknown(id)) {
        if (!skipping) {
          if (budget.left <= 0 || settling) return stop('unchecked')
          settling = found >= room
          budget.left--
        }
        await cache.blocks(upcoming(cache, stack, lists.slice(l + 1)))
      }
      const block = cache.block(id)
      frame.at++
      if (block && LAYOUT_TYPES.has(String(block.type)) && frame.hop < LAYOUT_HOPS) {
        stack.push({ ids: contentOf(cache, id), at: 0, hop: frame.hop + 1 })
        continue
      }
      // Anything else is an entry, listed or not.
      if (!skipping && block && PAGE_TYPES.has(String(block.type))) {
        if (found >= room) return stop('pages')
        pages[l].push(id)
        found++
      }
      entry++
    }
  }
  return { pages, rest: 'none', resume: 0 }
}

/**
 * The blocks to look up next, at most a batch of them: those not known yet, in the order the walk
 * reaches them (what is left of each frame, then the lists after it), looking through layout
 * blocks already known.
 */
function upcoming(
  cache: PageLookups,
  stack: { ids: string[]; at: number; hop: number }[],
  lists: string[][],
): string[] {
  const out = new Set<string>()
  const visit = (ids: string[], hop: number): boolean => {
    for (const id of ids) {
      if (out.size >= LOOKUP_BATCH) return false
      const block = cache.block(id)
      if (!block) {
        if (cache.unknown(id)) out.add(id)
      } else if (LAYOUT_TYPES.has(String(block.type)) && hop < LAYOUT_HOPS && !visit(contentOf(cache, id), hop + 1))
        return false
    }
    return true
  }
  for (let f = stack.length - 1; f >= 0; f--) if (!visit(stack[f].ids.slice(stack[f].at), stack[f].hop)) break
  for (const list of lists) if (out.size >= LOOKUP_BATCH || !visit(list, 0)) break
  return [...out]
}

/**
 * Looks up the blocks among `ids` not known yet, and the names of the databases among them, a batch
 * at a time while `budget` lasts: for lists of pages known to be pages (a workspace's sections), so
 * the lists built from them afterwards find them known and send nothing more.
 */
export async function lookUpPages(cache: PageLookups, ids: string[], budget: Lookups): Promise<void> {
  while (budget.left > 0 && ids.some((id) => cache.unknown(id))) {
    budget.left--
    await cache.blocks(ids)
  }
  const blocks = ids.map((id) => cache.block(id)).filter((b): b is Block => !!b && b.type !== 'page')
  await cache.collections(blocks.filter((b) => PAGE_TYPES.has(b.type)))
}

/** The sidebar pages among `ids`, as nodes, in order. */
async function nodesFor(cache: PageLookups, ids: string[]): Promise<TreeNode[]> {
  const pages = ids.map((id) => cache.block(id)).filter((b): b is Block => !!b && PAGE_TYPES.has(b.type))
  // Databases are named by their collection.
  await cache.collections(pages.filter((b) => b.type !== 'page'))
  return pages.map((b) => {
    const database = b.type !== 'page'
    const collection = database ? cache.records.collection?.[collectionId(b) ?? ''] : undefined
    const title = runsText(database ? collection?.name : b.properties?.title)
    return { id: b.id, title: title || (database ? 'Untitled database' : 'Untitled'), database, children: [] }
  })
}

/** The ids of the blocks a known block holds, in order. */
export function contentOf(cache: PageLookups, id: string): string[] {
  const content = cache.block(id)?.content
  return Array.isArray(content) ? content.filter((c): c is string => typeof c === 'string') : []
}

export function runsText(value: unknown): string {
  return Array.isArray(value) ? value.map((r) => (Array.isArray(r) ? String(r[0]) : '')).join('') : ''
}

/** The tree as an indented list, one entry per line, each with its page id. */
export function treeLines(nodes: TreeNode[], indent = ''): string[] {
  return nodes.flatMap((n) => [
    `${indent}- ${n.database ? '🗃' : '📄'} ${n.title} ^${hexId(n.id)}`,
    ...treeLines(n.children, `${indent}  `),
  ])
}
