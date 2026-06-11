import Kernel from "@onkernel/sdk";
import { createInterface } from "node:readline";
import { createWriteStream } from "node:fs";

const rl = createInterface({
  input: process.stdin,
  output: process.stderr,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function parseDate(input: string): Date {
  const d = new Date(input);
  if (isNaN(d.getTime())) {
    console.error(`Invalid date: ${input}`);
    process.exit(1);
  }
  return d;
}

// Per-second usage rates in USD. These already account for each browser
// type's memory footprint (headless = 1 GB, headful = 8 GB, GPU = 48 GB)
// at the base price of $0.0000166667 / GB-second.
const RATE_USD_PER_SEC = {
  headless: 0.0000166667,
  headful: 0.0001333336,
  gpu: 0.0008000016,
} as const;

type BrowserType = keyof typeof RATE_USD_PER_SEC;

function getBrowserType(headless: boolean, gpu?: boolean): BrowserType {
  if (gpu) return "gpu";
  if (headless) return "headless";
  return "headful";
}

function formatMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

function escapeCSV(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

async function main() {
  const args = process.argv.slice(2);

  let apiKey: string;
  let startInput: string;
  let endInput: string;

  if (args.length >= 2) {
    // Non-interactive: npx tsx index.ts <start> <end>
    startInput = args[0];
    endInput = args[1];
    apiKey = process.env.KERNEL_API_KEY ?? "";
    if (!apiKey) {
      console.error("KERNEL_API_KEY env var required in non-interactive mode.");
      process.exit(1);
    }
  } else {
    // Interactive: prompt for everything
    apiKey = process.env.KERNEL_API_KEY ?? "";
    if (!apiKey) {
      apiKey = await ask("Enter your Kernel API key: ");
      if (!apiKey.trim()) {
        console.error("API key is required.");
        process.exit(1);
      }
    }
    startInput = await ask("Start date (YYYY-MM-DD): ");
    endInput = await ask("End date (YYYY-MM-DD): ");
    rl.close();
  }

  const startDate = parseDate(startInput);
  const endDate = parseDate(endInput);
  endDate.setHours(23, 59, 59, 999);

  if (endDate < startDate) {
    console.error("End date must be after start date.");
    process.exit(1);
  }

  const client = new Kernel({ apiKey });

  const outputFile = `sessions_${startInput}_${endInput}.csv`;
  const ws = createWriteStream(outputFile);
  const columns = [
    "session_id",
    "created_at",
    "deleted_at",
    "usage_time",
    "usage_ms",
    "usage_seconds",
    "browser_type",
    "rate_usd_per_sec",
    "est_cost_usd",
    "pool_id",
    "pool_name",
  ];
  ws.write(columns.join(",") + "\n");

  console.error(`Fetching sessions from ${startInput} to ${endInput}...`);

  let count = 0;
  let scanned = 0;

  // Running totals for the summary.
  let totalMs = 0;
  let totalCost = 0;
  const byType: Record<BrowserType, { count: number; ms: number; cost: number }> = {
    headless: { count: 0, ms: 0, cost: 0 },
    headful: { count: 0, ms: 0, cost: 0 },
    gpu: { count: 0, ms: 0, cost: 0 },
  };

  for await (const session of client.browsers.list({
    status: "all",
    limit: 100,
  })) {
    scanned++;
    const createdAt = new Date(session.created_at);

    // Sessions are returned newest-first. Once we pass the start date, stop.
    if (createdAt < startDate) break;
    if (createdAt > endDate) continue;

    const uptimeMs = session.usage?.uptime_ms ?? 0;
    const uptimeSec = uptimeMs / 1000;
    const browserType = getBrowserType(session.headless, session.gpu);
    const rate = RATE_USD_PER_SEC[browserType];
    const estCost = uptimeSec * rate;

    const row = [
      escapeCSV(session.session_id),
      escapeCSV(session.created_at),
      escapeCSV(session.deleted_at ?? ""),
      escapeCSV(uptimeMs > 0 ? formatMs(uptimeMs) : "active"),
      String(uptimeMs),
      uptimeSec.toFixed(3),
      escapeCSV(browserType),
      rate.toFixed(10),
      estCost.toFixed(6),
      escapeCSV(session.pool?.id ?? ""),
      escapeCSV(session.pool?.name ?? ""),
    ];
    ws.write(row.join(",") + "\n");
    count++;

    totalMs += uptimeMs;
    totalCost += estCost;
    byType[browserType].count++;
    byType[browserType].ms += uptimeMs;
    byType[browserType].cost += estCost;

    if (scanned % 500 === 0) {
      console.error(`  scanned ${scanned} sessions, matched ${count}...`);
    }
  }

  ws.end();

  // Print a summary to stderr so it doesn't pollute the CSV.
  const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
  const fmtHrs = (ms: number) => (ms / 3_600_000).toFixed(2);
  console.error(`\nDone. ${count} sessions written to ${outputFile} (scanned ${scanned}).`);
  console.error(`\nSummary (${startInput} to ${endInput}):`);
  for (const t of ["headful", "headless", "gpu"] as BrowserType[]) {
    const b = byType[t];
    if (b.count === 0) continue;
    console.error(`  ${t.padEnd(9)} ${String(b.count).padStart(6)} sessions  ${fmtHrs(b.ms).padStart(9)} hrs  ${fmtUsd(b.cost).padStart(11)}`);
  }
  console.error(`  ${"TOTAL".padEnd(9)} ${String(count).padStart(6)} sessions  ${fmtHrs(totalMs).padStart(9)} hrs  ${fmtUsd(totalCost).padStart(11)}`);
  console.error(`\nNote: est_cost_usd is a usage estimate based on published per-second rates and`);
  console.error(`does not include your plan's monthly subscription or included credits. Your`);
  console.error(`invoice is the source of truth.`);
}

main().catch((err) => {
  console.error("Error:", err.message ?? err);
  process.exit(1);
});
