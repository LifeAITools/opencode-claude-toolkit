---
title: Placement PID — plant identification of subscription-quota consumption
date: 2026-11-12
status: analysis (read-only; no network, no proxy touched)
inputs:
  - /home/relishev/.claude-local/claude-max-stats.jsonl   (433 MB, 1,374,461 lines, 2026-04-03 … 2026-11-12)
  - /home/relishev/.claude-local/quota-samples.jsonl      (288 lines, 12 h, opencode-go + open-design)
  - /home/relishev/.claude-local/claude-max-proxy.jsonl   (OD_REQUEST / GO_COMPLETE events, for Go/OD session counts)
outputs:
  - /home/relishev/projects/vibe/claude-code-sdk/research/placement-pid-scripts/  (extract.py → analyze.py → godes.py; rerun to regenerate)
  - /home/relishev/projects/vibe/claude-code-sdk/research/placement-pid-history.jsonl.gz  (replay dataset, 20,953 lines, 1.07 MB)
---

# Placement PID — plant identification (2026-11)

## Bottom line

One Opus session costs about **2.6 points of the 5-hour quota per hour it is active**,
so a fresh 5-hour window, after background drift, holds roughly **seven parallel Opus
sessions running for the whole window** before the wall. One Fable session costs about **9.6 points per hour,
3.8 times an Opus session**. Sonnet and Haiku cost almost nothing in this data: their
sessions are mostly one-turn helper calls. On top of what tracked sessions explain, every
org drifts up by about **2 points per hour**. That consumption is not visible in our stats
(other clients on the same account, unlabeled lines), and the controller has to model it
as a disturbance, not as session cost.

The plant is an **integrator with a long tail of inertia, not a lagged gain**. The meter
itself answers within a minute: a big cache write shows up in `util5h` after a median of
36 s. A newly placed session, however, keeps spending for hours. Half of its lifetime cost
is gone after a median of 2.2 h, 90 % after 5.2 h, and its lifetime from first to last turn
is a median of 6.7 h (p90 30 h, which spans several windows). A placement decision is
therefore a commitment of roughly one full window's worth of spend, and the controller
has to act on the forecast integral, not on the current reading.

The token cost model confirms the prior: **~459k cache-write tokens per point**
(bootstrap p10–p90 418k–499k; prior 494k). Output tokens cost ~99k per point. Cache
reads cannot be separated from writes in this data (see caveats).

## Data and coverage

The script streamed the file once (python, line by line, ~6 s) and kept only
`type:"stream"` lines whose `org` starts with one of the four real org prefixes.
Skipped: 11 malformed lines, 61,150 non-stream events (keepalive, token_rotated, …),
310,844 stream lines without `org` (all of April–May and part of June: those predate the
org field and cannot be assigned to an org), and 55,923 lines on synthetic `org-xxxx`.
Kept: **946,550 turns, 16,750 sessions**.

| org (prefix) | turns | sessions | first → last (UTC) | 5-min buckets with traffic |
|---|---|---|---|---|
| b3219c9b | 111,249 | 2,005 | 2026-06-10 → 2026-11-12 | 3,510 |
| 02b4bfd1 | 352,165 | 5,829 | 2026-06-25 → 2026-10-16 | 7,196 |
| f9420373 | 370,017 | 5,956 | 2026-06-10 → 2026-10-11 | 7,969 |
| 35140078 | 113,119 | 2,960 | 2026-07-27 → 2026-11-12 | 2,278 |

On every kept line `util5h` is present. `resetAt` is missing on 22 % to 98 % of lines
depending on the org: b3219c9b has only one distinct `resetAt` at all, so resets are
detected mainly from `util5h` itself. Buckets with no traffic do not exist in the dataset.
A missing bucket means "not measured", **not zero use**: an org can also be used by
clients this proxy does not see.

Model to class mapping: `anthropic/<family>` by substring of `model`, giving opus (all
4-6 … 5-5), sonnet, haiku and fable. **No `mythos` model appears anywhere in the file**,
so that class has no data. A session's class is its dominant family by turn count. Only
142 of 16,750 sessions mix families, and in all of them the dominant share is at or near 100 %.

