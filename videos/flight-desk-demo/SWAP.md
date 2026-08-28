# Swapping in the real footage

Six of the nine scenes are cut from `assets/placeholder-run.mp4` — the old
recording. Three are built and need no footage.

| scene | source | needs reshoot |
| --- | --- | --- |
| 01 cold-open | footage @134s | yes — CAPTURE.md shot 1 |
| 02 title | built | no |
| 03 prompt | footage @48s | yes — shot 3 |
| 04 compare | footage @72s | yes — shot 3 tail |
| 05 draft | footage @100s | yes — shots 4–5 |
| 06 mandate | footage @128s | yes — **shot 7, the one that matters** |
| 07 architecture | built | no |
| 08 rails | built | no |
| 09 close | footage @168s | yes — shot 8 |

## The swap

1. Drop the new recording at `assets/run.mp4`.
2. In each scene file under `compositions/frames/`, change the `<video>`:
   - `src="assets/placeholder-run.mp4"` → `src="assets/run.mp4"`
   - `data-media-start="<old>"` → the second in the new recording where that
     beat begins.
3. `npm run check`, then `npm run render`.

Scene lengths (`data-duration` on the host in `index.html`) are the intended
edit and should not move — they were chosen for the overlay pacing. If a new
take runs longer than its slot, the slot trims it; if shorter, the last frame
holds. Adjust `data-media-start` first and only change a duration if the beat
genuinely needs more room.

## Why the placeholder is not shippable

It predates the current build. On screen it shows 10px labels, the 420px split
with one pane empty, no outcome panel, no rail picker, and — worst — a FluxA
mandate reading *"Fund a virtual card…"* when the booking being paid for is a
flight. That last one is the frame the whole video rests on, and it now reads
`Pay <amount> USDC for flight booking <PNR>`.

## Audio

Narrated with Kokoro (local, offline) in voice `bm_george`. Nine clips, one per
scene, in `assets/vo/`, each normalised to -16 LUFS; the finished mix measures
-13.2 LUFS integrated against the old recording's -29.1.

The narration lives on tracks 30–38, one per scene, keyed to the scene it
belongs to. To re-record a line: edit `assets/vo/NN.txt`, then

```bash
export HYPERFRAMES_PYTHON=<repo>/.venv-tts/bin/python
npx hyperframes tts "assets/vo/NN.txt" -o "assets/vo/NN.wav" --voice bm_george
ffmpeg -y -i assets/vo/NN.wav -af loudnorm=I=-16:TP=-1.5:LRA=11 -ar 48000 tmp.wav && mv tmp.wav assets/vo/NN.wav
```

Keep each clip inside its slot — scene 02 and scene 07 were widened by 1s and
2s because the take ran long. If a rewrite overruns, widen the slot in
`index.html` rather than rushing the read.

Prefer your own voice? Record from `demo/SCRIPT.md` at about -16 LUFS and
replace the wavs; the timings stay put.
