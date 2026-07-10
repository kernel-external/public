/**
 * Click-to-photon latency probe for Kernel live view.
 *
 * Measures the full input-to-render round trip a user feels when driving a
 * Kernel browser through live view: local click -> data channel -> TURN ->
 * X input inject -> Chrome paint -> capture -> encode -> TURN -> local
 * decode -> present. No clock sync is needed: the loop starts and ends on
 * this machine.
 *
 * How it works:
 *  1. Creates a headful Kernel browser session and navigates it (over CDP)
 *     to a sentinel page whose background flips black/white on pointerdown.
 *  2. Launches a local browser and connects a minimal neko-compatible WebRTC
 *     client to the session's live view (signaling websocket + data channel),
 *     attaching the video track to a same-origin <video> so pixels are
 *     readable.
 *  3. For each trial: sends a real mouse click over the data channel, then
 *     watches decoded frames via requestVideoFrameCallback until the sentinel
 *     patch luminance crosses the midpoint. t1 - t0 is that click's
 *     click-to-photon latency.
 *
 * Detection is quantized to the remote frame interval (~40 ms at 25 fps), so
 * single trials are noisy by design — read the p50/p95 over many clicks.
 */
import { writeFileSync } from "node:fs";
import Kernel from "@onkernel/sdk";
import { chromium, type Browser } from "playwright";

interface CliArgs {
  clicks: number;
  warmup: number;
  clickTimeoutMs: number;
  settleMs: number;
  jsonPath?: string;
  keep: boolean;
  headless: boolean;
}

const USAGE = `Usage: npx tsx index.ts [options]

Options:
  --clicks <n>          Measured clicks per run (default 100)
  --warmup <n>          Extra leading clicks discarded from stats (default 5)
  --click-timeout <ms>  Per-click detection timeout before counting a drop (default 5000)
  --settle <ms>         Delay between trials (default 200)
  --json <path>         Also write full results as JSON
  --keep                Don't delete the Kernel session when done
  --headless            Run the local probe browser headless (rendering may throttle)
  --help                Show this help`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    clicks: 100,
    warmup: 5,
    clickTimeoutMs: 5000,
    settleMs: 200,
    keep: false,
    headless: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${argv[i - 1]}`);
      return v;
    };
    switch (argv[i]) {
      case "--clicks":
        args.clicks = Number(next());
        break;
      case "--warmup":
        args.warmup = Number(next());
        break;
      case "--click-timeout":
        args.clickTimeoutMs = Number(next());
        break;
      case "--settle":
        args.settleMs = Number(next());
        break;
      case "--json":
        args.jsonPath = next();
        break;
      case "--keep":
        args.keep = true;
        break;
      case "--headless":
        args.headless = true;
        break;
      case "--help":
        console.log(USAGE);
        process.exit(0);
      default:
        console.error(`Unknown option: ${argv[i]}\n\n${USAGE}`);
        process.exit(1);
    }
  }
  if (![args.clicks, args.warmup, args.clickTimeoutMs, args.settleMs].every((n) => Number.isFinite(n) && n >= 0)) {
    throw new Error("numeric options must be non-negative numbers");
  }
  if (args.clicks < 1) throw new Error("--clicks must be at least 1");
  return args;
}

// Full-viewport page loaded in the remote browser; flips between pure black
// and pure white on every pointerdown so "the video updated" reduces to a
// luminance threshold instead of fragile arbitrary-frame diffing.
const SENTINEL_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>c2p sentinel</title><style>
html,body{margin:0;height:100%;overflow:hidden}
#t{position:fixed;inset:0;background:#000;cursor:none;user-select:none}
</style></head><body><div id="t"></div><script>
let on = false;
const el = document.getElementById('t');
addEventListener('pointerdown', (e) => { e.preventDefault(); on = !on; el.style.background = on ? '#fff' : '#000'; });
addEventListener('contextmenu', (e) => e.preventDefault());
</script></body></html>`;