## 1. Time series and window resets

Per (org, 5-minute bucket) the script records: last `util5h`, the max `util5h`,
a running envelope (cumulative max inside the window), last `util7d`, last `resetAt`,
turn count, distinct active sessions, new sessions (first turn ever in this bucket), token
sums (in/out/cacheRead/cacheWrite), and the same per class.

`util5h` is quantized to 0.01. Within seconds it jitters downward by 0.01 to 0.04
(5,000 to 12,000 such steps per org), because concurrent responses carry slightly older
readings. The raw last value is therefore noisy, and all gain estimates use the
**envelope** (cumulative max within a window), which is monotone by construction.

A new window starts when one of these happens, in priority order: the bucket max drops
≥ 0.05 below the envelope (503 cases; median drop 0.45–0.69 → 0.00, i.e. a real reset),
`resetAt` moves by ≥ 1 h after the old reset passed (181), a gap with no traffic ≥ 5 h
(42), or the first bucket of an org (4). Total: **730 windows**.

## 2. Plant gain

### 2a. Per-window, all classes pooled

K_window = Δenvelope over the window ÷ session-hours in the window. Session-hours are
counted as (active sessions per bucket) × 5 min. The window qualifies when it has ≥ 1
session-hour, spans ≥ 1 h, and Δ ≥ 0.02. Note that this K **absorbs the background drift**
into the session cost, so it is an upper-ish effective number.

| scope | windows | K p10 | K median | K p90 (Δutil5h per session-hour) |
|---|---|---|---|---|
| all orgs | 504 of 730 | 0.0139 | **0.0303** | 0.0678 |
| without ceiling-censored (end < 0.95) | 434 | 0.0133 | 0.0280 | 0.0580 |
| b3219c9b | 93 | 0.0280 | 0.0477 | 0.0975 |
| 02b4bfd1 | 166 | 0.0133 | 0.0235 | 0.0576 |
| f9420373 | 191 | 0.0141 | 0.0296 | 0.0686 |
| 35140078 | 54 | 0.0125 | 0.0193 | 0.0364 |

b3219c9b is the most expensive per session-hour. That fits its share of Fable (20,666 of
its 111k turns) and the recent model mix (opus-5-5).

### 2b. Per class, multi-regression (founder's request)

Model: within each window the script cuts hour-long chunks (12 buckets) and fits
Δenvelope_chunk ≈ Σ K_class · session-hours_class + c, using non-negative least squares.
The intercept c is the per-hour background drift. Confidence comes from a bootstrap that
resamples whole windows (200×). n = 2,266 hourly chunks from 599 windows, R² = 0.76.

| class | K (Δutil5h per session-hour) | bootstrap p10–p90 | session-hours of data | chunks containing it | verdict |
|---|---|---|---|---|---|
| anthropic/opus | **0.0256** | 0.0246–0.0266 | 5,773 | 2,142 | solid |
| anthropic/fable | **0.0963** | 0.0910–0.1023 | 394 | 293 | solid enough |
| anthropic/sonnet | 0.0018 | 0.0000–0.0070 | 420 | 377 | **weak**: mostly 1-turn calls, not distinguishable from 0 |
| anthropic/haiku | 0.0000 | 0.0000–0.0000 | 1,368 | 1,324 | **weak**: 1-turn helper calls, cost below the 0.01 meter step |
| anthropic/mythos | — | — | 0 | 0 | **no data** (model never seen) |
| background drift c | 0.0203 per hour per org | 0.0179–0.0227 | — | — | unexplained upward drift |

The windows dominated by one class (≥ 90 % of session-hours) give a direct cross-check
that does not depend on the regression. For opus, n = 136 windows, K median 0.045
(p10 0.018, p90 0.058). For fable, n = 10 windows, K median 0.103 (p10 0.086, p90 0.131).
The opus number is higher than the regression's 0.0256 because the per-window figure
also carries the background drift. Fable agrees with the regression.

Controller reading: with c ≈ 0.02/h, a 5-h window spends ~0.10 before any session.
The remaining 0.90 buys about 35 Opus session-hours or about 9 Fable session-hours.

