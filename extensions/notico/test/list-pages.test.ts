// The list_pages tool (extensions/notico/src/tools/find.ts) against a fake Notion tab: a fake workspace answers
// block lookups (syncRecordValuesMain) the way Notion does, and getSpaces and getTeamsV2 answer
// with queued responses in Notion's shapes.
import { afterEach, describe, expect, it } from 'vitest'
import { LIST_LIMIT, LIST_LOOKUPS, SECTION_LIMIT, listPages } from '../src/tools/find'
import { forgetReads } from '../src/tools/memory'
import { FakeNotionTab, FakeWorkspace, PAGE, PAGE_URL, SPACE, USER, notionError, restoreGlobals } from './notion-tab'
import { LIMITED_STOP, NO_USER_MAP, UNEXPECTED_STOP } from '../src/notion/api'

afterEach(() => {
  restoreGlobals()
  // The open page's workspace is remembered across calls.
  forgetReads()
})

const hex = (id: string) => id.replace(/-/g, '')
const id = (n: number) => `a0a0a0a0-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const COLLECTION = 'c0c0c0c0-0000-4000-8000-000000000001'

type Rec = Record<string, unknown>
function wrapped(record: Rec) {
  return { spaceId: SPACE, value: { role: 'editor', value: { version: 1, alive: true, space_id: SPACE, ...record } } }
}
const page = (n: number, title: string, content: string[] = []) => ({
  id: id(n),
  type: 'page',
  properties: { title: [[title]] },
  content,
})
/** Pages with these ids, titled `${title} ${i}`, each holding `content(i)`. */
const pages = (ids: string[], title: string, content: (i: number) => string[] = () => []) =>
  ids.map((m, i) => ({ ...page(0, `${title} ${i}`, content(i)), id: m }))
const text = (ids: string[]) => ids.map((m) => ({ id: m, type: 'text', properties: { title: [['Some text']] } }))
const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => id(from + i))
/** A page holding `words` text blocks and then one subpage, with those blocks. */
const wordy = (pageId: string, title: string, words: string[], sub: number) => [
  { ...page(0, title, [...words, id(sub)]), id: pageId },
  ...text(words),
  page(sub, 'Sub'),
]

/**
 * A Notion tab on the open page, whose block lookups a workspace holding `blocks` (and the open
 * page) answers. Ids not in it come back missing, as Notion leaves out blocks the user can't open.
 */
function notion(blocks: Rec[], { collections = [] as Rec[], cookie = undefined as string | undefined } = {}) {
  const tab = new FakeNotionTab(PAGE_URL, ...(cookie === undefined ? [] : [cookie]))
  const workspace = new FakeWorkspace(
    [{ id: PAGE, type: 'page', properties: { title: [['Fixture page']] } }, ...blocks],
    SPACE,
  )
  for (const c of collections) workspace.collections.set(c.id as string, { version: 1, ...c } as never)
  tab.workspace = workspace
  return tab
}

const run = async (args: Rec = {}) => (await listPages.run(args)) as string
const listed = (result: string) => result.split('\n').filter((l) => l.trimStart().startsWith('- '))

const VIEW = 'b0b0b0b0-0000-4000-8000-000000000001'
/** getSpaces' answer for the tab's user: the workspace (teamspaces on) and their view of it. */
function spaces(space: Rec, view: Rec, user = USER) {
  return {
    [user]: {
      __version__: 3,
      space: {
        [SPACE]: wrapped({ id: SPACE, name: 'Fixture workspace', settings: { is_teams_enabled: true }, ...space }),
      },
      space_view: { [VIEW]: wrapped({ id: VIEW, space_id: SPACE, ...view }) },
    },
  }
}
const teamId = (n: number) => `d0d0d0d0-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
/** A teamspace record as getTeamsV2 returns it: its sidebar pages are `team_pages`. */
const team = (n: number, name: string, pages: string[], extra: Rec = {}) => ({
  id: teamId(n),
  name,
  team_pages: pages,
  team_page_id: id(9000 + n),
  parent_table: 'space',
  parent_id: SPACE,
  ...extra,
})
/** getTeamsV2's answer: the teamspaces in the sidebar's order, and their records. */
function teams(list: Rec[]) {
  return {
    teams: list.map((t) => ({ id: t.id, type: 'Joined', title: t.name, teamRole: 'member' })),
    recordMap: { __version__: 3, team: Object.fromEntries(list.map((t) => [t.id, wrapped(t)])) },
    hasUnjoinedActiveTeams: false,
  }
}
const endpoints = (tab: FakeNotionTab) => tab.sent.map((r) => r.url.split('/api/v3/')[1])
/** The record lookups sent, each as the ids it asked for. */
const lookups = (tab: FakeNotionTab) =>
  tab.sent
    .filter((r) => r.url.endsWith('/syncRecordValuesMain'))
    .map((r) => (r.body.requests as { pointer: { id: string } }[]).map((q) => q.pointer.id))

