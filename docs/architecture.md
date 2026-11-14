# Architecture

How Cofun's extensions and the backend they share are built, and why. For setup and deployment see [development.md](development.md); for the workflow and coding rules see [AGENTS.md](../AGENTS.md).

Each Cofun extension is an AI side panel for one kind of page, in its own folder under `extensions/` (Notico, for Notion, is the first), built and published by itself. All of them call one Cloudflare Worker (`worker/`), which signs users in, checks who is asking, keeps their credits, and passes the conversation to the model. The worker knows nothing about any site: it never talks to Notion or any other page's service. The agent and its tools run in the extension, next to the page they act on.

Each extension keeps its own copy of the side panel code (UI, agent, sign-in, settings, credits), and duplication between extensions is accepted: a fix or feature in one is applied to the others by hand, and `worker/test/extension.test.ts` runs an extension's own agent against the worker so the part that faces the worker cannot drift. One account and one balance of credits serve every extension.

## Single source of truth

Each fact is stored in one place, and everything else is worked out from it when it is read. A copy, a cache, or a stored total is added only when reading the source is too slow or costs too much, and then the code says which is the source and how the copy is kept right. Two stores that each hold part of the same fact drift apart, and then nobody can say which one is right.

For example, a user's balance and what they owe are not stored: they are worked out from their grants and model calls each time. What a call cost is a column of the call's own row, not a second record. The one stored running value in the credits is what is left of each grant (`grants.left`): working it out would mean replaying every call in the order grants are spent, and it is written in the same transaction as the call that spends it. Data kept only for watching the service, such as the usage records in Analytics Engine, is not a copy in this sense: it describes requests in its own way (refused ones included), and nothing the service does reads it.

## Shared by every extension: the worker, sign-in, and credits