### 2c. Tokens per 1 % point

Same hourly chunks, regressors [cacheWrite, output, cacheRead, input] summed over all
classes. NNLS with intercept, R² = 0.72.

| token kind | tokens per 1 point | bootstrap p10–p90 | prior |
|---|---|---|---|
| cacheWrite | **459k** | 418k–499k | ~494k (consistent) |
| output | **99k** | 88k–121k | — |
| input (uncached) | 155k | 104k–247k | — |
| cacheRead | not identifiable (coef 0) | p10 815M, p90 ∞ | ~44M |

Per family (12 regressors, R² = 0.95, NNLS; read as indicative, no bootstrap):
opus cacheWrite 625k/pt and output 75k/pt; **fable cacheWrite 187k/pt and output 23k/pt**,
which makes Fable ≈ 3.3× Opus per token and agrees with the per-session ratio of 3.8;
sonnet cacheWrite 705k/pt. Haiku is not identifiable.

As a check without regression, the cost-equivalent tokens per point per window
(cacheWrite + cacheRead × 494k/44M) come out at a median of **397k**
(p10 192k, p90 594k, n = 504). This is close to the prior after absorbing the drift.

## 3. Session dynamics

Most "sessions" are not work sessions. 11,744 of the 16,750 are Haiku and 2,520 are Sonnet,
and both are median **1 turn, 0 h lifetime**: helper calls (titles, classification,
sub-agent pings). They cost nothing measurable, so the controller should place only
**main sessions**, defined here as dominant class not Haiku and ≥ 5 turns. There are 2,309 of them.

| main sessions (n = 2,309) | p10 | median | p90 | other |
|---|---|---|---|---|
| lifetime first→last turn (h) | 0.85 | **6.7** | **30.1** | p75 16.7, p95 48.9 |
| active hours (5-min buckets with a turn) | 0.58 | 2.9 | 4.75 | |
| turns | 64 | 343 | 689 | |
| turns per active hour | 78 | 127 | 203 | |
| time to 50 % of own cost (h) | 0.18 | **2.2** | 13.6 | n = 2,306 |
| time to 90 % of own cost (h) | 0.64 | **5.2** | 25.7 | |

Opus alone (n = 2,185): lifetime median 6.3 h, p90 29.4 h, 335 turns. Fable (n = 301) is
shorter: lifetime median 1.0 h, p90 11.8 h, 103 turns.

**Inertia / dead-time for the controller:** the long lifetime (median 6.7 h) is mostly
idle tail. Active time is a median of 2.9 h, and cost is front-loaded: half within 2.2 h,
90 % within 5.2 h. A placement therefore commits about one window's worth of spend, and
a session placed late in a window spills into the next.

**New sessions per hour (control input budget)**, counted over hours where the fleet had
any traffic (n = 1,853 h):

| | mean | p10 | median | p90 | p95 | p99 | max |
|---|---|---|---|---|---|---|---|
| main sessions, fleet | 1.25 | 0 | **0** | **4** | 5 | 11 | 22 |
| all sessions incl. helpers, fleet | 9.0 | 0 | 4 | 22.8 | 32 | 75 | 238 |

Per org, main sessions: median 0, p90 3, p99 9–12 per hour, means 0.8–1.2.
Concurrent sessions per 5-min bucket (non-Haiku): medians 2–4, p90 6–9, p99 12–18 per org.
The controller makes about one real decision per hour, with bursts of 5–11.

## 4. Lag (reaction of util5h)

**Meter lag, turn level.** Events: a turn with cacheWrite ≥ 200k on an org where no other
session had a turn within ±10 min (n = 177). The measure is the time until `util5h` rises
≥ 0.01 above the max before the turn. 3 events showed the rise in the same response, and
133 resolved within 10 min: **lag p10 10 s, median 36 s, p90 192 s**. The rest
(44) did not register a full 0.01 step within 10 minutes. This is quantization, not delay:
200k write ≈ 0.4 point.

