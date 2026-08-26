---
name: flight-desk
description: Search, price, book, pay for and manage real flights through the Flight Desk HTTP API. Flights come from Atlas (AtripTech); payment is authorised and settled through FluxA. Use when an agent needs to find flights, hold a booking, settle it by virtual card or agency deposit, reuse saved traveller details, or follow an existing order.
---

# Flight Desk

Flight Desk books real flights on **Atlas** (the travel platform by AtripTech)
and settles them through **FluxA**. It exposes a small HTTP API you can drive
directly, plus a conversational endpoint that runs its own booking agent.

The split matters, because the two systems do different jobs:

| Atlas | FluxA |
|---|---|
| inventory, fares, orders, ticketing, refunds | the money |
| which payment rails a fare accepts | virtual cards, and the mandate the user signs |

Atlas never asks anyone for permission; FluxA is where a human authorises a
spend. Anything you tell a user about approval is FluxA's doing, not Atlas's.

This document is served by the service itself at `<base_url>/SKILL.md`, so the
host you fetched it from is the host you should call. In development that is
`http://localhost:3100`.

There is no authentication: it is a single-operator service. Do not expose it to
a network you do not control.

**It is wired to the Atlas sandbox.** Bookings are real bookings against real
inventory with real PNRs and ticket numbers, but no money changes hands.

## Hard rules

1. **Never place, pay for, or refund an order without the user's explicit
   go-ahead for that specific action.** These are irreversible. Approval to
   search is not approval to book; approval to book is not approval to pay.
2. **Never sign a FluxA mandate on the user's behalf, and never claim you can.**
   Only the human can sign. You hand them a URL and wait.
3. **Never invent a price, flight number, fare rule or availability count.**
   Call the endpoint that returns it.
4. **Passenger names must match the travel document exactly.** A mismatch means
   denied boarding, usually with no refund. Ask rather than guess or correct.

## The two halves of the API

Everything divides into operations that are free and reversible, and operations
that are not. Know which you are calling.

| Safe — call freely | Irreversible — needs explicit approval |
|---|---|
| search, verify, seats, baggage | `place` — creates a real airline booking |
| `draft` — prices a booking, books nothing | `pay` — settles it |
| reading orders and refund quotes | `refund` — submits a refund |

## Conversational endpoint

`POST /api/chat` runs Flight Desk's own agent for one turn and streams
Server-Sent Events.

```
POST /api/chat
{ "messages": [ { "role": "user", "content": "Hong Kong to Singapore on 15 Oct 2026" } ] }
```

Each SSE line is `data: {…}` with one of:

- `{"type":"text","delta":"…"}` — prose, streamed
- `{"type":"tool_start","tool":"search_flights"}`
- `{"type":"tool_result","tool":"search_flights","data":{…}}`
- `{"type":"tool_error","tool":"…","message":"…","code":"…"}`
- `{"type":"done","messages":[…]}` — the updated history; post it back next turn
- `{"type":"error","message":"…"}`

The server keeps no conversation state. You own the transcript: send the full
`messages` array each time and keep the array returned in `done`.

That agent can search, verify, price a draft, read the wallet and quote refunds.
It **cannot** place, pay or refund — those tools do not exist in its schema, so
no prompt can make it do them. Drive those yourself against `/api/orders`.

## Booking, step by step

### 1. Find a flight

Either ask via `/api/chat` and read the `search_flights` tool result, or let the
agent do it. Each offer looks like:

```json
{
  "flightId": "f7",
  "price": { "currency": "USD", "adult": 85.73 },
  "outbound": [ { "carrier": "TR", "flightNumber": "TR983",
                  "departure": { "airport": "HKG", "time": "2026-10-15T20:45:00Z" },
                  "arrival":   { "airport": "SIN", "time": "2026-10-16T00:45:00Z" } } ],
  "baggageIncluded": true,
  "refundable": true,
  "seatsLeft": 2,
  "cardPayable": true,
  "depositPayable": true
}
```

`flightId` is a short handle (`f7`), valid only for this server process. Pass it
back verbatim.