| Area | Choice | Why |
|---|---|---|
| Sign-in | [Clerk](https://clerk.com) (`@clerk/chrome-extension`) with [Sync Host](https://clerk.com/docs/references/chrome-extension/sync-host) | Ready-made sign-in UI and sessions; the backend only verifies JWTs with a public key. Social logins need a redirect, which Chrome side panels don't support, so users sign in on a normal web page and the session syncs into the extension |
| Backend | Cloudflare Workers + Hono | Model access stays server-side; the AI binding needs no API token |
| Model | Workers AI through AI Gateway | No third-party API keys; the gateway adds logs, caching, and per-user analytics |
| API shape | OpenAI-compatible `/v1/chat/completions` | A common streaming format, so the extension doesn't change if the model or backend does |
| Deploy | Cloudflare Workers Builds (Git integration) | Cloudflare pulls the repo and deploys on merge to `main`; no Cloudflare credentials stored on GitHub |

### Auth flow

1. The user clicks "Sign in" in an extension's side panel. The extension opens `https://api.cofun.cc/login` in a new tab; the worker serves this page with Clerk's sign-in UI.
2. Sign-in runs against Clerk's production instance, whose Frontend API is `clerk.cofun.cc`. After sign-in, Clerk's client cookie (`__client`) lives on that host, and a cookie that says whether anyone is signed in (`__client_uat`) on the parent domain `cofun.cc`. The extension is configured with `syncHost` and uses the `cookies` permission to read that session: from the Frontend API host on a production instance, and from the sign-in page's host on a development instance, which keeps its client cookie there (each extension's `src/clerk.ts`). Clerk doesn't refresh an already-open side panel, so the extension watches those cookies and reloads the panel when they change.
3. Before each request, the extension gets a short-lived session JWT with `getToken()` and sends it as `Authorization: Bearer`.
4. The worker verifies the JWT locally with Clerk's JWT public key (signature, expiry). If the token has an `azp` (the origin that requested it: `chrome-extension://<id>` for the extension, the worker's own origin for the admin page), it must be an allowed origin, which stops other websites from using a session they obtained in the browser. No network call to Clerk is needed.
5. The worker checks the user's credits (see [Credits](#credits)) and refuses the request when none are left.
6. The request goes through AI Gateway to Workers AI, tagged with the Clerk user id and the product for per-user analytics. The product is the one `PRODUCTS` (in `wrangler.jsonc`) lists for the token's `azp`, which Clerk signs, so a client cannot choose it; a caller that is no listed extension (the admin page, a token with no `azp`) is `unknown`, and is not refused, since credits are one balance across products and the product only sorts what was spent. Gateway log collection is off (`collectLog: false`), so the gateway keeps request analytics but not prompts or replies.
7. When the reply ends, the worker records the model call and charges the user what its tokens cost, and writes one usage record for the request (see [Usage records](development.md#usage-records)).

Each extension's ID is pinned with its manifest `key`, so Clerk and the worker can trust it.

### Credits

Using the hosted model costs credits. A credit is money: 1 US dollar = 1000 credits, and a model call costs what its tokens cost at the provider's list price, with no markup. Every signed-in user gets 200 free credits a week.

- **The ledger** (`worker/src/credits.ts`) is kept in one D1 database for every user (binding `DB`, schema in `worker/migrations/`), the only source of truth for billing. The balance is not one number: the `grants` table has one row per grant, with its amount, what is left of it, when it was granted and when it expires, and where it came from (`free`, the weekly grant; `manual`, credits an admin granted by hand, with the admin's Clerk user id; or `purchase`, credits bought, with the Stripe payment they came from). The `model_calls` table has one row per call the worker made to the model, however it ended (answered, stopped by the user, broken off, or failed): when it started and ended, the product it came from, the model, whether it streamed, how it ended and why the model stopped, the prompt, cached, and completion tokens (and whether they are an estimate), what it cost, and what of that the user owed. Requests refused before the model was called are not model calls. Spending takes from the grant that expires first, and an expired grant counts for nothing. Rows are never deleted: an expired grant stays as the record of what the user was given, with what went unspent, and every model call as the record of what was asked of the model and what it cost, so what was granted and spent can be totalled across all accounts and over any period (example queries in [development.md](development.md#credits-database)). Amounts are integers in micro-credits (1 credit = 1,000,000), so the cost of one call is exact. The usage records in Analytics Engine are sampled and kept for 90 days: they describe every request, refused and failed ones too, for watching the service, and are never used for charging.
- **Debt** is not a number of its own. A model call records the part of its cost that the grants still counting did not cover (`model_calls.owed`), and a grant records the part of its amount that paid debt back when it was made (`grants.repaid`; its `left` starts at the amount less that). What a user owes is the sum of the one less the sum of the other, leaving out what a purchase taken back had repaid (that is owed again). So, apart from right after a take-back, there is debt only while no grant that still counts has anything left, and every grant pays it back first.
- **Concurrency.** The worker runs on many machines at once, and so do a user's requests. Every change to the ledger is one D1 batch, which D1 runs as a transaction, one batch at a time. The lazy free grant is one conditional statement (insert a free grant unless one still counts), so two requests arriving together cannot both grant the week. A call that ends records itself and takes its cost from the grants with a relative update (`left = left - …`), in the same batch, so calls that end together are each charged and none is lost.
- **The free grant** is given lazily: when a chat request arrives and the user has no free grant that has not expired, the worker grants 200 credits that expire 7 days later. Only free grants are looked at, and only the user's own chat requests grant them: credits granted by hand never stand in for the free week, and an admin looking at an account or granting to it never starts it. No schedule runs, nothing is written for users who don't come back, and grants don't add up: a user who returns after a month gets one.
- **Prices** (`worker/src/pricing.ts`) are a table per model, in micro-credits per token, with input the model read from its prompt cache priced apart: it is far cheaper, and an agent resends its instructions, tool definitions, and the conversation on every call. The hosted model reports the cached part of the prompt as `usage.prompt_tokens_details.cached_tokens`. A `MODEL` with no entry is a configuration error (503), not a free call. AI Gateway's cost numbers are only for checking; its logs stay off.
- **Charging is after use.** A call goes ahead when the balance is above zero, and its cost is taken when the reply ends, so the last call of a question may take the balance below zero. That overdraft is kept as a debt, which the next grant pays back first. Nothing is set aside for calls still running: calls sent at once all start on the same balance, so together they can overspend by more than one call's cost. That is accepted: one call costs little, what was overspent is still owed, and a Workers rate limiting binding keyed by user id caps how many chat requests one user can start a minute (429 `rate_limited`), which bounds it. With no credits left the request is refused before any model call (402 `out_of_credits`), with a message that says when the next free grant arrives. A call that cost nothing (it failed, or a stream carried nothing) is still recorded, with a cost of 0.
- **What a call costs when it does not end well.** A call that fails costs what it reported: nothing when the model never answered, and nothing for a stream that carried a model error and no usage, or that broke off before it reported or carried anything. A reply the user stops, or a stream that breaks off, costs what it used. Its totals come in the stream's last chunks, which never arrived, so they are estimated: the prompt is the count the first chunk gave (Workers AI sends it there), or one token per 3 characters of input when no chunk gave one; the reply is one token per 3 characters streamed (text, reasoning, and tool calls), and never below what the stream did report. How much of the prompt was read from the cache is only known at the end, so 90% of it is charged as cached input and the rest as new: an agent resends its instructions, tools, and the conversation on every call, so most of a prompt usually is cached. A stream that ran to its end (`[DONE]`) before the client stopped reading has its totals, and is charged by them. Every reply says what its call cost, so a product can show it without pricing anything itself: in the body next to `usage`, or, for a stream, in a chunk of its own (`{"choices":[],"cost":{"micro_credits","estimated"}}`) written as the last before `[DONE]`, or before the end of a stream that broke off. Only then are the stream's totals all in (Workers AI reports usage on many chunks), and nothing after `[DONE]` is read into them, so the number sent is the one charged. A reply the user stopped has no reader left to tell.
- **A client that goes away** does not get a free call. The model call, its record, and its charge are handed to the request's `waitUntil`, so they finish after a client drops the request, before the reply or partway through a stream.
- **Admins** look up one account by Clerk user id and grant it credits by hand, on a page the worker serves (`/admin`, `worker/src/admin.ts`). The page holds no data: it signs in with Clerk and calls `/v1/admin/*` with the session token. Those routes sit behind the same session check as the rest of `/v1/*`, and then need two things of the token. Its `role` claim must be `admin`: the Clerk instance's session token is customized to carry the `role` from the user's public metadata, which only Clerk's dashboard and Backend API can write (see [Admin page](development.md#admin-page)). And its `azp` must be the worker's own origin, so only a session on the admin page counts, not one from the extension. Everything else gets one and the same refusal (403 `forbidden`), whatever path it asked for. A lookup reads the account's grants and debt and writes nothing. A grant by hand takes whole credits and days, both bounded (50,000 credits, 366 days), records the admin's user id on the grant, pays back debt first like any grant, and is logged: the admin's user id, the account's user id, the credits, and the expiry. A grant whose database call fails may have been written all the same, so its refusal tells the admin to look the account up before granting again; the grant's own row, with the admin's id, is the record either way. The worker cannot ask Clerk whether a user id exists (it holds no Clerk secret key), so it checks only the id's shape; the page shows an account with no grants as such, before anything is granted.
- **The overview** on the same page shows credits as a whole: what was granted and spent in a period the admin picks, in all, per day, per product, and per account (`worker/src/overview.ts`). It only reads, behind the same admin check, and stores nothing: every number is worked out from the `grants` and `model_calls` rows when asked for, and an account's balance comes from the same definition as the ledger's own. D1 runs one query at a time, so a slow overview query would hold up charging: every query is bounded by the period and reads through the tables' time indexes.
- **A user's own credits** are read by the side panel from `GET /v1/credits`, behind the same session check as the chat, for the caller only: there is no way to name another account. It answers with the balance, the grants that still count (source, what is left, when it expires, never the admin who made a grant by hand), the state of the free week, and credits used per day for the last 30 days. It only reads (`Ledger.look`): the free week still starts with the user's next question. When no free grant counts, the balance it reports is what that question will start with, the stored balance plus the free grant, marked as not started; `Ledger.open` and `Ledger.look` read that number with the same statement (`READ_BALANCE`), one after giving the grant and one without, so what is shown and what is given cannot drift apart. Usage per day is totalled from `model_calls` on every read, bounded by the `model_calls_by_user` index; no totals are stored. A call belongs to the day it started on, on the user's clock: the panel sends how far its clock is ahead of UTC, in minutes (`utc_offset`, validated and bounded to the offsets that exist), since the worker does not know the user's time zone. The offset is the one in force when the panel asks, so around a daylight-saving change a call within an hour of midnight can land on the neighbouring day.
- **The history of a user's credits** is read apart from that, by a sibling route the panel calls only when the user opens the history, so the read it makes on every load and after every question stays small: `GET /v1/credits/grants` for every grant the user was given, newest first, the expired ones included (what is left of an expired grant is what went unspent), and for a purchase what it cost in US cents, its list price worked out from its credits at 1000 a dollar (what Checkout charged in the buyer's currency, with tax, is not kept). It only reads, for the caller only, and stores nothing. The list has no end, so it is read a page at a time, bounded and served by an index, with each page saying where the next starts. Usage is read only for the last 30 days, above: nothing older is shown anywhere.
- **Buying credits** (`worker/src/billing.ts`, `worker/src/stripe.ts`) is one-time purchases of fixed packs through Stripe's hosted Checkout in payment mode, with Managed Payments: Stripe is the merchant of record, picks the buyer's currency and payment methods, and adds the tax. There are no subscriptions or plans. Only the worker talks to Stripe's API; the extension only opens the Checkout page in a normal tab. Stripe sells one product, 1,000 credits for US$1 (`CREDIT_PRICE`), and a pack is a quantity of it (`CREDIT_PACKS`, `[1, 5, 20, 100]`), so changing the packs on sale is configuration only; the side panel shows the packs the worker lists (`GET /v1/billing/packs`). The panel asks the worker for a Checkout Session for a pack (`POST /v1/billing/checkout`); the worker writes the Clerk user id, the price, and the quantity on the session, and Stripe's webhook (`POST /stripe/webhook`, trusted only with Stripe's signature) reports the payment. A paid session adds one grant of source `purchase`: the quantity of the credit price on its line item (read from Stripe) × 1000 credits, which must match the price and quantity the worker wrote on it (so a session keeps its price across a change of `CREDIT_PRICE`), never worked out from the amount charged; anything else grants nothing and is logged. It lasts one year, paying back debt first like any grant; the weekly free grant still looks only at free grants. The grant carries the payment's reference (`grants.payment`, unique), so a payment reported twice grants once. A refund or dispute takes back what is left: the grant ends at that moment and `grants.revoked` says why; what was spent stays spent, what it repaid of a debt is owed again (a revoked grant's `repaid` no longer counts), and no row is deleted. A refund or dispute of a payment with no grant yet (its own event has not been handled) is recorded against the payment (`revoked_payments`), and that payment never makes a grant, so the order events arrive in does not matter. Events arrive in any order and more than once, and every step is safe to repeat. After opening Checkout, the panel reads the credits again each time it gets the focus, so a purchase shows when the user comes back.
- **When the database fails.** If the balance can't be read (D1 unreachable), the request is refused (503 `credits_unavailable`) and the model is not called. If the call's record fails after the model answered, the reply still goes out, the failure is logged, the usage record says nothing was charged, and the call is not charged: the batch either wrote both the record and what it took from the grants, or neither.

## Notico: the extension for Notion

```
┌──────────────────────── Chrome ─────────────────────────┐
│ Notion tab            │ Side panel (React)              │──Bearer <Clerk session JWT>──▶ Worker ──▶ AI Gateway ──▶ Workers AI
│  /api/v3 as the user ◀──chrome.scripting── agent + tools│                                (verifies JWT)
├───────────────────────┴─────────────────────────────────┤      ▲ reads the Clerk cookies signing in sets (Clerk Sync Host)
│ Sign-in tab: api.cofun.cc/login                         │──────┘  this page is served by the same worker
└─────────────────────────────────────────────────────────┘
```

The agent loop and its tools run in the side panel. The worker only checks who is asking and passes the conversation to the model; it never talks to Notion. A user may instead have their own model answer: on OpenRouter or DeepSeek, with their own key, which the side panel asks directly (`openrouter.ai` and `api.deepseek.com` are in the content security policy; a host permission would not widen it, and both answer cross-origin requests). Each is a provider behind the agent's `ModelProvider`; DeepSeek's models, with how each is asked and its prices, come from pi's own catalog, not from DeepSeek. Each service keeps its own key and model, so switching between them asks for neither again. The choice and the keys are kept per account in `chrome.storage.local`, read as each question starts, so a switch applies from the next question and the conversation goes on with the new model; such questions never reach the worker and spend no credits. Notion requests are made inside the user's own Notion tab, with that tab's session.

The panel is open on every tab, but the tools work on the current tab only: the active tab of the panel's window, looked up again for each question and each tool call, since the user can switch tabs at any time. Each question tells the model whether that tab is a Notion page (and which), and nothing else about a tab on another site. The Notion tools are offered everywhere; when the current tab is not on Notion they fail with `no_notion_tab`, which tells the model to send the user to a Notion page, and they never use a Notion page open in another tab instead. `get_current_tab` gives the model the current tab's URL and title on any site when a question needs them; no tool reads another site's content.

The page a question goes with is shown at the top of the composer (`Pages.tsx`), read from the tab as Chrome reports it (`chrome.tabs` events, no Notion request), so the question carries what the user saw. The user can take it off; the question's note then names no page, and `carryPages` (`src/tools/current.ts`) makes every tool that would default to the open page (reading it, its comments, its database or selection, and `get_current_tab`) refuse for that question while the tab shows a Notion page, so the model asks or searches instead; on another site they work as they do without a page. The pages a question went with are saved with it in the session and shown in its bubble.

The user adds more pages to a question with `@` in the composer or its "+" button, which open one picker (`PagePicker.tsx`). Its groups are the open page, the other Notion pages open in the browser's tabs (`chrome.tabs`), and recent pages, worked out from the saved sessions (the pages their questions carried, and those their tool calls read or changed, `pagesIn` in `src/tools/index.ts`): none asks anything of Notion. Its fourth group is Notion's own search of the workspace (`findPages` in `src/tools/find.ts`), sent from the Notion tab like any tool's request, and held to the same rules: only once typing pauses, one search at a time (a newer query replaces one still waiting, and waits for one already sent), counted toward no question, and never retried; when Notion turns one away, or one fails, the picker searches no more for that question. The picker and the agent never ask Notion at once: no search goes out while a question is answered, and a question sent while a search is out waits for it, and stops, sending nothing, if Notion turned that search away. The question carries the added pages as titles and URLs in its note (`carryPages`), not their content: the model reads them with its tools when it needs to. A page added by hand stays with the question when the tab moves; the open page's chip follows the tab.

| Area | Choice | Why |
|---|---|---|
| Extension | Chrome MV3 + [Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) | Sits next to the page without covering Notion. One panel per window, on every tab (the manifest's `side_panel.default_path`), so the conversation stays as the user switches tabs |
| Extension build | Vite + React + TypeScript | Clerk's extension SDK is React-based; Vite needs little config and no extension framework |
| Agent runtime | [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core), wrapped in `extensions/notico/src/agent/` | Tool loop, events, abort, and tool hooks in a small package; it runs in the side panel because tools act on the browser. Only `src/agent/` imports it, so it can be replaced |
| Notion read/write | Notion's own internal endpoints (`/api/v3/loadPageChunk` to read, `/api/v3/saveTransactionsFanout` to write), called from inside the user's Notion tab with `chrome.scripting` | Verified to read and write a real page, with edits persisting after reload. Requests are same-origin and carry the tab's own Notion session (sessions are per host: `app.notion.com` and `www.notion.so` don't share one), so no Notion integration token is needed. They run in an isolated world, out of the page's reach. No `chrome.debugger` (which shows a permanent "debugging this browser" banner). The trade-off: these are not public APIs and may change |

### Sessions

A saved conversation is a *session* in code and a *chat* in everything users read (the side panel, the README, the privacy policy, the store listing); session names in code and storage stay as they are, so that renaming them never loses saved data.

Conversations are saved in the extension's IndexedDB, one database per Clerk user (`notico-sessions-<userId>`), and never sent to the worker beyond what the model needs for the current question. They stay after sign-out so the user can pick up again, and they are not encrypted: keeping accounts apart only means one account's panel never shows another's sessions. Anyone with access to the Chrome profile can read them, tool results included, such as the content of Notion pages the agent read (for example in DevTools).

What is read back is parsed against the session's schemas (`SessionInfo` in `sessions.ts`, `HistoryMessage` in `src/agent/types.ts`), since an earlier version may have saved it in another form. A session that doesn't parse is unreadable: the list shows it as such and offers only to delete it, and it is never opened, so nothing of it reaches the chat or the model. There is no migration or format version yet; they come with the first change to the format that is not only an added optional field.

A session is titled with its first question until its first reply is in; then the agent asks the model that answered for a short title (`CopilotAgent.title`), so it goes only where the conversation already went, and on the hosted model it spends credits like any request. The title the model wrote replaces the first question in the stored session, once, and later saves keep it; a failed or unusable answer changes nothing.

With a button under a reply, or one at the top of the panel, the user can save that reply, or the whole chat so far, as a new Notion page (`savePage` in `src/tools/save.ts`, `Save.tsx`). It is the user's own action, not a tool the agent is offered, so Read only does not limit it, and nothing asks to confirm it. The page always goes at the end of the page open in the current tab when the user saves, the same tab rule the tools follow; with no Notion page there the action is unavailable, and a database is refused before anything is written. It is written the way `create_page` writes a page, from the reply's Markdown, in one transaction sent once and never retried: a rate limit stops it with nothing more sent, and an unknown outcome tells the user to look in Notion before saving again. Unlike the picker's search, a save may go out while a question is answered: it is two requests, started by hand, and counted toward no question. A save notifies nobody: people a reply mentions are written as names.

### Writes without approval

The agent edits pages, creates pages and rows, changes properties, adds comments, and moves and duplicates pages without asking first. Moving pages to the trash is the one thing it asks the user's approval for, each time, showing each page by its current name; pages only ever go to Notion's trash, where they can be restored. Each change shows on its tool card in the side panel, and a page's history in Notion can undo edits. The trade-off: the agent reads text the user doesn't control (shared pages, guest content, search results), and an instruction hidden in that text can make it write as the user without anyone being asked. It could change many pages in one call, move a private page under a page others can read (a page takes its sharing from where it sits, so it is exposed as soon as it moves), or copy content the user can see into a page or a comment someone else can read; a comment also notifies the people following the page or the thread, and a mention notifies the person mentioned. When a mention's name matches no one, the agent is told the members with a similar name, so text in a page could have it probe for the names of the workspace's people. Page history and "Move to" can undo the changes, but not what someone read in the meantime.

### Credits in the side panel

The avatar in the header opens the panel's own account menu (`Account.tsx`): the name and email from Clerk, then "Credits" with the credits left and "Settings", each opening its page, and "Sign out". Clerk's `<UserButton />` and its account management are not used: Notico needs Clerk only for who the user is, and disconnecting the only sign-in method could leave a user unable to get back to their account and its credits. A page covers the whole panel, the chat's header included, with its own Back (`Page` in `Header.tsx`). The Credits page (`Credits.tsx`) shows the balance by source, the packs of credits to buy (see [Credits](#credits)), and usage per day over the last 30 days as a bar chart; from the balance the history of the grants opens in its place (`History.tsx`), read when it opens, and a read of it that fails says so there and touches nothing else. The Settings page (`Settings.tsx`) shows which model answers (`Model.tsx`: the hosted one, or OpenRouter or DeepSeek with the user's key; OpenRouter's public model list is read only once the user picks it, filtered to models that take tools, and once per panel, again after a read that failed) and the account, with Sign out. A chip in the composer's toolbar, next to the send button (`ModelMenu` in `Model.tsx`), shows the model in use and opens a menu that switches between the hosted model, the user's chosen OpenRouter model and the recommended ones, and DeepSeek's models once a DeepSeek key is saved, without leaving the chat, and leads to the Settings page for any other model. The panel reads the credits when it loads, after every question, and when the account menu or the Credits page opens (a reply the user stopped is charged after the panel's read, and another window may have spent credits); amounts are shown as whole credits (what is left rounded down, what was used to the nearest). Each reply on the hosted model that ended normally shows what its question cost in the row under it (`CostNote` in `Chat.tsx`), saved with the question: the agent reads each call's cost from the worker's stream (`callCost` in `worker.ts`, through pi's `onProviderStreamEvent`) and adds them up. A reply stopped or failed shows none, rather than a number that is too low: a call cut short never hears what it was charged (the credits still show it), and a cost the worker estimated is never shown. A user's own model spends no credits, and shows none. A read that fails never touches the chat: the menu and the page say the credits are unavailable, with no number, and the page offers to try again. A question refused with `out_of_credits` shows the worker's message, which says when the free credits return and that credits can be bought, with a link to the Credits page to buy them.

## Layout

```
extensions/               one folder per Chrome extension, each built and published by itself
                          and never importing another; they share the worker
extensions/notico/        Notico, the extension for Notion
  README.md               what Notico does and how to use it, for its users
  PRIVACY.md              what Notico reads, the hosts it may contact, and what it keeps on the device
  vite.config.ts          build config; writes manifest.json into the build
  manifest.ts             builds manifest.json from .env; a test pins its permissions and content security policy
  icons/icon.svg          the extension icon; `pnpm icons` exports it into public/icons, which the manifest lists
  sidepanel.html
  src/background.ts       opens the side panel from the toolbar icon, on any tab
  src/agent/              the agent, and the only folder that imports pi (index.ts: what the rest of the extension uses)
    agent.ts              the agent loop: a question, its tool calls, and the conversation it keeps
    types.ts              the agent's types: its config, tools, updates, and the conversation as sessions save it
    calls.ts              tool calls as pi runs them: arguments, previews, the user's OK, errors that stop a question
    history.ts            what of a conversation is sent and kept, and what a question used
    title.ts              a conversation's title, written by the model that answered it
    provider.ts           ModelProvider: where model requests go, and how a service's errors read
    worker.ts             the worker: the hosted model's provider, and the user's credits and purchases
    openrouter.ts         OpenRouter with the user's own key, and its models
    deepseek.ts           DeepSeek with the user's own key, and its models from pi's catalog
    own.ts                the user's own model, and the Settings page's check of it
  src/models.ts           which model answers, and the user's own keys, kept per account on the device
  src/tools/              tools the agent runs in the extension (index.ts: the list of them)
    read.ts               read_page, get_selection
    find.ts               list_pages, search_pages
    write.ts              edit_page, create_page, update_pages
    database.ts           query_database, create_database, update_database_schema
    organize.ts           move_page, duplicate_page, trash_page
    comments.ts           read_comments, add_comment
    current.ts            the current tab and the page a question carries; get_current_tab
    save.ts               saving a reply or a chat as a Notion page, which the user starts (not a tool)
    shared.ts             common arguments, how a call is worded, and the pages a call names
    load.ts               loads several tools share: a page with its database and mentions, a database, a workspace
    memory.ts             what the agent remembers between calls (pages read, rows and databases seen),
                          behind functions: its maps are its own
  src/tool.ts             defines a tool from one zod schema of its arguments
  src/clerk.ts            Clerk's Frontend API host and Sync Host, read from the publishable key
  src/zod.ts              zod, set up for the extension's content security policy; the only module that imports it
  src/sessions.ts         saved sessions (IndexedDB, per user)
  src/credits.ts          the user's credits as the worker reports them, and how the panel words them
  src/notion/hosts.ts     Notion hosts, and the page id in a Notion URL
  src/notion/api.ts       Notion's internal API: endpoints, request shapes, record maps, errors
  src/notion/markdown.ts  Notion pages as Markdown for the model, with a reference on each block
  src/notion/blocks.ts    Markdown from the model back into Notion blocks
  src/notion/edit.ts      checks edits against the page as the agent read it, and plans the transaction
  src/notion/comments.ts  a page's comment threads for the model, quoted so they read as data
  src/notion/people.ts    matches the people mentions name to the workspace's members
  src/notion/props.ts     page titles and database property values, checked against the database's schema
  src/notion/schema.ts    a database's properties: a new database's schema, and checked changes to one
  src/notion/tree.ts      pages as the sidebar lists them, level by level, without content
  src/notion/tab.ts       runs Notion requests in the user's Notion tab (chrome.scripting)
  src/sidepanel/          React UI (main.tsx: sign-in, Chat.tsx: chat, Sessions.tsx: saved sessions,
                          ToolCall.tsx: one tool call and its changes, Header.tsx: the top bar,
                          Markdown.tsx: a reply's text as formatted Markdown,
                          Pages.tsx: the pages a question goes with, in the composer and its bubble,
                          PagePicker.tsx: the page picker `@` and "+" open,
                          Save.tsx: the buttons that save a reply or the chat to Notion, and why a save failed,
                          Account.tsx: the avatar and its menu, Header.tsx: the header, and a page's,
                          Credits.tsx: the Credits page, History.tsx: the history of the user's credits,
                          Settings.tsx: the Settings page,
                          Model.tsx: the model menu by the composer, and the Settings page's choice
                          of model and OpenRouter or DeepSeek setup, menu.ts: how the panel's menus behave,
                          icons.tsx: the Cofun mark and the icons, style.css: the look)
  test/                   tests of the extension's client code (fake Notion tab with sanitized
                          fixtures), and of the side panel's UI: the whole panel in jsdom
                          (*.test.tsx)
  use-cases/              Notico's use cases (UC-NOTICO-…), by domain; tests are named with their
                          scenario IDs (docs/bdd.md)
worker/                   Cloudflare Worker
  src/app.ts              the Hono app, composed from the sub-apps below; everything under /v1 is one
                          sub-app whose first handler is the session check
  src/http.ts             what every route shares: bindings, options, errors, and request parsing
  src/routes/             the routes, by area, each a Hono sub-app:
    session.ts            Clerk JWT verification, the first handler under /v1
    chat.ts               /v1/chat/completions, charged to credits (chat-request.ts: what a request may hold)
    credits.ts            the user's own credits and their history (/v1/credits…)
    billing.ts            buying credits (/v1/billing/*), Checkout's return pages, and /stripe/webhook
    admin.ts              the admin routes (/v1/admin/*)
    pages.ts              the sign-in page, the admin page, /health, and / (a redirect to /login)
  src/credits.ts          credit ledger over D1: grants, expiry, spending, model calls and their cost
  src/billing.ts          the packs on offer, and what the Stripe webhook does with each event
  src/stripe.ts           Stripe's API (Checkout Sessions), webhook signatures, and the events' shapes
  src/billing-page.ts     the page Checkout sends a buyer back to
  src/pricing.ts          what each model's tokens cost in credits
  src/usage.ts            per-request usage records (Workers Analytics Engine), no message content
  src/login.ts            sign-in page (Clerk Sync Host)
  src/admin.ts            admin page: credits granted and spent as a whole, one account's credits, grants by hand
  src/overview.ts         what was granted and spent in a period across accounts, read from the ledger's tables
  migrations/             the D1 schema (grants, model_calls), applied on deploy
  test/                   REST integration tests (real signed JWTs, fake AI binding, fake Stripe with
                          webhook events signed like Stripe's, the real SQL on SQLite behind a fake D1),
                          and the extension's agent run against the worker
  use-cases/              the rules only the worker decides, whichever extension asks, and the
                          backend's own use cases (UC-COFUN-…), by domain
e2e/                      pnpm e2e: drives the shared Chrome Canary over CDP for ai-e2e runs
                          (maintainer's machine only; its unit tests run in pnpm test)
smoke/                    pnpm smoke: loads the built extension into Chromium and checks that it
                          still works (Notion and Clerk answered from fixtures; runs in CI)
docs/
  architecture.md         this file
  development.md          setup, deployment, and repository settings
  assets/                 pictures used by Notico's README.md
  bdd.md                  how use cases and scenarios are written, and how to run ai-e2e scenarios
.oxlintrc.json            lint rules, including the extensions' module boundaries
.github/rulesets/         GitHub branch rulesets (export format)
.github/workflows/        CI, CodeQL, dependency review, workflow lint, Claude review, and Claude on request
.github/dependabot.yml    weekly dependency updates
scripts/
  sync-github-settings.sh applies the rulesets and repository options with gh
  check-use-cases.ts      pnpm use-cases (run by pnpm check): every ✅ api-test scenario has a test;
                          the check itself is in use-cases.ts, with its unit tests in test/
README.md                 Cofun and its extensions, for users
PRIVACY.md                what the sign-in and the worker do with users' data, for every extension
AGENTS.md                 development workflow and conventions (CLAUDE.md links here)
```
