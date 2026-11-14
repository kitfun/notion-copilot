<p align="center">
  <img src="icons/icon.svg" alt="Notico icon" width="96" height="96" />
</p>

<h1 align="center">Notico: AI copilot for Notion</h1>

<p align="center">
  An AI side panel for Chrome that reads and edits your Notion pages with you.<br />
  Ask in plain words; it finds the pages, does the work, and shows you every change.
</p>

<p align="center">
  <a href="https://github.com/cofun-labs/cofun/actions/workflows/ci.yml?query=branch%3Amain"><img src="https://github.com/cofun-labs/cofun/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status" /></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/github/license/cofun-labs/cofun" alt="License: Apache-2.0" /></a>
</p>

<p align="center">
  <img src="../../docs/assets/demo.svg" alt="You ask in the side panel, Notico reads the open page, then adds an Action items section to it" width="880" />
</p>

<p align="center"><sub>An illustration of the side panel, not a screenshot.</sub></p>

## What it can do

- **Read:** The page you have open or any other page, long pages included. Databases as tables, filtered and sorted. Comment threads.
- **Find:** Search your workspace, or browse pages the way the sidebar lists them, then read what it finds.
- **Write:** Insert, replace, and delete content in a page. Create new pages with content. Change titles and icons.
- **Databases:** Create databases, add rows, fill in properties, and add, rename, or remove properties and select options.
- **Organize:** Move pages under another page, duplicate them, or move them to Notion's trash (it asks you first).
- **Collaborate:** Add comments on a page or on a block, and mention workspace members by name.
- **Stay in context:** It knows which page is open and what you selected in it. The panel stays open, with your chat, as you switch tabs. Past chats are saved, searchable, and can be picked up again.
- **Keep the answer:** Save a reply, or a whole chat, as a new page under the Notion page you have open, with the save button under the reply or at the top of the panel.

## Get started

1. **Install** [Notico from the Chrome Web Store](https://chromewebstore.google.com/detail/notico-ai-copilot-for-not/moblfnjjebknafkgoifncombfnbfghom).
2. **Open a Notion page** and click the Notico icon in Chrome's toolbar (if it's hidden, pin it from the puzzle-piece Extensions menu). The side panel opens next to the page. It opens on any other tab too, and you can chat there, but reading and changing Notion works only while the tab you're on is a Notion page.
3. **Sign in.** The panel opens a sign-in page in a new tab (Google is supported); once you're signed in, the panel picks it up.
4. **Ask.** A few things to try:
   - _Summarize this page in five bullet points._
   - _Turn the notes on this page into a list of action items._
   - _Find our onboarding docs and tell me what's out of date._
   - _Which tasks in this database are overdue? Add a comment on each one._
   - _Create a page for next week's meeting, with the agenda from the last one._
   - Select some text in the page, then: _Rewrite this to be shorter._

There is nothing to connect on the Notion side: no integration to create, no token to paste.

**Credits.** Asking the AI with Notico's own model costs credits (answering with your own model on OpenRouter or DeepSeek spends none), and every account gets 200 free credits each week. Your avatar at the top of the panel shows how many are left; its Credits page shows where they came from, how many you used on each of the last 30 days, and the history of your credits: every lot you were given, and what you paid for those you bought. When you need more, buy a pack on the Credits page: it opens Stripe's checkout in a new tab, nothing renews, and the credits last a year. Back in the side panel, they show as soon as the payment goes through.

**What's new.** The [changelog](CHANGELOG.md) lists what changed in each version.

## How it works

<p align="center">
  <img src="../../docs/assets/how-it-works.svg" alt="The side panel reads and edits pages through your own Notion tab, and sends your question and what it read to the Notico server, which passes them to an AI model" width="880" />
</p>

- **It works as you, in your own Notion tab.** Pages are read and changed from inside the Notion tab you already have open, with the session you're already signed in with. Notico can reach what you can reach, and nothing else. The trade-off: it uses the same internal API as Notion's own web app, which is not a public API and may change.
- **The server never talks to Notion.** It checks who you are and passes the conversation to the model. The work on your pages happens in your browser.
- **It is careful with your Notion account.** If Notion asks it to slow down, or answers with something it doesn't understand, it stops and tells you instead of pushing on or working around it.

## Privacy and safety

**What leaves your browser.** Your questions, and what Notico reads to answer them (pages, database rows, comments, search results), go to our server (one for every [Cofun](../../README.md) extension) and on to the AI model, which runs on Cloudflare Workers AI. On a tab that isn't Notion, Notico never reads the page; it sends that tab's address and title only when a question needs them. The server doesn't keep any of this: for each request it records who asked, sizes, token counts, and the outcome, never the text of a prompt or a reply. [Notico's privacy page](PRIVACY.md) has the full account of what is read and which hosts it goes to, and [Cofun's](../../PRIVACY.md) of what the server keeps.

**What stays on your device.** Chats are saved in Chrome on your device, per account, and kept after you sign out so you can pick up again. They are not encrypted: anyone who can use your Chrome profile can read them, including the page content Notico read.

> [!WARNING]
> **It edits without asking first.** Notico edits pages, creates pages and rows, changes properties (it can remove a database property, with its values in every row), adds comments, and moves and duplicates pages as soon as it decides to. Moving pages to the trash is the one thing it asks you about, every time. Each change is shown in the side panel as it happens, and Notion's page history can undo edits. To keep it from changing anything, switch the message box to **Read only** with the pencil button at its bottom left: it then only reads and answers, until you switch back to Edit.

> [!CAUTION]
> **Be careful with pages you don't control.** Notico reads text written by other people: shared pages, guest content, search results. An instruction hidden in that text could make it act as you without anyone being asked, for example by copying something private into a page or a comment that others can read. Comments and mentions also notify people. Page history can undo a change, but not what someone read in the meantime. [More on this trade-off](../../docs/architecture.md#writes-without-approval).

## For developers

Notico is one of the [Cofun](../../README.md) extensions, which share one backend. Its code is in this folder; the rest of the repository holds the backend and the docs:

- [Architecture](../../docs/architecture.md): how it is built, the technical choices and why, the sign-in flow, and the code layout.
- [Development](../../docs/development.md): build and load the extension, run the checks, and deploy your own worker.
- [AGENTS.md](../../AGENTS.md): the issue → PR → review → merge workflow and coding rules.
- [BDD](../../docs/bdd.md) and [Notico's use cases](use-cases): the product behavior contract and how it is tested.

## License

Copyright 2026 Cofun Labs. The code is licensed under the [Apache License 2.0](../../LICENSE). It grants no rights to the Notico and Cofun names and logos as trademarks.

Notico is an independent open-source project. It is not made or endorsed by Notion.
