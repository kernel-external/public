# Live view vs. CDP screencast, side by side

> **Because You Asked About the Line Between Headful and Headless**
>
> Live views were loading in a silent window<br>
> That while you watched Page.navigate dot-coms<br>
> Rend'ring a gradient invisible<br>
> From chrome and cursor to captchas, divs, and DOMs.
>
> There came a moment that your patience flagged.<br>
> And then one clearly clicked instead of lagged.

*After Howard Nemerov's "Because You Asked about the Line Between Prose and Poetry."*

The two panes really are hard to tell apart, and the reason is that a headless browser
runs the whole pipeline — DOM, layout, paint — and skips only the last step, where pixels
reach a screen. It even reports an `outerHeight` of 570 against an `innerHeight` of 513,
budgeting 57px of window chrome and 30px of desktop panel that exist nowhere. It doesn't
just render the page unseen; it renders the room it isn't in. That quirk is the whole
reason [matching the two viewports](#matching-the-two-viewports) takes any work at all.

---

Renders two Kernel browsers next to each other in one page so you can compare the two
ways of watching a browser:

| | Pane A | Pane B |
|---|---|---|
| Transport | `browser_live_view_url` in an `<iframe>` | CDP `Page.startScreencast` onto a `<canvas>` |
| Browser | headful | headless (default) or headful |
| Shows | whole desktop, including browser chrome | page viewport only |
| Interactive | yes, built in | yes — this sample forwards mouse/keyboard over CDP `Input.*` |

## Run

```sh
npm install
export KERNEL_API_KEY=...
npm start
```

Opens `http://localhost:3111`. Ctrl-C deletes both browsers.

Options:

```sh
node index.mjs --url=https://news.ycombinator.com   # starting page for both browsers
node index.mjs --screencast-headful                 # screencast a headful browser instead
node index.mjs --viewport=1024x768                  # shared display size (see table below)
node index.mjs --no-match-viewport                  # leave the default viewports alone
node index.mjs --port=3111 --timeout=900
```

## No relay server for the video

`cdp_ws_url` carries its own JWT in the query string, so it needs no `Authorization`
header and the page can open the WebSocket itself:

```js
const ws = new WebSocket(cdpWsUrl);
const { targetInfos } = await send('Target.getTargets');
const page = targetInfos.find(t => t.type === 'page');
const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 }, sessionId);
```

Frames arrive as base64 JPEG on `Page.screencastFrame` and get drawn to a canvas. Every
frame must be acked with `Page.screencastFrameAck` — Chrome keeps only one frame in
flight, so if you stop acking, the stream stops.

The local Node process only serves the static page and drives navigation on both
browsers. No video passes through it. Note the flip side: putting `cdp_ws_url` in the
page hands the client full CDP control of that browser, so in a real app you would proxy
the socket rather than shipping the JWT to the frontend.

## Input forwarding

Pane B is interactive because DOM events on the canvas are translated into CDP:

- `mousemove` / `mousedown` / `mouseup` / `wheel` → `Input.dispatchMouseEvent`
- `keydown` / `keyup` → `Input.dispatchKeyEvent`

Things worth knowing, all verified against a live browser:

- **Coordinates are page CSS pixels.** The canvas is laid out with `object-fit: contain`,
  so the drawn image is letterboxed inside the element. Undo the letterboxing and scale
  into `metadata.deviceWidth`/`deviceHeight` from the last screencast frame.
- **Wheel sign matches the DOM.** CDP `deltaY: +300` scrolls down, same as a DOM wheel
  event, so pass `e.deltaY` straight through. (Negating it inverts scrolling.)
- **Printable keys need `text`.** Send `keyDown` with `text` set for printable keys and
  `rawKeyDown` without it for the rest; otherwise Chrome registers the keypress but
  inserts no character.
- **Don't await input dispatches.** Awaiting the CDP reply adds a round trip of latency
  to every `mousemove`. Fire and forget, and coalesce moves to one per animation frame.
- The canvas needs `tabindex="0"` and a click to take keyboard focus.

## Matching the two viewports

Left alone, the panes render at different sizes. Measured on a real pair of browsers:

| | headful (live view) | headless (screencast) |
|---|---|---|
| `screen` | 1920×1080 | 800×600 |
| `screen.avail` | 1920×1050 | 800×570 |
| `outerWidth/Height` | 1920×1050 | 800×570 |
| `innerWidth/Height` | **1920×993** | **800×513** |

The geometry chain is identical — both lose 30px to the desktop panel and 57px to
browser chrome. The only difference is the virtual screen. A headful browser gets
Kernel's default 1920×1080 display ([viewport docs](https://www.kernel.sh/docs/browsers/viewport));
a headless browser has no Kernel display, so Chromium falls back to its built-in 800×600
default window.

**Kernel's `viewport` param is the fix, and it works on headless browsers too** — it
sizes the real window there, and a headless browser has no panel or chrome to subtract,
so the requested size lands exactly:

| Created with | Resulting `innerWidth/Height` |
|---|---|
| headful, `viewport: 1024x768` | 1024×681 (768 − 30 panel − 57 chrome) |
| headless, `viewport: 1024x681` | 1024×681 |
| headless, `viewport: 1920x993` | 1920×993 |

So this sample creates the headful browser first, measures its real page viewport, then
creates the headless browser with `viewport` set to exactly that. Both panes end up
identical with real windows on both sides. `--viewport=WxH` sets the shared display size
(pick from Kernel's supported resolutions); `--no-match-viewport` leaves the defaults
alone.

### Two things that do *not* work

`Browser.setWindowBounds` is clamped to the headless browser's 800×600 virtual screen —
asking for 1920×1050 yields 780×493.

`Emulation.setDeviceMetricsOverride` does resize the page viewport to any size, but it
is **not a neutral way to equalize the panes**. It resizes only the renderer viewport
while the compositor surface stays 800×600, and it measures *faster* than a genuine
window of the same size:

| headless at 1920×993 | fps | Bitrate |
|---|---|---|
| real window (`viewport: 1920x993`) | 16.3 | 3.4 Mbps |
| 800×600 window + emulation override | 20.9 | 4.4 Mbps |

Using the override would have made the screencast pane look ~28% smoother than a real
browser of that size actually is. Hence the `viewport` param instead.

## Reading the comparison

Both pages get a magenta sweep bar and a millisecond clock injected via
`Page.addScriptToEvaluateOnNewDocument`. Watching the two panes side by side shows the
end-to-end lag of each transport. Pane B also reports live fps, bitrate, and frame size;
live view is an opaque stream, so there is no equivalent instrumentation for pane A.

### Measured throughput

Controlled runs, all on `about:blank` with the same full-viewport gradient animation so
every case has identical paint load, JPEG quality 80, real windows (no emulation):

| Browser | Page viewport | fps | Bitrate |
|---|---|---|---|
| headless (default window) | 800×513 | 22.9 | 1.4 Mbps |
| headless | 1024×681 | 20.5 | 1.8 Mbps |
| headful | 1024×681 | 17.4 | 1.5 Mbps |
| headless | 1920×993 | 16.3 | 3.4 Mbps |
| headful (default display) | 1920×993 | 12.1 | 2.6 Mbps |

Frame rate falls off with viewport area, and headful costs a few fps against headless at
the same size. On a real content-heavy page the JPEGs get much larger — Hacker News at
1920×993 with the overlay running measured ~4.8 fps at 8.3 Mbps.

Screencast is not a fixed-fps transport: it delivers frames as fast as it can encode and
you can ack. Drop `quality`, set `maxWidth`/`maxHeight`, or raise `everyNthFrame` to
trade resolution for smoothness. Run-to-run variance is significant, so treat these as
rough magnitudes rather than precise figures.
