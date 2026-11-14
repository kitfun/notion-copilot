// Finding pages: list_pages as the sidebar shows them, and search_pages as Notion's search does.
import { defineTool } from '../tool'
import { z } from '../zod'
import { pageLink } from '../notion/hosts'
import { clip } from '../notion/comments'
import { PAGE_TYPES, hexId } from '../notion/markdown'
import { activeNotionTab } from '../notion/tab'
import { PageLookups, contentOf, lookUpPages, pageTree, runsText, treeLines, type PageTree } from '../notion/tree'
import type { OpenPage } from './current'
import { databaseNames, workspaceOf } from './load'
import { LIST, NONE, SEARCH, filled, on, pageArg, wholeArg } from './shared'

const LIST_MAX_DEPTH = 3
/** How many pages one list shows, so a large workspace still fits the conversation. */
export const LIST_LIMIT = 100
/** How many pages each top-level section shows. */
export const SECTION_LIMIT = 50
/**
 * How many block lookups (one request each) one list makes to find which blocks are pages, besides
 * those that skipping to `offset` takes. The overview's sections share them.
 */
export const LIST_LOOKUPS = 20

export const listPages = defineTool({
  name: 'list_pages',
  description:
    "Lists pages and databases as Notion's sidebar shows them: without `page` or `section`, the top level of the " +
    "open page's workspace by section (Private, Shared, Workspace, and each teamspace the user joined); with `section`, " +
    'one of those sections; with `page`, the pages and databases under it. Titles and ids only, no content: ' +
    'read a page with read_page. With `page` or `section`, `depth` also lists the pages under those, up to 3 ' +
    'levels. A long list is cut off; `section` and `offset` list the rest.',
  touched: () => NONE,
  describe: (args) =>
    args?.page
      ? { verb: LIST, what: 'the pages under a page' }
      : on(LIST, args?.section, 'the sidebar', 'the pages in'),
  args: z.strictObject({
    page: z.string().describe('URL or id of a page to list the pages under. Leave out for the top level.').optional(),
    section: z
      .string()
      .describe(
        'Without `page`: list only this top-level section, by its name as a list showed it (say "Private", or ' +
          "a teamspace's name).",
      )
      .optional(),
    depth: wholeArg(
      'depth',
      'With `page` or `section`: how many levels to list. Defaults to 1, the only depth without them.',
      1,
      LIST_MAX_DEPTH,
    ),
    offset: wholeArg(
      'offset',
      'With `page` or `section`: skip this many entries of the top level, to see what a cut-off list left ' +
        'out. Entries include blocks that are not listed (text, say), so use the offset a cut-off list gives.',
      0,
    ),
  }),
  run: async ({ page, section, depth = 1, offset = 0 }) => {
    const named = filled(page)
    const rootId = named ? pageArg(named) : undefined
    if (named && !rootId) throw new Error(`Not a Notion page URL or id: ${named}`)
    const wanted = filled(section)?.trim()
    if (wanted && rootId) throw new Error('Give `page` or `section`, not both.')
    if (offset && !rootId && !wanted) throw new Error('`offset` needs `page` or `section`.')
    if (depth > 1 && !rootId && !wanted) {
      throw new Error(
        '`depth` needs `page` or `section`: without them, only the top level is listed. List it first, then ' +
          'list the section or page to look under with `depth`.',
      )
    }
    const tab = await activeNotionTab()

    if (rootId) {
      const records = await tab.client.getRecords([{ table: 'block', id: rootId }])
      const root = records.block![rootId]
      if (root.type !== 'page') {
        throw new Error(
          PAGE_TYPES.has(String(root.type))
            ? 'That is a database; its rows are not pages to list.'
            : 'That id is a block inside a page, not a page.',
        )
      }
      const cache = new PageLookups(tab.client, records)
      const tree = await pageTree(cache, contentOf(cache, rootId), {
        depth,
        limit: LIST_LIMIT,
        budget: { left: LIST_LOOKUPS },
        skip: offset,
      })
      const title = runsText(root.properties?.title) || 'Untitled'
      return [
        `Pages under “${title}” ^${hexId(rootId)}${offset ? `, from entry ${offset}` : ''}:`,
        '',
        ...(tree.nodes.length ? treeLines(tree.nodes) : ['(no pages)']),
        ...cutOff(tree, LIST_LIMIT),
      ].join('\n')
    }

    if (!tab.pageId) throw new Error('Open a page of the workspace to list it.')
    const space = await tab.client.getSpace(await workspaceOf(tab))
    const cache = new PageLookups(tab.client)
    // Every label is unique, ignoring case, so `section` can name any one of them: teamspaces whose
    // names match are numbered until their label is free.
    const lower = (label: string) => label.toLowerCase()
    const bases = space.teams.map((t) => `Teamspace: ${t.name}`)
    const used = new Set(['private', 'shared', 'workspace'])
    const labels = bases.map((base) => {
      const shared = bases.filter((b) => lower(b) === lower(base)).length > 1
      let label = base
      for (let n = 1; used.has(lower(label)) || (shared && label === base); n++) label = `${base} (${n})`
      used.add(lower(label))
      return label
    })
    // A page can be in more than one list (a shared page often stays in the owner's private
    // pages, where the sidebar shows it); it belongs to the first only, even where that list is
    // cut off before it, so a section listed alone matches the overview, entry for entry, and
    // their offsets agree.
    const earlier = new Set<string>()
    const sections: [string, string[]][] = (
      [
        ['Private', space.privatePages],
        ['Shared', space.sharedPages],
        ['Workspace', space.workspacePages],
        ...space.teams.map((t, i): [string, string[]] => [labels[i], t.pages]),
      ] as [string, string[]][]
    ).map(([label, all]) => {
      const ids = all.filter((id) => !earlier.has(id))
      for (const id of all) earlier.add(id)
      return [label, ids]
    })
    const teamsNote = space.teamsError ? [`(Teamspaces could not be listed: ${space.teamsError})`] : []

    if (wanted) {
      // The label as a list shows it, or a teamspace's own name when only one teamspace has it.
      const key = lower(wanted)
      const named = space.teams.flatMap((t, i) => (lower(t.name) === key ? [labels[i]] : []))
      const match = sections.find(([l]) => lower(l) === key)?.[0] ?? (named.length === 1 ? named[0] : undefined)
      const section = sections.find(([l]) => l === match)
      if (!section) {
        throw new Error(
          `No section “${wanted}”. The sections are: ${sections.map(([label]) => label).join(', ')}.` +
            (teamsNote.length ? ` ${teamsNote[0]}` : ''),
        )
      }
      const [label, all] = section
      const tree = await pageTree(cache, all, {
        depth,
        limit: LIST_LIMIT,
        budget: { left: LIST_LOOKUPS },
        skip: offset,
      })
      return [
        `${label}, in the workspace “${space.name}”${offset ? `, from entry ${offset}` : ''}:`,
        '',
        ...(tree.nodes.length ? treeLines(tree.nodes) : ['(no pages)']),
        ...cutOff(tree, LIST_LIMIT, label),
      ].join('\n')
    }

    // Each section has its own share of the limit, so a long one can't hide the others, and all of
    // them together stay within the overall limit. Their top levels are pages, so the ones that can
    // be shown (and one more each, to tell whether more follow) are looked up together, however many
    // sections there are, out of the lookups they all share.
    const budget = { left: LIST_LOOKUPS }
    const shown: string[] = []
    let room = LIST_LIMIT
    for (const [, ids] of sections) {
      if (room <= 0) break
      const take = Math.min(SECTION_LIMIT, room, ids.length)
      shown.push(...ids.slice(0, take + 1))
      room -= take
    }
    await lookUpPages(cache, shown, budget)

    const out = [`Pages in the workspace “${space.name}”:`]
    const skipped: string[] = []
    let any = false
    let left = LIST_LIMIT
    for (const [label, ids] of sections) {
      if (!ids.length) continue
      if (left <= 0) {
        skipped.push(label)
        continue
      }
      const limit = Math.min(SECTION_LIMIT, left)
      const tree = await pageTree(cache, ids, { depth: 1, limit, budget })
      if (!tree.nodes.length) {
        // Out of lookups before finding any of its pages: it can still be listed alone.
        if (tree.next !== undefined) skipped.push(label)
        continue
      }
      any = true
      left -= tree.nodes.length
      out.push('', label, ...treeLines(tree.nodes), ...cutOff(tree, limit, label))
    }
    if (skipped.length)
      out.push('', `Not listed, to keep the list short: ${skipped.join(', ')}. List one with \`section\`.`)
    if (!any) out.push('', '(no pages)')
    if (teamsNote.length) out.push('', ...teamsNote)
    return out.join('\n')
  },
})

