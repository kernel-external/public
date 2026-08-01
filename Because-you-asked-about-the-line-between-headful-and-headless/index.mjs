// Side-by-side comparison of Kernel live view vs. a raw CDP Page.startScreencast.
//
// Creates two browsers with default viewports:
//   Pane A - headful browser, rendered via `browser_live_view_url` in an iframe.
//   Pane B - browser rendered from CDP screencast frames drawn onto a <canvas>.
//
// The screencast is NOT relayed through this process. `cdp_ws_url` carries its own
// JWT in the query string, so the comparison page opens the WebSocket to Kernel
// directly from the tab. Node only serves the static page and drives navigation.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import Kernel from "@onkernel/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);

const TARGET_URL = args.get("url") ?? "https://news.ycombinator.com";
const PORT = Number(args.get("port") ?? 3111);
const TIMEOUT_SECONDS = Number(args.get("timeout") ?? 900);
// The screencast browser is headless by default. Pass --screencast-headful to
// compare headful-vs-headful, where the transport is the only variable.
const SCREENCAST_HEADLESS = args.get("screencast-headful") !== "true";

// Left alone, the two browsers render at different sizes: a headful browser gets
// Kernel's default 1920x1080 display (minus desktop panel and browser chrome, so a
// 1920x993 page viewport), while a headless browser has no display and falls back to
// Chromium's built-in 800x600 window.
//
// We fix that by creating the headful browser first, measuring its real page
// viewport, then creating the second browser with `viewport` set to exactly that.
// Kernel's viewport param applies to headless browsers too and sizes the real
// window, so both panes end up identical with no emulation involved.
//
// Note we deliberately do NOT use Emulation.setDeviceMetricsOverride here. It also
// equalizes the size, but it resizes only the renderer viewport while the compositor
// surface stays 800x600 -- which measures *faster* than a genuine 1920x993 window and
// so flatters the screencast pane. See README.
const MATCH_VIEWPORT = args.get("no-match-viewport") !== "true";

// Optional shared display size for the headful browser, e.g. --viewport=1024x768.
// Must be one of Kernel's supported resolutions. Omit for the 1920x1080 default.
const VIEWPORT = args.get("viewport")
  ? (([w, h]) => ({ width: Number(w), height: Number(h) }))(args.get("viewport").split("x"))
  : undefined;

const kernel = new Kernel();

// A moving marker + millisecond clock injected into both pages. Watching the two
// panes side by side makes the end-to-end lag of each transport directly visible.
const OVERLAY = `
(() => {
  if (window.__kernelLagOverlay) return;
  window.__kernelLagOverlay = true;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;top:0;left:0;right:0;height:56px;z-index:2147483647;background:#000;pointer-events:none;font:700 26px ui-monospace,SFMono-Regular,monospace;color:#0f0';
  const clock = document.createElement('div');
  clock.style.cssText = 'position:absolute;top:4px;left:10px';
  const track = document.createElement('div');
  track.style.cssText = 'position:absolute;bottom:0;left:0;right:0;height:18px;background:#111';
  const dot = document.createElement('div');
  dot.style.cssText = 'position:absolute;top:0;width:60px;height:18px;background:#f0f';
  track.appendChild(dot);
  wrap.append(clock, track);
  const attach = () => document.documentElement.appendChild(wrap);
  if (document.documentElement) attach();
  else document.addEventListener('DOMContentLoaded', attach);
  const tick = () => {
    const t = Date.now();
    clock.textContent = new Date(t).toISOString().slice(11, 23);
    // 2s sweep across the viewport
    dot.style.left = Math.abs(((t % 4000) / 2000) - 1) * (window.innerWidth - 60) + 'px';
    requestAnimationFrame(tick);
  };
  tick();
})();
`;