interface ProbeConfig {
  wsUrl: string;
  clicks: number;
  warmup: number;
  clickTimeoutMs: number;
  settleMs: number;
  connectTimeoutMs: number;
}

interface ProbeRaw {
  measuredMs: number[];
  warmupMs: number[];
  drops: number;
  trials: number;
  remote: { width: number; height: number; rate: number };
  videoSize: string;
  wsOpenMs: number | null;
  firstFrameMs: number | null;
  framesSeen: number;
  probeDurationMs: number;
  rtc: Record<string, unknown>;
}

// Runs inside the local browser via page.evaluate — must be self-contained.
async function probeInPage(cfg: ProbeConfig): Promise<ProbeRaw> {
  const log = (m: string) => (window as any).probeLog?.(String(m));
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  const OPCODE = { MOVE: 0x01, KEY_DOWN: 0x03, KEY_UP: 0x04 };
  const BTN_LEFT = 1; // X11 button numbering
  const tStart = performance.now();

  // --- video sink + patch sampler --------------------------------------
  const video = document.createElement("video");
  video.muted = true;
  video.autoplay = true;
  (video as any).playsInline = true;
  video.style.width = "960px";
  video.style.background = "#444";
  document.body.style.margin = "0";
  document.body.appendChild(video);

  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

  let remoteW = 0;
  let remoteH = 0;
  let remoteRate = 0;

  // Mean Rec.709 luma of a ~120 remote-px patch offset 160 px right of the
  // click point, so the composited mouse cursor never overlaps the sample.
  const patchLuma = (): number | null => {
    if (!video.videoWidth || !video.videoHeight) return null;
    const rw = remoteW || video.videoWidth;
    const rh = remoteH || video.videoHeight;
    const scaleX = video.videoWidth / rw;
    const scaleY = video.videoHeight / rh;
    const size = 120 * scaleX;
    const sx = (rw / 2 + 160) * scaleX - size / 2;
    const sy = (rh / 2) * scaleY - size / 2;
    ctx.drawImage(video, sx, sy, size, size, 0, 0, 16, 16);
    const d = ctx.getImageData(0, 0, 16, 16).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return sum / (d.length / 4);
  };

  // --- frame-accurate observation loop ----------------------------------
  interface FrameInfo {
    now: number;
    displayTime: number;
    luma: number | null;
  }
  const frameListeners = new Set<(f: FrameInfo) => void>();
  let framesSeen = 0;
  let firstFrameAt: number | null = null;
  const rvfc = (cb: (now: number, meta: any) => void) => (video as any).requestVideoFrameCallback(cb);
  const onFrame = (now: number, meta: any) => {
    framesSeen++;
    if (firstFrameAt === null) firstFrameAt = now;
    const info: FrameInfo = { now, displayTime: meta?.expectedDisplayTime ?? now, luma: patchLuma() };
    for (const listener of Array.from(frameListeners)) listener(info);
    rvfc(onFrame);
  };
  rvfc(onFrame);

  const waitForFrame = (pred: (f: FrameInfo) => boolean, timeoutMs: number): Promise<FrameInfo | null> =>
    new Promise((resolve) => {
      const listener = (f: FrameInfo) => {
        if (!pred(f)) return;
        clearTimeout(timer);
        frameListeners.delete(listener);
        resolve(f);
      };
      const timer = setTimeout(() => {
        frameListeners.delete(listener);
        resolve(null);
      }, timeoutMs);
      frameListeners.add(listener);
    });

  // --- minimal neko-compatible transport ---------------------------------
  // Signaling messages are flat JSON: { event, ...payload }. The server
  // offers; we answer and open a reliable data channel named "data".
  const ws = new WebSocket(cfg.wsUrl);
  let pc: RTCPeerConnection | null = null;
  let channel: RTCDataChannel | null = null;
  let heartbeat: number | undefined;
  let wsOpenAt: number | null = null;
  const bufferedCandidates: RTCIceCandidateInit[] = [];

  let fatalError: Error | null = null;
  const fatalDeferred = deferred<never>();
  fatalDeferred.promise.catch(() => {}); // avoid unhandled rejection when connect already succeeded
  const fail = (err: Error) => {
    if (fatalError) return;
    fatalError = err;
    fatalDeferred.reject(err);
  };

  const dcOpen = deferred<void>();
  const gotResolution = deferred<void>();

  const wsSend = (event: string, payload: Record<string, unknown> = {}) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event, ...payload }));
  };

  const answerOffer = async (sdp: string) => {
    await pc!.setRemoteDescription({ type: "offer", sdp });
    for (const c of bufferedCandidates.splice(0)) await pc!.addIceCandidate(c);
    const answer = await pc!.createAnswer();
    await pc!.setLocalDescription(answer);
    wsSend("signal/answer", { sdp: answer.sdp, displayname: "c2p-probe" });
  };

  ws.onopen = () => {
    wsOpenAt = performance.now();
  };
  ws.onerror = () => fail(new Error("signaling websocket error"));
  ws.onclose = (e) => fail(new Error(`signaling websocket closed (code ${e.code}${e.reason ? `: ${e.reason}` : ""})`));
  ws.onmessage = async (e) => {
    try {
      const { event, ...payload } = JSON.parse(e.data);
      if (event === "signal/provide") {
        pc = payload.lite ? new RTCPeerConnection() : new RTCPeerConnection({ iceServers: payload.ice });
        pc.onicecandidate = (ev) => {
          if (ev.candidate) wsSend("signal/candidate", { data: JSON.stringify(ev.candidate.toJSON()) });
        };
        pc.ontrack = (ev) => {
          if (ev.track.kind === "video") video.srcObject = ev.streams[0] ?? new MediaStream([ev.track]);
        };
        // Create the channel before answering so it is included in the SDP.
        channel = pc.createDataChannel("data");
        channel.onopen = () => dcOpen.resolve();
        await answerOffer(payload.sdp);
      } else if (event === "signal/candidate") {
        const candidate = JSON.parse(payload.data);
        if (pc) await pc.addIceCandidate(candidate);
        else bufferedCandidates.push(candidate);
      } else if (event === "signal/offer") {
        if (pc) await answerOffer(payload.sdp); // renegotiation
      } else if (event === "system/init") {
        if (payload.heartbeat_interval > 0) {
          heartbeat = window.setInterval(() => wsSend("client/heartbeat"), payload.heartbeat_interval * 1000);
        }
      } else if (event === "screen/resolution") {
        remoteW = payload.width;
        remoteH = payload.height;
        remoteRate = payload.rate;
        gotResolution.resolve();
      } else if (event === "system/disconnect" || event === "system/error") {
        fail(new Error(`${event}: ${payload.title ?? ""} ${payload.message ?? ""}`.trim()));
      }
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const withConnectTimeout = <T,>(p: Promise<T>, what: string): Promise<T> =>
    Promise.race([
      p,
      fatalDeferred.promise,
      sleep(cfg.connectTimeoutMs).then(() => {
        throw new Error(`timed out after ${cfg.connectTimeoutMs}ms waiting for ${what}`);
      }),
    ]);

  try {
    await withConnectTimeout(dcOpen.promise, "the neko data channel to open");
    log(`data channel open at +${(performance.now() - tStart).toFixed(0)}ms`);
    wsSend("screen/resolution"); // request it in case the unprompted broadcast raced past us
    await withConnectTimeout(gotResolution.promise, "screen/resolution");
    const first = await withConnectTimeout(
      waitForFrame(() => true, cfg.connectTimeoutMs),
      "the first decoded video frame",
    );
    if (!first) throw new Error("no video frames decoded — check H.264 support in the probe browser");
    log(
      `first frame at +${(performance.now() - tStart).toFixed(0)}ms, remote ${remoteW}x${remoteH}@${remoteRate}, video ${video.videoWidth}x${video.videoHeight}`,
    );

    // --- input senders (little-endian binary over the data channel) -------
    const sendMove = (x: number, y: number) => {
      const buf = new ArrayBuffer(7);
      const v = new DataView(buf);
      v.setUint8(0, OPCODE.MOVE);
      v.setUint16(1, 4, true);
      v.setUint16(3, Math.round(x), true);
      v.setUint16(5, Math.round(y), true);
      channel!.send(buf);
    };
    const sendButton = (opcode: number, key: number) => {
      const buf = new ArrayBuffer(11);
      const v = new DataView(buf);
      v.setUint8(0, opcode);
      v.setUint16(1, 8, true);
      v.setBigUint64(3, BigInt(key), true);
      channel!.send(buf);
    };

    const clickX = Math.round((remoteW || video.videoWidth) / 2);
    const clickY = Math.round((remoteH || video.videoHeight) / 2);
    sendMove(clickX, clickY);
    await sleep(500); // let the encoder settle before reading the initial state

    const initial = await waitForFrame((f) => f.luma !== null, cfg.connectTimeoutMs);
    if (!initial) throw new Error("could not sample the sentinel patch from the video");
    let stateWhite = initial.luma! >= 128;
    log(`initial sentinel state: ${stateWhite ? "white" : "black"} (luma ${initial.luma!.toFixed(0)})`);

    // --- trial loop --------------------------------------------------------
    const totalTrials = cfg.warmup + cfg.clicks;
    const warmupMs: number[] = [];
    const measuredMs: number[] = [];
    let drops = 0;
    const probeStart = performance.now();

    for (let i = 0; i < totalTrials; i++) {
      if (fatalError) throw fatalError;
      await sleep(cfg.settleMs);
      const target = !stateWhite;
      // Arm detection before sending so a fast flip can't race past us.
      const detection = waitForFrame((f) => f.luma !== null && (f.luma >= 128) === target, cfg.clickTimeoutMs);
      const t0 = performance.now();
      sendMove(clickX, clickY);
      sendButton(OPCODE.KEY_DOWN, BTN_LEFT);
      sendButton(OPCODE.KEY_UP, BTN_LEFT);
      const frame = await detection;
      if (frame === null) {
        drops++;
        log(`trial ${i + 1}/${totalTrials}: no flip within ${cfg.clickTimeoutMs}ms (drop)`);
        if (i === 2 && drops === 3) {
          throw new Error(
            "first 3 clicks produced no visible change — input may not be reaching the page, or the sentinel is not on screen",
          );
        }
        const current = await waitForFrame((f) => f.luma !== null, 2000);
        if (current) stateWhite = current.luma! >= 128; // resync in case the flip landed after the timeout
      } else {
        const ms = frame.displayTime - t0;
        (i < cfg.warmup ? warmupMs : measuredMs).push(ms);
        stateWhite = target;
        if ((i + 1) % 10 === 0 || i + 1 === totalTrials) log(`trial ${i + 1}/${totalTrials}: ${ms.toFixed(0)} ms`);
      }
    }
    const probeDurationMs = performance.now() - probeStart;

    // --- WebRTC stats to separate network RTT from pipeline latency -------
    const rtc: Record<string, unknown> = {};
    if (pc) {
      const report = await (pc as RTCPeerConnection).getStats();
      const byId = new Map<string, any>();
      report.forEach((s: any) => byId.set(s.id, s));
      let inbound: any;
      let transport: any;
      report.forEach((s: any) => {
        if (s.type === "inbound-rtp" && s.kind === "video") inbound = s;
        if (s.type === "transport") transport = s;
      });
      const pair = transport?.selectedCandidatePairId ? byId.get(transport.selectedCandidatePairId) : undefined;
      const local = pair ? byId.get(pair.localCandidateId) : undefined;
      const remoteCand = pair ? byId.get(pair.remoteCandidateId) : undefined;
      const codec = inbound?.codecId ? byId.get(inbound.codecId) : undefined;
      rtc.codec = codec?.mimeType;
      rtc.framesPerSecond = inbound?.framesPerSecond;
      rtc.framesDecoded = inbound?.framesDecoded;
      rtc.framesDropped = inbound?.framesDropped;
      rtc.freezeCount = inbound?.freezeCount;
      rtc.totalFreezesDurationMs = inbound?.totalFreezesDuration != null ? inbound.totalFreezesDuration * 1000 : undefined;
      rtc.jitterMs = inbound?.jitter != null ? inbound.jitter * 1000 : undefined;
      rtc.jitterBufferMeanMs =
        inbound?.jitterBufferDelay && inbound?.jitterBufferEmittedCount
          ? (inbound.jitterBufferDelay / inbound.jitterBufferEmittedCount) * 1000
          : undefined;
      rtc.rttMs = pair?.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : undefined;
      rtc.localCandidate = local ? `${local.candidateType}${local.relayProtocol ? `/${local.relayProtocol}` : ""}` : undefined;
      rtc.remoteCandidate = remoteCand?.candidateType;
    }

    return {
      measuredMs,
      warmupMs,
      drops,
      trials: totalTrials,
      remote: { width: remoteW, height: remoteH, rate: remoteRate },
      videoSize: `${video.videoWidth}x${video.videoHeight}`,
      wsOpenMs: wsOpenAt !== null ? wsOpenAt - tStart : null,
      firstFrameMs: firstFrameAt !== null ? firstFrameAt - tStart : null,
      framesSeen,
      probeDurationMs,
      rtc,
    };
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    try {
      (pc as RTCPeerConnection | null)?.close();
    } catch {}
    try {
      ws.close();
    } catch {}
  }
}

// --- stats + reporting ------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function report(raw: ProbeRaw, args: CliArgs, sessionId: string, metroOrigin: string): void {
  const sorted = [...raw.measuredMs].sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / (sorted.length || 1);
  const fmt = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(0)} ms` : "n/a");
  const rtc = raw.rtc as Record<string, any>;

  console.log("");
  console.log(
    `Click-to-photon latency — ${sorted.length} measured clicks (${raw.drops} dropped, ${raw.warmupMs.length} warmup discarded)`,
  );
  console.log(`  p50   ${fmt(percentile(sorted, 50))}`);
  console.log(`  p90   ${fmt(percentile(sorted, 90))}`);
  console.log(`  p95   ${fmt(percentile(sorted, 95))}`);
  console.log(`  mean  ${fmt(mean)}   min ${fmt(sorted[0])}   max ${fmt(sorted[sorted.length - 1])}`);
  console.log(
    `Stream: remote ${raw.remote.width}x${raw.remote.height}@${raw.remote.rate} (${(1000 / (raw.remote.rate || 25)).toFixed(0)} ms frame floor), ` +
      `decoded ${raw.videoSize} ${rtc.codec ?? "?"} @ ~${rtc.framesPerSecond ?? "?"} fps`,
  );
  console.log(
    `WebRTC: rtt ${fmt(rtc.rttMs)}, jitter buffer ~${fmt(rtc.jitterBufferMeanMs)}, ` +
      `path ${rtc.localCandidate ?? "?"} -> ${rtc.remoteCandidate ?? "?"}, ` +
      `freezes ${rtc.freezeCount ?? "?"} (${fmt(rtc.totalFreezesDurationMs)})`,
  );
  console.log(`Connection: signaling open ${fmt(raw.wsOpenMs)}, first frame ${fmt(raw.firstFrameMs)} after probe start`);

  if (args.jsonPath) {
    const summary = {
      clicks: sorted.length,
      drops: raw.drops,
      p50Ms: percentile(sorted, 50),
      p90Ms: percentile(sorted, 90),
      p95Ms: percentile(sorted, 95),
      meanMs: mean,
      minMs: sorted[0] ?? null,
      maxMs: sorted[sorted.length - 1] ?? null,
    };
    writeFileSync(
      args.jsonPath,
      JSON.stringify({ generatedAt: new Date().toISOString(), sessionId, metroOrigin, config: args, summary, raw }, null, 2),
    );
    console.log(`Wrote ${args.jsonPath}`);
  }
}

// --- orchestration ------------------------------------------------------------

async function waitForLiveView(url: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `status ${res.status}`;
    } catch (err) {
      last = String(err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`live view not ready after ${timeoutMs}ms (${last})`);
}

// Keep rendering unthrottled: the detector needs frames even if the window is
// briefly occluded, and the video must autoplay without a user gesture.
const LAUNCH_ARGS = [
  "--autoplay-policy=no-user-gesture-required",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
];

async function launchLocalBrowser(headless: boolean): Promise<Browser> {
  try {
    // Installed Chrome has the most complete H.264 WebRTC decode support.
    return await chromium.launch({ channel: "chrome", headless, args: LAUNCH_ARGS });
  } catch {
    return await chromium.launch({ headless, args: LAUNCH_ARGS });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.KERNEL_API_KEY) {
    throw new Error("Set KERNEL_API_KEY (get one at https://dashboard.onkernel.com)");
  }
  const kernel = new Kernel();

  console.log("Creating headful Kernel browser session...");
  // kiosk_mode hides the address bar and tabs so the sentinel page fills the
  // entire captured screen.
  const session = await kernel.browsers.create({ timeout_seconds: 300, kiosk_mode: true });
  console.log(`  session ${session.session_id}`);
  console.log(`  live view: ${session.browser_live_view_url}`);

  let local: Browser | undefined;
  let remote: Browser | undefined;
  try {
    if (!session.browser_live_view_url) throw new Error("session has no live view URL (live view requires headful)");
    const jwt = new URL(session.cdp_ws_url).searchParams.get("jwt");
    if (!jwt) throw new Error("could not extract the session JWT from cdp_ws_url");
    const liveOrigin = new URL(session.browser_live_view_url).origin;
    const wsUrl = `${liveOrigin.replace(/^http/, "ws")}/browser/live/ws?password=admin&username=c2p-probe&jwt=${jwt}`;

    console.log("Loading the sentinel page in the remote browser...");
    remote = await chromium.connectOverCDP(session.cdp_ws_url);
    const context = remote.contexts()[0] ?? (await remote.newContext());
    const remotePage = context.pages()[0] ?? (await context.newPage());
    await remotePage.goto(`data:text/html;base64,${Buffer.from(SENTINEL_HTML).toString("base64")}`);

    await waitForLiveView(session.browser_live_view_url);

    console.log("Launching the local probe browser...");
    local = await launchLocalBrowser(args.headless);
    const page = await local.newPage();
    await page.exposeFunction("probeLog", (message: string) => console.log(`  ${message}`));
    // tsx (esbuild) injects __name helper calls into transpiled functions,
    // which breaks when Playwright serializes probeInPage into the page.
    await page.evaluate("globalThis.__name = (fn) => fn");
    await page.bringToFront();

    console.log(`Probing: ${args.warmup} warmup + ${args.clicks} measured clicks...`);
    const raw = await page.evaluate(probeInPage, {
      wsUrl,
      clicks: args.clicks,
      warmup: args.warmup,
      clickTimeoutMs: args.clickTimeoutMs,
      settleMs: args.settleMs,
      connectTimeoutMs: 20000,
    });

    report(raw, args, session.session_id, liveOrigin);
  } finally {
    await local?.close().catch(() => {});
    await remote?.close().catch(() => {});
    if (args.keep) {
      console.log(`Keeping session ${session.session_id} alive (--keep).`);
    } else {
      await kernel.browsers.deleteByID(session.session_id).catch((err) => {
        console.error(`Failed to delete session ${session.session_id}: ${err}`);
      });
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