/**
 * What a list left out and how to see it: the entries from `next` on when its top level stopped,
 * and pages under the listed ones. `limit` is how many pages the list could
 * show, and `section` the section's label.
 */
function cutOff(tree: PageTree, limit: number, section?: string): string[] {
  const deeper = 'To see what is under a listed page, list it by its id.'
  if (tree.next !== undefined) {
    const where = section ? `\`section: ${JSON.stringify(section)}\` and ` : ''
    const under = tree.deeper
      ? ` Pages under the ones shown ${tree.deeper === 'cut' ? 'are' : 'may be'} left out too. ${deeper}`
      : ''
    return [
      `(Cut off: more entries ${tree.nextKnown ? 'follow' : 'may follow'}. List them with ${where}\`offset: ${tree.next}\`.${under})`,
    ]
  }
  if (tree.deeper === 'cut')
    return [
      `(Cut off: this list shows at most ${limit} pages, so some pages under the ones shown are left out. ${deeper})`,
    ]
  if (tree.deeper === 'unchecked')
    return [
      `(Not looked into: what is under some of the pages shown, to keep this list short and its requests to Notion few. ${deeper})`,
    ]
  return []
}

const SEARCH_DEFAULT = 10
const SEARCH_MAX = 20

const QUERY_WORDS = '`query` must be some words to search for.'