describe('UC-NOTICO-NOTION-005 browse the workspace', () => {
  it('[UC-NOTICO-NOTION-005-S01] lists the top level by section, with titles and ids and no content', async () => {
    const tab = notion(
      [
        page(1, 'Notes', [id(9)]),
        { id: id(2), type: 'collection_view_page', collection_id: COLLECTION },
        page(3, 'Shared plan'),
        page(5, 'Company home'),
        page(4, 'Eng handbook'),
      ],
      { collections: [{ id: COLLECTION, name: [['Tasks']] }] },
    )
      .respond(
        'getSpaces',
        200,
        spaces({ pages: [id(5)] }, { private_pages: [id(1), id(2)], shared_pages_manual_sort: [id(3)] }),
      )
      .respond('getTeamsV2', 200, teams([team(1, 'Engineering', [id(4)])]))
      .install()

    expect(await run()).toBe(
      [
        'Pages in the workspace “Fixture workspace”:',
        '',
        'Private',
        `- 📄 Notes ^${hex(id(1))}`,
        `- 🗃 Tasks ^${hex(id(2))}`,
        '',
        'Shared',
        `- 📄 Shared plan ^${hex(id(3))}`,
        '',
        'Workspace',
        `- 📄 Company home ^${hex(id(5))}`,
        '',
        'Teamspace: Engineering',
        `- 📄 Eng handbook ^${hex(id(4))}`,
      ].join('\n'),
    )
    // No page content was loaded, nor the blocks under the listed pages.
    expect(endpoints(tab)).not.toContain('loadPageChunk')
    expect(lookups(tab).flat()).not.toContain(id(9))
  })

  it('[UC-NOTICO-NOTION-005-S05] lists the teamspaces the user joined, in the order Notion gives them, without archived ones', async () => {
    const tab = notion([page(1, 'Notes'), page(21, 'Brand'), page(22, 'Icons'), page(11, 'Eng handbook')])
      .respond('getSpaces', 200, spaces({}, { private_pages: [id(1)] }))
      .respond(
        'getTeamsV2',
        200,
        teams([
          team(2, 'Design', [id(21), id(22)]),
          team(3, 'Old team', [id(31)], { archived_by: USER, archived_at: 1 }),
          team(1, 'Engineering', [id(11)]),
        ]),
      )
      .install()

    expect(await run()).toBe(
      [
        'Pages in the workspace “Fixture workspace”:',
        '',
        'Private',
        `- 📄 Notes ^${hex(id(1))}`,
        '',
        'Teamspace: Design',
        `- 📄 Brand ^${hex(id(21))}`,
        `- 📄 Icons ^${hex(id(22))}`,
        '',
        'Teamspace: Engineering',
        `- 📄 Eng handbook ^${hex(id(11))}`,
      ].join('\n'),
    )
    const asked = tab.sent.find((r) => r.url.endsWith('/getTeamsV2'))!
    expect(asked.body).toEqual({ spaceId: SPACE, teamTypes: ['Joined'] })
    // The archived teamspace's pages were never looked up.
    expect(JSON.stringify(tab.sent.map((r) => r.body))).not.toContain(id(31))
  })

  it('[UC-NOTICO-NOTION-005-S02] lists the pages under a page, as deep as asked and no deeper', async () => {
    const tab = notion([
      page(10, 'Projects', [id(11), id(12), id(13)]),
      page(11, 'Alpha', [id(21)]),
      { id: id(12), type: 'text', properties: { title: [['Just text']] } },
      { id: id(13), type: 'column_list', content: [id(14)] },
      { id: id(14), type: 'column', content: [id(15)] },
      page(15, 'Beta'),
      page(21, 'Alpha notes', [id(31)]),
      page(31, 'Too deep'),
    ]).install()

    expect(await run({ page: hex(id(10)), depth: 2 })).toBe(
      [
        `Pages under “Projects” ^${hex(id(10))}:`,
        '',
        `- 📄 Alpha ^${hex(id(11))}`,
        `  - 📄 Alpha notes ^${hex(id(21))}`,
        `- 📄 Beta ^${hex(id(15))}`,
      ].join('\n'),
    )
    // Alpha notes' own child (a third level) was never asked for.
    expect(JSON.stringify(tab.sent.map((r) => r.body))).not.toContain(id(31))
  })

  it('[UC-NOTICO-NOTION-005-S03] says when the list was cut off', async () => {
    const many = range(100, LIST_LIMIT + 20)
    notion([page(10, 'Big', many), ...pages(many, 'Page')]).install()
    const result = await run({ page: hex(id(10)) })
    expect(listed(result)).toHaveLength(LIST_LIMIT)
    expect(result).toContain(`(Cut off: more entries follow. List them with \`offset: ${LIST_LIMIT}\`.)`)
  })

  it('[UC-NOTICO-NOTION-005-S06] lists the entries after the ones a cut-off list showed', async () => {
    // A text block among the children counts as an entry, so the offset lines up with the page's own list.
    const many = [id(99), ...range(100, LIST_LIMIT + 20)]
    const blocks = [page(10, 'Big', many), ...text([id(99)]), ...pages(many.slice(1), 'Page')]
    notion(blocks).install()
    const first = await run({ page: hex(id(10)) })
    const next = LIST_LIMIT + 1
    expect(first).toContain(`List them with \`offset: ${next}\`.`)
    notion(blocks).install()
    const result = await run({ page: hex(id(10)), offset: next })
    expect(result.split('\n')[0]).toBe(`Pages under “Big” ^${hex(id(10))}, from entry ${next}:`)
    expect(listed(result)).toEqual(many.slice(next).map((m, i) => `- 📄 Page ${LIST_LIMIT + i} ^${hex(m)}`))
    expect(result).not.toContain('Cut off')
  })

  it('[UC-NOTICO-NOTION-005-S06] picks up inside columns that hold more pages than one list shows', async () => {
    // Two pages before the columns, and more pages in them than one list shows.
    const inside = range(100, LIST_LIMIT + 50)
    const blocks = [
      page(10, 'Columns', [id(1), id(2), id(3)]),
      page(1, 'First'),
      page(2, 'Second'),
      { id: id(3), type: 'column_list', content: [id(4)] },
      { id: id(4), type: 'column', content: inside },
      ...pages(inside, 'Page'),
    ]
    const seen: string[] = []
    let offset = 0
    for (let call = 0; call < 3; call++) {
      notion(blocks).install()
      const result = await run({ page: hex(id(10)), ...(offset ? { offset } : {}) })
      seen.push(...listed(result))
      const next = result.match(/`offset: (\d+)`/)
      if (!next) break
      expect(Number(next[1])).toBeGreaterThan(offset)
      offset = Number(next[1])
    }
    // Every page once, in order, across the calls.
    expect(seen).toEqual([
      `- 📄 First ^${hex(id(1))}`,
      `- 📄 Second ^${hex(id(2))}`,
      ...inside.map((m, i) => `- 📄 Page ${i} ^${hex(m)}`),
    ])
  })

  it('[UC-NOTICO-NOTION-005-S06] lists one top-level section from where it was cut off', async () => {
    const many = range(200, SECTION_LIMIT + 10)
    const workspace = () =>
      notion([page(1, 'Notes'), ...pages(many, 'Eng')])
        .respond('getSpaces', 200, spaces({}, { private_pages: [id(1)] }))
        .respond('getTeamsV2', 200, teams([team(1, 'Engineering', many)]))
        .install()
    workspace()
    const first = await run()
    expect(first).toContain(
      `(Cut off: more entries follow. List them with \`section: "Teamspace: Engineering"\` and \`offset: ${SECTION_LIMIT}\`.)`,
    )

    workspace()
    const rest = await run({ section: 'Teamspace: Engineering', offset: SECTION_LIMIT })
    expect(rest).toBe(
      [
        `Teamspace: Engineering, in the workspace “Fixture workspace”, from entry ${SECTION_LIMIT}:`,
        '',
        ...many.slice(SECTION_LIMIT).map((m, i) => `- 📄 Eng ${SECTION_LIMIT + i} ^${hex(m)}`),
      ].join('\n'),
    )
  })

  it('[UC-NOTICO-NOTION-005-S08] says what it did not look into when the list fills up before the asked depth', async () => {
    // Exactly full at the top level, and every page holds blocks: whether they hold pages isn't looked up.
    const kids = range(300, LIST_LIMIT)
    const tab = notion([page(10, 'Exactly full', kids), ...pages(kids, 'Child', () => [id(900)])]).install()
    const result = await run({ page: hex(id(10)), depth: 2 })
    expect(listed(result)).toHaveLength(LIST_LIMIT)
    expect(result.split('\n').at(-1)).toBe(
      '(Not looked into: what is under some of the pages shown, to keep this list short and its requests to Notion ' +
        'few. To see what is under a listed page, list it by its id.)',
    )
    expect(result).not.toContain('Cut off')
    expect(lookups(tab).flat()).not.toContain(id(900))
  })
})