**`cardPayable` and `depositPayable` decide how the booking can be paid**, and
many fares accept both. Read them now, not later — see *Two payment rails*.

Times are the airline's local wall-clock at each airport. They carry a `Z`
suffix but are **not** UTC instants; render them as-is and do not convert.

### 2. Price it — books nothing

If the traveller is already saved (see *Saved travellers*), pass their id and
skip the details entirely:

```
POST /api/orders
{ "action": "draft", "flightId": "f7", "travellerIds": ["tv_29ab93dc"] }
```

Otherwise supply them in full:

```
POST /api/orders
{
  "action": "draft",
  "flightId": "f7",
  "passengers": [{
    "firstName": "Ada", "lastName": "Lovelace",
    "dateOfBirth": "1979-12-10", "type": "adult",
    "gender": "F", "nationality": "US",
    "passportNumber": "X1120045", "passportExpiry": "2031-06-30"
  }],
  "contact": { "email": "ada@example.com", "phone": "+6591234599" }
}
→ { "draft": { "draftId": "dr_…", "quote": { "total": 85.73, … }, "cardPayable": true },
    "priceChanged": false }
```

This re-verifies the live fare first, so `quote.total` is what the airline will
honour — it can differ from the search price. Show the user the total and
`priceChanged` before going further.

`phone` must be international format with a country code (`+6591234599`). A
local number is rejected here, deliberately, while the booking can still be
fixed. If the user gives a local number, ask which country it is from.

### 3. Place it — this books a real seat

Only after the user approves the priced draft.

```
POST /api/orders   { "action": "place", "draftId": "dr_…" }
→ { "order": { "orderId": "TESTA2026…", "pnr": "SJN21P",
                "status": "pending_payment", "totalPrice": 85.73,
                "expiresAt": "…", "cardPayable": true } }
```

The airline holds the seat for roughly 30 minutes. After `expiresAt` the hold
drops and the fare must be re-searched.

### 4. Pay it

Two rails. The order's `cardPayable` and `depositPayable` say which are open.

## Two payment rails

Atlas reports the rails a fare accepts, and they vary a lot. In a typical
HKG→SIN search, all nine offers took the deposit rail but only two took a card.
**Check both flags before promising the user anything.**

| flags | what to do |
|---|---|
| both `true` | let the user choose — they are not equivalent, see below |
| `cardPayable: false` | deposit rail only |
| `depositPayable: false` | card rail only |
| both `false` | not payable here; say so rather than offering a button |

When both are open the choice is the user's, because the two rails spend
different people's money: the card is theirs, the deposit is the operator's.
Do not pick silently. If you must default, default to the card.

### `cardPayable: true` — FluxA virtual card

The airline charges the user's prepaid card directly.

```
GET  /api/cards                    → { "cards": [ { "id": "card_…", "last4": "9608",
                                                    "balance": "5.00" } ] }
POST /api/orders  { "action": "pay", "orderId": "…", "cardId": "card_…" }
→ { "order": { "status": "ticketing" } }
```

### `depositPayable: true` — Atlas agency deposit

Settles from the operator's Atlas deposit, which every fare in testing accepted.
The user still authorises the amount with a FluxA mandate they sign themselves:

```
1.  POST /api/cards   { "action": "mandate-create", "amountUsd": 104.43 }
    → { "mandate": { "id": "mand_…", "approvalUrl": "https://agentwallet.fluxapay.xyz/…" },
        "signed": false }

2.  Give the user approvalUrl. They sign it. You cannot.

3.  GET /api/cards?mandateId=mand_…   → { "signed": true }   (poll every ~3s)

4.  POST /api/orders
    { "action": "pay", "orderId": "…", "method": "deposit", "mandateId": "mand_…" }
    → { "order": { "status": "ticketing" }, "simulatedDeduction": true }
```

**`simulatedDeduction: true` means no money left the user's wallet.** The
signature is real; the deduction is not. Say so plainly — never report this as
a completed charge. The ticket was settled from the operator's deposit, which is
the operator's money, not the traveller's.

