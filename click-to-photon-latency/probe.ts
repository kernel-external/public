/**
 * Shared core of the click-to-photon latency probe: the sentinel page served
 * in the target browser, the measurement client injected into the probe
 * browser's page, and result summarization. Used by both the local CLI
 * (index.ts) and the deployed Kernel app (app.ts).
 */

// Full-viewport page loaded in the remote browser; flips between pure black
// and pure white on every pointerdown so "the video updated" reduces to a
// luminance threshold instead of fragile arbitrary-frame diffing.
export const SENTINEL_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>c2p sentinel</title><style>
html,body{margin:0;height:100%;overflow:hidden}
#t{position:fixed;inset:0;background:#000;cursor:none;user-select:none}
</style></head><body><div id="t"></div><script>
let on = false;
const el = document.getElementById('t');
addEventListener('pointerdown', (e) => { e.preventDefault(); on = !on; el.style.background = on ? '#fff' : '#000'; });
addEventListener('contextmenu', (e) => e.preventDefault());
</script></body></html>`;

export function sentinelDataUrl(): string {
  return `data:text/html;base64,${Buffer.from(SENTINEL_HTML).toString("base64")}`;
}

export interface ProbeConfig {
  wsUrl: string;
  clicks: number;
  warmup: number;
  clickTimeoutMs: number;
  settleMs: number;
  connectTimeoutMs: number;
}

export interface ProbeRaw {
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
  aborted: string | null;
  rtc: Record<string, unknown>;
}

// The session's live view signaling websocket, authenticated with the same
// JWT that the API returns on cdp_ws_url.
export function liveViewWsUrl(session: { cdp_ws_url: string; browser_live_view_url?: string }): string {
  if (!session.browser_live_view_url) throw new Error("session has no live view URL (live view requires headful)");
  const jwt = new URL(session.cdp_ws_url).searchParams.get("jwt");
  if (!jwt) throw new Error("could not extract the session JWT from cdp_ws_url");
  const liveOrigin = new URL(session.browser_live_view_url).origin;
  return `${liveOrigin.replace(/^http/, "ws")}/browser/live/ws?password=admin&username=c2p-probe&jwt=${jwt}`;
}

export async function waitForLiveView(url: string, timeoutMs = 60000): Promise<void> {
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

// Runs inside the probe browser via page.evaluate — must be self-contained.
export async function probeInPage(cfg: ProbeConfig): Promise<ProbeRaw> {
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
        pc.oniceconnectionstatechange = () => log(`ice connection: ${pc!.iceConnectionState}`);
        pc.onicegatheringstatechange = () => log(`ice gathering: ${pc!.iceGatheringState}`);
        pc.onicecandidate = (ev) => {
          if (!ev.candidate) return;
          const type = /typ (\w+)/.exec(ev.candidate.candidate)?.[1] ?? "?";
          log(`local candidate: ${type} ${ev.candidate.protocol ?? ""}`);
          wsSend("signal/candidate", { data: JSON.stringify(ev.candidate.toJSON()) });
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
    try {
      await withConnectTimeout(dcOpen.promise, "the neko data channel to open");
    } catch (err) {
      // Enrich connection failures with ICE detail — the usual culprits are
      // blocked UDP, a proxy that won't tunnel TURN, or no reachable relay.
      const peer = pc as RTCPeerConnection | null;
      if (peer) {
        const gathered: string[] = [];
        const report = await peer.getStats().catch(() => null);
        report?.forEach((s: any) => {
          if (s.type === "local-candidate") gathered.push(`${s.candidateType}/${s.protocol}${s.relayProtocol ? `(${s.relayProtocol})` : ""}`);
        });
        throw new Error(
          `${err instanceof Error ? err.message : err} — ice connection: ${peer.iceConnectionState}, ` +
            `gathering: ${peer.iceGatheringState}, local candidates: [${gathered.join(", ") || "none"}]`,
        );
      }
      throw err;
    }
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
    let consecutiveDrops = 0;
    let aborted: string | null = null;
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
        consecutiveDrops++;
        log(`trial ${i + 1}/${totalTrials}: no flip within ${cfg.clickTimeoutMs}ms (drop)`);
        if (i === 2 && drops === 3) {
          throw new Error(
            "first 3 clicks produced no visible change — input may not be reaching the page, or the sentinel is not on screen",
          );
        }
        // A dead connection (e.g. a rotating proxy exit changed mid-run)
        // never recovers here — return what we have instead of burning the
        // per-click timeout on every remaining trial.
        const iceState = (pc as RTCPeerConnection | null)?.iceConnectionState;
        if (consecutiveDrops >= 2 && iceState && iceState !== "connected" && iceState !== "completed") {
          aborted = `connection lost mid-run (ice ${iceState}) after ${warmupMs.length + measuredMs.length} successful trials`;
          log(aborted);
          break;
        }
        const current = await waitForFrame((f) => f.luma !== null, 2000);
        if (current) stateWhite = current.luma! >= 128; // resync in case the flip landed after the timeout
      } else {
        consecutiveDrops = 0;
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
      aborted,
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

// --- stats -------------------------------------------------------------------

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export interface ProbeSummary {
  clicks: number;
  drops: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  meanMs: number;
  minMs: number | null;
  maxMs: number | null;
}

export function summarize(raw: ProbeRaw): ProbeSummary {
  const sorted = [...raw.measuredMs].sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / (sorted.length || 1);
  return {
    clicks: sorted.length,
    drops: raw.drops,
    p50Ms: percentile(sorted, 50),
    p90Ms: percentile(sorted, 90),
    p95Ms: percentile(sorted, 95),
    meanMs: mean,
    minMs: sorted[0] ?? null,
    maxMs: sorted[sorted.length - 1] ?? null,
  };
}