describe('list_pages sections', () => {
  it('gives each top-level section its own limit, so a long one hides no other', async () => {
    const many = range(200, SECTION_LIMIT + 10)
    // A shared page that is also private is listed under Private only.
    notion([...pages(many, 'Private'), page(3, 'Shared plan')])
      .respond('getSpaces', 200, spaces({}, { private_pages: many, shared_pages_manual_sort: [id(3), many[0]] }))
      .respond('getTeamsV2', 200, teams([]))
      .install()
    const result = await run()
    expect(result).toContain(
      `(Cut off: more entries follow. List them with \`section: "Private"\` and \`offset: ${SECTION_LIMIT}\`.)`,
    )
    // The shared section is still there, and a page already listed isn't listed twice.
    expect(result.split('Shared\n')[1]).toBe(`- 📄 Shared plan ^${hex(id(3))}`)
  })
})

describe('list_pages arguments', () => {
  it('checks depth and the page before asking Notion', async () => {
    const tab = new FakeNotionTab(PAGE_URL).install()
    await expect(run({ depth: 4 })).rejects.toThrow('`depth` must be a whole number from 1 to 3.')
    await expect(run({ page: 'Roadmap' })).rejects.toThrow('Not a Notion page URL or id: Roadmap')
    expect(tab.sent).toEqual([])
  })

  it('refuses arguments that are not what its schema says, without asking Notion', async () => {
    const tab = new FakeNotionTab(PAGE_URL).install()
    await expect(run({ depth: 0 })).rejects.toThrow('`depth` must be a whole number from 1 to 3.')
    await expect(run({ depth: 1.5 })).rejects.toThrow('`depth` must be a whole number from 1 to 3.')
    await expect(run({ depth: '2' })).rejects.toThrow('`depth` must be a whole number from 1 to 3.')
    await expect(run({ section: 'Private', offset: 'ten' })).rejects.toThrow(
      '`offset` must be a whole number of at least 0.',
    )
    await expect(run({ page: 5 })).rejects.toThrow('`page`: Invalid input: expected string, received number')
    await expect(run({ section: ['Private'] })).rejects.toThrow(
      '`section`: Invalid input: expected string, received array',
    )
    await expect(run({ limit: 10 })).rejects.toThrow('Unrecognized key: "limit"')
    expect(tab.sent).toEqual([])
  })

  it('checks section and offset before asking Notion', async () => {
    const tab = new FakeNotionTab(PAGE_URL).install()
    await expect(run({ offset: 5 })).rejects.toThrow('`offset` needs `page` or `section`.')
    await expect(run({ page: hex(id(10)), section: 'Private' })).rejects.toThrow('Give `page` or `section`, not both.')
    await expect(run({ page: hex(id(10)), offset: -1 })).rejects.toThrow(
      '`offset` must be a whole number of at least 0.',
    )
    expect(tab.sent).toEqual([])
  })

  it('names the sections there are when asked for one that is not', async () => {
    notion([])
      .respond('getSpaces', 200, spaces({}, { private_pages: [id(1)] }))
      .respond('getTeamsV2', 200, teams([team(1, 'Engineering', [id(11)])]))
      .install()
    await expect(run({ section: 'Marketing' })).rejects.toThrow(
      'No section “Marketing”. The sections are: Private, Shared, Workspace, Teamspace: Engineering.',
    )
  })

  it('tells apart teamspaces named like a built-in section or like each other', async () => {
    const workspace = () =>
      notion([page(1, 'Notes'), page(11, 'Team notes'), page(21, 'First'), page(31, 'Second'), page(41, 'Third')])
        .respond('getSpaces', 200, spaces({}, { private_pages: [id(1)] }))
        .respond(
          'getTeamsV2',
          200,
          teams([
            team(1, 'Private', [id(11)]),
            team(2, 'Design', [id(21)]),
            team(3, 'Design', [id(31)]),
            team(4, 'Design (1)', [id(41)]),
          ]),
        )
        .install()
    workspace()
    await expect(run({ section: 'nope' })).rejects.toThrow(
      'The sections are: Private, Shared, Workspace, Teamspace: Private, Teamspace: Design (1), Teamspace: Design (2), ' +
        'Teamspace: Design (1) (1).',
    )
    const section = async (name: string) => {
      workspace()
      return (await run({ section: name })).split('\n').slice(2)
    }
    expect(await section('Private')).toEqual([`- 📄 Notes ^${hex(id(1))}`])
    expect(await section('Teamspace: Private')).toEqual([`- 📄 Team notes ^${hex(id(11))}`])
    expect(await section('teamspace: design (2)')).toEqual([`- 📄 Second ^${hex(id(31))}`])
    expect(await section('Teamspace: Design (1) (1)')).toEqual([`- 📄 Third ^${hex(id(41))}`])
    // A teamspace's own name picks it, even when another teamspace's label looks the same.
    expect(await section('Design (1)')).toEqual([`- 📄 Third ^${hex(id(41))}`])
    // A name two teamspaces share names neither.
    workspace()
    await expect(run({ section: 'Design' })).rejects.toThrow('No section “Design”.')
  })

  it('tells apart teamspaces whose names differ only in case', async () => {
    const workspace = () =>
      notion([page(11, 'Upper'), page(21, 'Lower')])
        .respond('getSpaces', 200, spaces({}, {}))
        .respond('getTeamsV2', 200, teams([team(1, 'Design', [id(11)]), team(2, 'design', [id(21)])]))
        .install()
    workspace()
    await expect(run({ section: 'nope' })).rejects.toThrow(
      'The sections are: Private, Shared, Workspace, Teamspace: Design (1), Teamspace: design (2).',
    )
    workspace()
    expect((await run({ section: 'Teamspace: design (2)' })).split('\n').slice(2)).toEqual([
      `- 📄 Lower ^${hex(id(21))}`,
    ])
  })

  it('says a page with nothing under it has no pages', async () => {
    notion([page(10, 'Empty')]).install()
    expect(await run({ page: hex(id(10)) })).toBe(`Pages under “Empty” ^${hex(id(10))}:\n\n(no pages)`)
  })
})

