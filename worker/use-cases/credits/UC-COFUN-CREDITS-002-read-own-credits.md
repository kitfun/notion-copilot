# UC-COFUN-CREDITS-002: Read one's own credits and history

## Behavior

A signed-in user's product reads, for them, their credits (UC-COFUN-CREDITS-001), their usage per day over the last 30 days, and the history of the credits they were given (with what each purchase cost), to show them. Older usage is not read: no product shows it. What each product shows, and how, is in its own use cases (Notico's UC-NOTICO-CHAT-003).

Key constraint:

- A user reads only their own credits, usage, and history.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-COFUN-CREDITS-002-S01 | P0 | ✅ | Given two users; when one looks at their credits, usage, or history; then they see only their own. |

### ai-e2e

(none)
