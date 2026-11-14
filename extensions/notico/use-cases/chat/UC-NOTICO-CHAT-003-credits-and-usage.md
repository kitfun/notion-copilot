# UC-NOTICO-CHAT-003: See credits and usage

## Behavior

A signed-in user needs to know how much of the AI they can still use (see UC-COFUN-CREDITS-001 for what credits are and how they are spent). Their account menu in the side panel shows the account they are signed in to, then Credits, with how many credits are left, and Settings, each opening its own page, and Sign out. The Credits page is about the present: the credits left, split by where they came from (this week's free credits with when new ones can arrive, bought credits with when they expire, and any added by Cofun), the packs to buy (UC-NOTICO-BILLING-001), and the credits used on each of the last 30 days, by the days of their own clock, with the total and today's. The Settings page holds the rest: which model answers (UC-NOTICO-AGENT-002) and the account, with Sign out. They see only their own credits (UC-COFUN-CREDITS-002).

Free credits arrive only when the user asks the AI. Until then, a user with no current week of free credits (a new user, or one whose week has ended) is shown the credits their next question starts with, as not started yet: the free credits, less anything they overspent before.

From the Credits page they can open the history of their credits, which lists only where credits came from: every lot of credits they were given (free, added by Cofun, or bought; see UC-NOTICO-BILLING-001), newest first, the expired ones included, each with how many it was, the day it was given, the day it expires or expired, and what is left, what went unspent when it expired, or what was taken back. Usage is shown only on the Credits page, for the last 30 days; nothing older is shown anywhere.

Under each reply on the hosted model, next to its Copy button, the user sees what the question cost in credits: every model call behind the reply, added up, as the service charged them (UC-COFUN-CREDITS-001). Only a reply that ended normally shows its cost, and that cost is exact: a reply the user stopped, or one that ended in an error, shows no cost, since a call cut short never hears what it was charged. The credits shown in the account menu and on the Credits page still include what such a reply was charged. A reply from the user's own model spends no credits and shows no cost. A reopened chat shows each reply's cost as it was.

The credits shown are current after every question. When a question is refused for lack of credits, the refusal says when credits arrive and leads to the Credits page.

Key constraints:

- Looking at credits changes nothing: it never starts the week of free credits.
- Credits are for information: the chat works the same when they cannot be shown.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-CHAT-003-S01 | P0 | ✅ | Given a user who used some of this week's credits; when they look at their credits; then the account menu shows how many are left, and the Credits page shows them by source, with when new free credits can arrive. |
| UC-NOTICO-CHAT-003-S02 | P0 | ✅ | Given a user with no current week of free credits; when they look at their credits; then they see the free credits their next question starts with, as not started, and their week starts only with that question, with exactly those credits. |
| UC-NOTICO-CHAT-003-S03 | P1 | ✅ | Given a user who overspent their credits; when they look at their credits; then they see none left, and once their week has ended, the next free credits less what they overspent. |
| UC-NOTICO-CHAT-003-S04 | P1 | ✅ | Given a user who asked the AI on several days; when they open the Credits page; then they see the credits used on each of the last 30 days, by the days of their own clock, with the total for those days and today's. |
| UC-NOTICO-CHAT-003-S06 | P1 | ✅ | Given a user with the side panel open; when a question of theirs ends; then the credits shown are what is left after it. |
| UC-NOTICO-CHAT-003-S07 | P1 | ✅ | Given a user with no credits left; when they ask the AI from the side panel; then the refusal says when credits arrive and leads to the Credits page. |
| UC-NOTICO-CHAT-003-S08 | P1 | ✅ | Given the user's credits cannot be read; when they use the side panel; then they can still ask the AI, and the panel says the credits are unavailable instead of showing a number. |
| UC-NOTICO-CHAT-003-S10 | P1 | ✅ | Given a user who was given credits over several weeks; when they open their credit history; then they see every lot of credits they were given (free, added by Cofun, or bought; see UC-NOTICO-BILLING-001), newest first, the expired ones included, each with how many it was, when it was given, when it expires or expired, and what is left or went unspent, and no usage. |
| UC-NOTICO-CHAT-003-S11 | P1 | ✅ | Given a user who asked the AI longer ago than the last 30 days; when they look at their credits and their credit history; then the credits used then are not shown. |
| UC-NOTICO-CHAT-003-S12 | P1 | ✅ | Given a signed-in user; when they open their account in the side panel; then they see which account they are signed in to, then Credits with the credits left and Settings, each opening its page, and Sign out. |
| UC-NOTICO-CHAT-003-S13 | P1 | ✅ | Given a question the hosted model answered in several steps; when its reply ends; then the row under the reply shows what all of its model calls cost in credits, and the reopened chat shows it too. |
| UC-NOTICO-CHAT-003-S14 | P1 | ✅ | Given a reply on the hosted model that the user stopped, or that ended in an error, after a step; when it ends; then no cost is shown under it, though the credits shown still include what it was charged. |
| UC-NOTICO-CHAT-003-S15 | P1 | ✅ | Given a user who uses their own model; when its reply ends; then no cost in credits is shown under it. |
| UC-NOTICO-CHAT-003-S16 | P1 | ✅ | Given a signed-in user; when they open Settings from their account; then they see which model answers and the account they are signed in to, with Sign out, and nothing about credits. |

### ai-e2e

(none)
