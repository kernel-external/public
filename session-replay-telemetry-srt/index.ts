import Kernel from "@onkernel/sdk";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

type BrowserReplay = {
  replay_id: string;
  started_at?: string | null;
  finished_at?: string | null;
  replay_view_url?: string;
};

type TelemetryEnvelope = {
  seq: number;
  event: {
    ts: number;
    category: string;
    type: string;
    data?: unknown;
    source?: string;
  };
};

type Args = {
  sessionId?: string;
  outputDir: string;
  categories: string[];
  cueSeconds: number;
  maxLines: number;
  help: boolean;
};

const DEFAULT_BASE_URL = "https://api.onkernel.com";
const DEFAULT_CATEGORIES = ["console", "network", "page", "control", "connection", "system", "captcha"];

function usage(): string {
  return `Usage:
  npx tsx index.ts <browser-session-id>
  npx tsx index.ts --session-id <browser-session-id>

Options:
  --session-id <id>       Browser session ID.
  --output-dir <path>     Directory for generated SRT files. Default: ./srt.
  --categories <list>     Telemetry categories to include. Default: ${DEFAULT_CATEGORIES.join(",")}.
  --cue-seconds <n>       Seconds per subtitle bucket. Default: 2.
  --max-lines <n>         Max log lines per subtitle cue. Default: 3.
  --help                  Show this help.

Environment:
  KERNEL_API_KEY          Required Kernel API key.
  KERNEL_BASE_URL         Optional API base URL. Default: ${DEFAULT_BASE_URL}.`;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    outputDir: "srt",
    categories: DEFAULT_CATEGORIES,
    cueSeconds: 2,
    maxLines: 3,
    help: false,
  };

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value after ${arg}`);
      return value;
    };

    switch (arg) {
      case "--help":
      case "-h":
        out.help = true;
        break;
      case "--session-id":
        out.sessionId = next();
        break;
      case "--output-dir":
      case "--output":
      case "-o":
        out.outputDir = next();
        break;
      case "--categories":
        out.categories = next()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--cue-seconds":
        out.cueSeconds = parsePositiveNumber(next(), "--cue-seconds");
        break;
      case "--max-lines":
        out.maxLines = parsePositiveInt(next(), "--max-lines");
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
        positional.push(arg);
    }
  }

  if (!out.sessionId) out.sessionId = positional[0];
  return out;
}

function parsePositiveInt(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function parsePositiveNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number`);
  return parsed;
}

function requireDate(input: string | null | undefined, label: string): Date {
  if (!input) throw new Error(`Replay is missing ${label}. Stop the replay first, or try again after it is available.`);
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) throw new Error(`Replay has invalid ${label}: ${input}`);
  return date;
}

