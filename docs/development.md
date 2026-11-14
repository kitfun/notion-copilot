# Development

Requires Node.js 24 and pnpm. The repository is one pnpm workspace: the [worker](#worker), shared by every extension, and one folder per extension in `extensions/` ([Notico](#notico) is the first). The commands below cover all of them.

```bash
pnpm install
pnpm check        # lint, unused code check (knip), format check, use case coverage (pnpm use-cases), typecheck, extension build, and every package's tests
pnpm knip         # unused files, exports, and dependencies (knip.jsonc lists what is kept, and why)
pnpm smoke        # build the extension and load it into Chromium (first: pnpm --filter cofun-smoke exec playwright install chromium)
pnpm icons        # export extensions/notico/icons/icon.svg into extensions/notico/public/icons (needs the same Chromium); commit the PNGs
```

A lefthook pre-commit hook runs `pnpm check`. GitHub Actions runs it and `pnpm smoke` on every pull request.

See [AGENTS.md](../AGENTS.md) for the issue → PR → review → merge workflow.

## GitHub settings

The `main` branch ruleset is kept in [`.github/rulesets/main.json`](../.github/rulesets/main.json): no deletion or force push, linear history, changes only through PRs with CI, dependency review, and actionlint passing and every review thread resolved, no open CodeQL or zizmor code scanning alerts of medium severity or above, merged by a merge queue that runs the required checks again on top of the latest `main` before it squash-merges (code scanning runs on the PR and on `main`, not in the queue). Every action is pinned to a full commit SHA. [`scripts/sync-github-settings.sh`](../scripts/sync-github-settings.sh) applies it along with the repository options: squash merge only (the PR title and body become the commit message), delete head branches on merge, auto-merge allowed (on a branch with a merge queue, `gh pr merge` adds a PR to the queue through it), secret scanning with push protection, and Dependabot alerts and security updates. Weekly Dependabot version updates are configured in [`.github/dependabot.yml`](../.github/dependabot.yml).

A repository admin runs it from their machine with `gh` signed in; it is not run in CI, so no admin token is stored on GitHub. It changes only what differs and prints what it changed:

```bash
scripts/sync-github-settings.sh
```

If you change a setting in the GitHub dashboard, copy it back into these files.

## PR media

The GIF or screenshots that show a finished feature in a PR comment ([AGENTS.md](../AGENTS.md), step 9) are kept in the public R2 bucket `cofun-static`, served at `https://static.cofun.cc`, never on a git branch. Upload them and embed the URLs it prints as `![what it shows](<url>)` (GitHub shows only images that way; link to a video instead):

```bash
pnpm media 367 demo.gif before.png
# https://static.cofun.cc/cofun/pr/367/demo.gif
# https://static.cofun.cc/cofun/pr/367/before.png
```

Only the maintainer's machine can upload: the script runs the `cf` CLI with the Cloudflare login there (with several accounts in it, `CLOUDFLARE_ACCOUNT_ID` picks the one that has the bucket; don't commit it). Showcase GIFs meant for the README or an extension's help pages are committed in the repository instead.

## Worker

The worker is one deployment for every extension: sign-in, the model, credits, and the admin page.

