# Capture list — record these, in this order

Server: `cd web && npm run dev -- -p 3100` → http://localhost:3100

## Set up before you hit record

1. **Window.** Make the browser window 16:9 and fill it. Zoom the page to
   ~125% (⌘+ twice). The type is already 15% larger than your last take; the
   zoom is for the recording, not the product.
2. **Hide the desktop.** A third of the last cut was macOS wallpaper. Full
   screen, or crop to the window in post.
3. **Clean slate.** `rm web/.data/travellers.json` then re-add Ada in shot 4 —
   the save is part of the story. Restart the server to clear old orders, so
   Trips starts empty.
4. **Wallet.** Have `••9608 $5.00` selected. The empty `$0.00` card makes the
   picker look broken.
5. **Audio.** Record voiceover separately if you can. Your last take was
   -29 LUFS; I normalise to -16, but I cannot recover what was not captured.

## Shots

### 1 — Cold open (record LAST, from the end of shot 7)
Two moments, ~4s total. The FluxA screen showing **`Pay 107.06 USDC for flight
booking <PNR>`**, then the order card reading **Ticketed** with a ticket number.
This is the whole pitch; it opens the film.

### 2 — Empty state, 3s
Just the home screen. Do not linger — the last cut spent 40 seconds here.

### 3 — The mystery box, ~20s
Click **"Sunrise · 2 days · $200"**. Let it run. What must be legible:
- three destinations searched, with the agent's reasons
- the budget being enforced — it names what is over and by how much
- `no card payment` tags on the AirAsia fares

### 4 — Passenger details, ~10s
Click **fill in details myself** on the recommended fare. Type one traveller.
Leave **"Remember this traveller"** ticked — hold on it for a beat.
Then **Continue**.

### 5 — Draft, ~6s
The approval card. Hold on **"The agent cannot place this booking or move
money."** Then **Approve and book**.

### 6 — Order created, ~5s
`pending_payment`, PNR visible. If the fare takes both rails you will get the
**FluxA card / FluxA Deposit** picker — hold 2s on it; it is a good shot.

### 7 — THE SPINE, ~20s. Do not rush this one.
Choose **FluxA Deposit**. Then:
1. the four-step tracker appearing
2. click **Approve … in FluxA** — new tab
3. **wait for the FluxA screen to finish loading.** Your last take caught it as
   grey skeleton bars. The amount and purpose must be readable.
4. sign it
5. **Budget approved** → *Go back to agent to continue the task*
6. back to Flight Desk: the tracker advances on its own, no clicking
7. hold on **Ticketed** and the ticket number

### 8 — Trips tab, ~4s
One booking, ticketed, ticket number. Then stop recording.

## Do not

- Book the same passenger twice — Atlas rejects duplicates (`atlas_318`) and
  you will record an error.
- Cut away during the FluxA round trip. The return to a *self-advancing* agent
  is the proof; a cut there looks like an edit hiding something.
- End on a search screen. Your last cut did, mid-second-scenario.

## Then

Drop the file in `demo/footage/` and tell me. Timestamps optional — I can find
the beats.

---

## Status (autonomous pass, 28 Aug)

A cut exists: `demo/flight-desk-demo-v1.mp4` — 1m48s, 1920x1080, silent.

Three scenes are finished and need nothing: **title**, **architecture**
(Atlas / FluxA, and `place · pay · refund` struck through — *not disabled,
absent*), and **both rails** (2 of 9 vs 9 of 9).

Six scenes are cut from the old recording as placeholder. Swap instructions in
`videos/flight-desk-demo/SWAP.md`. Shot 7 — the FluxA mandate — is the one that
most needs reshooting: the placeholder shows the old "Fund a virtual card…"
wording, and the current build reads `Pay <amount> USDC for flight booking <PNR>`.

It is silent because HeyGen is not signed in and the local voice engine needs a
multi-GB install. Record the VO from `SCRIPT.md` at about -16 LUFS.
