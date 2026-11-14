# UC-NOTICO-NOTION-005: Browse the workspace

## Behavior

A signed-in user asks the AI how their Notion workspace is organized: "what projects do I have?", "what's under this page?", "where does the roadmap live?". The AI lists pages and databases the way Notion's sidebar shows them: the top level of the open page's workspace, by section (the user's private pages and shared pages, the workspace's pages, and each teamspace the user joined, leaving out archived ones), or one of those sections or the pages and databases under a page, a few levels deep if asked. The whole workspace is listed one level deep only; to look further, the AI lists a section or a page. It gets titles and a way to open each one, never their content; reading a page is UC-NOTICO-NOTION-001.

A large workspace is listed only up to a limit, and the AI is told when the list was cut off and how to list the rest: one section at a time, the pages under a listed page, or the entries after the ones shown. To spare the user's Notion account, a list also looks only so far into the pages it shows, and the whole workspace's top level costs Notion about the same few requests however many teamspaces it has; when it stops before the asked depth, the AI is told what it didn't look into, not that pages were cut off. As with reading, the listing runs as the user's own Notion account, so it shows only pages that account can open.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-NOTION-005-S01 | P0 | ✅ | Given a workspace with private and shared pages; when the AI lists the top level; then it gets each section's pages and databases with their titles and a way to open them, each page once, and no page content. |
| UC-NOTICO-NOTION-005-S02 | P1 | ✅ | Given a page with pages nested under it, some inside columns; when the AI lists it two levels deep; then it gets those two levels and nothing deeper. |
| UC-NOTICO-NOTION-005-S03 | P1 | ✅ | Given more pages than one list shows; when the AI lists them; then it gets the first ones and is told the list was cut off. |
| UC-NOTICO-NOTION-005-S05 | P0 | ✅ | Given a workspace with teamspaces, some joined by the user and one of them archived; when the AI lists the top level; then it gets each joined teamspace that isn't archived, in the order Notion gives them, with its pages under its name. |
| UC-NOTICO-NOTION-005-S06 | P1 | ✅ | Given a page or a top-level section with more pages than one list shows; when the AI asks for the entries after the ones shown; then it gets the next ones, picking up where the list was cut off. |
| UC-NOTICO-NOTION-005-S09 | P1 | ✅ | Given a workspace with many teamspaces; when the AI lists its top level; then it gets every section's pages with a request or two to Notion, not one per section, and asking for more than one level without naming a section or page is refused before Notion is asked. |
| UC-NOTICO-NOTION-005-S08 | P1 | ✅ | Given a list that fills up before the asked depth; when the AI lists it; then it is told that what is under the last pages shown wasn't looked into, and not that pages were cut off. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-NOTION-005-S04 | P0 | ✅ | Given the side panel open on a page with pages under it; when the user asks what is under it; then the agent lists them without reading their content. |
| UC-NOTICO-NOTION-005-S07 | P1 | ✅ | Given the side panel open in a workspace with a teamspace the user joined; when the user asks what teamspaces they have; then the agent names the teamspace and the pages in it. |