describe('list_pages at the limit', () => {
  it('looks under the listed pages only until the list is full', async () => {
    // Each child holds a lot of text before its one subpage, so every child looked into costs lookups.
    const kids = range(300, LIST_LIMIT - 2)
    const tab = notion([
      page(10, 'Nearly full', kids),
      ...kids.flatMap((k, i) => wordy(k, `Child ${i}`, range(10_000 + i * 200, 150), 1000 + i)),
    ]).install()
    const result = await run({ page: hex(id(10)), depth: 2 })
    expect(listed(result)).toHaveLength(LIST_LIMIT)
    expect(result).toContain(
      `(Cut off: this list shows at most ${LIST_LIMIT} pages, so some pages under the ones shown are left out.`,
    )
    // The page itself, its children, the first two children's 302 blocks in batches of 100, and one
    // more to tell that more pages follow: not the blocks of all 98 children.
    expect(lookups(tab)).toHaveLength(7)
  })

  it('gives the next offset by position when the list holds an id twice', async () => {
    // The first child is listed again later; the offset still points past the last one shown.
    const kids = range(700, LIST_LIMIT + 5)
    kids[LIST_LIMIT - 1] = kids[0]
    notion([page(10, 'Twice', kids), ...pages([...new Set(kids)], 'Child')]).install()
    expect(await run({ page: hex(id(10)) })).toContain(`List them with \`offset: ${LIST_LIMIT}\`.)`)
  })

  it('says pages under the ones shown may be left out too when the top level is cut off deeper than one level', async () => {
    const kids = range(300, LIST_LIMIT + 1)
    notion([page(10, 'Too many', kids), ...pages(kids, 'Child', () => [id(900)])]).install()
    expect(await run({ page: hex(id(10)), depth: 2 })).toContain(
      `List them with \`offset: ${LIST_LIMIT}\`. Pages under the ones shown may be left out too. To see what is under a listed page, list it by its id.)`,
    )
  })

  it('says nothing is left out when the pages shown hold nothing', async () => {
    const kids = range(300, LIST_LIMIT)
    notion([page(10, 'Flat', kids), ...pages(kids, 'Child')]).install()
    const result = await run({ page: hex(id(10)), depth: 3 })
    expect(listed(result)).toHaveLength(LIST_LIMIT)
    expect(result).not.toContain('(')
  })
})

