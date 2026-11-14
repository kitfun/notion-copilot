# UC-NOTICO-BILLING-001: Buy credits

## Behavior

A user who wants more than the free credits of each week buys a pack of credits, once: nothing renews, and there is no subscription. Credits pay only for questions the hosted model answers; a question answered by the user's own model spends none (UC-NOTICO-AGENT-002). From the Credits page in the side panel they pick one of the packs on offer, priced in US dollars at a thousand credits a dollar, and pay on the payment provider's own page, which opens in a new tab. Once the payment goes through, the pack's credits are added to their account; the side panel shows them when the user comes back to it, without signing in again. The Credits page tells them that bought credits last one year from the purchase, that nothing renews, and that questions answered with their own key spend none; their credits and history show what they bought, what they paid for it, and what a refund took back; and a question refused for lack of credits offers to buy more.

What a payment adds, when, how bought credits are spent, and what a refund or dispute takes back are the service's rules, the same in every product: UC-COFUN-BILLING-001.

Key constraint:

- Payment details are entered on the payment provider's page only, and never reach the side panel or the service.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-BILLING-001-S01 | P0 | ✅ | Given a signed-in user on the Credits page; when they choose a pack; then the payment page for that pack opens in a new tab, for their account. |
| UC-NOTICO-BILLING-001-S10 | P1 | ✅ | Given a user who paid in the tab the side panel opened; when they come back to the side panel; then it shows their new credits. |
| UC-NOTICO-BILLING-001-S11 | P1 | ✅ | Given a user who bought credits; when they look at their credits and their history; then the purchase shows as such, with what they paid and the day it expires, and a refunded purchase shows what was taken back. |
| UC-NOTICO-BILLING-001-S12 | P1 | ✅ | Given a user with no credits left; when a question of theirs is refused; then the refusal offers to buy credits beside saying when the free ones return. |
| UC-NOTICO-BILLING-001-S15 | P1 | ✅ | Given a signed-in user on the Credits page; when they look at the packs on offer; then they are told that bought credits last one year from the purchase, that nothing renews, and that questions answered with their own key spend no credits. |

### ai-e2e

(none)
