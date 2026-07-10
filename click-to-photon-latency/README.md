# click-to-photon-latency

Measure the input latency a user actually feels when driving a Kernel browser
through [live view](https://docs.onkernel.com/browsers/live-view): the full
"click-to-photon" round trip from sending a click to seeing the result render
on your screen. The probe reports a p50/p90/p95 distribution over many clicks,
plus WebRTC stream stats (network RTT, jitter buffer, freezes) so you can
separate your network's contribution from the streaming pipeline's.

Because the round trip starts and ends on your machine, no clock
synchronization with the remote browser is needed.

## How it works

1. Creates a headful Kernel browser session in kiosk mode (no address bar or
   tabs, so the page fills the captured screen) and navigates it (over CDP) to
   a **sentinel page**: a full-viewport div that flips between black and white
   on every `pointerdown`. Detecting "the video updated" then reduces to a
   simple luminance threshold, robust to codec noise.
2. Launches a local browser and connects a **minimal live-view WebRTC client**
   (signaling websocket + input data channel, compatible with the neko-based
   live view) directly to the session, attaching the video track to a
   same-origin `<video>` element so its pixels are readable.
3. For each trial, sends a real mouse click over the data channel and watches
   decoded frames via `requestVideoFrameCallback` until the sentinel patch
   crosses the luminance midpoint. `t1 − t0` covers the entire loop: input
   encode → data channel → TURN relay → input inject → remote paint → capture →
   video encode → TURN relay → decode → present.

## Setup

```bash
npm install
export KERNEL_API_KEY=your_api_key
```

The probe prefers an installed Google Chrome (most complete H.264 WebRTC
decode). If Chrome isn't installed, it falls back to Playwright's bundled
Chromium — run `npx playwright install chromium` once in that case.

## Usage

```bash
npm start                                  # 100 measured clicks
npx tsx index.ts --clicks 200 --json out.json
```

| Flag | Default | Description |
|------|---------|-------------|
| `--clicks <n>` | 100 | Measured clicks per run |
| `--warmup <n>` | 5 | Leading clicks discarded from stats |
| `--click-timeout <ms>` | 5000 | Per-click detection timeout before counting a drop |
| `--settle <ms>` | 200 | Delay between trials |
| `--json <path>` | — | Also write full results (per-click samples included) as JSON |
| `--keep` | off | Don't delete the Kernel session when done |
| `--headless` | off | Run the local probe browser headless (rendering may throttle; headed is more representative) |

## Example output

```
Click-to-photon latency — 100 measured clicks (0 dropped, 5 warmup discarded)
  p50   183 ms
  p90   224 ms
  p95   241 ms
  mean  187 ms   min 130 ms   max 288 ms
Stream: remote 1920x1080@25 (40 ms frame floor), decoded 1920x1080 video/H264 @ ~25 fps
WebRTC: rtt 23 ms, jitter buffer ~45 ms, path relay/udp -> relay, freezes 0 (0 ms)
Connection: signaling open 412 ms, first frame 2103 ms after probe start
```

## Notes

- **Frame quantization:** a change is only observable on a frame boundary, so
  per-click resolution is about one frame period (~40 ms at 25 fps). Read the
  distribution over many clicks, not single samples.
- Results include *your* network path to the Kernel metro and TURN relay — run
  from where your users are to measure what they feel.
- Keep the probe window visible; browsers throttle rendering of occluded
  windows, which inflates measurements.
- The open live view connection counts as session activity (it keeps the
  session alive and is billed like any live view connection).