describe('list_pages requests to Notion', () => {
  it('looks up each block at most once, even ones the user cannot open', async () => {
    // Children the user can't open (missing from the workspace), some inside columns, at every level.
    const kids = range(100, 10)
    const blocks: Rec[] = [page(10, 'Root', [...range(5000, 20), ...kids])]
    kids.forEach((k, i) => {
      const [list, column, sub] = [id(200 + i), id(300 + i), id(400 + i)]
      blocks.push(
        { ...page(0, `Child ${i}`, [...range(6000 + i * 20, 10), list]), id: k },
        { id: list, type: 'column_list', content: [column] },
        { id: column, type: 'column', content: [...range(7000 + i * 20, 5), sub] },
        { ...page(0, `Sub ${i}`, range(8000 + i * 20, 5)), id: sub },
      )
    })
    const tab = notion(blocks).install()
    const result = await run({ page: hex(id(10)), depth: 3 })
    expect(listed(result)).toHaveLength(20)
    const asked = lookups(tab).flat()
    expect(asked.length).toBe(new Set(asked).size)
    // The page, its blocks, then each level's blocks: the column lists and columns cost one more each.
    expect(lookups(tab)).toHaveLength(7)
  })

  it(`stops after ${LIST_LOOKUPS} lookups and says what it did not look into`, async () => {
    // Every child holds a lot of text before its one subpage.
    const kids = range(100, 10)
    const tab = notion([
      page(10, 'Wordy', kids),
      ...kids.flatMap((k, i) => wordy(k, `Child ${i}`, range(10_000 + i * 400, 300), 1000 + i)),
    ]).install()
    const result = await run({ page: hex(id(10)), depth: 2 })
    // The page itself, then the lookups one list may make.
    expect(lookups(tab)).toHaveLength(1 + LIST_LOOKUPS)
    expect(listed(result).length).toBeLessThan(20)
    expect(result).toContain('(Not looked into: what is under some of the pages shown,')
  })

  it("picks up where a list ran out of lookups in a page's own blocks", async () => {
    const words = range(10_000, LIST_LOOKUPS * 100 + 50)
    const kids = range(100, 3)
    const blocks = [page(10, 'Long', [...words, ...kids]), ...text(words), ...pages(kids, 'Child')]
    notion(blocks).install()
    const first = await run({ page: hex(id(10)) })
    expect(first).toContain(`(Cut off: more entries may follow. List them with \`offset: ${LIST_LOOKUPS * 100}\`.)`)
    notion(blocks).install()
    const rest = await run({ page: hex(id(10)), offset: LIST_LOOKUPS * 100 })
    expect(listed(rest)).toEqual(kids.map((k, i) => `- 📄 Child ${i} ^${hex(k)}`))
  })

  it('[UC-NOTICO-NOTION-005-S09] lists the top level of many teamspaces with a request or two, not one per section', async () => {
    // Twenty teamspaces of two wordy pages each, and a database among them.
    const list = Array.from({ length: 20 }, (_, t) => team(t + 1, `Team ${t}`, range(100 + t * 2, 2)))
    const blocks: Rec[] = list.flatMap((_, t) =>
      [0, 1].flatMap((p) =>
        wordy(id(100 + t * 2 + p), `Team ${t} page ${p}`, range(10_000 + (t * 2 + p) * 400, 300), 1000 + t * 2 + p),
      ),
    )
    blocks[0] = { id: id(100), type: 'collection_view_page', collection_id: COLLECTION }
    const tab = notion(blocks, { collections: [{ id: COLLECTION, name: [['Tasks']] }] })
      .respond('getSpaces', 200, spaces({}, {}))
      .respond('getTeamsV2', 200, teams(list))
      .install()
    const result = await run()
    expect(listed(result)).toHaveLength(40)
    expect(result).toContain(`Teamspace: Team 0\n- 🗃 Tasks ^${hex(id(100))}\n- 📄 Team 0 page 1 ^${hex(id(101))}`)
    // The open page, then every section's pages at once, then the database's name.
    expect(endpoints(tab).filter((e) => e === 'syncRecordValuesMain')).toHaveLength(3)

    // Looking under them needs a section or page, and is refused before asking Notion.
    const sent = tab.sent.length
    await expect(run({ depth: 2 })).rejects.toThrow('`depth` needs `page` or `section`')
    expect(tab.sent).toHaveLength(sent)
  })

  it('names a section it ran out of lookups for as not listed', async () => {
    // None of Private's pages can be opened, so looking for one runs out of lookups.
    const tab = notion([page(3, 'Shared plan')])
      .respond('getSpaces', 200, spaces({}, { private_pages: range(10_000, 2000), shared_pages_manual_sort: [id(3)] }))
      .respond('getTeamsV2', 200, teams([]))
      .install()
    const result = await run()
    expect(result).toContain('Not listed, to keep the list short: Private. List one with `section`.')
    expect(result).toContain(`Shared\n- 📄 Shared plan ^${hex(id(3))}`)
    // The open page, then the lookups the overview's sections share.
    expect(lookups(tab)).toHaveLength(1 + LIST_LOOKUPS)
  })

  it("asks for the open page's workspace once", async () => {
    const tab = notion([page(1, 'Notes')])
      .respond('getSpaces', 200, spaces({}, { private_pages: [id(1)] }))
      .respond('getTeamsV2', 200, teams([]))
      .respond('getSpaces', 200, spaces({}, { private_pages: [id(1)] }))
      .respond('getTeamsV2', 200, teams([]))
      .install()
    await run()
    await run()
    expect(lookups(tab).filter((ids) => ids.includes(PAGE))).toHaveLength(1)
  })

  it('stops the question when Notion turns a lookup away, and sends nothing more', async () => {
    const kids = range(100, 3)
    const root = page(10, 'Root', kids)
    const tab = notion([root, ...pages(kids, 'Child', () => [id(900)])])
      .respond('syncRecordValuesMain', 200, { recordMap: { __version__: 3, block: { [root.id]: wrapped(root) } } })
      .limit('syncRecordValuesMain', 1)
      .install()
    expect((await notionError(run({ page: hex(id(10)), depth: 2 }))).stopsQuestion).toBe(LIMITED_STOP)
    expect(lookups(tab)).toHaveLength(2)
  })
})

