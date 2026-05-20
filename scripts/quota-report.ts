#!/usr/bin/env bun
/**
 * quota-report.ts — subscription quota burn analysis from claude-max-stats.jsonl
 *
 * Phase 3 of claude-code-discipline-sdk PRP (rev 1.1.0). Implements REQ-06 +
 * US-01 AC-01.2 / AC-01.3: operator can answer "what TTL setting burns my
 * quota slower for my use pattern?" by reading one report.
 *
 * Algorithm:
 *   1. Stream-read `~/.claude-local/claude-max-stats.jsonl` line-by-line
 *      (file is 60MB+; do NOT load whole thing into memory).
 *   2. Filter entries where `rateLimit.claim === "five_hour"` AND
 *      `rateLimit.util5h` is present.
 *   3. Detect Δ`util5h` jumps of ≥0.01 (= 1 percentage point).
 *   4. Between jumps, sum: cacheRead, cacheWrite (aggregate),
 *      cacheWrite5m (Phase 3.B), cacheWrite1h (Phase 3.B), in, out.
 *   5. Aggregate across all jumps → tokens-per-1%-util5h per category.
 *
 * Output: markdown to stdout. Operator pipes to file if needed.
 *
 * Exit codes:
 *   0 — report generated successfully
 *   1 — insufficient data (no five_hour entries OR no util5h jumps)
 *   2 — file read / parse error
 *
 * Flags:
 *   --compare-baseline <path>  optional bookmarked baseline file
 *   --limit N                  show last N jumps (default 10)
 *   --since YYYY-MM-DD         filter date range (inclusive)
 *
 * Usage:
 *   bun run scripts/quota-report.ts
 *   bun run scripts/quota-report.ts --limit 25 --since 2026-05-10
 *
 * @see PRP claude-code-discipline-sdk.md §US-01 AC-01.2 + REQ-06 + REQ-05
 * @see CR-01 (flag with kill-switch), CR-13 (script in scripts/ is NEW file)
 * @see CN-09 (no bare-catches — all catches narrow + log)
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

interface StatsEntry {
  ts: string;
  pid?: number | string;
  ses?: string;
  type?: string;
  model?: string;
  dur?: number;
  stop?: string;
  usage?: {
    in?: number;
    out?: number;
    cacheRead?: number;
    cacheWrite?: number;
    /** Phase 3.B subfield — ephemeral_5m_input_tokens, optional */
    cacheWrite5m?: number;
    /** Phase 3.B subfield — ephemeral_1h_input_tokens, optional */
    cacheWrite1h?: number;
    /** Phase 3.B subfield — cache_deleted_input_tokens, optional */
    cacheDeleted?: number;
  };
  rateLimit?: {
    status?: string;
    claim?: string;
    resetAt?: number;
    util5h?: number;
    util7d?: number;
  };
}

interface Jump {
  fromUtil5h: number;
  toUtil5h: number;
  /** Δutil5h × 100 = % increase (e.g. 1 means 1 percentage point) */
  deltaPct: number;
  turns: number;
  sumCacheRead: number;
  sumCacheWrite: number;
  sumCacheWrite5m: number;
  sumCacheWrite1h: number;
  sumIn: number;
  sumOut: number;
  /** how many entries in the window actually had cacheWrite5m present */
  cw5mPresentCount: number;
  cw1hPresentCount: number;
  startTs: string;
  endTs: string;
}

interface Aggregate {
  totalTurns: number;
  jumpsAnalyzed: number;
  totalDeltaPct: number;
  sumCacheRead: number;
  sumCacheWrite: number;
  sumCacheWrite5m: number;
  sumCacheWrite1h: number;
  sumIn: number;
  sumOut: number;
  cw5mPresentJumps: number;
  cw1hPresentJumps: number;
  totalDeltaPctCw5m: number;
  totalDeltaPctCw1h: number;
}

interface CliFlags {
  baselinePath: string | null;
  limit: number;
  since: string | null;
}

// ────────────────────────────────────────────────────────────────────
// CLI parsing
// ────────────────────────────────────────────────────────────────────