export const searchPages = defineTool({
  name: 'search_pages',
  description:
    "Searches the Notion workspace of the open page for pages by title and content, as Notion's search does. " +
    'Returns each page with its id, where it is, when it was last edited, and the matching text. Read a page it ' +
    'finds with read_page and its id.',
  touched: () => NONE,
  describe: (args) => on(SEARCH, args?.query.trim() || undefined, 'pages', 'for'),
  args: z.strictObject({
    query: z.string({ error: QUERY_WORDS }).describe('Words to search for.'),
    limit: wholeArg(
      'limit',
      `How many pages to return, up to ${SEARCH_MAX}. Defaults to ${SEARCH_DEFAULT}.`,
      1,
      SEARCH_MAX,
    ),
  }),
  run: async ({ query: words, limit = SEARCH_DEFAULT }) => {
    const query = words.trim()
    if (!query) throw new Error(QUERY_WORDS)
    const tab = await activeNotionTab()
    if (!tab.pageId) throw new Error('Open a page of the workspace to search it.')
    // The workspace to search is the open page's; it is looked up once per page.
    const spaceId = await workspaceOf(tab)

    const found = await tab.client.search(spaceId, query, limit)
    // A page in the trash can't be read, so it isn't offered.
    const alive = found.results.filter((r) => found.recordMap.block?.[r.id]?.alive !== false)
    const trashed = found.results.length - alive.length
    // Fewer results than asked for are all Notion has, whatever its total says.
    const complete = found.results.length < limit
    found.results = alive
    if (!found.results.length) return `No pages found for "${query}".`
    const tag = highlightTag(found.results)
    const plain = (text: unknown) => withoutTag(typeof text === 'string' ? text : undefined, tag)
    // A database's name is on its collection, which search doesn't return.
    const names = await databaseNames(
      tab,
      found.results.map((r) => found.recordMap.block?.[r.id]),
    )
    const lines = found.results.map((r, n) => {
      const block = found.recordMap.block?.[r.id]
      const database = block?.type === 'collection_view_page' || block?.type === 'collection_view'
      const title =
        plain(r.highlight?.title) ||
        (database ? names.get(r.id) : runsText(block?.properties?.title)) ||
        (database ? 'Untitled database' : 'Untitled')
      const where = whereFound(plain(r.highlight?.pathText), title)
      const text = plain(r.highlight?.text)
      const edited =
        typeof block?.last_edited_time === 'number' ? new Date(block.last_edited_time).toISOString().slice(0, 10) : ''
      return [
        `${n + 1}. ${database ? '🗃' : '📄'} ${title} ^${hexId(r.id)}`,
        ...(where ? [`   In: ${where}`] : []),
        ...(edited ? [`   Edited: ${edited}`] : []),
        ...(text ? [`   Match: “${clip(text, 200)}”`] : []),
        `   URL: ${pageLink(tab.url, r.id)}`,
      ].join('\n')
    })
    const shown = found.results.length
    // Notion's total counts the trashed pages it found too. Those among the results are taken off;
    // others beyond them may be in it still, so the rest is only an upper bound then.
    const total = found.total - trashed
    const more = !complete && total > shown ? ` (${trashed ? 'up to ' : ''}${total} in all; showing ${shown})` : ''
    return [`Pages found for "${query}"${more}:`, '', ...lines].join('\n')
  },
})

