# Privacy

The Dashboard's Privacy tab. It must agree with [Notico's privacy page](../PRIVACY.md) and [Cofun's](../../../PRIVACY.md), which together are the privacy policy it links to.

## Single purpose

```text
Notico is an AI assistant in Chrome's side panel that reads and edits the user's Notion pages at the user's request.
```

## Permission justifications

One for each permission in the manifest, and one for its host permissions together.

### sidePanel

```text
The extension's whole interface is a side panel, where the user chats with the assistant next to their Notion page.
```

### storage

```text
Keeps the user signed in (the sign-in client token) and a small setting: how long to wait after Notion asked it to slow down.
```

### tabs

```text
Reads the current tab's URL and title to tell whether it is a Notion page, and to find the Notion tab the assistant works in. A non-Notion tab's URL and title are sent only when the user's question needs them. When the user opens the page picker in the message box, it also reads the URLs and titles of the other tabs that show Notion pages, to offer them; one is sent only when the user adds it to a question.
```

### cookies

```text
Reads the sign-in cookies that our own sign-in service (Clerk, on cofun.cc) sets, to bring the user's session into the extension and to notice sign-in and sign-out. It reads no cookies of other sites.
```

### scripting

```text
Runs the requests that read and edit Notion pages inside the user's own Notion tab, with that tab's session, so no Notion credentials leave the tab.
```

### Host permission

```text
www.notion.so and app.notion.com: to read and edit the user's pages in their Notion tab. api.cofun.cc: our server and sign-in page. clerk.cofun.cc: our sign-in service, whose session cookie the extension reads to sign the user in. *.cofun.cc: only to read the sign-in cookie that the sign-in service sets on the parent domain.
```

## Remote code

No, I am not using remote code. Everything the extension runs is in its package; its content security policy allows scripts only from the extension itself (`script-src 'self'`).

## Data usage

| Category | Collected | Why |
|---|---|---|
| Personally identifiable information | Yes | The account's name, email address, and avatar, shown in the panel |
| Health information | No | |
| Financial and payment information | No | |
| Authentication information | Yes | The Clerk session token and cookie |
| Personal communications | Yes | The user's conversation with the assistant goes to the worker and the model, and to the user's own Notion workspace when the user saves a chat or a reply there |
| Location | No | The clock's offset from UTC is sent to count credits used per day; it is not a location |
| Web history | Yes | A tab's URL and title, when a question needs them, and the URL and title of a Notion page open in another tab that the user adds to a question |
| User activity | No | |
| Website content | Yes | The Notion content the assistant reads goes to the worker and the model |

All three certifications are checked: no selling or transfer of user data to third parties outside the approved use cases, no use or transfer for purposes unrelated to the single purpose, and none to determine creditworthiness or for lending.

## For the next version

This page describes version 0.1.0, the one in the store. The version after it lets users answer with their own OpenRouter or DeepSeek key, and buy credit packs through Stripe, so before it is submitted:

- The **storage** justification also says that the user's own model keys, and the model chosen with each, are kept there.
- The **storage** justification also names the setting for whether the assistant may change the user's pages (Edit or Read only).
- **Financial and payment information** becomes Yes: the worker keeps each purchase, by Clerk user id, with its Stripe payment reference and whether it was refunded or disputed (see `PRIVACY.md`). The card details go to Stripe's Checkout page, never to the extension or the worker.
- The rest of the data usage stays as it is: a user's own key is authentication information, and the conversation and the Notion content it holds go to the model service the user chose, which is personal communications and website content again. The privacy policy already says so.
- The extension asks for no new permission: OpenRouter and DeepSeek are reached under the content security policy, not through host permissions.

## Privacy policy URL

```text
https://github.com/cofun-labs/cofun/blob/main/extensions/notico/PRIVACY.md
```
