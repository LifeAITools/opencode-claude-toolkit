#!/usr/bin/env python3
"""
Claude Max Plan — Token Budget & Cost Analysis

Reads ~/.claude/claude-max-stats.log and calculates:
- Token consumption (output, input, cache read/write)
- Plan budget estimation from utilization data
- API cost equivalent (Opus 4.6 pricing)
- Remaining allowance and runway
- Cache savings analysis

Usage:
  python3 scripts/budget-analysis.py                         # Today, markdown
  python3 scripts/budget-analysis.py 2026-04-04              # Specific date
  python3 scripts/budget-analysis.py --all                   # All time
  python3 scripts/budget-analysis.py --json                  # JSON to stdout
  python3 scripts/budget-analysis.py --json --out report.json
  python3 scripts/budget-analysis.py --md                    # Markdown to stdout
  python3 scripts/budget-analysis.py --md --out report.md
"""

import argparse
import json
import re
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

# ─── Opus 4.6 Pricing (per token) ───────────────────────────
PRICE_INPUT = 15.0 / 1_000_000
PRICE_OUTPUT = 75.0 / 1_000_000
PRICE_CACHE_READ = 1.875 / 1_000_000
PRICE_CACHE_WRITE = 18.75 / 1_000_000

STATS_LOG = Path.home() / ".claude" / "claude-max-stats.log"


# ─── ASCII Graph Helpers ────────────────────────────────────
def bar(value, max_value, width=40):
    """Render a horizontal bar: █████░░░░░"""
    filled = int(value / max(max_value, 1) * width)
    return "█" * filled + "░" * (width - filled)


def gauge(fraction, width=20):
    """Render a utilization gauge: [████████░░░░░░░░] 41%"""
    fraction = max(0.0, min(1.0, fraction))
    filled = int(fraction * width)
    return f"[{'█' * filled}{'░' * (width - filled)}] {fraction * 100:.0f}%"


def fmt(n):
    """Format number with commas."""
    return f"{n:,.0f}" if isinstance(n, (int, float)) else str(n)


def dollar(n):
    """Format as dollar amount."""
    return f"${n:,.2f}"


# ─── Log Parsing ────────────────────────────────────────────
def parse_line(line):
    """Extract fields from a stats log line."""
    result = {}
    for key, pat in [
        ("ts", r"\[([^\]]+)\]"),
        ("type", r"type=(\S+)"),
        ("model", r"model=(\S+)"),
        ("out", r"out=(\d+)"),
        ("inp", r"in=(\d+)"),
        ("cr", r"cacheRead=(\d+)"),
        ("cw", r"cacheWrite=(\d+)"),
        ("u5", r"util5h=([0-9.]+)"),
        ("u7", r"util7d=([0-9.]+)"),
        ("pid", r"pid=(\d+)"),
        ("claim", r"claim=(\S+)"),
        ("dur", r"dur=(\d+)"),
    ]:
        m = re.search(pat, line)
        if m:
            val = m.group(1)
            if key in ("out", "inp", "cr", "cw", "pid", "dur"):
                val = int(val)
            elif key in ("u5", "u7"):
                val = float(val)
            result[key] = val
    return result


def load_data(date_filter=None):
    """Load and filter stats log entries."""
    if not STATS_LOG.exists():
        print(f"Error: {STATS_LOG} not found", file=sys.stderr)
        sys.exit(1)

    streams = []
    keepalives = []

    for line in STATS_LOG.read_text().splitlines():
        if date_filter and date_filter not in line:
            continue
        d = parse_line(line)
        if not d.get("type"):
            continue
        if d["type"] == "stream":
            streams.append(d)
        elif d["type"] == "keepalive":
            keepalives.append(d)

    return streams, keepalives


