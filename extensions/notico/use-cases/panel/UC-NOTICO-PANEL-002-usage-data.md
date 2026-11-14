# UC-NOTICO-PANEL-002: Share usage data, or not

## Behavior

Notico tells its makers how it is used, so they can see what works: that the panel was opened, that a question was asked and how it ended, which tools ran and whether they worked, and which of the panel's actions were used. It says that something happened, never what was written or read. Usage is counted per device before anyone signs in, and under the account after. The user can turn this off in the settings; it is on until they do.

Key constraints:

- Usage data never holds what the user asked, what the AI answered, anything from a page (its content, title, or address), or a key.
- While usage data is turned off, nothing is sent.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-PANEL-002-S01 | P0 | ✅ | Given a signed-in user on a Notion page; when they ask a question the AI answers by reading the page; then the usage data sent says only that the question was asked and ended, which tool ran, and how each went, and holds none of the question, the answer, or the page. |
| UC-NOTICO-PANEL-002-S02 | P0 | ✅ | Given a user who turned usage data off in the settings; when they go on using the panel, and open it again later; then nothing more is sent. |

### ai-e2e

(none)