describe('list_pages workspace', () => {
  it("reads the tab's own user's view when several signed-in users share the workspace", async () => {
    const OTHER = '0e0e0e0e-0000-4000-8000-000000000099'
    notion([page(1, 'Mine'), page(2, 'Theirs')])
      // The other account comes first, as Notion may list it.
      .respond('getSpaces', 200, {
        ...spaces({}, { private_pages: [id(2)] }, OTHER),
        ...spaces({}, { private_pages: [id(1)] }),
      })
      .respond('getTeamsV2', 200, teams([]))
      .install()
    expect(await run()).toContain(`Private\n- 📄 Mine ^${hex(id(1))}`)
  })

  it("says so when Notion's answer has nothing for the tab's own user", async () => {
    const OTHER = '0e0e0e0e-0000-4000-8000-000000000099'
    notion([])
      .respond('getSpaces', 200, spaces({}, { private_pages: [id(2)] }, OTHER))
      .install()
    const err = await notionError(run())
    expect(err.code).toBe('notion_error')
    expect(err.message).toBe(NO_USER_MAP)
  })

  it('says the tab is signed out when it has no Notion user, and reads no account', async () => {
    notion([], { cookie: 'notion_browser_id=b' })
      .respond('getSpaces', 200, spaces({}, { private_pages: [id(1)] }))
      .install()
    expect((await notionError(run())).code).toBe('signed_out')
  })

  it('finds the tab user when Notion keys it without hyphens', async () => {
    notion([page(1, 'Mine')])
      .respond('getSpaces', 200, spaces({}, { private_pages: [id(1)] }, USER.replace(/-/g, '')))
      .respond('getTeamsV2', 200, teams([]))
      .install()
    expect(await run()).toContain(`Private\n- 📄 Mine ^${hex(id(1))}`)
  })

  it('finds the tab user by an undashed cookie id', async () => {
    notion([page(1, 'Mine')], { cookie: `notion_user_id=${USER.replace(/-/g, '')}` })
      .respond('getSpaces', 200, spaces({}, { private_pages: [id(1)] }))
      .respond('getTeamsV2', 200, teams([]))
      .install()
    expect(await run()).toContain(`Private\n- 📄 Mine ^${hex(id(1))}`)
  })

  it('keeps a page in its first section only, even where that section is cut off before it', async () => {
    const many = range(600, SECTION_LIMIT + 1)
    const last = many.at(-1)!
    notion([...pages(many, 'Private'), page(3, 'Shared plan')])
      .respond('getSpaces', 200, spaces({}, { private_pages: many, shared_pages_manual_sort: [last, id(3)] }))
      .respond('getTeamsV2', 200, teams([]))
      .install()
    const result = await run()
    // The last private page is cut from Private and isn't moved to Shared; Private's offset reaches it.
    expect(result).toContain(`List them with \`section: "Private"\` and \`offset: ${SECTION_LIMIT}\`.)`)
    expect(result.split('Shared\n')[1]).toBe(`- 📄 Shared plan ^${hex(id(3))}`)
  })

  it('asks for teamspaces when the workspace does not say whether it has them', async () => {
    notion([page(11, 'Eng handbook')])
      .respond('getSpaces', 200, spaces({ settings: {} }, {}))
      .respond('getTeamsV2', 200, teams([team(1, 'Engineering', [id(11)])]))
      .install()
    expect(await run()).toContain(`Teamspace: Engineering\n- 📄 Eng handbook ^${hex(id(11))}`)
  })

  it('leaves out teams that getTeamsV2 lists as anything but joined', async () => {
    const answer = teams([team(1, 'Engineering', [id(11)]), team(2, 'Elsewhere', [id(21)])])
    answer.teams[1].type = 'Archived'
    notion([page(11, 'Eng handbook'), page(21, 'Elsewhere page')])
      .respond('getSpaces', 200, spaces({}, {}))
      .respond('getTeamsV2', 200, answer)
      .install()
    const result = await run()
    expect(result).toContain('Teamspace: Engineering')
    expect(result).not.toContain('Elsewhere')
  })

  it('lists a section alone as the overview does, without pages an earlier section has', async () => {
    // The private page is also in Shared. Shared leaves it out, alone and in the overview, so their offsets agree.
    const shared = [id(1), ...range(400, SECTION_LIMIT + 5)]
    const blocks = pages(shared.slice(1), 'Shared')
    const workspace = () =>
      notion([page(1, 'Notes'), ...blocks])
        .respond('getSpaces', 200, spaces({}, { private_pages: [id(1)], shared_pages_manual_sort: shared }))
        .respond('getTeamsV2', 200, teams([]))
        .install()
    workspace()
    expect(await run()).toContain(`List them with \`section: "Shared"\` and \`offset: ${SECTION_LIMIT}\`.)`)
    workspace()
    const rest = (await run({ section: 'Shared', offset: SECTION_LIMIT })).split('\n').slice(2)
    expect(rest).toEqual(blocks.slice(SECTION_LIMIT).map((b, i) => `- 📄 Shared ${SECTION_LIMIT + i} ^${hex(b.id)}`))
  })

  it('stops the question when the teamspaces fail in a way that is not understood', async () => {
    const tab = notion([page(1, 'Notes')])
      .respond('getSpaces', 200, spaces({}, { private_pages: [id(1)] }))
      .respond('getTeamsV2', 400, { name: 'ValidationError', debugMessage: 'Invalid input.' })
      .install()
    expect((await notionError(run())).stopsQuestion).toBe(
      `${UNEXPECTED_STOP} Notion returned an error (400 ValidationError): Invalid input.`,
    )
    expect(endpoints(tab)).toEqual(['syncRecordValuesMain', 'getSpaces', 'getTeamsV2'])
  })

  it('still lists the other sections when the teamspaces can not be opened', async () => {
    notion([page(1, 'Notes')])
      .respond('getSpaces', 200, spaces({}, { private_pages: [id(1)] }))
      .respond('getTeamsV2', 403, { name: 'PermissionError', message: 'No access.' })
      .install()
    expect(await run()).toBe(
      [
        'Pages in the workspace “Fixture workspace”:',
        '',
        'Private',
        `- 📄 Notes ^${hex(id(1))}`,
        '',
        "(Teamspaces could not be listed: The Notion page doesn't exist, or the signed-in Notion account has no access to it.)",
      ].join('\n'),
    )
  })

  it('stops the question when Notion turns the teamspaces away, and sends nothing more', async () => {
    const tab = notion([page(1, 'Notes')])
      .respond('getSpaces', 200, spaces({}, { private_pages: [id(1)] }))
      .limit('getTeamsV2', 1)
      .install()
    expect((await notionError(run())).stopsQuestion).toBe(LIMITED_STOP)
    expect(endpoints(tab)).toEqual(['syncRecordValuesMain', 'getSpaces', 'getTeamsV2'])
  })

  it('asks for no teamspaces in a workspace that has them turned off', async () => {
    const tab = notion([page(1, 'Notes')])
      .respond('getSpaces', 200, spaces({ settings: { is_teams_enabled: false } }, { private_pages: [id(1)] }))
      .install()
    expect(await run()).toBe(
      ['Pages in the workspace “Fixture workspace”:', '', 'Private', `- 📄 Notes ^${hex(id(1))}`].join('\n'),
    )
    expect(endpoints(tab)).not.toContain('getTeamsV2')
  })

  it('says so when the open page is in the trash', async () => {
    const tab = new FakeNotionTab(PAGE_URL)
    tab.workspace = new FakeWorkspace([{ id: PAGE, type: 'page', alive: false }], SPACE)
    tab.install()
    await expect(run()).rejects.toThrow('The open page is in the trash. Open another page of the workspace.')
  })
})