# ─── Compute All Stats ─────────────────────────────────────
def compute_stats(streams, keepalives, label):
    """Compute all stats into a structured dict."""

    # Token totals
    s_out = sum(d.get("out", 0) for d in streams)
    s_inp = sum(d.get("inp", 0) for d in streams)
    s_cr = sum(d.get("cr", 0) for d in streams)
    s_cw = sum(d.get("cw", 0) for d in streams)

    k_out = sum(d.get("out", 0) for d in keepalives)
    k_inp = sum(d.get("inp", 0) for d in keepalives)
    k_cr = sum(d.get("cr", 0) for d in keepalives)
    k_cw = sum(d.get("cw", 0) for d in keepalives)

    t_out = s_out + k_out
    t_inp = s_inp + k_inp
    t_cr = s_cr + k_cr
    t_cw = s_cw + k_cw

    # Utilization
    with_u5 = [d for d in streams if d.get("u5") is not None and d["u5"] > 0]
    with_u7 = [d for d in streams if d.get("u7") is not None and d["u7"] > 0]

    first_u5 = with_u5[0]["u5"] if with_u5 else 0
    last_u5 = with_u5[-1]["u5"] if with_u5 else 0
    first_u7 = with_u7[0]["u7"] if with_u7 else 0
    last_u7 = with_u7[-1]["u7"] if with_u7 else 0

    u5_consumed = last_u5 - first_u5
    u7_consumed = last_u7 - first_u7

    claim = streams[-1].get("claim", "unknown") if streams else "unknown"
    first_ts = streams[0].get("ts", "?") if streams else "?"
    last_ts = streams[-1].get("ts", "?") if streams else "?"

    # Extract time portion from timestamps
    first_time = first_ts[11:19] if len(first_ts) >= 19 else first_ts
    last_time = last_ts[11:19] if len(last_ts) >= 19 else last_ts

    # Extract date from first timestamp
    date_str = first_ts[:10] if len(first_ts) >= 10 else label

    # Hit ratio
    total_cache = s_cr + s_cw
    hit_ratio = s_cr * 100 / max(total_cache, 1) if total_cache > 0 else 0

    # Budget derivation
    budget = {}
    if u7_consumed > 0.001:
        budget_7d_out = t_out / u7_consumed
        budget_daily_out = budget_7d_out / 7
        budget_5h_out = budget_7d_out / (7 * 24 / 5)
        budget_monthly_out = budget_daily_out * 30
        remaining_7d_out = budget_7d_out * (1 - last_u7)
        days_left = remaining_7d_out / max(t_out, 1)
        budget = {
            "5h_output": round(budget_5h_out),
            "daily_output": round(budget_daily_out),
            "7d_output": round(budget_7d_out),
            "monthly_output": round(budget_monthly_out),
            "remaining_7d": round(remaining_7d_out),
            "days_left": round(days_left, 1),
        }

    # Cost calculation
    cost_inp = t_inp * PRICE_INPUT
    cost_out = t_out * PRICE_OUTPUT
    cost_cr = t_cr * PRICE_CACHE_READ
    cost_cw = t_cw * PRICE_CACHE_WRITE
    cost_total = cost_inp + cost_out + cost_cr + cost_cw

    cost_no_cache_inp = (t_inp + t_cr + t_cw) * PRICE_INPUT
    cost_no_cache = cost_no_cache_inp + cost_out
    cache_savings = cost_no_cache - cost_total

    monthly_projection = cost_total * 30
    sub_price = 200
    value_multiplier = monthly_projection / sub_price if sub_price > 0 else 0

    # Hourly breakdown
    hourly_map = defaultdict(lambda: {"out": 0, "cr": 0, "calls": 0})
    for d in streams:
        ts = d.get("ts", "")
        h = ts[11:13] if len(ts) > 13 else "?"
        if h == "?":
            continue
        hourly_map[h]["out"] += d.get("out", 0)
        hourly_map[h]["cr"] += d.get("cr", 0)
        hourly_map[h]["calls"] += 1

    hourly = []
    for h in sorted(hourly_map):
        hourly.append(
            {
                "hour": h,
                "output": hourly_map[h]["out"],
                "cache_read": hourly_map[h]["cr"],
                "calls": hourly_map[h]["calls"],
            }
        )

    # Per-PID breakdown
    pid_map = defaultdict(lambda: {"out": 0, "cr": 0, "cw": 0, "calls": 0, "ka": 0})
    for d in streams:
        pid = str(d.get("pid", "?"))
        pid_map[pid]["out"] += d.get("out", 0)
        pid_map[pid]["cr"] += d.get("cr", 0)
        pid_map[pid]["cw"] += d.get("cw", 0)
        pid_map[pid]["calls"] += 1
    for d in keepalives:
        pid = str(d.get("pid", "?"))
        pid_map[pid]["ka"] += 1

    sessions = []
    for pid in sorted(pid_map, key=lambda p: pid_map[p]["out"], reverse=True):
        d = pid_map[pid]
        total_c = d["cr"] + d["cw"]
        ratio = f"{d['cr'] * 100 / max(total_c, 1):.0f}%" if total_c > 0 else "-"
        sessions.append(
            {
                "pid": pid,
                "calls": d["calls"],
                "keepalives": d["ka"],
                "output": d["out"],
                "cache_read": d["cr"],
                "ratio": ratio,
            }
        )

    return {
        "date": date_str,
        "label": label,
        "plan": claim,
        "time_range": {"start": first_time, "end": last_time},
        "calls": {"stream": len(streams), "keepalive": len(keepalives)},
        "tokens": {
            "output": {"stream": s_out, "keepalive": k_out, "total": t_out},
            "input": {"stream": s_inp, "keepalive": k_inp, "total": t_inp},
            "cache_read": {"stream": s_cr, "keepalive": k_cr, "total": t_cr},
            "cache_write": {"stream": s_cw, "keepalive": k_cw, "total": t_cw},
        },
        "hit_ratio": round(hit_ratio, 1),
        "utilization": {
            "util5h": {
                "start": round(first_u5, 4),
                "end": round(last_u5, 4),
                "delta": round(u5_consumed, 4),
            },
            "util7d": {
                "start": round(first_u7, 4),
                "end": round(last_u7, 4),
                "delta": round(u7_consumed, 4),
            },
        },
        "budget": budget,
        "cost": {
            "with_cache": {
                "input": round(cost_inp, 2),
                "output": round(cost_out, 2),
                "cache_read": round(cost_cr, 2),
                "cache_write": round(cost_cw, 2),
                "total": round(cost_total, 2),
            },
            "without_cache": {"total": round(cost_no_cache, 2)},
            "savings": round(cache_savings, 2),
            "monthly_projection": round(monthly_projection, 2),
            "value_multiplier": round(value_multiplier, 1),
        },
        "hourly": hourly,
        "sessions": sessions,
    }


