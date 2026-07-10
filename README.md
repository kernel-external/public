# Kernel public samples

Public, ready-to-run sample code built on Kernel's API, SDK, and CLI. Each
directory is a self-contained example you can clone, install, and run against
your own Kernel account.

Get an API key from the [Kernel dashboard](https://dashboard.onkernel.com) and
see the [docs](https://docs.onkernel.com) for the full API reference.

## Samples

| Sample | Description |
|--------|-------------|
| [session-usage-export](session-usage-export) | Export your past browser sessions to CSV with an estimated usage cost per session. Useful for reconciling a bill or breaking usage down by time period. |
| [session-replay-telemetry-srt](session-replay-telemetry-srt) | Generate `.srt` subtitle files for every replay under a browser session by correlating replay timestamps with captured browser telemetry events. |
| [block-domains-extension](block-domains-extension) | Minimal Manifest V3 Chrome extension that blocks all network requests (XHR/fetch, scripts, frames, etc.) to a configurable set of domains via `declarativeNetRequest`. |
| [click-to-photon-latency](click-to-photon-latency) | Measure the end-to-end input latency a user feels in live view with a standalone WebRTC probe: real clicks over the input data channel, pixel-change detection on the video, p50/p95 over many clicks. |