The signature is re-checked server-side, so skipping step 3 returns `409`, not a
settlement.

### 5. Follow it

```
GET /api/orders                  → { "orders": [ … ] }   most recent first
GET /api/orders?orderId=TESTA…   → { "order": { … } }
```

`status` runs `pending_payment → ticketing → ticketed`. Ticket numbers appear a
minute or two *after* payment; `ticketing` is normal progress, not a failure.
Poll rather than reporting a problem.

## Refunds

```
POST /api/chat    ask the agent to quote a refund for the order
POST /api/orders  { "action": "refund", "orderId": "…", "refundOfferId": "…" }
```

Always show the user the penalty and whether the quote is exact
(`quoteType: "AccurateQuote"` vs `"CannotQuote"`) before they decide.

**Many airlines and routes have no refund service through Atlas at all.** You
will get `code: "refund_unsupported"` with a plain-language message. That is a
real answer, not a fault — report it as unavailable and do not retry.

## Saved travellers

Passport details are typed once, not every trip.

```
GET    /api/travellers        → { "travellers": [ { "id": "tv_29ab93dc",
                                                   "name": "Ada Lovelace",
                                                   "nationality": "US",
                                                   "hasPassport": true,
                                                   "email": "ada@example.com" } ] }
POST   /api/travellers        { "passenger": { … }, "contact": { … } }
DELETE /api/travellers?id=tv_…
```

**Document numbers never come back out.** The list gives you `hasPassport`, not
the number. Pass `travellerIds` to `draft` and the server expands the full
record on its way to the airline — so a passport stays out of your context, out
of the conversation transcript, and out of the browser.

That is the point: do not ask a user to retype, or to "confirm", a passport
number you are not allowed to see. Ask only for whoever is genuinely new.

The conversational agent has `list_travellers` for the same purpose, and passes
ids to `prepare_order` exactly this way.

## Wallet

```
GET  /api/cards        → cards (last4 and balance only) + cardholder
POST /api/cards        { "action": "cardholder-create", "firstName": …, "lastName": … }
                       { "action": "mandate-create", "amountUsd": 25 }
                       { "action": "card-create", "amountUsd": 25, "mandateId": "mand_…" }
```

Card numbers and CVVs never leave the server. You get `last4` and `balance`.

Issuing a card **spends real USDC** and needs a signed mandate, same three-step
handshake as above. `mandate-create` itself spends nothing — it only creates an
authorisation. Money moves at `card-create`.

## Things that will bite you

**Duplicate bookings.** Atlas rejects the same passenger on the same flight with
`code: "atlas_318"`. Use a genuinely different traveller for repeat tests, not a
suffix on the same name — it reads as a typo and gets corrected back.

**Orders live in server memory.** Restarting the server empties
`GET /api/orders`. The bookings still exist at the airline and are still
reachable by `orderId`; only the list is lost.

**Handles are per-process.** `flightId` (`f7`) and `draftId` (`dr_…`) do not
survive a restart. Re-search.

**A `pay` failure is usually the fare, not the card.** `card_not_accepted` means
this fare takes no card — switch to the deposit rail. A raw `pay_403` from Atlas
means the same thing, worded for integrators ("Switch to deposit mode or a
supported card type"). Trying a different card will not help; every card fails
on a fare that accepts none. An actual card decline is the rarer case.

**Sandbox does not check balances.** A $5 card will "successfully" pay a $200
fare. Do not present sandbox payments as proof that a card works.

## Error shape

Failures return `{ "error": "…" }` with a 4xx status. Business failures — as
opposed to plain validation ones like a missing field — also carry a `code`:

| code | meaning |
|---|---|
| `card_not_accepted` | this fare takes no card — use the deposit rail |
| `refund_unsupported` | no refund service for this airline/route |
| `atlas_318` | duplicate booking for this passenger and flight |
| `bad_phone` | contact phone is not international format |
| `draft_expired` / `session_expired` | re-search and rebuild |
| `deposit_not_accepted` | fare takes neither rail |
| `deposit_forbidden` | deposit settlement attempted against production |

Messages are written to be shown to a user as-is.