# ─── Markdown Renderer ─────────────────────────────────────
def render_markdown(stats):
    """Render a beautiful markdown report with ASCII graphs."""
    lines = []

    def w(s=""):
        lines.append(s)

    tok = stats["tokens"]
    util = stats["utilization"]
    cost = stats["cost"]
    budget = stats["budget"]

    # ── Header ──────────────────────────────────────────────
    w("# Claude Max — Budget & Cost Analysis")
    w()
    w(f"| Field | Value |")
    w(f"|-------|-------|")
    w(f"| **Date** | {stats['date']} |")
    w(f"| **Plan** | `{stats['plan']}` |")
    w(
        f"| **Time range** | {stats['time_range']['start']} → {stats['time_range']['end']} |"
    )
    w(
        f"| **Calls** | {fmt(stats['calls']['stream'])} stream + {fmt(stats['calls']['keepalive'])} keepalive |"
    )
    w()

    # ── Utilization Gauges ──────────────────────────────────
    w("## Utilization")
    w()
    w("```")
    u5_end = util["util5h"]["end"]
    u7_end = util["util7d"]["end"]
    u5_delta = util["util5h"]["delta"]
    u7_delta = util["util7d"]["delta"]
    w(f"  5-hour window:  {gauge(u5_end, 30)}  (Δ {u5_delta:.4f})")
    w(f"  7-day  window:  {gauge(u7_end, 30)}  (Δ {u7_delta:.4f})")
    w("```")
    w()

    # ── Token Consumption Table ─────────────────────────────
    w("## Token Consumption")
    w()
    w("| Metric | Stream | Keepalive | Total |")
    w("|--------|-------:|----------:|------:|")
    for label, key in [
        ("Output", "output"),
        ("Input (uncached)", "input"),
        ("Cache read", "cache_read"),
        ("Cache write", "cache_write"),
    ]:
        t = tok[key]
        w(
            f"| {label} | {fmt(t['stream'])} | {fmt(t['keepalive'])} | {fmt(t['total'])} |"
        )
    w(f"| **Hit ratio** | | | **{stats['hit_ratio']}%** |")
    w()

    # ── Hourly Breakdown with ASCII Bar Graphs ──────────────
    w("## Hourly Breakdown")
    w()
    hourly = stats["hourly"]
    if hourly:
        max_out = max(h["output"] for h in hourly) if hourly else 1
        max_cr = max(h["cache_read"] for h in hourly) if hourly else 1
        w("### Output Tokens by Hour")
        w()
        w("```")
        for h in hourly:
            b = bar(h["output"], max_out, 35)
            w(f"  {h['hour']}:00 │{b}│ {fmt(h['output']):>10}")
        w("```")
        w()
        w("### Cache Reads by Hour")
        w()
        w("```")
        for h in hourly:
            b = bar(h["cache_read"], max_cr, 35)
            w(f"  {h['hour']}:00 │{b}│ {fmt(h['cache_read']):>12}")
        w("```")
        w()
        w("| Hour | Calls | Output | Cache Read |")
        w("|------|------:|-------:|-----------:|")
        for h in hourly:
            w(
                f"| {h['hour']}:00 | {fmt(h['calls'])} | {fmt(h['output'])} | {fmt(h['cache_read'])} |"
            )
        w()

    # ── Plan Budget ─────────────────────────────────────────
    if budget:
        w("## Plan Budget (derived from 7d utilization)")
        w()
        w("| Window | Output Token Budget |")
        w("|--------|--------------------:|")
        w(f"| 5-hour | {fmt(budget['5h_output'])} |")
        w(f"| Daily | {fmt(budget['daily_output'])} |")
        w(f"| 7-day | {fmt(budget['7d_output'])} |")
        w(f"| Monthly (30d) | {fmt(budget['monthly_output'])} |")
        w()
        remaining_frac = budget["remaining_7d"] / max(budget["7d_output"], 1)
        w("### Remaining Allowance")
        w()
        w("```")
        w(f"  7d used:     {gauge(u7_end, 30)}")
        w(f"  7d remaining:{gauge(remaining_frac, 30)}")
        w(f"  Remaining:   {fmt(budget['remaining_7d'])} output tokens")
        w(f"  Runway:      {budget['days_left']} days at this rate")
        w("```")
        w()

    # ── API Cost Breakdown ──────────────────────────────────
    w("## API Cost Equivalent (Opus 4.6)")
    w()
    wc = cost["with_cache"]
    woc = cost["without_cache"]
    w("### With Caching")
    w()
    w("| Component | Tokens | Rate | Cost |")
    w("|-----------|-------:|-----:|-----:|")
    w(
        f"| Input (uncached) | {fmt(tok['input']['total'])} | $15.00/M | {dollar(wc['input'])} |"
    )
    w(f"| Output | {fmt(tok['output']['total'])} | $75.00/M | {dollar(wc['output'])} |")
    w(
        f"| Cache read | {fmt(tok['cache_read']['total'])} | $1.875/M | {dollar(wc['cache_read'])} |"
    )
    w(
        f"| Cache write | {fmt(tok['cache_write']['total'])} | $18.75/M | {dollar(wc['cache_write'])} |"
    )
    w(f"| **TOTAL** | | | **{dollar(wc['total'])}** |")
    w()
    w("### Without Caching")
    w()
    all_input = (
        tok["input"]["total"] + tok["cache_read"]["total"] + tok["cache_write"]["total"]
    )
    w("| Component | Tokens | Rate | Cost |")
    w("|-----------|-------:|-----:|-----:|")
    w(
        f"| Input (all) | {fmt(all_input)} | $15.00/M | {dollar(woc['total'] - wc['output'])} |"
    )
    w(f"| Output | {fmt(tok['output']['total'])} | $75.00/M | {dollar(wc['output'])} |")
    w(f"| **TOTAL** | | | **{dollar(woc['total'])}** |")
    w()

    # ── Cache Savings Visual ────────────────────────────────
    w("### Cache Savings")
    w()
    max_cost = max(wc["total"], woc["total"], 0.01)
    bar_width = 40
    w("```")
    w(
        f"  With cache:    │{bar(wc['total'], max_cost, bar_width)}│ {dollar(wc['total'])}"
    )
    w(
        f"  Without cache: │{bar(woc['total'], max_cost, bar_width)}│ {dollar(woc['total'])}"
    )
    w(f"  Savings:       {dollar(cost['savings'])}")
    w("```")
    w()

    # ── 30-Day Projection ───────────────────────────────────
    w("## 30-Day Projection")
    w()
    monthly = cost["monthly_projection"]
    monthly_no_cache = woc["total"] * 30
    monthly_savings = monthly_no_cache - monthly
    w("```")
    max_monthly = max(monthly, monthly_no_cache, 0.01)
    w(f"  With caching:    │{bar(monthly, max_monthly, bar_width)}│ {dollar(monthly)}")
    w(
        f"  Without caching: │{bar(monthly_no_cache, max_monthly, bar_width)}│ {dollar(monthly_no_cache)}"
    )
    w(f"  Cache savings:   {dollar(monthly_savings)}/month")
    w("```")
    w()
    w("### Value Analysis")
    w()
    w("| Metric | Value |")
    w("|--------|------:|")
    w(f"| Max subscription | $200/month |")
    w(f"| API equivalent/day | {dollar(wc['total'])} |")
    w(f"| API equivalent/month | {dollar(monthly)} |")
    w(f"| **Value multiplier** | **{cost['value_multiplier']:.0f}x** |")
    w()

    # ── Per-PID Session Table ───────────────────────────────
    sessions = stats["sessions"]
    if sessions:
        w("## Sessions (by PID)")
        w()
        w("| PID | Calls | KA | Output | Cache Read | Hit Ratio |")
        w("|-----|------:|---:|-------:|-----------:|----------:|")
        for s in sessions:
            w(
                f"| {s['pid']} | {fmt(s['calls'])} | {fmt(s['keepalives'])} "
                f"| {fmt(s['output'])} | {fmt(s['cache_read'])} | {s['ratio']} |"
            )
        w()

    w("---")
    w(
        f"*Generated {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} — stdlib only, no deps*"
    )

    return "\n".join(lines)


