# YouTube listing

## Title

From Schedule to Boarding Pass: The Agentic Travel Agency | FluxA x Atlas

(73 chars. YouTube's hard limit is 100 and search shows about 60, so the
hackathon name is carried in the description instead of the title, where it
would have been invisible.)

## Description

Can an AI agent plan a trip and pay for it, without asking you to approve every
step?

Flight Desk is an autonomous flight-booking agent built on Atlas. You give it a
schedule and a budget instead of a route. It chooses where to go, searches live
Atlas inventory, compares real fares, prepares the booking, and pays from your
FluxA wallet once you have approved the amount.

In this 2-minute demo:

1. One prompt: two days free, $200, somewhere to watch the sunrise, out of Hong Kong
2. The agent picks the destinations itself and searches live Atlas fares for each
3. It treats the budget as a ceiling and says what it ruled out, and by how much
4. Saved traveller details fill the booking, and the passport number never enters
   the agent's context
5. FluxA raises a mandate for the exact amount of that booking
6. You approve it, the agent resumes on its own, and the ticket is issued

Why the payment layer is the hard part:

Atlas exposes two settlement rails, and which one a fare accepts varies by
airline. Flight Desk reads that per fare and supports both, so it can book
inventory a single-rail integration would silently fail on. On one Hong Kong to
Singapore search, only two of nine fares accepted a card. All nine were payable.

The agent prepares everything. It does not decide to spend. A FluxA mandate is
raised for the exact amount and the exact booking, and value moves only after a
human signs it.

Built for the Alibaba Cloud x Atlas x Qoder Agentic AI Hackathon 2026,
Singapore. Tracks: Flights & Aviation, Payments & Fintech.

Running against the Atlas sandbox: real routes, real fares, real PNRs and real
ticket numbers.

→ FluxA: https://fluxapay.xyz
→ Give your agent a co-wallet: https://fluxapay.xyz/skill.md
→ Atlas: https://www.atriptech.com

#AIAgents #AgenticAI #AgenticPayments #TravelTech #Atlas #FluxA #Fluxapay
#AlibabaCloud #AIpayments #FlightBooking
