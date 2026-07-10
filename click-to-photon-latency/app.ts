/**
 * Click-to-photon latency probe — deployable Kernel app.
 *
 * Runs the same measurement as index.ts, but entirely inside Kernel: the
 * action creates a *target* browser (kiosk + sentinel page) and a *probe*
 * browser that plays the user — it connects to the target's live view over
 * WebRTC, sends real clicks, and times the pixel response. Nothing runs on
 * your machine.
 *
 * Because the probe browser is a normal Kernel session, you can attach a
 * proxy to it (`proxy_id`) to emulate users in different locales. When a
 * proxy is set, the probe browser defaults to the Chrome policy
 * `WebRtcIPHandling: disable_non_proxied_udp` so the WebRTC media path is
 * forced through the proxy too — without it, Chrome routes only the
 * signaling websocket through the proxy and sends media over direct UDP,
 * which would silently measure the unproxied path.
 *
 * Deploy:  kernel deploy app.ts
 * Invoke:  kernel invoke click-to-photon probe --payload '{"clicks": 100}'
 *          kernel invoke click-to-photon probe --payload '{"proxy_id": "..."}'
 */
import Kernel, { type KernelContext } from "@onkernel/sdk";
import { chromium, type Browser } from "playwright";
import { liveViewWsUrl, probeInPage, type ProbeRaw, sentinelDataUrl, summarize, waitForLiveView } from "./probe";

const kernel = new Kernel();
const app = kernel.app("click-to-photon");

interface ProbePayload {
  clicks?: number; // measured clicks (default 100)
  warmup?: number; // leading clicks discarded from stats (default 5)
  click_timeout_ms?: number; // per-click detection timeout (default 5000)
  settle_ms?: number; // delay between trials (default 200)
  gpu?: boolean; // use a GPU image for the target browser (default false)
  proxy_id?: string; // proxy for the probe browser — the simulated user's egress
  force_proxied_webrtc?: boolean; // force WebRTC media through the proxy (default: true when proxy_id is set)
  keep?: boolean; // keep both sessions alive afterwards (default false)
}

app.action("probe", async (ctx: KernelContext, payload?: ProbePayload) => {
  const clicks = payload?.clicks ?? 100;
  const warmup = payload?.warmup ?? 5;
  const clickTimeoutMs = payload?.click_timeout_ms ?? 5000;
  const settleMs = payload?.settle_ms ?? 200;
  const forceProxiedWebrtc = payload?.force_proxied_webrtc ?? Boolean(payload?.proxy_id);

  console.log(
    `creating target${payload?.gpu ? " GPU" : ""} browser and probe browser${payload?.proxy_id ? ` (proxy ${payload.proxy_id})` : ""}`,
  );
  const [target, prober] = await Promise.all([
    kernel.browsers.create({
      invocation_id: ctx.invocation_id,
      timeout_seconds: 600,
      // kiosk_mode hides the address bar and tabs so the sentinel page fills
      // the entire captured screen.
      kiosk_mode: true,
      gpu: payload?.gpu ?? false,
    }),
    kernel.browsers.create({
      invocation_id: ctx.invocation_id,
      timeout_seconds: 600,
      ...(payload?.proxy_id ? { proxy_id: payload.proxy_id } : {}),
      ...(forceProxiedWebrtc ? { chrome_policy: { WebRtcIPHandling: "disable_non_proxied_udp" } } : {}),
    }),
  ]);
  console.log(`target ${target.session_id} — live view ${target.browser_live_view_url}`);
  console.log(`probe  ${prober.session_id}`);

  let targetCdp: Browser | undefined;
  let proberCdp: Browser | undefined;
  try {
    const wsUrl = liveViewWsUrl(target);

    targetCdp = await chromium.connectOverCDP(target.cdp_ws_url);
    const targetContext = targetCdp.contexts()[0] ?? (await targetCdp.newContext());
    const targetPage = targetContext.pages()[0] ?? (await targetContext.newPage());
    await targetPage.goto(sentinelDataUrl());
    await waitForLiveView(target.browser_live_view_url!);

    proberCdp = await chromium.connectOverCDP(prober.cdp_ws_url);
    const proberContext = proberCdp.contexts()[0] ?? (await proberCdp.newContext());
    const proberPage = proberContext.pages()[0] ?? (await proberContext.newPage());
    // The probe page must sit on a real origin: Kernel browsers block network
    // requests initiated from the initial about:blank page. The jwt-less live
    // path returns a plain 400 page on the same origin as the signaling ws.
    const liveOrigin = new URL(target.browser_live_view_url!).origin;
    await proberPage.goto(`${liveOrigin}/browser/live`, { waitUntil: "domcontentloaded" });
    await proberPage.exposeFunction("probeLog", (message: string) => console.log(`[probe] ${message}`));
    // Bundlers (esbuild) inject __name helper calls into transpiled functions,
    // which breaks when Playwright serializes probeInPage into the page.
    await proberPage.evaluate("globalThis.__name = (fn) => fn");
    await proberPage.bringToFront();

    console.log(`probing: ${warmup} warmup + ${clicks} measured clicks`);
    const raw: ProbeRaw = await proberPage.evaluate(probeInPage, {
      wsUrl,
      clicks,
      warmup,
      clickTimeoutMs,
      settleMs,
      // Proxied TURN-over-TCP setups negotiate slower than direct UDP.
      connectTimeoutMs: 30000,
    });

    return {
      summary: summarize(raw),
      target: {
        session_id: target.session_id,
        live_view_url: target.browser_live_view_url,
        gpu: payload?.gpu ?? false,
      },
      probe: {
        session_id: prober.session_id,
        proxy_id: payload?.proxy_id ?? null,
        forced_proxied_webrtc: forceProxiedWebrtc,
      },
      raw,
    };
  } finally {
    await targetCdp?.close().catch(() => {});
    await proberCdp?.close().catch(() => {});
    if (payload?.keep) {
      console.log("keeping sessions alive (keep: true)");
    } else {
      await Promise.allSettled([kernel.browsers.deleteByID(target.session_id), kernel.browsers.deleteByID(prober.session_id)]);
    }
  }
});