// --- Minimal CDP client over the global WebSocket (Node 22+, no ws dependency) ---
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    });
  }

  // A freshly created browser can take a few seconds before its CDP endpoint
  // accepts connections, so retry rather than failing the whole run.
  static async connect(url, attempts = 20) {
    for (let i = 1; ; i++) {
      try {
        const ws = new WebSocket(url);
        await new Promise((resolve, reject) => {
          ws.addEventListener("open", resolve, { once: true });
          ws.addEventListener("error", () => reject(new Error("CDP connect failed")), { once: true });
        });
        return new CDP(ws);
      } catch (err) {
        if (i >= attempts) throw err;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  // Attach flat to the first page target and return its session id.
  async pageSession(attempts = 15) {
    for (let i = 1; ; i++) {
      const { targetInfos } = await this.send("Target.getTargets");
      const page = targetInfos.find((t) => t.type === "page");
      if (page) {
        const { sessionId } = await this.send("Target.attachToTarget", {
          targetId: page.targetId,
          flatten: true,
        });
        return sessionId;
      }
      if (i >= attempts) throw new Error("no page target");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function drive(cdpWsUrl, url) {
  const cdp = await CDP.connect(cdpWsUrl);
  const session = await cdp.pageSession();
  await cdp.send("Page.enable", {}, session);
  await cdp.send("Runtime.enable", {}, session);
  // Survive subsequent navigations.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: OVERLAY }, session);
  await cdp.send("Page.navigate", { url }, session);
  await new Promise((r) => setTimeout(r, 2500));
  await cdp.send("Runtime.evaluate", { expression: OVERLAY }, session);
  return { cdp, session };
}

const viewportOf = async ({ cdp, session }) => {
  const { result } = await cdp.send(
    "Runtime.evaluate",
    { expression: "JSON.stringify([innerWidth, innerHeight])", returnByValue: true },
    session,
  );
  return JSON.parse(result.value);
};

const drivers = {};
const created = [];
const cleanup = async () => {
  console.log("\nDeleting browsers...");
  await Promise.allSettled(created.map((id) => kernel.browsers.deleteByID(id)));
  process.exit(0);
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// --- 1. Headful browser for the live view pane ---
console.log("Creating live view browser (headful)...");
const liveBrowser = await kernel.browsers.create({
  timeout_seconds: TIMEOUT_SECONDS,
  ...(VIEWPORT ? { viewport: VIEWPORT } : {}),
});
created.push(liveBrowser.session_id);
drivers.live = await drive(liveBrowser.cdp_ws_url, TARGET_URL);

// Its real page viewport: the display size minus the desktop panel and browser chrome.
const [lw, lh] = await viewportOf(drivers.live);
console.log(`  ${liveBrowser.session_id} — page viewport ${lw}x${lh}`);

// --- 2. Second browser, sized so its page viewport matches exactly ---
// Kernel's viewport param sizes a headless browser's real window, and a headless
// browser has no panel or chrome to subtract, so requesting lw x lh yields exactly
// lw x lh. A headful browser would subtract chrome again, so it keeps VIEWPORT.
const castViewport = MATCH_VIEWPORT
  ? SCREENCAST_HEADLESS
    ? { width: lw, height: lh }
    : VIEWPORT
  : undefined;

console.log(`Creating screencast browser (${SCREENCAST_HEADLESS ? "headless" : "headful"})...`);
const castBrowser = await kernel.browsers.create({
  timeout_seconds: TIMEOUT_SECONDS,
  headless: SCREENCAST_HEADLESS,
  ...(castViewport ? { viewport: castViewport } : {}),
});
created.push(castBrowser.session_id);
drivers.cast = await drive(castBrowser.cdp_ws_url, TARGET_URL);

const [cw, ch] = await viewportOf(drivers.cast);
console.log(`  ${castBrowser.session_id} — page viewport ${cw}x${ch}`);
console.log(
  lw === cw && lh === ch
    ? "  viewports match"
    : `  viewports differ (${lw}x${lh} vs ${cw}x${ch})`,
);

// --- Static page + a /navigate control that drives both browsers at once ---
const config = {
  liveViewUrl: liveBrowser.browser_live_view_url,
  castCdpWsUrl: castBrowser.cdp_ws_url,
  liveSessionId: liveBrowser.session_id,
  castSessionId: castBrowser.session_id,
  castHeadless: SCREENCAST_HEADLESS,
  targetUrl: TARGET_URL,
  liveViewport: `${lw}x${lh}`,
  castViewport: `${cw}x${ch}`,
};

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://localhost:${PORT}`);

  if (pathname === "/config") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(config));
  }

  if (pathname === "/navigate" && req.method === "POST") {
    const body = await new Promise((r) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => r(b));
    });
    const { url } = JSON.parse(body || "{}");
    try {
      await Promise.all(
        [drivers.live, drivers.cast].map(async ({ cdp, session }) => {
          await cdp.send("Page.navigate", { url }, session);
          await new Promise((r) => setTimeout(r, 2000));
          await cdp.send("Runtime.evaluate", { expression: OVERLAY }, session);
        }),
      );
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: String(err) }));
    }
  }

  const html = await fs.readFile(path.join(__dirname, "public", "index.html"), "utf8");
  res.writeHead(200, { "content-type": "text/html" });
  res.end(html);
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\nComparison page: ${url}`);
  console.log("Ctrl-C to delete both browsers and exit.\n");
  spawn("open", [url], { stdio: "ignore", detached: true }).unref();
});