async function fetchTelemetryEvents(params: {
  apiKey: string;
  baseURL: string;
  sessionId: string;
  since: Date;
  until: Date;
  categories: string[];
}): Promise<TelemetryEnvelope[]> {
  const events: TelemetryEnvelope[] = [];
  let offset: string | undefined;

  do {
    const url = new URL(`/browsers/${params.sessionId}/telemetry/events`, ensureTrailingSlash(params.baseURL));
    url.searchParams.set("limit", "100");
    url.searchParams.set("order", "asc");
    url.searchParams.set("until", params.until.toISOString());
    if (offset) {
      url.searchParams.set("offset", offset);
    } else {
      url.searchParams.set("since", params.since.toISOString());
    }
    for (const category of params.categories) {
      url.searchParams.append("category", category);
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Telemetry request failed (${response.status}): ${text || response.statusText}`);
    }

    const page = (await response.json()) as TelemetryEnvelope[];
    events.push(...page);

    const hasMore = response.headers.get("x-has-more")?.toLowerCase() === "true";
    const nextOffset = response.headers.get("x-next-offset");
    offset = hasMore && nextOffset && nextOffset !== "0" ? nextOffset : undefined;
  } while (offset);

  return events;
}

function ensureTrailingSlash(baseURL: string): string {
  return baseURL.endsWith("/") ? baseURL : `${baseURL}/`;
}

function eventTimeMs(event: TelemetryEnvelope["event"]): number {
  if (event.ts > 1e14) return Math.floor(event.ts / 1000);
  if (event.ts > 1e12) return Math.floor(event.ts);
  return Math.floor(event.ts * 1000);
}

function buildSrt(events: TelemetryEnvelope[], replayStart: Date, replayEnd: Date, cueSeconds: number, maxLines: number): string {
  const startMs = replayStart.getTime();
  const durationMs = Math.max(1000, replayEnd.getTime() - startMs);
  const cueMs = cueSeconds * 1000;
  const buckets = new Map<number, string[]>();

  const filtered = events
    .filter((item) => item.event && Number.isFinite(item.event.ts))
    .map((item) => ({ item, offsetMs: eventTimeMs(item.event) - startMs }))
    .filter(({ offsetMs }) => offsetMs >= 0 && offsetMs <= durationMs)
    .sort((a, b) => a.offsetMs - b.offsetMs || a.item.seq - b.item.seq);

  for (const { item, offsetMs } of filtered) {
    const bucketStart = Math.floor(offsetMs / cueMs) * cueMs;
    const line = formatLogLine(item, offsetMs);
    const lines = buckets.get(bucketStart) ?? [];
    lines.push(line);
    buckets.set(bucketStart, lines);
  }

  let cueIndex = 1;
  const blocks: string[] = [];
  for (const [bucketStart, lines] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const bucketEnd = Math.min(durationMs, bucketStart + cueMs);
    const chunks = chunk(lines, maxLines);
    const chunkMs = Math.max(250, (bucketEnd - bucketStart) / chunks.length);

    chunks.forEach((cueLines, index) => {
      const cueStart = bucketStart + index * chunkMs;
      const cueEnd = index === chunks.length - 1 ? bucketEnd : bucketStart + (index + 1) * chunkMs;
      blocks.push([
        String(cueIndex++),
        `${formatSrtTime(cueStart)} --> ${formatSrtTime(Math.max(cueStart + 250, cueEnd))}`,
        cueLines.join("\n"),
      ].join("\n"));
    });
  }

  return blocks.join("\n\n") + (blocks.length ? "\n" : "");
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function formatLogLine(envelope: TelemetryEnvelope, offsetMs: number): string {
  const event = envelope.event;
  const prefix = `[+${formatOffset(offsetMs)}] ${event.category}/${event.type}`;
  const summary = summarizeData(event.data);
  return sanitizeSubtitleLine(summary ? `${prefix} ${summary}` : prefix);
}

function summarizeData(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const record = data as Record<string, unknown>;
  const candidates = [
    record.message,
    record.text,
    record.value,
    record.error,
    record.reason,
    record.url,
    record.request_url,
    record.response_url,
  ];
  const firstString = candidates.find((value): value is string => typeof value === "string" && value.length > 0);
  if (firstString) return truncate(firstString, 180);

  const status = typeof record.status === "number" || typeof record.status === "string" ? `status=${record.status}` : "";
  const method = typeof record.method === "string" ? record.method : "";
  if (method || status) return [method, status].filter(Boolean).join(" ");

  try {
    return truncate(JSON.stringify(data), 180);
  } catch {
    return "";
  }
}

function sanitizeSubtitleLine(value: string): string {
  return value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[^\S ]+/g, " ")
    .trim();
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;
}

function formatSrtTime(ms: number): string {
  const totalMs = Math.max(0, Math.floor(ms));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`;
}

function formatOffset(ms: number): string {
  const totalMs = Math.max(0, Math.floor(ms));
  const minutes = Math.floor(totalMs / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  return `${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function outputPathForReplay(outputDir: string, replayId: string): string {
  const safeReplayId = replayId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(outputDir, `replay-${safeReplayId}.srt`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.sessionId) throw new Error("Missing browser session ID.\n\n" + usage());

  const apiKey = process.env.KERNEL_API_KEY;
  if (!apiKey) throw new Error("KERNEL_API_KEY is required.");
  const baseURL = process.env.KERNEL_BASE_URL ?? DEFAULT_BASE_URL;
  const client = new Kernel({ apiKey, baseURL });

  console.error(`Listing replays for session ${args.sessionId}...`);
  const replays = (await client.browsers.replays.list(args.sessionId)) as BrowserReplay[];
  if (replays.length === 0) {
    console.error("No replays found for this session.");
    return;
  }

  await mkdir(args.outputDir, { recursive: true });

  let totalEvents = 0;
  let totalCues = 0;
  let written = 0;
  for (const replay of replays) {
    const replayStart = requireDate(replay.started_at, `started_at for replay ${replay.replay_id}`);
    const replayEnd = replay.finished_at ? requireDate(replay.finished_at, `finished_at for replay ${replay.replay_id}`) : new Date();

    console.error(`Fetching telemetry for replay ${replay.replay_id} from ${replayStart.toISOString()} to ${replayEnd.toISOString()}...`);
    const events = await fetchTelemetryEvents({
      apiKey,
      baseURL,
      sessionId: args.sessionId,
      since: replayStart,
      until: replayEnd,
      categories: args.categories,
    });

    const srt = buildSrt(events, replayStart, replayEnd, args.cueSeconds, args.maxLines);
    const output = outputPathForReplay(args.outputDir, replay.replay_id);
    const cueCount = srt.trim() ? srt.trim().split(/\n\n/).length : 0;
    await writeFile(output, srt, "utf8");

    console.error(`  wrote ${output} (${events.length} events, ${cueCount} cues)`);
    if (!replay.finished_at) {
      console.error("  note: replay has no finished_at yet, so this SRT covers telemetry through the current time.");
    }
    written++;
    totalEvents += events.length;
    totalCues += cueCount;
  }

  console.error(`Done. Wrote ${written} SRT file(s) to ${args.outputDir}.`);
  console.error(`Session: ${args.sessionId}`);
  console.error(`Telemetry events fetched: ${totalEvents}`);
  console.error(`Subtitle cues: ${totalCues}`);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