**Session start.** Events: new main sessions on an org that had been idle 30 min before
(n = 106). In 46 of them `util5h` rose 0.01 before any other session joined, with
**median 0.75 min** (p10 0.17, p90 6.6 min) after the first turn. It took
cost-equivalent tokens of p10 106k, median 149k, p90 285k. The other 60 had another
session join first, so the rise could not be attributed.

Reading: the measurement has practically no dead-time (well under the 5-minute bucket).
The only sensor limitation is the 0.01 resolution. A single session at 2.6 points/h moves
the meter one step every ~23 min, so per-session attribution needs ≥ 30–60 min of data.

## 5. Replay dataset

`/home/relishev/projects/vibe/claude-code-sdk/research/placement-pid-history.jsonl.gz`:
20,953 lines (one per org × 5-min bucket with traffic), 1.07 MB gzipped. Fields:

`org` (full id), `t` (bucket start epoch s), `ts`, `util5h` (last), `util5h_max`,
`util5h_env` (window envelope, use this for gain), `util7d`, `resetAt` (null when not
reported), `window` (window id), `reset` (start|drop|resetAt|gap5h|null — why a window
began here), `turns`, `active_sessions`, `new_sessions`, **`sessions_by_class`**
(`{"anthropic/opus": n, …}`), `new_by_class`, `tokens` {in,out,cacheRead,cacheWrite},
`tokens_by_class`.

Every line carries a `util5h` (min 0). Gaps between buckets mean no traffic was observed,
which is not the same as zero use.

## 6. Go / OpenDesign (low confidence, 12 h of samples)

Source: `quota-samples.jsonl`, ~5-min samples from 2026-11-11 23:48 to 2026-11-12 11:44
UTC. Session counts per interval come from `OD_REQUEST` (account taken from the
message) and `GO_COMPLETE` (`callKind:"real"`) in `claude-max-proxy.jsonl`. Model: NNLS
Δutil5h ≈ K · session-hours + c over consecutive sample pairs ≤ 15 min apart, skipping drops.

| class | intervals (with sessions) | session-hours | accounts active | K (Δ5h per session-hour) | ratio ΣΔ/Σsh | confidence |
|---|---|---|---|---|---|---|
| open-design/deepseek (`deepseek-v4.1-flash-eco`) | 848 (418) | 70.3 | 6 | **~0.008** | 0.012 | LOW |
| opencode-go/* (`deepseek-v4.1-flash` only) | 1,765 (77) | 11.2 | 1 of 13 (`hello@synqwire.io`; the rest stayed at 0) | **~0.006** | 0.008 | VERY LOW |

Both are 3 to 4 times cheaper per session-hour than an Opus session on its own meter
(the meters are different products, so this does not compare money). Only one model per
provider was in use, so per-model classes cannot be separated. The Go figure rests on
0.09 of total Δutil on one account. OpenDesign's door logged an upstream outage
(DOOR_PASSES_NOTHING, 2026-11-12 11:26), and that hour's activity is in the sample. Use
both numbers only as priors, and re-fit after a week of samples.

## Caveats

- **Background drift is real and large** (≈ 0.02/h per org). Possible sources: clients on
  the same account outside this proxy, stream lines without `org`, and keepalive fires
  (excluded here as non-stream). A controller that sets K from per-window ratios
  double-counts it, so model it as a separate disturbance input.
- **cacheRead cost is not identifiable**: per hour it is almost perfectly collinear with
  cacheWrite and active session count. The 44M/pt prior is neither confirmed nor refuted.
- **Ceiling censoring**: windows that end ≥ 0.95 understate demand (blocked requests are
  not in the log). Removing them shifts the median K from 0.030 to 0.028.
- **Model mix drifts over time** (opus 4-6 → 5-5, fable since summer). K per class pools
  all versions within a family. b3219c9b's higher K suggests newer models cost more, and
  re-fitting on the last month alone is worth doing when the controller is tuned.
- Only data from June onward has `org`, so April–May (310k lines) is excluded.
- A session is attributed to the org of its first turn. A session moved between orgs
  mid-life (per-org pinning) is counted in each org where it has turns for the
  per-bucket counts, but its lifetime stats are global.
- Go/OD: 12 h, one model each, a different meter (Go and OD report a 5-h util of their own).
