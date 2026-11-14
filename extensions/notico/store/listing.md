# Store listing

## Description

The text between the fences goes into the Description field as it is (plain text; the store keeps line breaks and shows no Markdown).

```text
Ask Notion anything, right next to the page. Notico is an AI copilot that reads, writes, and organizes your Notion pages from Chrome's side panel, and shows you every change it makes.

✓ Free to start: every account gets free credits each week
✓ Nothing to set up in Notion: no integration, no API token
✓ Open source (Apache 2.0)

WHAT YOU CAN ASK
• Summarize and explain: the page you have open or any other page, long pages included, with their comments.
• Write and rewrite: draft new pages, add sections, rewrite or shorten what you selected, fix titles and icons.
• Work with databases: read them as tables, filter and sort, add rows, fill in properties, and add, rename, or remove properties and select options.
• Find things: search your workspace, or browse pages the way the sidebar lists them, then read what it finds.
• Organize: move pages under another page, duplicate them, or move them to Notion's trash (it always asks you first).
• Collaborate: comment on a page or a block, and mention workspace members by name.

THINGS TO TRY
• "Summarize this page in five bullet points."
• "Turn the notes on this page into a list of action items, with an owner for each."
• "Which tasks in this database are overdue? Add a comment on each one."
• "Find our onboarding docs and tell me what's out of date."
• Select some text, then: "Rewrite this to be shorter."

STAYS IN CONTEXT
Notico knows which page is open and what you selected. The panel stays open, with your chat, as you switch tabs, and past chats are saved on your device so you can pick them up again.

HOW IT WORKS
Notico works inside your own Notion tab, with the session you're already signed in with, so it can reach what you can reach and nothing else. Sign in to Notico once with Google or your email; nothing else to configure.

CREDITS
Asking the AI costs credits. Every account gets free credits each week, and the panel shows how many you have left and when they renew.

PRIVACY
Your questions, and the Notion content Notico reads to answer them, go to our server and on to an AI model running on Cloudflare Workers AI. The server does not store that content: it keeps only usage numbers, never the text of a question or an answer. Chats are saved only in Chrome on your device. Notico also reports which features are used and whether they worked, never the text of a question, an answer, or a page; you can turn that off in the settings. No ads.

PLEASE NOTE
• Notico edits pages as soon as it decides to; moving pages to the trash is the one thing it asks about first. Every change is shown in the side panel, and Notion's page history can undo edits.
• Be careful with pages written by others: text in them could steer the assistant.

Source code and privacy policy: https://github.com/cofun-labs/cofun

Notico is an independent project. It is not made or endorsed by Notion.
```

## Details

| Field | Value |
|---|---|
| Category | Productivity → Workflow & Planning |
| Language | English |
| Homepage URL | https://cofun.cc |
| Support URL | https://github.com/cofun-labs/cofun/issues |

## Images

| Field | File | Size |
|---|---|---|
| Store icon | [`../public/icons/icon-128.png`](../public/icons/icon-128.png) | 128×128 |
| Screenshots, in this order | [screenshot-1.png](images/screenshot-1.png) (action items added to a page), [screenshot-2.png](images/screenshot-2.png) (overdue tasks in a database, with comments), [screenshot-3.png](images/screenshot-3.png) (a page summarized) | 1280×800 |
| Small promo tile | [small-promo-tile.png](images/small-promo-tile.png) | 440×280 |
| Marquee promo tile | [marquee-promo-tile.png](images/marquee-promo-tile.png) | 1400×560 |

The screenshots show the real side panel next to throwaway pages, made with `pnpm e2e`: the Notion page and the side panel are captured separately and set side by side, so they carry no browser frame. The screenshots and promo tiles are PNG without transparency, as the store requires for them.

## For the next version

The text above describes version 0.1.0, the one in the store. The next version adds credit packs bought through Stripe and answering with the user's own OpenRouter or DeepSeek key: CREDITS, PRIVACY, and the list at the top change with it.
