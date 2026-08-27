---
workflow: product-launch-video
flow: both
length: 100s
aspect: 16:9
capture: none
---

# Flight Desk — hackathon demo

## Subject

Flight Desk: an AI agent that searches, compares and prepares real flight
bookings on **Atlas** (the travel platform by AtripTech), and settles them
through **FluxA**.

## Intent

Sell, not tour. One claim, proved: **the agent does the work, the human holds
the money.** Everything in the cut exists to make a judge believe that.

## Angle

Autonomous execution + human authorisation + controlled funds.

The differentiator is not natural-language flight search — everyone has that.
It is that the agent *cannot* spend. Not "is instructed not to": the tools to
place, pay or refund an order do not exist in its schema, so no prompt can
produce them. Money moves only when a human signs a FluxA mandate.

Second, quieter claim, and the strongest Atlas-specific one: Flight Desk reads
`supportPaymentMethods` per fare and supports **both** of Atlas's settlement
rails. On HKG→SIN that is the difference between booking 2 of 9 fares and 9 of
9. Most integrations hardcode one rail and fail silently on the rest.

## Naming — get this right

| Atlas (AtripTech) | FluxA |
| --- | --- |
| inventory, fares, orders, ticketing, refunds | the money |
| which payment rails a fare accepts | virtual cards, and the mandate the user signs |

Atlas never asks permission. **FluxA** is where the human authorises a spend.
Never narrate "Atlas budget mandate" — the approval screen is FluxA's.

## Honesty constraints — non-negotiable

- Atlas **sandbox**. Say so on screen once.
- On the deposit rail the deduction is **simulated**; the API returns
  `simulatedDeduction: true`. Never call it a completed charge.
- Do not imply FluxA holds the airline deposit. It does not; the desk's Atlas
  balance settles the ticket, and FluxA authorises.

## Structure (~100s)

| t | beat | source |
| --- | --- | --- |
| 0:00–0:08 | Cold open: the mandate approving, then the ticket number | capture |
| 0:08–0:16 | Title + one-line positioning | built |
| 0:16–0:40 | Mystery-box prompt: $200, two days, sunrise | capture |
| 0:40–0:55 | Agent compares and recommends, with reasons | capture |
| 0:55–1:06 | Self-fill + draft; nothing booked yet | capture |
| 1:06–1:26 | **The spine:** FluxA mandate, amount visible, user signs, agent resumes | capture |
| 1:26–1:34 | Architecture: who does what | built |
| 1:34–1:40 | Ticketed. "No money moved without approval." | capture + built |

## Destination

16:9, hackathon submission. Subtitles burned in. Voiceover normalised to
-16 LUFS (the previous cut ran at -29).
