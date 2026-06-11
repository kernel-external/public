# Session Usage Export

CLI tool that queries the Kernel API for your past browser sessions and exports them to CSV, with an estimated usage cost per session.

## Setup

```bash
npm install
```

## Usage

```bash
# With API key in env
export KERNEL_API_KEY=your_api_key
npx tsx index.ts                       # prompts for start/end dates
npx tsx index.ts 2026-03-01 2026-03-31 # non-interactive

# Or run with no env var and it will prompt for the key
npx tsx index.ts
```

Dates are `YYYY-MM-DD`. The tool fetches all sessions created in that range and writes `sessions_<start>_<end>.csv`, then prints a summary (sessions, hours, and estimated cost broken down by browser type) to stderr.

### CSV Columns

| Column | Description |
|--------|-------------|
| `session_id` | Unique session identifier |
| `created_at` | ISO timestamp when the session was created |
| `deleted_at` | ISO timestamp when the session was deleted (empty if still active) |
| `usage_time` | Human-readable usage duration (e.g. `0h 5m 30s`) or `active` if still running |
| `usage_ms` | Usage time in milliseconds |
| `usage_seconds` | Usage time in seconds |
| `browser_type` | One of: `headful`, `headless`, `gpu` |
| `rate_usd_per_sec` | Per-second usage rate applied for this browser type |
| `est_cost_usd` | Estimated usage cost = `usage_seconds × rate_usd_per_sec` |
| `pool_id` | Browser pool ID (empty if not from a pool) |
| `pool_name` | Browser pool name (empty if unnamed or not from a pool) |

### Cost estimate

`est_cost_usd` uses Kernel's published per-second usage rates, which already
account for each browser type's memory footprint:

| Browser type | Memory | Rate (USD / second) |
|--------------|--------|---------------------|
| `headless` | 1 GB | 0.0000166667 |
| `headful` | 8 GB | 0.0001333336 |
| `gpu` | 48 GB | 0.0008000016 |

This is a **usage estimate only**. It does not include your plan's monthly
subscription fee or included monthly credits, and it does not reflect any
custom contract pricing. Your invoice is always the source of truth. See
[Pricing](https://docs.onkernel.com/info/pricing) for details. If you don't
need live view or stealth, `headless` browsers bill at 1 GB instead of
headful's 8 GB — roughly 8x cheaper.

### Output

CSV is written to a file. Progress and the summary are printed to stderr, so
you can pipe stdout if needed.