/** Where a search hit is: its path, which may end with the page itself (a top-level page's is only its own title). */
function whereFound(path: string, title: string): string {
  return path === title ? '' : path.endsWith(` / ${title}`) ? path.slice(0, -title.length - 3) : path
}

/** A page Notion's search found for the composer's page picker, with where it is. */
export interface FoundPage extends OpenPage {
  path?: string
}

/**
 * Searches the workspace of the open page for the composer's page picker, as search_pages does,
 * for the user rather than the model: no tool runs, and the requests count toward no question.
 * Pages in the trash are left out. A failure throws as any Notion call does and is never retried;
 * a database is named as the search names it, with no request for its name.
 */
export async function findPages(words: string, limit: number): Promise<FoundPage[]> {
  const tab = await activeNotionTab({ counted: false })
  if (!tab.pageId) throw new Error('Open a page of the workspace to search it.')
  const spaceId = await workspaceOf(tab)
  const found = await tab.client.search(spaceId, words.trim(), limit)
  const tag = highlightTag(found.results)
  const plain = (text: unknown) => withoutTag(typeof text === 'string' ? text : undefined, tag)
  return found.results.flatMap((r) => {
    const block = found.recordMap.block?.[r.id]
    if (block?.alive === false) return []
    const database = block?.type === 'collection_view_page' || block?.type === 'collection_view'
    const title =
      plain(r.highlight?.title) ||
      (database ? '' : runsText(block?.properties?.title)) ||
      (database ? 'Untitled database' : 'Untitled')
    const path = whereFound(plain(r.highlight?.pathText), title)
    return [
      { title, url: pageLink(tab.url, r.id), ...(database && { database: true as const }), ...(path && { path }) },
    ]
  })
}

/**
 * The tag a search response marks matched words with: a random name per response, such as
 * `<gzkNfoUU>word</gzkNfoUU>`. Only that tag is removed, so other `<…>` text stays as written.
 */
function highlightTag(results: { highlight?: Record<string, unknown> }[]): string | undefined {
  // The name used most often across every highlight, preferring Notion's random 8-character
  // shape, so literal markup in page text (say `<b>bold</b>`) isn't taken for it.
  const counts = new Map<string, number>()
  for (const r of results) {
    for (const text of Object.values(r.highlight ?? {})) {
      if (typeof text !== 'string') continue
      for (const m of text.matchAll(/<([A-Za-z0-9]+)>[^<]*<\/\1>/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
    }
  }
  // Only Notion's shape counts: without one, no tag is removed at all.
  const ranked = [...counts].filter(([name]) => /^[A-Za-z0-9]{8}$/.test(name)).sort(([, n], [, m]) => m - n)
  return ranked[0]?.[0]
}

function withoutTag(text: string | undefined, tag: string | undefined): string {
  const out = tag ? (text ?? '').split(`<${tag}>`).join('').split(`</${tag}>`).join('') : (text ?? '')
  return out.replace(/\s+/g, ' ').trim()
}
