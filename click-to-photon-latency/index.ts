/**
 * Click-to-photon latency probe for Kernel live view — local CLI.
 *
 * Measures the full input-to-render round trip a user feels when driving a
 * Kernel browser through live view: local click -> data channel -> TURN ->
 * X input inject -> Chrome paint -> capture -> encode -> TURN -> local
 * decode -> present. No clock sync is needed: the loop starts and ends on
 * this machine.
 *
 * See probe.ts for the measurement core, and app.ts for a deployable Kernel
 * app variant that runs the probe from a Kernel browser (optionally behind a
 * proxy) instead of your laptop.
 *
 * Detection is quantized to the remote frame interval (~40 ms at 25 fps), so
 * single trials are noisy by design — read the p50/p95 over many clicks.
 */
import { writeFileSync } from "node:fs";
import Kernel from "@onkernel/sdk";
import { chromium, type Browser } from "playwright";
import { liveViewWsUrl, percentile, probeInPage, type ProbeRaw, sentinelDataUrl, summarize, waitForLiveView } from "./probe";

interface CliArgs {
  clicks: number;
  warmup: number;
  clickTimeoutMs: number;
  settleMs: number;
  jsonPath?: string;
  keep: boolean;
  headless: boolean;
  gpu: boolean;
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
  --gpu                 Create a GPU-accelerated Kernel browser (requires a plan with GPU access)
  --help                Show this help`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    clicks: 100,
    warmup: 5,
    clickTimeoutMs: 5000,
    settleMs: 200,
    keep: false,
    headless: false,
    gpu: false,
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
      case "--gpu":
        args.gpu = true;
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

function report(raw: ProbeRaw, args: CliArgs, sessionId: string, metroOrigin: string): void {
  const summary = summarize(raw);
  const sorted = [...raw.measuredMs].sort((a, b) => a - b);
  const fmt = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(0)} ms` : "n/a");
  const rtc = raw.rtc as Record<string, any>;

  console.log("");
  console.log(
    `Click-to-photon latency — ${summary.clicks} measured clicks (${raw.drops} dropped, ${raw.warmupMs.length} warmup discarded)`,
  );
  console.log(`  p50   ${fmt(summary.p50Ms)}`);
  console.log(`  p90   ${fmt(summary.p90Ms)}`);
  console.log(`  p95   ${fmt(percentile(sorted, 95))}`);
  console.log(`  mean  ${fmt(summary.meanMs)}   min ${fmt(summary.minMs)}   max ${fmt(summary.maxMs)}`);
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
    writeFileSync(
      args.jsonPath,
      JSON.stringify({ generatedAt: new Date().toISOString(), sessionId, metroOrigin, config: args, summary, raw }, null, 2),
    );
    console.log(`Wrote ${args.jsonPath}`);
  }
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

  console.log(`Creating headful${args.gpu ? " GPU" : ""} Kernel browser session...`);
  // kiosk_mode hides the address bar and tabs so the sentinel page fills the
  // entire captured screen.
  const session = await kernel.browsers.create({ timeout_seconds: 300, kiosk_mode: true, gpu: args.gpu });
  console.log(`  session ${session.session_id}`);
  console.log(`  live view: ${session.browser_live_view_url}`);

  let local: Browser | undefined;
  let remote: Browser | undefined;
  try {
    const wsUrl = liveViewWsUrl(session);
    const liveOrigin = new URL(session.browser_live_view_url!).origin;

    console.log("Loading the sentinel page in the remote browser...");
    remote = await chromium.connectOverCDP(session.cdp_ws_url);
    const context = remote.contexts()[0] ?? (await remote.newContext());
    const remotePage = context.pages()[0] ?? (await context.newPage());
    await remotePage.goto(sentinelDataUrl());

    await waitForLiveView(session.browser_live_view_url!);

    console.log("Launching the local probe browser...");
    local = await launchLocalBrowser(args.headless);
    const page = await local.newPage();
    // Give the probe page a real origin (matches the app variant, where
    // Kernel browsers block network requests from the initial about:blank).
    await page.goto(`${liveOrigin}/browser/live`, { waitUntil: "domcontentloaded" });
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