# ─── JSON Renderer ──────────────────────────────────────────
def render_json(stats):
    """Render stats as pretty-printed JSON."""
    # Remove the label key (internal only)
    output = {k: v for k, v in stats.items() if k != "label"}
    return json.dumps(output, indent=2, ensure_ascii=False)


# ─── CLI ────────────────────────────────────────────────────
def parse_args():
    parser = argparse.ArgumentParser(
        description="Claude Max Plan — Token Budget & Cost Analysis",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
examples:
  %(prog)s                         Today, markdown to terminal
  %(prog)s 2026-04-04              Specific date
  %(prog)s --all                   All time
  %(prog)s --json                  JSON to stdout
  %(prog)s --json --out report.json
  %(prog)s --md --out report.md
""",
    )
    parser.add_argument(
        "date",
        nargs="?",
        default=None,
        help="Date to analyze (YYYY-MM-DD). Default: today",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Analyze all time (no date filter)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="output_json",
        help="Output as JSON",
    )
    parser.add_argument(
        "--md",
        action="store_true",
        dest="output_md",
        help="Output as Markdown (explicit, same as default)",
    )
    parser.add_argument(
        "--out",
        metavar="FILE",
        default=None,
        help="Write output to file instead of stdout",
    )
    return parser.parse_args()


def main():
    args = parse_args()

    # Determine date filter and label
    if args.all:
        date_filter = None
        label = "All Time"
    elif args.date:
        date_filter = args.date
        label = args.date
    else:
        date_filter = datetime.now().strftime("%Y-%m-%d")
        label = f"Today ({date_filter})"

    streams, keepalives = load_data(date_filter)

    if not streams:
        msg = f"No data found for {label}"
        if args.output_json:
            print(json.dumps({"error": msg}))
        else:
            print(msg, file=sys.stderr)
        sys.exit(0)

    stats = compute_stats(streams, keepalives, label)

    # Render
    if args.output_json:
        output = render_json(stats)
    else:
        output = render_markdown(stats)

    # Write
    if args.out:
        Path(args.out).write_text(output + "\n", encoding="utf-8")
        dest = Path(args.out).resolve()
        print(f"Written to {dest}", file=sys.stderr)
    else:
        print(output)


if __name__ == "__main__":
    main()
