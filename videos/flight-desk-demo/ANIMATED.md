# The animated scenes

Six scenes are now built UI rather than screen capture. The three explainer
scenes (title, architecture, rails) were always built. So the film contains no
footage at all.

## Why

The recording could not carry the story. Its labels were 10px in a 1920 frame,
a third of every frame was desktop wallpaper, one pane was empty in most shots,
and the pace was the app's pace — twenty real seconds of waiting for a search.

## What makes it honest

- **Real values.** Fares, flight numbers, times and the payment-rail flags come
  from live Atlas sandbox calls (`HKG→TPE`, 15–17 Oct 2026): UO116 at 127.44,
  UO112 at 137.61, UO114 at 144.36.
- **Real design.** Colours, type and card structure are the app's own tokens
  from `web/app/globals.css`, scaled ~1.5x so a label that is fine in a browser
  is readable in a video.
- **Real behaviour.** Every step shown is one the software actually does and
  that was exercised against the sandbox during development.

## What it is not

It is a reconstruction, not a screen recording. If a judge asks "is this the
real product", the honest answer is: the product is real and does all of this;
this film is a rendered depiction of it, made because the raw capture was
unreadable.

Keep `demo/flight-desk-demo-v6.mp4` — the capture-based cut — as the answer to
that question. A short real-capture insert would settle it entirely; the
FluxA approval round trip is the shot worth having.

## Contrast note

The app's `--text-faint` (#78736a) measures 3.88:1 on the dark ground — fine in
a browser, below WCAG AA at video scale. The film lifts it to #9c968c (6.23:1).
The app itself is unchanged.
