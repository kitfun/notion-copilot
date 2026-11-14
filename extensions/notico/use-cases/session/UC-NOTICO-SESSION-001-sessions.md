# UC-NOTICO-SESSION-001: Keep sessions and pick up where you left off

## Behavior

Each conversation in the side panel is a session, which the panel calls a chat. Each question in a session is sent with the conversation so far, so the user can ask a follow-up. A signed-in user can start a new session at any time, and opening the side panel starts one. The top of the panel shows the open session's title, or "New chat" until its first question. Past sessions are kept in a list, most recently used first, each with its title and the Notion page it started on. The user can search the list by title and delete sessions they no longer want.

Once a session's first reply has come in, the model the user is asking with (the hosted one, which spends credits as any request does, or their own) is asked for a short title of a few words, in the language of the question, from the first question and the start of the reply. The title is written once and does not change as the conversation goes on. Until it arrives, or if the model gives none that can be used, the session is titled with its first question; that is not shown to the user as a failure and does not stop the conversation.

Reopening a session shows the whole conversation, including the tools the agent used and what they returned, and the next question continues it: the AI has the earlier conversation as context, as if the session had never been closed. Switching to another session, or starting a new one, while a question is still being answered is the same as stopping that question: it never lands in the wrong session, and the session it was asked in keeps what a stopped question keeps (see UC-NOTICO-AGENT-001), the tools it used and how they ended, so a follow-up there does not repeat a change already made. A question stopped before it used a tool leaves its session as it was.

Each browser window has its own side panel, and the same session can be open in more than one. If it is continued in two windows, neither conversation replaces the other: the one saved later is kept as a separate session in the list, and that window tells the user so.

A saved session the panel can no longer read, such as one kept in a form an earlier version wrote and this one does not understand, never stops the user from using the others. It stays in the list, marked as unreadable, and the only thing the user can do with it is delete it. A session whose conversation can't be read is not opened and nothing of it is sent to the AI: the user is told it can't be opened and is offered to delete it.

Sessions are kept on the user's device and do not follow them to other devices. They stay there after the user signs out, so they can pick up again after signing back in. The service never stores them; it only sees the conversation the AI needs to answer the current question (see UC-NOTICO-AGENT-001 and UC-COFUN-CHAT-002).

Key constraints:

- A session's context stays in that session. A new or different session never sends another session's conversation to the AI.
- Sessions belong to the account that made them. Another account signed in on the same browser cannot see or reopen them.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-SESSION-001-S01 | P0 | ✅ | Given a saved session in which the agent used a tool; when the user reopens it and asks a follow-up; then the AI gets the earlier conversation, including the tool calls and their results, followed by the new question. |
| UC-NOTICO-SESSION-001-S19 | P0 | ✅ | Given a session with an answered question; when the user asks a follow-up in it; then the AI gets the earlier question and reply, followed by the follow-up. |
| UC-NOTICO-SESSION-001-S02 | P1 | ✅ | Given a user with saved sessions; when they ask the AI in a new session; then nothing from the earlier sessions is sent to the AI. |
| UC-NOTICO-SESSION-001-S13 | P1 | ✅ | Given several saved sessions; when the user opens the session list; then it shows them most recently used first, each with its title and with the Notion page it started on. |
| UC-NOTICO-SESSION-001-S14 | P1 | ✅ | Given a new session; when the first reply has come in; then the model is asked for a short title from the first question and the start of the reply, the session is listed under that title, the list search matches it, and later questions do not change it. |
| UC-NOTICO-SESSION-001-S15 | P1 | ✅ | Given a new session; when the first reply has come in but the title request fails or gives nothing usable; then the session is listed under its first question, and the chat goes on with no error shown. |
| UC-NOTICO-SESSION-001-S12 | P1 | ✅ | Given sessions with different titles; when the user searches the list; then only the sessions whose title contains what they typed are listed, ignoring case. |
| UC-NOTICO-SESSION-001-S16 | P1 | ✅ | Given a new session; when the user asks a question, its first reply comes in, and the user later reopens an earlier session; then the top of the panel shows "New chat" before the question, then the session's title (its first question, then the model's title once it comes), then the reopened session's title. |
| UC-NOTICO-SESSION-001-S05 | P1 | ✅ | Given a saved session; when the user deletes it; then it is no longer listed and cannot be reopened. |
| UC-NOTICO-SESSION-001-S09 | P0 | ✅ | Given sessions saved by one account; when another account signs in on the same browser; then it sees none of them and cannot reopen them. |
| UC-NOTICO-SESSION-001-S20 | P1 | ✅ | Given a user with a saved session; when they sign out and sign back in to the same account; then the session is in the list again, and reopening it shows its conversation. |
| UC-NOTICO-SESSION-001-S10 | P1 | ✅ | Given one session open in two windows; when the user continues it in both; then the session keeps the first window's conversation, the second window's is saved as a separate session, and both are in the list. |
| UC-NOTICO-SESSION-001-S06 | P0 | ✅ | Given a session from earlier in which the agent used a tool, and the side panel opened again; when the user reopens that session and asks a follow-up; then the earlier conversation shows with its tool calls, and the reply uses the earlier context. |
| UC-NOTICO-SESSION-001-S07 | P1 | ✅ | Given earlier sessions; when the user opens the side panel; then it starts a new, empty session, and the earlier sessions are in the list. |
| UC-NOTICO-SESSION-001-S08 | P1 | ✅ | Given a question still being answered, for which the agent already used a tool; when the user switches to another session; then the question stops, nothing of it shows in the session they switched to, and the session it was asked in keeps the question with the tools it used: reopening it shows them, and a follow-up there gives them to the AI. |
| UC-NOTICO-SESSION-001-S21 | P1 | ✅ | Given a question still being answered, for which the agent already used a tool; when the user starts a new session; then the question stops, the new session is empty and sends nothing of it to the AI, and the session it was asked in is in the list with the question and the tools it used. |
| UC-NOTICO-SESSION-001-S22 | P2 | ✅ | Given a question still being answered, for which the agent has used no tool; when the user switches to another session or starts a new one; then the question stops and leaves its session as it was: nothing of the question is kept, and a session it was the first question of is not in the list. |
| UC-NOTICO-SESSION-001-S17 | P1 | ✅ | Given saved sessions, one of which the panel can no longer read; when the user opens the session list; then the others are listed as usual, the unreadable one is listed as unreadable, and the user can delete it but not open it. |
| UC-NOTICO-SESSION-001-S18 | P1 | ✅ | Given a listed session whose conversation the panel can no longer read; when the user opens it; then the chat is not entered, nothing of it is sent to the AI, the user is told it can't be opened, and they can delete it. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-SESSION-001-S11 | P2 | ✅ | Given a session open in the side panel that was continued in another window since; when the user asks a follow-up; then the reply arrives, the panel says the chat was saved as a separate chat, and both sessions are in the list. |