function parseCli(argv: string[]): CliFlags {
  const flags: CliFlags = { baselinePath: null, limit: 10, since: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--compare-baseline") {
      flags.baselinePath = argv[++i] ?? null;
    } else if (a === "--limit") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--limit requires a positive number, got: ${argv[i]}`);
      }
      flags.limit = Math.floor(n);
    } else if (a === "--since") {
      flags.since = argv[++i] ?? null;
      if (flags.since && !/^\d{4}-\d{2}-\d{2}$/.test(flags.since)) {
        throw new Error(`--since requires YYYY-MM-DD, got: ${flags.since}`);
      }
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
  return flags;
}

function printHelp(): void {
  process.stdout.write(
    [
      "quota-report.ts — subscription quota burn analysis",
      "",
      "Usage:",
      "  bun run scripts/quota-report.ts [flags]",
      "",
      "Flags:",
      "  --compare-baseline <path>  optional bookmarked baseline file",
      "  --limit N                  show last N jumps (default 10)",
      "  --since YYYY-MM-DD         filter date range (inclusive)",
      "  --help, -h                 this help",
      "",
      "Exit codes: 0 OK · 1 insufficient data · 2 file error",
      "",
    ].join("\n"),
  );
}

// ────────────────────────────────────────────────────────────────────
// Streaming parse
// ────────────────────────────────────────────────────────────────────

interface ParseResult {
  entries: StatsEntry[];
  parseErrors: number;
  filteredOut: number;
  totalLines: number;
}

/**
 * Stream-read the JSONL file. We keep ONLY the filtered five_hour entries
 * with util5h present in memory — bounded by file size but typically MUCH
 * smaller than the raw 60MB (~200K lines).
 *
 * Each kept entry is small (~200 bytes). 200K entries → ~40MB max in mem.
 * For the current ~230K-line file this is fine; if it grows 10×, switch
 * to a two-pass approach that aggregates inline.
 */
async function streamParse(
  filePath: string,
  since: string | null,
): Promise<ParseResult> {
  const result: ParseResult = {
    entries: [],
    parseErrors: 0,
    filteredOut: 0,
    totalLines: 0,
  };

  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const sinceCutoff = since ? `${since}T00:00:00.000Z` : null;

  for await (const line of rl) {
    if (!line.trim()) continue;
    result.totalLines++;
    let parsed: StatsEntry;
    try {
      parsed = JSON.parse(line) as StatsEntry;
    } catch (err) {
      // NOT a bare catch — we log + narrow to JSON parse failure.
      result.parseErrors++;
      if (result.parseErrors <= 3) {
        process.stderr.write(
          `[quota-report] line ${result.totalLines} JSON parse failed: ${(err as Error).message.slice(0, 80)}\n`,
        );
      }
      continue;
    }
    // Filter: five_hour claim with util5h
    if (parsed.rateLimit?.claim !== "five_hour") {
      result.filteredOut++;
      continue;
    }
    if (typeof parsed.rateLimit?.util5h !== "number") {
      result.filteredOut++;
      continue;
    }
    if (sinceCutoff && parsed.ts < sinceCutoff) {
      result.filteredOut++;
      continue;
    }
    result.entries.push(parsed);
  }

  return result;
}

// ────────────────────────────────────────────────────────────────────
// Jump detection + aggregation
// ────────────────────────────────────────────────────────────────────

/**
 * Walk entries chronologically. When util5h increases by ≥0.01 (1pp),
 * close the current window into a Jump record. Entries with non-increasing
 * util5h are accumulated into the in-progress window.
 *
 * We treat util5h reset (next value LOWER than prev — quota window rolled
 * over) as window-close-without-jump (the accumulator is discarded; new
 * window starts from the reset point). This avoids fake mega-jumps.
 */
function detectJumps(entries: StatsEntry[]): Jump[] {
  if (entries.length < 2) return [];

  // Ensure chronological order (file is append-only but sort defensively).
  const sorted = [...entries].sort((a, b) => (a.ts < b.ts ? -1 : 1));

  const jumps: Jump[] = [];

  let windowStart: StatsEntry = sorted[0]!;
  let acc = freshAcc();
  let lastUtil = windowStart.rateLimit!.util5h!;

  for (let i = 1; i < sorted.length; i++) {
    const e = sorted[i]!;
    const u = e.rateLimit!.util5h!;
    // Always count THIS entry's usage into the active window
    accumulate(acc, e);

    if (u < lastUtil - 0.001) {
      // Window reset (quota rolled over). Discard accumulator, restart.
      windowStart = e;
      acc = freshAcc();
      lastUtil = u;
      continue;
    }

    const delta = u - lastUtil;
    if (delta >= 0.01 - 1e-9) {
      // Close jump window
      jumps.push({
        fromUtil5h: round2(lastUtil),
        toUtil5h: round2(u),
        deltaPct: round2(delta * 100),
        turns: acc.turns,
        sumCacheRead: acc.cR,
        sumCacheWrite: acc.cW,
        sumCacheWrite5m: acc.cW5m,
        sumCacheWrite1h: acc.cW1h,
        sumIn: acc.in,
        sumOut: acc.out,
        cw5mPresentCount: acc.cw5mPresent,
        cw1hPresentCount: acc.cw1hPresent,
        startTs: windowStart.ts,
        endTs: e.ts,
      });
      lastUtil = u;
      windowStart = e;
      acc = freshAcc();
    }
  }
  return jumps;
}

interface Acc {
  turns: number;
  cR: number;
  cW: number;
  cW5m: number;
  cW1h: number;
  in: number;
  out: number;
  cw5mPresent: number;
  cw1hPresent: number;
}

function freshAcc(): Acc {
  return {
    turns: 0,
    cR: 0,
    cW: 0,
    cW5m: 0,
    cW1h: 0,
    in: 0,
    out: 0,
    cw5mPresent: 0,
    cw1hPresent: 0,
  };
}

function accumulate(acc: Acc, e: StatsEntry): void {
  acc.turns++;
  const u = e.usage ?? {};
  acc.cR += u.cacheRead ?? 0;
  acc.cW += u.cacheWrite ?? 0;
  acc.in += u.in ?? 0;
  acc.out += u.out ?? 0;
  if (typeof u.cacheWrite5m === "number") {
    acc.cW5m += u.cacheWrite5m;
    acc.cw5mPresent++;
  }
  if (typeof u.cacheWrite1h === "number") {
    acc.cW1h += u.cacheWrite1h;
    acc.cw1hPresent++;
  }
}

function aggregate(jumps: Jump[]): Aggregate {
  const agg: Aggregate = {
    totalTurns: 0,
    jumpsAnalyzed: jumps.length,
    totalDeltaPct: 0,
    sumCacheRead: 0,
    sumCacheWrite: 0,
    sumCacheWrite5m: 0,
    sumCacheWrite1h: 0,
    sumIn: 0,
    sumOut: 0,
    cw5mPresentJumps: 0,
    cw1hPresentJumps: 0,
    totalDeltaPctCw5m: 0,
    totalDeltaPctCw1h: 0,
  };
  for (const j of jumps) {
    agg.totalTurns += j.turns;
    agg.totalDeltaPct += j.deltaPct;
    agg.sumCacheRead += j.sumCacheRead;
    agg.sumCacheWrite += j.sumCacheWrite;
    agg.sumCacheWrite5m += j.sumCacheWrite5m;
    agg.sumCacheWrite1h += j.sumCacheWrite1h;
    agg.sumIn += j.sumIn;
    agg.sumOut += j.sumOut;
    if (j.cw5mPresentCount > 0) {
      agg.cw5mPresentJumps++;
      agg.totalDeltaPctCw5m += j.deltaPct;
    }
    if (j.cw1hPresentCount > 0) {
      agg.cw1hPresentJumps++;
      agg.totalDeltaPctCw1h += j.deltaPct;
    }
  }
  return agg;
}

// ────────────────────────────────────────────────────────────────────
// Report formatting
// ────────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "-";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

function fmtPerPct(sum: number, deltaPct: number): string {
  if (deltaPct <= 0) return "-";
  return fmtNum(sum / deltaPct);
}

function fmtRatio(num: number, denom: number): string {
  if (denom <= 0 || !Number.isFinite(denom)) return "-";
  return `${(num / denom).toFixed(2)}×`;
}

function fmtDate(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

function buildReport(
  filePath: string,
  parse: ParseResult,
  jumps: Jump[],
  agg: Aggregate,
  cliLimit: number,
  since: string | null,
  baseline: Aggregate | null,
): string {
  const lines: string[] = [];
  lines.push("# Quota Report — Subscription Burn Analysis");
  lines.push("");
  lines.push(`**Source:** ${filePath}`);
  lines.push(`**Window:** five_hour quota`);
  lines.push(`**Total lines scanned:** ${parse.totalLines}`);
  lines.push(`**Entries analyzed (after filtering):** ${parse.entries.length}`);
  if (parse.filteredOut > 0)
    lines.push(`**Filtered out (non-five_hour / no util5h / pre-since):** ${parse.filteredOut}`);
  if (parse.parseErrors > 0)
    lines.push(`**JSON parse errors (skipped):** ${parse.parseErrors}`);
  lines.push(`**util5h jumps detected (Δ≥0.01):** ${jumps.length}`);
  if (parse.entries.length > 0) {
    const first = parse.entries[0]!;
    const last = parse.entries[parse.entries.length - 1]!;
    lines.push(`**Date range:** ${fmtDate(first.ts)} .. ${fmtDate(last.ts)}`);
  }
  if (since) lines.push(`**--since filter:** ${since}`);
  lines.push("");

  // Section 1: per-category tokens-per-1%-util5h
  lines.push("## Tokens per +1% util5h (aggregate across all jumps)");
  lines.push("");
  const perCR = agg.totalDeltaPct > 0 ? agg.sumCacheRead / agg.totalDeltaPct : 0;
  lines.push("| Token Kind | Per +1% util5h | Effective Weight (vs cR baseline) | Notes |");
  lines.push("|---|---|---|---|");
  lines.push(
    `| cache_read | ${fmtPerPct(agg.sumCacheRead, agg.totalDeltaPct)} | 1.00× | baseline |`,
  );
  lines.push(
    `| cache_write (aggregate) | ${fmtPerPct(agg.sumCacheWrite, agg.totalDeltaPct)} | ${perCR > 0 ? fmtRatio(perCR, agg.sumCacheWrite / Math.max(agg.totalDeltaPct, 1e-9)) : "-"} | 5m+1h combined |`,
  );
  if (agg.cw5mPresentJumps > 0) {
    lines.push(
      `| cache_write (5m) | ${fmtPerPct(agg.sumCacheWrite5m, agg.totalDeltaPctCw5m)} | ${perCR > 0 && agg.totalDeltaPctCw5m > 0 ? fmtRatio(perCR, agg.sumCacheWrite5m / agg.totalDeltaPctCw5m) : "-"} | over ${agg.cw5mPresentJumps} jumps with cW5m present |`,
    );
  } else {
    lines.push(`| cache_write (5m) | n/a | n/a | NOT YET CAPTURED — Phase 3.B subfield missing |`);
  }
  if (agg.cw1hPresentJumps > 0) {
    lines.push(
      `| cache_write (1h) | ${fmtPerPct(agg.sumCacheWrite1h, agg.totalDeltaPctCw1h)} | ${perCR > 0 && agg.totalDeltaPctCw1h > 0 ? fmtRatio(perCR, agg.sumCacheWrite1h / agg.totalDeltaPctCw1h) : "-"} | over ${agg.cw1hPresentJumps} jumps with cW1h present |`,
    );
  } else {
    lines.push(`| cache_write (1h) | n/a | n/a | NOT YET CAPTURED — Phase 3.B subfield missing |`);
  }
  lines.push(
    `| input_tokens | ${fmtPerPct(agg.sumIn, agg.totalDeltaPct)} | ${perCR > 0 ? fmtRatio(perCR, agg.sumIn / Math.max(agg.totalDeltaPct, 1e-9)) : "-"} | uncached input |`,
  );
  lines.push(
    `| output_tokens | ${fmtPerPct(agg.sumOut, agg.totalDeltaPct)} | ${perCR > 0 ? fmtRatio(perCR, agg.sumOut / Math.max(agg.totalDeltaPct, 1e-9)) : "-"} | |`,
  );
  lines.push("");

  // Section 2: 5m vs 1h comparison
  lines.push("## 5m vs 1h Cache-Write Quota Cost Comparison");
  lines.push("");
  if (agg.cw5mPresentJumps > 0 && agg.cw1hPresentJumps > 0) {
    const per5m = agg.sumCacheWrite5m / agg.totalDeltaPctCw5m;
    const per1h = agg.sumCacheWrite1h / agg.totalDeltaPctCw1h;
    // Lower per-1% means more tokens consumed PER quota unit, i.e. CHEAPER quota cost
    // Higher per-1% means each quota unit is bought with MORE tokens → cheaper. So if
    // 1h costs MORE per quota-unit, it burns quota faster → per-1% is LOWER.
    // We want: 1h quota cost / 5m quota cost = (1 / per1h) / (1 / per5m) = per5m / per1h
    const ratio = per5m / per1h;
    lines.push(`- per 1% util5h via cache_write_5m: **${fmtNum(per5m)}** tokens`);
    lines.push(`- per 1% util5h via cache_write_1h: **${fmtNum(per1h)}** tokens`);
    lines.push(`- 1h cache_write empirical quota cost ratio: **${ratio.toFixed(2)}×** more per quota-unit than 5m`);
    lines.push(`- Theoretical prediction: ~1.60× (public docs $-pricing: 1h_write 2.0× base, 5m_write 1.25× base → 2.0/1.25 = 1.6)`);
    if (ratio >= 1.1 && ratio <= 2.1) {
      lines.push(`- **Empirical / theoretical match: YES** (within ±30% of 1.6×)`);
    } else {
      lines.push(`- **Empirical / theoretical match: SURPRISE** — document in quota-mechanics.md`);
    }
  } else {
    const missing: string[] = [];
    if (agg.cw5mPresentJumps === 0) missing.push("cacheWrite5m");
    if (agg.cw1hPresentJumps === 0) missing.push("cacheWrite1h");
    lines.push(
      `- **INSUFFICIENT DATA:** ${missing.join(" and ")} not observed in stats yet.`,
    );
    lines.push(
      "- These optional subfields are populated by claude-max-proxy Subtask 3.B (response-stream parser that extracts `usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`).",
    );
    lines.push(
      "- Until Subtask 3.B ships AND traffic flows under both TTLs, only the aggregate `cacheWrite` column above is meaningful.",
    );
    lines.push(
      "- To compare empirically: set `CACHE_CONTROL_TTL=5m` env var on a parallel opencode session for a known duration, then re-run this report.",
    );
  }
  lines.push("");

  // Section 3: last N jumps detail
  const tail = jumps.slice(-cliLimit);
  lines.push(`## Last ${tail.length} util5h Jumps (debugging detail)`);
  lines.push("");
  lines.push("| util5h | turns | cR_sum | cW_sum | cW5m_sum | cW1h_sum | in_sum | out_sum | start..end |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const j of tail) {
    const cw5mCell = j.cw5mPresentCount > 0 ? fmtNum(j.sumCacheWrite5m) : "—";
    const cw1hCell = j.cw1hPresentCount > 0 ? fmtNum(j.sumCacheWrite1h) : "—";
    lines.push(
      `| ${j.fromUtil5h.toFixed(2)}→${j.toUtil5h.toFixed(2)} | ${j.turns} | ${fmtNum(j.sumCacheRead)} | ${fmtNum(j.sumCacheWrite)} | ${cw5mCell} | ${cw1hCell} | ${fmtNum(j.sumIn)} | ${fmtNum(j.sumOut)} | ${fmtDate(j.startTs)}..${fmtDate(j.endTs)} |`,
    );
  }
  lines.push("");

  // Section 4: baseline comparison
  if (baseline) {
    lines.push("## Baseline Comparison");
    lines.push("");
    const baseCR = baseline.totalDeltaPct > 0 ? baseline.sumCacheRead / baseline.totalDeltaPct : 0;
    const nowCR = agg.totalDeltaPct > 0 ? agg.sumCacheRead / agg.totalDeltaPct : 0;
    const baseCW = baseline.totalDeltaPct > 0 ? baseline.sumCacheWrite / baseline.totalDeltaPct : 0;
    const nowCW = agg.totalDeltaPct > 0 ? agg.sumCacheWrite / agg.totalDeltaPct : 0;
    lines.push("| Metric | Baseline | Current | Δ |");
    lines.push("|---|---|---|---|");
    lines.push(`| cache_read per 1% util5h | ${fmtNum(baseCR)} | ${fmtNum(nowCR)} | ${baseCR > 0 ? fmtRatio(nowCR, baseCR) : "-"} |`);
    lines.push(`| cache_write per 1% util5h | ${fmtNum(baseCW)} | ${fmtNum(nowCW)} | ${baseCW > 0 ? fmtRatio(nowCW, baseCW) : "-"} |`);
    lines.push(`| Jumps in window | ${baseline.jumpsAnalyzed} | ${agg.jumpsAnalyzed} | ${agg.jumpsAnalyzed - baseline.jumpsAnalyzed > 0 ? "+" : ""}${agg.jumpsAnalyzed - baseline.jumpsAnalyzed} |`);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(
    "_Generated by `scripts/quota-report.ts` — see PRP claude-code-discipline-sdk.md §REQ-06, AC-01.2._",
  );
  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────────────
// Baseline file (JSON) load — for --compare-baseline
// ────────────────────────────────────────────────────────────────────

async function loadBaseline(path: string): Promise<Aggregate | null> {
  const { readFile } = await import("node:fs/promises");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    process.stderr.write(
      `[quota-report] WARN: --compare-baseline could not read '${path}': ${(err as Error).message}\n`,
    );
    return null;
  }
  // Baseline files can be either:
  //  (a) a previous stats.jsonl snapshot (run streamParse+detectJumps+aggregate),
  //  (b) a pre-computed JSON Aggregate object dumped by a prior run.
  // We auto-detect via first non-blank line.
  const first = raw.split("\n").find((l) => l.trim());
  if (!first) return null;
  if (first.startsWith("{") && first.includes('"sumCacheRead"')) {
    // (b) pre-computed aggregate JSON
    try {
      return JSON.parse(raw) as Aggregate;
    } catch (err) {
      process.stderr.write(
        `[quota-report] WARN: baseline JSON parse failed: ${(err as Error).message}\n`,
      );
      return null;
    }
  }
  // (a) treat as jsonl, full pipeline
  const parsed = await streamParse(path, null);
  const jumps = detectJumps(parsed.entries);
  return aggregate(jumps);
}

// ────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  let cli: CliFlags;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[quota-report] ${(err as Error).message}\n`);
    printHelp();
    return 2;
  }

  const filePath = join(homedir(), ".claude-local", "claude-max-stats.jsonl");
  let parse: ParseResult;
  try {
    parse = await streamParse(filePath, cli.since);
  } catch (err) {
    process.stderr.write(
      `[quota-report] ERROR reading ${filePath}: ${(err as Error).message}\n`,
    );
    return 2;
  }

  if (parse.entries.length === 0) {
    process.stderr.write(
      `[quota-report] INSUFFICIENT DATA: 0 five_hour entries with util5h found (scanned ${parse.totalLines} lines, ${parse.filteredOut} filtered).\n`,
    );
    return 1;
  }

  const jumps = detectJumps(parse.entries);
  if (jumps.length === 0) {
    process.stderr.write(
      `[quota-report] INSUFFICIENT DATA: 0 util5h jumps (Δ≥0.01) detected across ${parse.entries.length} entries. util5h may be flat / monotonic-reset only.\n`,
    );
    return 1;
  }
  const agg = aggregate(jumps);

  let baseline: Aggregate | null = null;
  if (cli.baselinePath) {
    baseline = await loadBaseline(cli.baselinePath);
  }

  const report = buildReport(
    filePath,
    parse,
    jumps,
    agg,
    cli.limit,
    cli.since,
    baseline,
  );
  process.stdout.write(report + "\n");
  return 0;
}

// Top-level: invoke main when run directly. `import.meta.main` is bun-native.
if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      // Catch is narrow: only handles top-level main() rejection, logs full
      // error, exits with file-read error code (CN-09 — not bare).
      process.stderr.write(
        `[quota-report] FATAL: ${(err as Error).stack ?? String(err)}\n`,
      );
      process.exit(2);
    },
  );
}

// Exports for unit testing (currently no tests required by Subtask 3.C,
// but published so a future task can add them without restructuring).
export {
  parseCli,
  streamParse,
  detectJumps,
  aggregate,
  buildReport,
  loadBaseline,
};
export type { StatsEntry, Jump, Aggregate, CliFlags, ParseResult };
