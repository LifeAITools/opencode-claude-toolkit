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
  python3 scripts/budget-analysis.py              # Today
  python3 scripts/budget-analysis.py 2026-04-04   # Specific date
  python3 scripts/budget-analysis.py --all         # All time
"""

import re
import sys
from collections import defaultdict
from pathlib import Path
from datetime import datetime

# ─── Opus 4.6 Pricing (per token) ───────────────────────────
PRICE_INPUT = 15.0 / 1_000_000
PRICE_OUTPUT = 75.0 / 1_000_000
PRICE_CACHE_READ = 1.875 / 1_000_000
PRICE_CACHE_WRITE = 18.75 / 1_000_000

STATS_LOG = Path.home() / ".claude" / "claude-max-stats.log"


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
        print(f"Error: {STATS_LOG} not found")
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


def fmt(n):
    """Format number with commas."""
    return f"{n:,.0f}" if isinstance(n, (int, float)) else str(n)


def main():
    # Parse args
    if len(sys.argv) > 1 and sys.argv[1] == "--all":
        date_filter = None
        label = "All Time"
    elif len(sys.argv) > 1:
        date_filter = sys.argv[1]
        label = sys.argv[1]
    else:
        date_filter = datetime.now().strftime("%Y-%m-%d")
        label = f"Today ({date_filter})"

    streams, keepalives = load_data(date_filter)

    if not streams:
        print(f"No data found for {label}")
        sys.exit(0)

    # ─── Totals ──────────────────────────────────────────────
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

    # ─── Utilization ─────────────────────────────────────────
    with_u5 = [d for d in streams if d.get("u5") is not None and d["u5"] > 0]
    with_u7 = [d for d in streams if d.get("u7") is not None and d["u7"] > 0]

    first_u5 = with_u5[0]["u5"] if with_u5 else 0
    last_u5 = with_u5[-1]["u5"] if with_u5 else 0
    first_u7 = with_u7[0]["u7"] if with_u7 else 0
    last_u7 = with_u7[-1]["u7"] if with_u7 else 0

    u7_consumed = last_u7 - first_u7
    claim = streams[-1].get("claim", "?")

    # Time range
    first_ts = streams[0].get("ts", "?")
    last_ts = streams[-1].get("ts", "?")

    # ─── Print Report ────────────────────────────────────────
    print("═" * 62)
    print(f"  Claude Max Plan — Token Budget & Cost Analysis")
    print(f"  Period: {label}")
    print("═" * 62)
    print()
    print(f"Plan: {claim}")
    print(f"Time: {first_ts} → {last_ts}")
    print(f"Calls: {len(streams):,} stream + {len(keepalives):,} keepalive")
    print()

    # ─── Token Consumption ───────────────────────────────────
    print("=== TOKEN CONSUMPTION ===")
    print(f"{'':20} {'Stream':>14}  {'Keepalive':>14}  {'Total':>14}")
    print(f"{'Output':20} {fmt(s_out):>14}  {fmt(k_out):>14}  {fmt(t_out):>14}")
    print(
        f"{'Input (uncached)':20} {fmt(s_inp):>14}  {fmt(k_inp):>14}  {fmt(t_inp):>14}"
    )
    print(f"{'Cache read':20} {fmt(s_cr):>14}  {fmt(k_cr):>14}  {fmt(t_cr):>14}")
    print(f"{'Cache write':20} {fmt(s_cw):>14}  {fmt(k_cw):>14}  {fmt(t_cw):>14}")
    print(f"{'Hit ratio':20} {s_cr * 100 / max(s_cr + s_cw, 1):>13.1f}%")
    print()

    # ─── Utilization & Budget ────────────────────────────────
    print("=== UTILIZATION ===")
    print(f"util5h: {first_u5:.2f} → {last_u5:.2f} (Δ={last_u5 - first_u5:.4f})")
    print(f"util7d: {first_u7:.2f} → {last_u7:.2f} (Δ={u7_consumed:.4f})")
    print()

    if u7_consumed > 0.001:
        budget_7d_out = t_out / u7_consumed
        budget_daily_out = budget_7d_out / 7
        budget_5h_out = budget_7d_out / (7 * 24 / 5)
        remaining_7d_out = budget_7d_out * (1 - last_u7)
        days_left = remaining_7d_out / max(t_out, 1)

        print("=== DERIVED PLAN LIMITS (from 7d utilization) ===")
        print(f"5-hour output budget:   {fmt(budget_5h_out):>14} tokens")
        print(f"Daily output budget:    {fmt(budget_daily_out):>14} tokens")
        print(f"7-day output budget:    {fmt(budget_7d_out):>14} tokens")
        print(f"Monthly (30d) budget:   {fmt(budget_daily_out * 30):>14} tokens")
        print()
        print(f"=== REMAINING ALLOWANCE ===")
        print(f"7d window used:         {last_u7 * 100:.1f}%")
        print(f"Remaining output:       {fmt(remaining_7d_out):>14} tokens")
        print(f"Days at this rate:      {days_left:.1f}")
        print()

    # ─── API Cost ────────────────────────────────────────────
    cost_inp = t_inp * PRICE_INPUT
    cost_out = t_out * PRICE_OUTPUT
    cost_cr = t_cr * PRICE_CACHE_READ
    cost_cw = t_cw * PRICE_CACHE_WRITE
    cost_total = cost_inp + cost_out + cost_cr + cost_cw

    cost_no_cache_inp = (t_inp + t_cr + t_cw) * PRICE_INPUT
    cost_no_cache = cost_no_cache_inp + cost_out
    cache_savings = cost_no_cache - cost_total

    print("=== API COST EQUIVALENT (Opus 4.6) ===")
    print()
    print("With caching:")
    print(f"  Input (uncached):   {fmt(t_inp):>14} × $15.00/M  = ${cost_inp:>12,.2f}")
    print(f"  Output:             {fmt(t_out):>14} × $75.00/M  = ${cost_out:>12,.2f}")
    print(f"  Cache read:         {fmt(t_cr):>14} × $1.875/M  = ${cost_cr:>12,.2f}")
    print(f"  Cache write:        {fmt(t_cw):>14} × $18.75/M  = ${cost_cw:>12,.2f}")
    print(f"  {'─' * 52}")
    print(f"  TOTAL:              {'':>14}              = ${cost_total:>12,.2f}")
    print()
    print("Without caching (all input at full price):")
    print(
        f"  Input (all):        {fmt(t_inp + t_cr + t_cw):>14} × $15.00/M  = ${cost_no_cache_inp:>12,.2f}"
    )
    print(f"  Output:             {fmt(t_out):>14} × $75.00/M  = ${cost_out:>12,.2f}")
    print(f"  TOTAL:              {'':>14}              = ${cost_no_cache:>12,.2f}")
    print()
    print(f"  Cache savings:      {'':>14}              = ${cache_savings:>12,.2f}")
    print()

    # ─── 30-Day Projection ───────────────────────────────────
    cost_30d = cost_total * 30
    cost_30d_no_cache = cost_no_cache * 30
    savings_30d = cost_30d_no_cache - cost_30d

    print("=== 30-DAY PROJECTION (at this rate) ===")
    print(f"With caching:         ${cost_30d:>12,.2f}")
    print(f"Without caching:      ${cost_30d_no_cache:>12,.2f}")
    print(f"Cache savings/month:  ${savings_30d:>12,.2f}")
    print()

    # ─── Value Analysis ──────────────────────────────────────
    sub_price = 200  # Max subscription price
    print("=== VALUE ANALYSIS ===")
    print(f"Max subscription:     ${sub_price}/month")
    print(f"API equivalent/day:   ${cost_total:>12,.2f}")
    print(f"API equivalent/month: ${cost_30d:>12,.2f}")
    print(f"Value multiplier:     {cost_30d / sub_price:>12,.0f}x")
    print()

    # ─── Hourly Breakdown ────────────────────────────────────
    hourly = defaultdict(lambda: {"out": 0, "cr": 0, "cw": 0, "calls": 0})
    for d in streams:
        ts = d.get("ts", "")
        h = ts[11:13] if len(ts) > 13 else "?"
        hourly[h]["out"] += d.get("out", 0)
        hourly[h]["cr"] += d.get("cr", 0)
        hourly[h]["cw"] += d.get("cw", 0)
        hourly[h]["calls"] += 1

    print("=== HOURLY BREAKDOWN ===")
    print(
        f"{'Hour':>5}  {'Calls':>6}  {'Output':>12}  {'Cache Read':>14}  {'Cache Write':>12}"
    )
    for h in sorted(hourly):
        if h == "?":
            continue
        d = hourly[h]
        print(
            f"{h}:00  {d['calls']:>6}  {fmt(d['out']):>12}  {fmt(d['cr']):>14}  {fmt(d['cw']):>12}"
        )

    # ─── Per-PID Breakdown ───────────────────────────────────
    by_pid = defaultdict(lambda: {"out": 0, "cr": 0, "cw": 0, "calls": 0, "ka": 0})
    for d in streams:
        pid = d.get("pid", "?")
        by_pid[pid]["out"] += d.get("out", 0)
        by_pid[pid]["cr"] += d.get("cr", 0)
        by_pid[pid]["cw"] += d.get("cw", 0)
        by_pid[pid]["calls"] += 1
    for d in keepalives:
        pid = d.get("pid", "?")
        by_pid[pid]["ka"] += 1

    print()
    print("=== PER-SESSION (PID) ===")
    print(
        f"{'PID':>10}  {'Calls':>6}  {'KA':>5}  {'Output':>12}  {'Cache Read':>14}  {'Ratio':>6}"
    )
    for pid in sorted(by_pid, key=lambda p: by_pid[p]["out"], reverse=True):
        d = by_pid[pid]
        total = d["cr"] + d["cw"]
        ratio = f"{d['cr'] * 100 / max(total, 1):.0f}%" if total > 0 else "-"
        print(
            f"{pid:>10}  {d['calls']:>6}  {d['ka']:>5}  {fmt(d['out']):>12}  {fmt(d['cr']):>14}  {ratio:>6}"
        )

    print()
    print("═" * 62)


if __name__ == "__main__":
    main()
