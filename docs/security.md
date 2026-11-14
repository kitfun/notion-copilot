# Security review

A review of the path from a user's question to what happens in Notion and in the worker: where it is weak against misuse, what already limits each weakness, and what is to be done about it. It was made for [#107](https://github.com/cofun-labs/cofun/issues/107) on 2026-11-14, against `main` at `e53e599` (Notico 0.1.0 plus what merged since).

It is a reading of the code and its tests, not a penetration test: nothing was tried against the deployed worker, real accounts, or a real Notion workspace. Where a control is said to hold, the code that enforces it and the test that pins it are named. Where something was not checked, it says so.

A change that touches one of the areas below is checked against this file, and updates it in the same PR when it changes a finding or a control (see [Rules for later changes](#rules-for-later-changes)). There is no private way to report a vulnerability yet ([#384](https://github.com/cofun-labs/cofun/issues/384) adds one). Until it exists, ask in #384 for a private contact, without the details: do not put the details of a hole that can be used in a public Issue.

## Threat model in brief

What is worth protecting:

- **The user's Notion workspace**: what it says (confidentiality), that it changes only as the user wants (integrity), and the account's standing with Notion (the tools call Notion's internal API as the user).
- **What is on the device**: chats (which hold Notion content the agent read), the Clerk client token, and the user's own OpenRouter and DeepSeek keys.
- **The account and its credits**: nobody else spends them or reads them.
- **The operator's money and secrets**: the hosted model's cost, the Stripe account, the Clerk instance, the Cloudflare account, and the right to publish the extension.

Who attacks, from where:

| Attacker | What they control |
|---|---|
| Someone who can put text where the agent reads it | A page shared with the user, a block or a row in a page they can edit, a page title, a comment, a page that shows up in a search. They need no account with Cofun and no access to the user's machine |
| A website the user visits | Its own pages, and requests the browser makes from them (cross-origin, with the cookies the browser attaches) |
| A signed-in Cofun user | Their own session token, so any request to the worker under their own account, at any rate and in any shape |
| Anyone on the internet | Requests to the worker's open routes (`/login`, `/admin`, `/billing/*`, `/stripe/webhook`, `/health`) |
| Someone with the Chrome profile | Everything the extension keeps on the device. Out of scope as an attacker to stop: the privacy pages say what is kept and that it is not encrypted |
| A contributor to the public repository | Issues, comments, and pull requests from forks |

Not covered: Notion, Clerk, Stripe, Cloudflare, OpenRouter, and DeepSeek being compromised themselves, and a malicious dependency in the build (limited by the lockfile, dependency review in CI, and Dependabot, not reviewed package by package).

Severity is what it would cost if it happened, weighed by how likely it is (the summary gives the likelihood of each by itself): **High** (a user's Notion content or account exposed or changed without them doing anything unusual), **Medium** (needs a condition the attacker does not fully control, or costs the operator money), **Low** (little to gain, or needs the user's machine or a click), **Info** (a control that was checked and holds, recorded so a later change does not lose it).

## Summary

| | Finding | Severity | How likely | Status |
|---|---|---|---|---|
| A1 | Text the agent reads can make it write as the user, unasked | High | Medium: normal use reaches it; depends on the model | Accepted for now; fix proposed → [#388](https://github.com/cofun-labs/cofun/issues/388), [#387](https://github.com/cofun-labs/cofun/issues/387) |
| A2 | Reading beyond Notion (planned) widens A1 and can add a way out for data | High once it ships | Not yet: nothing shipped | Fix proposed → raise [#348](https://github.com/cofun-labs/cofun/issues/348) from `later` before the first outside source ships |
| A3 | One question can change many pages | Medium | Low | Accepted; narrowed by #388 |
| A4 | Data can leave in a link someone clicks | Low | Low: needs a click | Accepted trade-off |
| A5 | Mention refusals reveal members' names | Low | Low | Accepted; [#137](https://github.com/cofun-labs/cofun/issues/137) |
| B1 | Chats and keys on the device are not encrypted | Low | Low: needs the device | Accepted trade-off |
| B2 | `static.cofun.cc` is on the same site as the sign-in | Low | Low: needs a maintainer mistake | Accepted, with a rule |
| C1 | A session token with no `azp` is accepted | Low | Very low | Fix proposed → [#385](https://github.com/cofun-labs/cofun/issues/385) |
| C2 | Findings about the hosted model's cost to the operator | Medium | Medium | Reported privately; details withheld here |
| C3 | Nothing bounds what all accounts together spend on the hosted model | Medium | Medium | Fix proposed → [#386](https://github.com/cofun-labs/cofun/issues/386) |
| C4 | The worker's pages have no script policy | Low | Low: no known injection | Fix proposed → #385 |
| C5 | Request bodies are read whole before they are measured | Low | Low | Fix proposed → #385 |
| C6 | Only the chat is rate limited | Low | Low | Fix proposed → #385 |
| C7 | Credits spent before a dispute are not recovered | Low | Low | Accepted trade-off |
| D1 | Secret scanning and push protection are off on the repository | Medium | Low: needs a maintainer mistake | Fix proposed → [#384](https://github.com/cofun-labs/cofun/issues/384) |
| D2 | No private way to report a vulnerability | Medium | Not an attack: a gap | Fix proposed → #384 |
| D3 | The `@claude` workflow reads text anyone can write, with write access | Medium | Low | Fix proposed → [#392](https://github.com/cofun-labs/cofun/issues/392) |

No credential or account identifier was found in the repository or its history, and no way was found to act as another user, read another user's data, or spend another user's credits.

## A. The agent: from text it reads to changes in Notion

How it works today. The agent loop runs in the side panel (`extensions/notico/src/agent/agent.ts`). The model gets a system prompt (`SYSTEM_PROMPT` in `src/sidepanel/Chat.tsx`), the conversation, and sixteen tools (`src/tools/index.ts`). Nine of them change Notion (`changesData`): `edit_page`, `create_page`, `update_pages`, `create_database`, `update_database_schema`, `move_page`, `duplicate_page`, `trash_page`, `add_comment`. Only `trash_page` asks the user first (`needsConfirmation`). Everything a tool returns is Notion's text as Markdown; the hosted model is a small, fast one, and a user may choose any model on OpenRouter.

### A1. Text the agent reads can make it write as the user, unasked (High)

- **The attacker controls** any text a tool returns: the body of a page shared with the user or editable by a guest, a database row, a page title (it also travels in the note ahead of each question, and in search results), a comment, the user's selection.
- **They could get** any change the user's Notion account can make, made in the user's name, without the user being asked: private content copied into a page or a comment the attacker can read; a private page moved under a shared one (a page takes its sharing from where it sits); pages or database properties rewritten; people notified by a comment or a mention.
- **How likely.** The user has to ask a question that makes the agent read the attacker's text, which is the product's normal use ("summarize this page"). Whether the model then obeys was not measured in this review. Small models follow injected instructions often enough that the system prompt cannot be counted as a control by itself.
- **What limits it today.**
  - The system prompt says text in pages, search results, comments, and tool results is data, and that a page title is a name. It is advice to the model, not enforcement.
  - Comments are quoted so one cannot end its line or pass for the tool's own words (`src/notion/comments.ts`). Page content, rows, and search results are not marked this way.
  - Moving pages to the trash asks, each time, naming each page (`src/tools/organize.ts`).
  - Read only (`src/mode.ts`): the tools that change data are not offered to the model for that question (`readingTools` in `agent.ts`), so the limit is in code, not in the prompt. It is off by default.
  - Every change shows on its tool card, and Notion's page history and "Move to" can undo it, though not what someone read meanwhile.
  - There is no tool that sends a request to an address the model chooses, so content cannot leave the workspace without a write to Notion and a reader there (see A4).
- **Proposed fix.** Ask before a change that reaches beyond the pages the question is about, decided in the extension from the call's arguments: [#388](https://github.com/cofun-labs/cofun/issues/388) (P1), which lists the rule recommended and the alternatives. Beside it, mark Notion's text as data in every tool result, as comments are: [#387](https://github.com/cofun-labs/cofun/issues/387) (P2).
- **Status.** Accepted until #388: the trade-off is stated to users in the README and in [architecture.md](architecture.md#writes-without-approval).

### A2. Reading beyond Notion widens A1 (planned; High once it ships)

The epic [#350](https://github.com/cofun-labs/cofun/issues/350) adds sources the user does not control at all: a URL the user pastes (#340), web search (#341), the page in the current tab (#244), several tabs (#343), files (#312, #346, #347), and outside services such as remote MCP servers (#349). Each puts text from anyone on the internet into a conversation whose agent can write to the user's Notion.

- **Injection.** With Notion alone, the attacker must already be able to write somewhere the user reads. With the web, they need only a page the user asks about or a search returns. #348 (ask before changing data once a conversation holds outside content) is the control for this and is labelled `later`, "the first sources ship without it". This review recommends the opposite order: #348, or #388 extended to cover it, lands before or with the first outside source.
- **A way out for data.** Today nothing the model writes becomes a request to a host of its choosing. #340 keeps that by reading only URLs the user's own messages contain, and #341 by reading only URLs the search provider returned. Both rules must be enforced in code against the conversation, as #340 says. A search query is written by the model and goes to the search provider: private text can leave that way, to the provider, which the privacy pages must say. #349 is the hard case: a remote MCP server chosen by the user receives whatever arguments the model writes, so a server (or text from another source steering the model) can be sent the user's Notion content. Its design has to decide which servers may be called once the conversation holds Notion content, and the extension's content security policy, which today names every host, would have to open.
- **Status.** Nothing to fix in code today. Recorded here so each of those PRs is checked against it.

### A3. One question can change many pages (Medium)

- **Limits in code:** ten model turns per question (`DEFAULT_MAX_STEPS`), after which calls are refused rather than run; 50 pages per `update_pages`, `move_page`, or `trash_page` call (`UPDATE_MAX`, `ORGANIZE_MAX`); 100 Notion requests per question, then the user is asked whether to go on (`REQUEST_BUDGET` in `src/notion/api.ts`); a rate limit from Notion stops the question and nothing is retried.
- **What is left.** A turn may hold several tool calls, and one call changes up to 50 pages in a few requests, so a question that goes wrong, by injection (A1) or by a model's mistake, can change a few hundred pages before the request budget asks. Notion's page history undoes each page, one at a time.
- **Status.** Accepted. #388 makes the many-pages case one the user is asked about unless the pages are the question's own.

### A4. Data can leave in a link someone clicks (Low)

- **What can be written.** `edit_page`, `create_page`, and a saved chat write text, and links only with `http:`, `https:`, `mailto:`, or a path on Notion (`inline` in `src/notion/blocks.ts`). No image, embed, bookmark, or file block can be written, and an icon is never an address: a page's icon must be one emoji (`isEmoji` in `src/tools/write.ts`, for `update_pages`), and a callout's icon, which `edit_page`, `create_page`, and a saved chat can write, is the callout's label only when that label starts with a pictographic character (`parseMarkdown` in `src/notion/blocks.ts`; the rest of the label is not checked, so it is looser than the page's rule, but it cannot start as a URL or a path). So nothing the agent writes makes Notion or a reader's browser fetch an outside address by being looked at.
- **In the side panel.** A reply's Markdown is rendered as React elements with no HTML plugin; images are never loaded (their alt text is shown as a link), and the extension's content security policy would block them anyway (`src/sidepanel/Markdown.tsx`, `manifest.ts`).
- **What is left.** A link whose address carries data (`https://attacker.example/?q=…`), written into a page, a comment, or a reply, sends that data when someone clicks it.
- **Status.** Accepted. Recheck whenever a new block type or property type becomes writable: anything that holds a URL Notion fetches by itself (image, embed, bookmark, file, link preview, an icon or cover by URL) turns this into exfiltration without a click.

### A5. Mention refusals reveal members' names (Low)

When a mention names no one, the tool tells the model the members with a similar name, so injected text could probe for names and write them somewhere. Limited to names the user's account can already see. Tracked in [#137](https://github.com/cofun-labs/cofun/issues/137).

### Checked and holding

| Control | Where | Pinned by |
|---|---|---|
| Read only removes the changing tools from what the model is offered | `readingTools`, `agent.ts` | `test/mode.test.tsx` |
| Saving a chat or a reply to Notion is the user's action, not a tool: the model cannot start it | `src/tools/save.ts`, `Save.tsx` | `test/save-to-notion.test.tsx` |
| Tool arguments are parsed with the tool's zod schema before anything runs | `defineTool` in `src/tool.ts` | Each tool's own tests refuse bad arguments; `test/tool-parameters.test.ts` only checks that every tool's schema is one the model can be given |
| A stored chat that does not parse is never opened or sent to the model | `src/sessions.ts` | `test/sessions.test.ts` |
| The tools act on the active tab only, and only when its host is `www.notion.so` or `app.notion.com` | `activeNotionTab`, `notionRequest` in `src/notion/tab.ts` | `test/notion.test.ts` (no test that another Notion tab is never used: [#247](https://github.com/cofun-labs/cofun/issues/247)) |
| A model-written chat title is plain text, asked of the model that already has the conversation | `src/agent/title.ts` | |

## B. The extension

- **Permissions** (`manifest.ts`, pinned by `test/manifest.test.ts`): `sidePanel`, `storage`, `tabs`, `cookies`, `scripting`; hosts `www.notion.so`, `app.notion.com`, the worker, Clerk's Frontend API, and `*.cofun.cc` (to see one Clerk cookie). `tabs` exposes every tab's URL and title to the extension's own code; the code reads the active tab's, and the Notion tabs' for the page picker.
- **No way in from a page.** The extension has no content script, no `externally_connectable`, no web-accessible resource, and no message listener (`chrome.runtime.onMessage`, `postMessage`): a web page, Notion included, has no channel to the side panel or the service worker. The service worker is one line that opens the panel.
- **Code in the Notion tab** runs with `chrome.scripting` in the ISOLATED world: the page cannot see or patch it. The functions injected are fixed (`notionRequest`, `tabUser`, `readSelection`); the model's arguments reach them only as a JSON request body for a fixed list of endpoints (`NotionEndpoint`), sent to the tab's own origin after checking the tab is still on a Notion host, with redirects not followed. Lint makes `chrome.scripting` an error anywhere else, `fetch` an error outside this module and `src/agent/` (which calls the worker and the user's own model), and `chrome.debugger` an error everywhere.
- **Content security policy** for the extension's pages: scripts from the extension only, connections only to the worker, Clerk, `openrouter.ai`, and `api.deepseek.com`, images only from the extension, `data:` and `blob:` URLs, and `img.clerk.com`. No remote code. zod is set up not to use `new Function` (`src/zod.ts`).
- **The user's own model.** The key is sent only to the service it belongs to, and the conversation goes there instead of to the worker. That is the user's choice of a third party, described in the privacy page. The services' answers are parsed with schemas.
- **`get_current_tab`** gives the model the active tab's whole URL on any site when it asks, and a URL can hold a token. It then stays in the conversation and the saved chat. Described in the privacy page; accepted.

### B1. Chats and keys on the device are not encrypted (Low)

Chats (with the Notion content the agent read) are in IndexedDB, one database per Clerk user; the Clerk client token, the OpenRouter and DeepSeek keys, and the mode are in `chrome.storage.local`. All stay after sign-out. Anyone with the Chrome profile, or malware running as the user, can read them. Encrypting them with a key kept in the same profile would not change that. Accepted, and stated in [Notico's privacy page](../extensions/notico/PRIVACY.md#what-stays-on-your-device). `chrome.storage.local` is not exposed to content scripts by default, and the extension has none.

### B2. `static.cofun.cc` is on the same site as the sign-in (Low)

The public R2 bucket for PR media is served from `static.cofun.cc`, a sibling of `api.cofun.cc` (the sign-in and admin pages) and `clerk.cofun.cc`. A page with script served from it would be same-site with them: it could set cookies for `.cofun.cc`, and its requests to Clerk's Frontend API would carry the user's Clerk cookie. It still could not get a session token the worker accepts (the token's `azp` would be `https://static.cofun.cc`, which is not an authorized party) and Clerk's client cookie is not readable by script.

- **What limits it.** `pnpm media` uploads only images and videos, with a fixed content type per extension and a sanitized name (`scripts/upload-media.ts`); only the maintainer's machine can upload.
- **Rule.** Nothing that a browser runs is ever served from a host under `cofun.cc` that is not the worker: no HTML, SVG, or script in the bucket, by the script or by hand. A host that must serve such content gets another registrable domain.
- **Status.** Accepted with that rule.

## C. Sign-in and the worker

How it works today. Every route under `/v1` is behind `requireSession` (`worker/src/routes/session.ts`): the bearer token is verified with the Clerk instance's public key (signature and expiry, no network call), and a token that names an origin (`azp`) must name an authorized one. Routes outside `/v1` are the pages, the Checkout return pages, `/health`, and the Stripe webhook. CORS allows any origin: authentication is the bearer token, never a cookie, so a cross-origin page gains nothing by calling.

### Checked and holding

| Control | Where | Pinned by |
|---|---|---|
| Every `/v1` route refuses a request with no session or an invalid one; the open routes are a fixed list | `v1Routes` in `app.ts` | `worker/test/session.test.ts` |
| A token signed by another key, expired, or issued to an origin not listed is refused | `requireSession` | `worker/test/api.test.ts` |
| A user reads only their own credits: no route takes a user id except the admin's | `routes/credits.ts` | `worker/test/credits.test.ts` |
| Admin routes need `role: admin` in the token (from Clerk public metadata, which users cannot write) and an `azp` equal to the worker's own origin; one refusal for every other case | `routes/admin.ts` | `worker/test/admin.test.ts` |
| Hand grants are bounded (50,000 credits, 366 days), record the admin, and are logged | `routes/admin.ts` | `worker/test/admin.test.ts` |
| The admin page writes what it shows with `textContent`, and neither page can be framed | `admin.ts`, `routes/pages.ts` | |
| The model is the worker's; a request naming another is refused, and only the fields the model needs are passed on | `routes/chat.ts`, `chat-request.ts` | `worker/test/api.test.ts` |
| A reply the client stops reading is still charged, by an estimate when it was cut short | `routes/chat.ts` | `worker/test/api.test.ts` |
| The product a call is recorded under comes from the signed `azp`, not from the client | `productOf` | `worker/test/api.test.ts` |
| A webhook event counts only with Stripe's signature (HMAC-SHA256, compared in constant time) made within 5 minutes | `verifiedEvent` in `stripe.ts` | `worker/test/billing.test.ts` |
| A replayed or repeated event grants nothing twice: a grant is unique per payment, and a take-back happens once | `grants.payment`, `revoked_payments` | `worker/test/billing.test.ts` |
| What is granted is what Stripe says was sold (the line item, read from Stripe), for the user and pack the worker wrote on the session, never an amount or a user from the client | `handleEvent` in `billing.ts` | `worker/test/billing.test.ts` |
| Logs hold ids, numbers, and at most 260 characters of an error the worker did not write (a failed usage record is the one error logged whole, and it is never given the conversation); usage records and the ledger hold no message text; the gateway's logs and cache are off per request. Cloudflare's own invocation logs keep each request's time, URL, and status, as [PRIVACY.md](../PRIVACY.md) says | `errorSummary`, `usage.ts`, `routes/chat.ts` | `worker/test/api.test.ts` |

### C1. A session token with no `azp` is accepted (Low)

`requireSession` checks `azp` only when the token has one. A browser always names its origin when it asks Clerk for a token, so a token without one comes from a client that is not a browser page, holding the user's own Clerk client token; it gains nothing it could not get by naming the extension's origin itself. The check exists to stop other websites using a session, and a website cannot produce such a token. Still, the rule is simpler and stricter as "every token names an allowed origin". The token's issuer is not checked either: the worker trusts one key, the instance's, so only that instance's tokens verify. → [#385](https://github.com/cofun-labs/cofun/issues/385).

### C2. Findings about the hosted model's cost to the operator (Medium)

Several related points about when and how much a call is charged, among them what happens to a request whose client goes away (the worker hands the charge to `waitUntil`, which the tests' fake does not exercise). What is at stake is the operator's cost for the hosted model, not another user's credits or data. Their details are kept out of this public document (rule 10 below) and were given to the maintainer on 2026-11-14; this entry is completed when the fixes land.

### C3. Nothing bounds what all accounts together spend (Medium)

- **The attacker controls** how many accounts they sign up. Each gets 200 free credits a week (US$0.20 of model use) and its overdraft.
- **They could get** free use of the model, or simply cost the operator money.
- **What limits it.** Sign-up is Clerk's, with whatever bot protection the instance has on (set in Clerk's dashboard, not in this repository, and not checked here). Each account's limits hold. The model is a cheap one.
- **Proposed fix.** A daily ceiling and an alert on the hosted model's cost across all accounts: [#386](https://github.com/cofun-labs/cofun/issues/386) (P2).

### C4. The worker's pages have no script policy (Low)

`/login` and `/admin` are served from the same origin, and a Clerk session on that origin is what the admin routes accept. Both pages build their HTML from constants and the publishable key (escaped), and load Clerk's scripts from the instance's Frontend API by major version, without integrity hashes: that is how Clerk is hosted, and trusting it is part of using Clerk. There is no known way to inject script into either page; a content security policy would make that hold by construction. → [#385](https://github.com/cofun-labs/cofun/issues/385).

### C5. Request bodies are read whole before they are measured (Low)

`/v1/chat/completions` parses the JSON body, then refuses one over 200,000 characters. `/stripe/webhook`, which needs no session, refuses by `content-length` but reads in full a body sent without one. Cloudflare caps a request body, and the cost is one request's memory in one isolate, so this is a hardening, not an outage. → [#385](https://github.com/cofun-labs/cofun/issues/385).

### C6. Only the chat is rate limited (Low)

`POST /v1/billing/checkout` makes a Stripe Checkout Session for each call, and the credit routes read D1, which runs one query at a time and is what charging waits on. A signed-in user could call either as fast as they like. Each query is bounded and indexed, and Stripe limits its own API. → [#385](https://github.com/cofun-labs/cofun/issues/385).

### C7. Credits spent before a dispute are not recovered (Low)

A refund or dispute takes back what is left of a purchase; what was spent stays spent, and what the purchase had repaid of a debt is owed again, by an account that may never return. Stripe is the merchant of record and handles the dispute. The loss is the model cost of the credits spent. Accepted.

## D. Secrets and the public repository

**What is committed is public by design**: the Clerk publishable key and JWT public key, the extension's public key and ID, the Stripe price id, the AI Gateway id, and domain names (`worker/wrangler.jsonc`, `extensions/notico/.env`). The D1 database is found by name, so its id is not committed. `.dev.vars`, `.env.local`, and `keys/` are git-ignored. A search of the tree and of every commit's diff for Stripe, Clerk, OpenRouter, GitHub, and AWS key patterns and private key blocks found none, and neither did a search of the tree for 32-character hex ids (the form of a Cloudflare account id) outside test fixtures. The worker's secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) are set on Cloudflare and read only from `env`; nothing logs them.

**Deploys and releases.** Cloudflare pulls the repository and deploys on merge to `main`, so no Cloudflare credential is on GitHub. `main` takes changes only through PRs with CI, dependency review, and workflow lint passing, through a merge queue. The Release workflow uses no secret: it builds from `main`, attaches the zip to a draft release, and a person uploads it to the store. Every action is pinned to a commit.

### D1. Secret scanning and push protection are off (Medium)

[development.md](development.md#github-settings) says `scripts/sync-github-settings.sh` turns on secret scanning with push protection. On 2026-11-14 the repository reports both as `disabled`. The settings drifted or the script was not run after the repository was made public, so a credential pushed by mistake would not be stopped or flagged. Nothing was found that had been (above). → [#384](https://github.com/cofun-labs/cofun/issues/384) (P1).

### D2. No private way to report a vulnerability (Medium)

There is no `SECURITY.md`, GitHub's private vulnerability reporting is off, and both privacy pages send reports to public Issues. Someone who finds a real hole can only publish it or stay silent. → [#384](https://github.com/cofun-labs/cofun/issues/384) (P1).

### D3. The `@claude` workflow reads text anyone can write (Medium)

`.github/workflows/claude.yml` runs with write access to contents, pull requests, and issues when the owner, a member, or a collaborator mentions `@claude`. The thread it then reads can hold text from anyone, so an instruction hidden in an Issue or a comment could steer it. With `contents: write` and the checkout's credentials the job could push a branch, post a comment, and also create or change a tag or a release, the draft release's zip included, which is the file the maintainer uploads to the store; the job also holds `CLAUDE_CODE_OAUTH_TOKEN`. How far a steered run gets depends on which tools `claude-code-action` allows by default, which this review did not check. It cannot push to `main` (the ruleset) or merge, a pushed branch still needs a PR that a person queues, and nothing reaches the store without the maintainer's upload. **How likely:** low, since only the owner, a member, or a collaborator can start it, on a thread they chose. `claude-review.yml` runs on `pull_request`, so a fork's PR gets no secret, and it is allowed only to read the diff and post comments. → [#392](https://github.com/cofun-labs/cofun/issues/392) (P2).

## Not reviewed

- **Product analytics** ([#376](https://github.com/cofun-labs/cofun/issues/376), PR #383) had not merged. When it does: which host is added to the content security policy and the privacy page's table, that events carry no page content, titles, URLs, or question text, and that the switch stops every event.
- **Settings outside the repository**: the Clerk instance (bot protection, allowed origins and subdomains, session lifetime, who has the admin role), the Stripe account, the Cloudflare account (who can deploy, the AI Gateway's settings), and the Chrome Web Store account. Each is a place where one compromised login is the whole product.
- **How well the hosted model resists injected instructions.** #387 proposes a small set of injected pages to measure it.
- **Dependencies**, beyond what CI checks.

## Rules for later changes

A PR is checked against these, and the reviewer's list in [AGENTS.md](../AGENTS.md) applies as always.

1. **A new tool that changes data** says in its PR why it may run unasked, or asks first. Until #388 lands, it is added to the list in [architecture.md](architecture.md#writes-without-approval).
2. **A new kind of writable content** (a block type, a property type, an icon or cover by URL) is checked for whether Notion or a reader's browser fetches an address in it without a click. If it does, the model must not be able to choose that address.
3. **A new source of text for the model** (another site, a file, a search, an outside service) is untrusted from the first PR: marked as data for the model, and covered by the approval rule before it ships (A2).
4. **A request to an address or with arguments the model writes** (a fetch, a search, an MCP call) is a way out for data. It needs a rule in code for which addresses are allowed, checked against the user's own messages, not the model's.
5. **A new host** changes the content security policy, `test/manifest.test.ts`, and the privacy page's table together, as [AGENTS.md](../AGENTS.md) says.
6. **A new way into the extension** (a content script, a message listener, `externally_connectable`, a web-accessible resource) treats what arrives as untrusted and is added to section B.
7. **A new route on the worker** goes under `/v1` unless it has its own proof of who is calling (as the Stripe webhook has), and never takes a user id from the request for anything but an admin route.
8. **Anything that spends the operator's money** (a model, a search, a fetch) is charged or capped per user before it is offered, and counted under C3's ceiling once it exists.
9. **Nothing a browser runs is served from another host under `cofun.cc`** (B2).
10. **A finding that can be used against users or the operator is not written into a public Issue, PR, or this file** until it is fixed. It goes to the maintainer privately (see #384).