Merging to `main` deploys the worker through Cloudflare Workers Builds. To deploy by hand (`pnpm run deploy` applies the [database](#credits-database) migrations first, like the build's deploy command):

```bash
cd worker
pnpm exec wrangler login
# If your Cloudflare login has several accounts, pick one with an env var (don't commit it)
CLOUDFLARE_ACCOUNT_ID=<account id> pnpm run deploy
```

The worker runs on the custom domain `api.cofun.cc` (see `routes` in `wrangler.jsonc`). The domain's zone must belong to the deploying Cloudflare account.

Variables in `wrangler.jsonc`:

| Variable | Description |
|---|---|
| `CLERK_PUBLISHABLE_KEY` | Clerk publishable key, used by the sign-in page. The hosted worker uses the production instance (`pk_live_…`, Frontend API `clerk.cofun.cc`) |
| `AI_GATEWAY_ID` | AI Gateway id; leave empty to call Workers AI directly |
| `MODEL` | The only model clients can use. Its token prices must be listed in `worker/src/pricing.ts`: without them every chat request is refused as `not_configured` |
| `CLERK_AUTHORIZED_PARTIES` | Allowed origins, comma-separated: `chrome-extension://<extension id>` and the sign-in page |
| `PRODUCTS` | Which product each extension is, by its origin (the token's `azp`), as a JSON object: `{"chrome-extension://<extension id>": "notico"}`. Model calls from any other caller are recorded as `unknown` |
| `CLERK_JWT_KEY` | Clerk JWT public key (PEM). Public; also available at `https://<frontend-api>/.well-known/jwks.json` |
| `CREDIT_PRICE` | The id of the Stripe price of one unit of credits: 1,000 credits for US$1, one-time. The committed value is the live account's |
| `CREDIT_PACKS` | The packs on sale, as quantities of `CREDIT_PRICE`: `[1, 5, 20, 100]` sells US$1, 5, 20, and 100 packs. A pack's credits are its quantity × 1000. Changing the packs on sale changes only this |
| `POSTHOG_HOST` | PostHog's ingestion host, `https://us.i.posthog.com` for the US region. See [PostHog](#posthog) |
| `POSTHOG_KEY` | The PostHog project's key (`phc_…`), public by design; the same one as the extension's `VITE_POSTHOG_KEY`. Empty: the worker sends no purchase event |

Secrets, set with `pnpm exec wrangler secret put <name>` in `worker/` (or in the dashboard: Workers & Pages → `cofun-api` → Settings → Variables and Secrets), never committed. Without them nothing can be bought: the side panel says buying credits is unavailable, and the webhook takes no event.

| Secret | Description |
|---|---|
| `STRIPE_SECRET_KEY` | The Stripe account's secret key (`sk_live_…`, or a restricted key with write access to Checkout Sessions), for making Checkout Sessions and reading what one sold |
| `STRIPE_WEBHOOK_SECRET` | The signing secret of the webhook endpoint below (`whsec_…`) |

### Stripe

Credits are sold through Stripe's Checkout with [Managed Payments](https://docs.stripe.com/payments/managed-payments), Stripe being the merchant of record (see [Credits](architecture.md#credits)). On the Stripe account:

1. **One product.** `Cofun Credits`, described as "1,000 credits per unit, valid for one year." (Checkout shows the name as its heading and the quantity only under "View details", so the name carries no number), with one one-time price of US$1.00, tax code `txcd_10105003` (AI as a Service, personal use; eligible for Managed Payments), tax not included in the price. Its price id is `CREDIT_PRICE`; a pack is a quantity of it. To change the unit price, make a new price and change `CREDIT_PRICE`; the side panel shows US$1 for each 1,000 credits. A Checkout opened before the change (open for up to 24 hours, or paid days later) keeps the price it was made with, and still grants its credits.
2. **Managed Payments** turned on (Settings → Managed Payments), and the business details, statement descriptor, and the website's terms and privacy links filled in as Cofun (`cofun.cc`).
3. **The webhook endpoint** (Developers → Webhooks → Add destination): the URL `https://api.cofun.cc/stripe/webhook`, API version `2025-08-27.basil` (a basil version, like the `2025-03-31.basil` the worker makes sessions with; the Dashboard no longer offers that one, and the fields the worker reads are the same in both), and these events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `charge.refunded`, and `charge.dispute.created`. Its signing secret is `STRIPE_WEBHOOK_SECRET`.

Each purchase is written to Workers Logs as `purchase: user=<user id> credits=<n> payment=<PaymentIntent id>`, and each one taken back as `purchase taken back: payment=<PaymentIntent id> reason=<refund|dispute>`.

There is no test environment: the one worker is deployed on merge, with the live Stripe account. The worker's tests cover buying against a fake Stripe, with webhook events signed by a test secret. After a deploy that changes buying, the maintainer checks it once by hand: buy the US$5 pack with a real card, see the credits arrive in the side panel, refund the payment in the Stripe Dashboard, and see what was left taken back. It costs one payment's fees, so it is never part of `pnpm e2e`.

### PostHog

Product analytics go to one [PostHog](https://posthog.com) project, in the US region: the extensions send usage events to it themselves, and the worker sends `purchase_completed` when a payment adds credits (see [Usage data](architecture.md#usage-data)). The project's key (Settings → Project → Project API key, `phc_…`) is public by design, and is set in two places: `VITE_POSTHOG_KEY` in `extensions/notico/.env`, and `POSTHOG_KEY` in `worker/wrangler.jsonc`. While it is empty nothing is sent, and the build and the tests need no key.

In the project's settings, turn on **Discard client IP data** (the privacy pages say PostHog is set not to keep the address), and leave autocapture, session replay, heatmaps, and exception capture off: the extension turns them off itself and never asks the project for its settings, so they would have no effect, but nothing should suggest otherwise. Don't use PostHog's setup wizard on this repository: it adds the SDK with its defaults, which send page views with the page's title and URL.

### Admin page

`https://<worker domain>/admin` shows an admin what was granted and spent across all accounts in a period of up to 92 days (in all, per day, per product, and per account, the biggest spenders first), and lets them look up one account's credits by Clerk user id (Clerk dashboard → Users shows it) and grant it credits by hand. See [Credits](architecture.md#credits) for how it is protected and how the overview is read. Days are days on the clock of the computer the page is open on.

Who is an admin is set in Clerk, on the instance whose keys the worker uses. Two settings, both in the Clerk dashboard:

1. **Sessions → Customize session token → Claims**: add the `role` claim, next to any claims already there, and save. The worker reads exactly this claim name.

   ```json
   {
     "role": "{{user.public_metadata.role}}"
   }
   ```

2. **Users → the admin's user → Metadata → Public → Edit**: set the role. The worker accepts exactly the string `admin`.

   ```json
   {
     "role": "admin"
   }
   ```

Without the first, no token carries a role and nobody is an admin; without the second, that user is not one. A user's new role reaches the worker with their next session token, within about a minute. To remove an admin, remove the `role` from their public metadata. Users cannot change their own public metadata: only the dashboard and Clerk's Backend API (with the secret key) write it. Never put the role in unsafe metadata, which users can write themselves.

The worker's own origin (`https://<worker domain>`) must be in `CLERK_AUTHORIZED_PARTIES`: admin requests are accepted only with a session token issued to that origin. To use the page with `wrangler dev`, add the local origin (`http://localhost:8787`) there, in `worker/.dev.vars`.

Each grant made by hand is written to Workers Logs as one line: `manual grant: admin=<user id> user=<user id> credits=<n> expires=<time>`.

### Usage records

Every chat request that passes auth leaves one data point in the `cofun_api_usage` Analytics Engine dataset (binding `USAGE`), written when the reply ends, is refused, or fails. Records hold sizes, token counts, the credits charged, and the outcome, never message or reply text. Analytics Engine deletes them after 90 days. They are for watching the service: they describe every request, refused and failed ones too. Users are charged from the credits database below (see [Credits](architecture.md#credits)), never from these records.

| Column | Value |
|---|---|
| `index1` | Clerk user id |
| `blob1` | model |
| `blob2` | outcome: `ok`, `incomplete` (stream ended early), `cancelled`, `stream_error`, or the error code returned (`out_of_credits`, `provider_error`, `credits_unavailable`, `bad_request`, …). A stream whose model reports an error is `provider_error` |
| `blob3` | finish reason: `stop`, `length`, `content_filter`, `tool_calls`, `other`, or empty |
| `blob4` | `stream` or `sync` |
| `blob5` | product: `notico`, another extension's name, or `unknown` (see `PRODUCTS`) |
| `double1` … `double5` | messages, input characters (message text, tool calls, and tool definitions), prompt tokens, completion tokens, duration in ms (until the request was refused, the reply was sent, or a stream ended; for streams it includes the time the client spends reading) |
| `double6`, `double7` | cached prompt tokens (the part of the prompt tokens the model read from its cache), micro-credits charged (1 credit = 1,000,000; 0 when nothing was charged). For a reply that was stopped or broke off, the token counts are the estimate it was charged by |

Query them with the [SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/), for example requests, tokens, and credits per user per day:

```sql
SELECT index1 AS user, toStartOfDay(timestamp) AS day,
       sum(_sample_interval) AS requests,
       sum(_sample_interval * double3) AS prompt_tokens,
       sum(_sample_interval * double4) AS completion_tokens,
       sum(_sample_interval * double7) / 1000000 AS credits,
       sumIf(_sample_interval, blob2 != 'ok' AND blob2 != 'cancelled') AS failed
FROM cofun_api_usage
WHERE timestamp > NOW() - INTERVAL '7' DAY
GROUP BY user, day
ORDER BY day DESC, requests DESC
```

### Credits database

Grants and model calls (with what each cost) are kept in the D1 database `cofun-db` (binding `DB`), on the account that deploys the worker. `wrangler.jsonc` names it and does not hold its id: on deploy, wrangler finds the database by name on that account, so the id never has to be committed. The schema is the migration files in `worker/migrations/`, applied in order on every deploy (see the deploy command below). A new migration is a new file with the next number; never change one that was applied.

Create the database once, on the account that deploys the worker (with several accounts in one login, choose one with `CLOUDFLARE_ACCOUNT_ID`; don't commit it):

```bash
cf d1 create --name cofun-db
```

Apply the migrations by hand, for example before the first deploy (wrangler finds the database by name; [`cf d1 migrations apply`](https://developers.cloudflare.com/d1/reference/migrations/) does the same with the database id, which `cf d1 list --name cofun-db` shows):

```bash
cd worker
pnpm exec wrangler d1 migrations apply cofun-db --remote
```

Query it with `cf d1 query <database id> --sql "…"`, or in the dashboard (Storage & databases → D1 → `cofun-db` → Console). Amounts are micro-credits (divide by 1,000,000 for credits) and times are ms since the epoch. Rows are never deleted. The [admin page](#admin-page) shows what was granted and spent per day and per account; the queries below are for what it does not show, or for a longer time than it covers. D1 runs one query at a time, so a query over a whole table holds up charging while it runs: bound it by time where you can. Credits granted and spent per day, with calls and tokens, across all users:

```sql
SELECT day, sum(granted) / 1e6 AS credits_granted, sum(spent) / 1e6 AS credits_spent,
       sum(calls) AS calls, sum(prompt_tokens) AS prompt_tokens, sum(completion_tokens) AS completion_tokens
FROM (
  SELECT date(granted_at / 1000, 'unixepoch') AS day, amount AS granted, 0 AS spent, 0 AS calls,
         0 AS prompt_tokens, 0 AS completion_tokens FROM grants
  UNION ALL
  SELECT date(started_at / 1000, 'unixepoch'), 0, micro_credits, 1, prompt_tokens, completion_tokens FROM model_calls
)
GROUP BY day ORDER BY day DESC LIMIT 30
```

Calls and credits spent per user over the last 7 days, with how many calls failed (every outcome but `ok`) and how many of those the user stopped:

```sql
SELECT user_id, count(*) AS calls, sum(micro_credits) / 1e6 AS credits_spent,
       sum(prompt_tokens) AS prompt_tokens, sum(cached_tokens) AS cached_tokens,
       sum(completion_tokens) AS completion_tokens,
       sum(outcome <> 'ok') AS failed, sum(outcome = 'cancelled') AS cancelled
FROM model_calls
WHERE started_at > (unixepoch() - 7 * 86400) * 1000
GROUP BY user_id ORDER BY credits_spent DESC
```

Granted per user and source, and what each user owes now (`sum(owed)` of their model calls less `sum(repaid)` of their grants):

```sql
SELECT user_id, source, count(*) AS grants, sum(amount) / 1e6 AS credits_granted, sum(left) / 1e6 AS credits_left
FROM grants GROUP BY user_id, source ORDER BY user_id, source;

SELECT u.user_id,
       ((SELECT coalesce(sum(owed), 0) FROM model_calls c WHERE c.user_id = u.user_id)
        - (SELECT coalesce(sum(repaid), 0) FROM grants g WHERE g.user_id = u.user_id)) / 1e6 AS credits_owed
FROM (SELECT DISTINCT user_id FROM grants) u ORDER BY credits_owed DESC;
```

### Workers Builds settings

In the Cloudflare dashboard: Workers & Pages → `cofun-api` → Settings → Builds → connect `cofun-labs/cofun`.

| Setting | Value |
|---|---|
| Root directory | `worker` |
| Build command | `pnpm install --frozen-lockfile && pnpm test` |
| Deploy command | `npx wrangler d1 migrations apply cofun-db --remote && npx wrangler deploy` |
| Production branch | `main` |

The deploy command applies the migrations not yet applied to `cofun-db`, then deploys, so new code never runs on an old schema. Wrangler skips its confirmation in CI, and a migration that fails is rolled back and stops the deploy. The build's API token (Workers & Pages → `cofun-api` → Settings → Builds → API token) needs **D1: Edit** on the account, both to apply the migrations and to find `cofun-db` by name. A token that Workers Builds creates has it (checked on one created in November 2026); a token made by hand needs it added. The worker's tests use Node's built-in `node:sqlite`, so the build needs Node.js 24 (the Workers Builds default).

## Notico

```bash
pnpm build        # builds every extension; Notico's goes to extensions/notico/dist
```

In `chrome://extensions`, turn on Developer mode, click "Load unpacked", and pick `extensions/notico/dist`.

`extensions/notico/.env` holds the public build config. To point at your own deployment, override values in `extensions/notico/.env.local`:

| Variable | Description |
|---|---|
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk publishable key, of the same instance as the worker's. It names the Frontend API host, which the manifest allows |
| `VITE_CLERK_SYNC_HOST` | URL of the sign-in page (the worker's domain). With a development instance's key (`pk_test_…`) Clerk syncs the session from this host; with a production instance's key (`pk_live_…`) it syncs from the Frontend API host instead |
| `VITE_API_URL` | Worker base URL, including `/v1` |
| `VITE_POSTHOG_HOST` | PostHog's ingestion host, where usage events go. The manifest's content security policy allows it |
| `VITE_POSTHOG_KEY` | The PostHog project's key (`phc_…`), public by design. Empty: the extension sends no usage events. See [PostHog](#posthog) |
| `CRX_PUBLIC_KEY` | Extension public key; pins the extension ID. The committed one is the Chrome Web Store's, so a development build has the store's ID. The [store build](#releases) leaves it out |
| `CLERK_COOKIE_DOMAIN` | Optional. The registrable domain Clerk sets its cookies on, e.g. `example.co.uk`. Defaults to the last two labels of the sign-in page's host |

To run the extension against your own deployment under an ID of your own, generate a signing key and set its public half as `CRX_PUBLIC_KEY`:

```bash
mkdir -p extensions/notico/keys
openssl genrsa -out extensions/notico/keys/crx-private.pem 2048
openssl rsa -in extensions/notico/keys/crx-private.pem -pubout -outform DER > extensions/notico/keys/pub.der
base64 -i extensions/notico/keys/pub.der | tr -d '\n'                          # CRX_PUBLIC_KEY
shasum -a 256 extensions/notico/keys/pub.der | cut -c1-32 | tr '0-9a-f' 'a-p'  # extension ID
```

In the Clerk dashboard, enable the Native API (Native applications page) so the Chrome extension can sign in. Development and production instances have separate settings, keys, and users: do it on the instance whose keys you use.

A production instance also needs:

- Its DNS records in place, so the Frontend API answers at `clerk.<your domain>`. The sign-in page must be on the same registrable domain, because that is where Clerk sets its cookies.
- Your own OAuth credentials for each social sign-in (Clerk's shared ones work only on development instances).
- The extension's origin (`chrome-extension://<extension id>`) in the instance's `allowed_origins`, set through Clerk's Backend API as [Clerk's Sync Host guide](https://clerk.com/docs/guides/sessions/sync-host) describes.
- `CLERK_JWT_KEY` taken from that instance: the PEM form of the key at `https://clerk.<your domain>/.well-known/jwks.json`.

### Another extension

An extension of its own goes through the same steps, in its own folder: its own signing key and extension ID, its `.env`, and its origin (`chrome-extension://<extension id>`) added to the worker's `CLERK_AUTHORIZED_PARTIES` and `PRODUCTS`, and to the Clerk instance's `allowed_origins`. To release it, add its folder name to the `extension` choices in [`release.yml`](../.github/workflows/release.yml), once the smoke test covers it.

## Releases

An extension is released from `main` by the [Release workflow](../.github/workflows/release.yml), run by hand: Actions → Release → Run workflow, on `main`, with the extension and the version. Or:

```bash
gh workflow run release.yml --ref main -f extension=notico -f version=0.2.0
```

Before running it, add the version to the extension's `CHANGELOG.md` ([Notico's](../extensions/notico/CHANGELOG.md)) through a PR: what changed for users since the last release (`git log <name>-v<last version>..main`), worker changes they notice included, written for them rather than copied from commit titles. The workflow uses that entry (the text under the `## <version> (<date>)` heading) as the body of the GitHub Release, and stops before it builds or tags anything if the changelog has no entry for the version.

The version goes into the manifest and is not committed: `package.json` keeps its development version, and the tags record what was released. It must be 1 to 4 dot-separated integers from 0 to 65535, without leading zeros, and higher than the version last uploaded to the store, which rejects any other.

The workflow needs no secrets. It checks out `main`, runs `pnpm check`, builds the extension for the store, runs the smoke test against that build, and zips `extensions/<name>/dist`. Then it tags the commit `<name>-v<version>` (for example `notico-v0.2.0`) and creates a **draft** GitHub Release with the changelog entry as its body and the zip (`<name>-<version>.zip`) attached; the zip is also kept as the run's artifact. A tag that exists already stops the run, so each version is built once. To throw a run's result away, delete the draft release and its tag:

```bash
gh release delete notico-v0.2.0 --cleanup-tag
```

The store build is the normal build with two variables set, which you can also set by hand to look at one: `EXTENSION_VERSION` replaces the version, and `CRX_STORE_BUILD=1` leaves `key` out of the manifest. The Chrome Web Store signs the item with a key of its own, which sets its ID.

```bash
CRX_STORE_BUILD=1 EXTENSION_VERSION=0.2.0 pnpm --filter ./extensions/notico build
```

Uploading to the store is done by hand ([#298](https://github.com/cofun-labs/cofun/issues/298) would automate it): in the Chrome Web Store Developer Dashboard, Package → Upload new package with the draft release's zip, then Submit for review. What the Dashboard's other tabs say (the listing, the privacy answers, distribution, test instructions, and the images) is kept in `extensions/<name>/store/` ([Notico's](../extensions/notico/store/README.md)); change it there first, then copy it into the Dashboard before submitting the version that needs it. The store's API can't create an item, so an extension's first version is also how its listing and privacy fields first get into the Dashboard, and the store assigns the extension its ID at that first upload. Its public key (Package tab → View public key) then becomes the extension's `CRX_PUBLIC_KEY`, so development builds load under the same ID, and that ID goes into the worker's `CLERK_AUTHORIZED_PARTIES` and `PRODUCTS`, the Clerk instance's `allowed_origins`, and `EXTENSION_ID` in `e2e/src/extension.ts`.
