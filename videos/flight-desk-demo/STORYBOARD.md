---
format: 1920x1080
duration: 100s
message: The agent does the work; the human holds the money.
arc: Proof → Positioning → Task → Judgement → Gate → Architecture → Result
audience: Atlas hackathon judges
mode: autonomous
music: none
---

## Frame 1 — Cold open: the gate, then the ticket

- status: outline
- src: compositions/frames/01-cold-open.html
- duration: 8s
- transition_in: cut
- scene: FluxA approving 107.06 USDC, then a ticket number
- asset_candidates: capture/assets/placeholder-run.mp4 (PLACEHOLDER — reshoot per demo/CAPTURE.md, shot 1)
- footage: PLACEHOLDER

Two moments, no context, no logo. The FluxA mandate reading its amount and
purpose, then the order card reading Ticketed with a ticket number. The claim
lands before the product is named.

Overlay, sequential: `A human approved 107.06 USDC` → `Then a real ticket`.

## Frame 2 — Title

- status: outline
- src: compositions/frames/02-title.html
- duration: 7s
- transition_in: cut
- scene: Flight Desk wordmark and one-line positioning
- footage: BUILT

Wordmark, then the line: *An AI agent that books real flights — and cannot
spend your money.* A hairline `ATLAS SANDBOX · REAL FARES · REAL PNRs` sits
beneath, so the honesty note is made once and never repeated.

## Frame 3 — One constraint, no destination

- status: outline
- src: compositions/frames/03-prompt.html
- duration: 22s
- transition_in: crossfade
- scene: the sunrise mystery box, and three destinations chosen from it
- asset_candidates: capture/assets/placeholder-run.mp4 (PLACEHOLDER — shot 3)
- footage: PLACEHOLDER

The prompt is the hook: *$200, two days, somewhere to watch the sunrise, out of
Hong Kong.* No route given. The agent picks Taipei, Da Nang, Chiang Mai and
searches live Atlas inventory for each.

Overlay: `Searches multiple destinations from one constraint`.

## Frame 4 — It judges, it does not list

- status: outline
- src: compositions/frames/04-compare.html
- duration: 15s
- transition_in: cut
- scene: budget held as a ceiling; two fares compared on time, not price
- asset_candidates: capture/assets/placeholder-run.mp4 (PLACEHOLDER — shot 3 tail)
- footage: PLACEHOLDER

Pull-quote the agent's own words over the footage — *"$7 more for six fewer
hours"* — because that sentence is the product. Second overlay names what it
ruled out and by how much.

## Frame 5 — Fills the form, stops at the gate

- status: outline
- src: compositions/frames/05-draft.html
- duration: 11s
- transition_in: cut
- scene: saved traveller self-fill, then the draft that books nothing
- asset_candidates: capture/assets/placeholder-run.mp4 (PLACEHOLDER — shots 4–5)
- footage: PLACEHOLDER

Details fill themselves. Overlay: `Passport never enters the agent's context`.
Then it stops on *The agent cannot place this booking or move money.*

## Frame 6 — The spine

- status: outline
- src: compositions/frames/06-mandate.html
- duration: 20s
- transition_in: crossfade
- scene: FluxA mandate — amount, purpose, signature, agent resumes alone
- asset_candidates: capture/assets/placeholder-run.mp4 (PLACEHOLDER — shot 7, the reshoot that matters most)
- footage: PLACEHOLDER

The longest frame and the only one that must not be cut short. Amount legible,
purpose legible, the signature, then the return — and the agent advancing with
nobody touching it.

Overlay at the signature: `FluxA mandate — the agent cannot pass this`.
Overlay on return: `Deduction simulated in sandbox`.

## Frame 7 — Who does what

- status: outline
- src: compositions/frames/07-architecture.html
- duration: 9s
- transition_in: crossfade
- scene: Atlas / FluxA split, and the absent tools
- footage: BUILT

Two columns. Atlas: inventory, fares, ticketing, and which rails a fare takes.
FluxA: the money, and the mandate a human signs.

Then the line the whole submission rests on, struck through to show it is not a
setting: `place · pay · refund` — **not disabled. absent.**

## Frame 8 — Both rails

- status: outline
- src: compositions/frames/08-rails.html
- duration: 8s
- transition_in: cut
- scene: 2 of 9 fares take a card; 9 of 9 take the deposit
- footage: BUILT

The Atlas-specific claim, as a count-up: most integrations hardcode one rail.
Reading `supportPaymentMethods` per fare is the difference between booking two
of nine and nine of nine.

## Frame 9 — Ticketed

- status: outline
- src: compositions/frames/09-close.html
- duration: 8s
- transition_in: crossfade
- scene: the ticket, then the closing claim
- asset_candidates: capture/assets/placeholder-run.mp4 (PLACEHOLDER — shot 8)
- footage: PLACEHOLDER + BUILT

Hold on the ticketed booking, then resolve to the single line:
**No money moved without approval.**

## Video direction

Dark throughout — the film never leaves the application's own ground
(`#16150f`), so built frames and screen recordings cut together without a
luminance jump. Mint (`#6fc3a4`) is scarce: it marks only the two moments that
matter, the gate and the ticket.

Motion is slow and declarative. No idle drift. Overlays arrive on a cut, hold
still while they are read, and leave on the cut — nothing breathes.

Every PLACEHOLDER frame is cut from an older recording and is to be replaced
from `demo/CAPTURE.md`. Their durations are the intended edit, so replacing the
source does not disturb the structure.
