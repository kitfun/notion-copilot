# Notico privacy

Notico is a Chrome extension that opens an AI side panel in Chrome, which reads and edits your Notion pages with you. It is one of the [Cofun](../../README.md) extensions, which share one server and one sign-in. This page says what data Notico reads, where that data goes, and what is kept on your device. What the server and the sign-in do with it, the same for every Cofun extension, is on [Cofun's privacy page](../../PRIVACY.md); the two pages together are Notico's privacy policy. They describe the extension built from this folder with its committed configuration (`extensions/notico/.env`) and the worker deployed from `worker/`. If you build the extension against your own deployment, the hosts are the ones you configure.

The short version: when you ask a question, the conversation, including the Notion content the assistant read to answer it, goes to our worker and from there to an AI model that runs on Cloudflare. If you set up your own model on OpenRouter or DeepSeek, it goes to that service instead, with your own key, and not to our worker. We do not store that content on our servers. Your chats are saved on your device only.

## What the extension reads

- **Notion content, as you.** To answer a question, the assistant calls tools that read from Notion with your own Notion session, in your Notion tab: pages (as text), database rows and properties, comment threads, search results, the list of pages in your workspace, what you have selected in the page, and the names of workspace members when you ask it to mention someone. It reads only what a question needs, and it can read anything your Notion account can. While the current tab is a Notion page, its title and URL are added to every question, and so are the title and URL of each page you add to a question yourself (with `@` or the "+" button in the message box), but not their content: the assistant reads what it needs of them as above. When you type at least two characters in the page picker, the text you typed is sent to Notion's search, from your Notion tab, to find pages in your workspace.
- **Your sign-in session.** You sign in on a web page served by our worker, with [Clerk](https://clerk.com). The extension reads the Clerk session cookies that signing in there sets to know who is signed in, and gets a short-lived session token from Clerk for each request to the worker.
- **The current tab's URL and title.** The side panel opens on every tab, and you can chat on any of them; the Notion tools work only while the current tab is a Notion page (`www.notion.so` or `app.notion.com`). With each question, and each time a Notion tool runs, the extension looks at the URL of the current tab (the active tab of the panel's window) to tell whether it is Notion. On a tab that is not Notion, the question only says that the current tab is not a Notion page. The URL and title of such a tab leave the browser only when the assistant calls its `get_current_tab` tool because a question needs them (say, "save a link to this page in my reading list"): the URL is the whole address, including its query string and fragment, which on some sites hold a sign-in or share token. They are then part of the conversation, which goes to the worker and the model and is saved with the chat on your device, as described below.

- **The other Notion pages open in your tabs.** When you open the page picker, the extension reads the URL and title of your tabs that show a Notion page, to offer them. They stay in the browser unless you add one to a question, as above.

It never reads the content of other sites or of tabs other than the current one, the URL or title of a tab on another site other than the current one, your browsing history, or what you type outside the side panel.

It also writes to Notion when you ask it to: it edits and creates pages, changes properties, adds comments, and moves pages. When you save a reply or a chat to Notion yourself, it creates a page under the page open in the current tab, holding your questions and the assistant's replies. These changes are requests to Notion, made as you.

## Where data goes

The extension sends requests to these hosts and no others. The extension's content security policy stops its own pages from connecting anywhere else, and a test pins that policy and the hosts the extension has permission for, so neither can change unnoticed.

| Host | What is sent | Why |
|---|---|---|
| `www.notion.so`, `app.notion.com` | Requests to Notion's own API, sent from inside your Notion tab with that tab's session: reads, searches (the assistant's, and the text you type in the page picker), the changes you ask for, and the questions and replies of a chat or a reply you save to Notion | To read and edit your pages. This is the same service your Notion tab already talks to |
| `api.cofun.cc` (our worker) | Your Clerk session token, and for each question the conversation so far: your messages, the assistant's replies, the tool calls and their results (which contain the Notion content the assistant read), the open Notion page's title and URL, the titles and URLs of the pages you added to a question, the current tab's title and URL on another site if the assistant looked them up, and the assistant's instructions | To get the AI model's reply |
| `api.cofun.cc` (our worker) | Your Clerk session token, how far your clock is from UTC, in minutes, and, when you read further down your credit history, the place in the list to go on from (both as part of the request's address) | To show you your own credits, how many you used each day, by the days of your own clock, and their history |
| `api.cofun.cc` (our worker) | Your Clerk session token, and when you buy credits, which pack you chose | To list the packs of credits on offer, and to start a checkout for the one you chose |
| `openrouter.ai` (OpenRouter), only once you choose it in the settings | When the settings page shows OpenRouter (you pick it, or it is already your choice), or you open the model menu above the message box once your key is saved: a request for its public list of models, with nothing of yours in it, once each time the side panel opens, and again after a request that failed. When you check a model, or ask a question with your own model chosen: your OpenRouter key, and the conversation so far, as listed for the worker above (Notion content the assistant read included) | To get the reply from the model you chose, under your own OpenRouter account. OpenRouter passes the conversation to the company that runs that model; [OpenRouter's privacy policy](https://openrouter.ai/privacy) says what they keep. These questions do not go to our worker and spend no credits |
| `api.deepseek.com` (DeepSeek), only once you choose it in the settings | Nothing until you check a model or ask a question with a DeepSeek model chosen; then your DeepSeek key, and the conversation so far, as listed for the worker above (Notion content the assistant read included). The list of DeepSeek's models comes with the extension, so it is not requested | To get the reply from the DeepSeek model you chose, under your own DeepSeek account. [DeepSeek's privacy policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html) says what DeepSeek keeps and where it stores it. These questions do not go to our worker or to OpenRouter, and spend no credits |
| `clerk.cofun.cc` (Clerk's Frontend API) | Your Clerk session, to load your account and get session tokens | Sign-in |
| `img.clerk.com` (Clerk's image host) | A request for your account's avatar image | To show who is signed in, in the side panel's account menu and Settings page |

The extension also holds a host permission for `*.cofun.cc`. It uses it for nothing but reading one cookie, and sends no requests to any host under it other than the worker and Clerk's Frontend API above: Chrome only lets an extension see a cookie when it has permission for the cookie's domain, and Clerk sets the cookie that says whether you are signed in on the sign-in page's parent domain.

Notion content never goes to Clerk. Your OpenRouter key is sent only to OpenRouter, and your DeepSeek key only to DeepSeek: neither goes to our worker, to Clerk, or to the other service. Your Notion session is never sent anywhere but Notion: requests to Notion are made inside your Notion tab, and the worker and Clerk do not receive your Notion cookies or credentials. The extension reads your Notion user id from the tab to make changes as you.

As with any web service, Cloudflare (which runs the worker) and Clerk see your IP address when the extension connects to them.

When you buy credits, the extension opens Stripe's Checkout page (`checkout.stripe.com`) in a normal tab, as a link would. The extension sends nothing to Stripe itself: what you enter on that page goes to Stripe, and never to the extension or the worker. [Cofun's privacy page](../../PRIVACY.md#buying-credits) says what Stripe and the worker exchange.

### The sign-in page

"Sign in" opens Cofun's sign-in page, `https://api.cofun.cc/login`, in a normal tab. What you enter there goes to Clerk and to the sign-in provider you choose, not to our worker; [Cofun's privacy page](../../PRIVACY.md#the-sign-in-page) says more. The side panel shows your name, email address, and avatar from that account, and lets you sign out; it offers nothing to change the account.

## What the worker does with it

The worker checks who you are, passes the conversation to the AI model and streams the reply back, keeps your credits, and keeps a usage record of each request: numbers, times, and ids, never what you asked or what the assistant answered. It does not store the conversation or the Notion content in it, and of a request that fails it logs at most a short, bounded part of the error. [Cofun's privacy page](../../PRIVACY.md#what-the-worker-does-with-it) has the full account: what is kept, for how long, and who can see it.

The side panel's account menu shows how many credits are left, and its Credits page shows them by where they came from, when they expire or renew, and how many you used on each of the last 30 days; older usage is not shown. From the Credits page you can open the history of your credits: every grant you were given, with what a purchase cost. The history is read from the worker only when you open it.

## What stays on your device

- **Your chats.** Chats are saved in the extension's IndexedDB storage in your Chrome profile, one database per signed-in account. They include tool results, such as the content of Notion pages the assistant read, and the URL and title of a tab it looked up. They are not sent to our servers, except that continuing a chat sends it to the worker again as described above. They are **not encrypted** and they **stay after you sign out**, so that you can pick up again: anyone with access to your Chrome profile can read them. Deleting a chat in the side panel removes it; removing the extension removes them all.
- **Your sign-in.** Clerk's code in the extension keeps its client token, which keeps you signed in, in the extension's local storage (`chrome.storage.local`). It is not encrypted either.
- **Your own model, if you set one up.** Your OpenRouter key and your DeepSeek key, each with the model you chose there, are kept in the extension's local storage (`chrome.storage.local`), for the account that set them up: another account signed in on the same Chrome profile does not use them. They are **not encrypted** and they **stay after you sign out**; anyone with access to your Chrome profile can read the keys. Removing a key in the settings page deletes it; removing the extension deletes it too.
- **Small settings.** The extension's local storage also holds, for each account, whether the assistant may change your pages (Edit or Read only), and the time until which it waits after Notion turned a request away.

## What is never collected

- No analytics, advertising, or tracking in the extension. It loads no remote code.
- The worker does not store Notion content, messages, or replies, and does not write them to its logs (of a failed model call or an unexpected failure it logs only a short, bounded part of the error, as described above).
- No Notion credentials or cookies are sent to the worker or to Clerk.
- No browsing history, and no content of other sites. Of a tab that is not Notion, only its URL and title can leave the browser, only for the current tab, and only when the assistant looks them up to answer a question.
- We do not sell your data, and we do not use it for anything other than providing the assistant.

## Changes and contact

This file changes in the same pull request as any change to what data leaves the browser or where it goes; its [history](https://github.com/cofun-labs/cofun/commits/main/extensions/notico/PRIVACY.md) shows every change. Questions and reports: [open an issue](https://github.com/cofun-labs/cofun/issues).
