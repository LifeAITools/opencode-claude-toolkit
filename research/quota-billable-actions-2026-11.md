# What moves the 5-hour subscription quota — keep-alive, web tools, and the 0.02/h drift

Date: 2026-11-12. Read-only analysis of local logs; no network calls, proxy untouched.
Question (founder, 12.11): is cache keep-alive ("прогрев") free? Do web search / web fetch cost?
Where does the unexplained ~0.020/h per-org drift from
`research/placement-pid-plant-identification-2026-11.md` §2b come from?

## Bottom line

1. **Keep-alive is billed. It is not free.** A keep-alive fire is almost pure cache read
   (in=2, out=1, cacheWrite≈0), and it moves `util5h` at the **same price as a cache read on
   a real turn**: about **0.17 util per billion cache-read tokens** (≈ 59M tokens per 1
   point; block-bootstrap p10–p90 0.12–0.23 per B), against 0.12–0.17 per B for real-turn
   reads on the same org and hours. A placebo test (the keep-alive series shifted in time)
   collapses the coefficient to about 0 (median −0.006, 0 of 48 shifts reach the true
   value). An average fire reads 273k tokens, so roughly **200 fires ≈ 1 point**.
2. **Web search / web fetch: no measurable surcharge.** 65 isolated web-tool turns step the
   meter by a mean 0.0052 within 3 minutes, against 0.0060 for 2,129 same-size Haiku turns
   without web tools. The resolution is about 0.001 util per turn, and the sample is small
   (138 calls total, all Haiku, mostly one probe session).
3. **The 0.02/h drift is mostly cache reads the plant model did not price.** The plant
   regression got 0 for cacheRead, so the cost of reads landed in the intercept. There are
   two invisible parts: (a) real-turn cache reads, which the window fit prices at
   0.10–0.17 per B and which cut the drift term from 0.019/h to 0.012/h; (b) keep-alive fires,
   which **never reach the stats file because of a bug** (below) and which cost about
   0.007–0.012/h on an org with an active keep-alive fleet. On the one org where every
   token is itemized (Oct 15–16, 25 h), the leftover is **0.003/h**, the same as zero within
   the 0.01 quantization. There is no evidence of clients outside the proxy.

## Data

| source | span (UTC) | what it gives |
|---|---|---|
| `~/.claude-local/claude-max-proxy.log.5.gz` | 2026-10-14 19:23 → 10-16 09:48 | 6,659 unique `KA_FIRE_COMPLETE` with usage + `utilization5h`, org 02b4bfd1 |
| `~/.claude-local/claude-max-proxy.log` | 2026-11-11 16:16 → 11-12 12:10 | 80 unique `KA_FIRE_COMPLETE` (orgs b3219c9b, 35140078) |
| `claude-max-proxy.log.{1..4}.gz` | 2026-10-16 → 11-11 | **no** KA fires itemized; heartbeats report `firesLastHour=0` throughout (keep-alive idle/disarmed; Anthropic doors mostly 403/429, traffic went to the Go/OpenDesign doors) |
| `~/.claude-local/claude-max-stats.jsonl` | 2026-04-03 → 11-12 | 1.31M real turns; util5h + org from June. Its `type:"keepalive"` rows (56,666) exist **only Apr–May**, without org and without util |

Clock reconstruction: log lines carry `HH:MM:SS.mmm` in **UTC**. This was verified by
`DEPLOY_CLEAN … deployed 2026-11-11T16:16:30Z` printed at 16:16:33, and by matching log
`REAL_REQUEST_COMPLETE` lines to stats rows: **30,329 of 30,336 match within 10 ms on the same
org**. Dates were rebuilt from the first line's date plus midnight rollovers. Each record is
printed twice, and identical lines were deduplicated. There were 81 `KA_FIRE_ERROR` (no
usage), which were excluded.

## Why keep-alive never shows in the stats file (bug, not fixed here — read-only brief)

`packages/claude-max-proxy/src/stats-emitter.ts:169-175` subscribes to both
`REAL_REQUEST_COMPLETE` **and** `KA_FIRE_COMPLETE`, then reads `ev.rateLimit?.util5h` /
`util7d` and **drops the line when both are null**. The keep-alive event
(`src/proxy-client.ts:3157-3185`, built from `src/keepalive-engine.ts:2011-2023`) carries its
readings as `rateLimit.utilization5h` / `utilization7d`. It puts `util5h` only at the event's
top level, not inside `rateLimit`. So every keep-alive line is silently discarded. The
evidence: 0 of 6,739 fires have a stats row (the 113 timestamp coincidences are different
sessions with different usage). This is why the plant identification "saw no keep-alive", and
why every quota model built on `claude-max-stats.jsonl` under-counts spend by the keep-alive
volume. Fix: the emitter should read
`rateLimit.util5h ?? rateLimit.utilization5h ?? ev.util5h`. Better, one event contract should
name the field once. It should also tag the line `type:"keepalive"` so it stays separable
from real turns.

## Method and numbers

### Test 1 — keep-alive-only intervals (the brief's KEY TEST): inconclusive by construction

Per org, a run is consecutive keep-alive readings with **no real turn on that org** between
them and the same `resetAt`. Δutil = last − first reading of the run.

| guard (min time since last real turn at run start) | runs (≥2 fires) | fires counted | span hours | KA cacheRead | Σ Δutil | if free | if billed at 0.17/B |
|---|---|---|---|---|---|---|---|
| 0 s | 1,376 | 3,149 | 2.2 | 958M | **+0.15** (15 steps of 0.01, 1,361 runs at 0) | 0 | +0.16 |
| 30 s | 13 | 27 | 0.6 | 7.1M | +0.01 | 0 | +0.001 |
| 120 s | 4 | 12 | 0.4 | 1.9M | 0.00 | 0 | 0.0003 |
| 300 s | 1 | 1 | 0.05 | 0.13M | 0.00 | 0 | 0.00002 |

At guard 0 the observed +0.15 matches the billed prediction of +0.16. However, all 15 positive
steps start within about 1 minute of a real turn on the same org, and the meter lags by about
36 s (plant study §2). So that step can be the trailing real turn rather than keep-alive. Once
a lag guard is applied, almost nothing is left. The reason is structural: keep-alive fires at
idle *sessions* (median 220 min after that session's last turn, p90 853 min), while the *org*
stays busy with other sessions (27.7k turns in 26.5 h on 02b4bfd1). Pure keep-alive stretches
at the org level hardly exist in this data, so they cannot decide the question either way.

### Test 2 — 10-minute bucket regression on the fully itemized org (decisive)

The test used org 02b4bfd1 from 2026-10-15 05:54 to 10-16 08:42 UTC: 150 consecutive
10-minute buckets inside the same window, Δ = change of the running-max envelope. The
regressors per bucket are real-turn cacheWrite / output / cacheRead split by family (opus,
sonnet, haiku), uncached input, keep-alive cacheRead, and an intercept. The keep-alive load
there is 1.82B reads in 25.8 h (70M/h), 17% of all cache reads on the org, and its
correlation with real-turn reads per bucket is **−0.045**. That low correlation is what makes
the two separable.

| spec | KA coef (util per B KA reads) | real cacheRead coefs (per B) | R² |
|---|---|---|---|
| 10 min, no lag | 0.094 (p10–p90 0.042–0.151) | opus 0.165, sonnet 0.118 | 0.903 |
| 10 min, + 1-bucket lag (sum) | **0.168** (0.116–0.225) | opus 0.174, sonnet 0.132 | 0.914 |
| 5 min, + lag (sum) | **0.185** (0.119–0.239) | opus 0.223, sonnet 0.122 | 0.692 |
| placebo: KA series circularly shifted ≥1 h (48 shifts) | median −0.006 (p10–p90 −0.065–0.047); 0/48 ≥ true 0.128 | — | — |

Block bootstrap: 400 resamples of 1-hour blocks. **Verdict:** keep-alive reads cost the same
as real cache reads, and the placebo rules out that busy-hour co-movement produces the
coefficient. As a share of all spend on that org, keep-alive accounted for +0.16 of the
+2.95 climb (≈ 5.5%, 0.0065/h) in the conservative no-lag fit, and ≈ 0.012/h at the
lagged price.

Attribution of that org's +2.95 over 25 h (no-lag fit): opus output +0.79, sonnet cacheRead
+0.70, opus cacheRead +0.43, opus cacheWrite +0.35, sonnet output +0.25, sonnet cacheWrite
+0.21, **keep-alive +0.16**, **intercept +0.08 (0.003/h)**. Without the keep-alive term the
intercept rises to 0.008/h, which shows that the unpriced keep-alive becomes "drift".

### Test 3 — 5-hour-window accounting across all history (where the 0.02/h goes)

There are 248 windows with real UUID orgs (≥ 20 turns, peak < 0.95), June–Nov. The fit is
Δenvelope per window, OLS with a 300× bootstrap. Units: per M tokens for cw/out/in/fable, per B
for cacheRead, per hour for span.

| model | span (drift/h) | cacheRead (per B) | R² |
|---|---|---|---|
| A: no cacheRead term (the plant model's situation) | **0.0192** (0.014–0.024) | — | 0.884 |
| B: cacheRead priced, no span | — | 0.171 (0.136–0.198) | 0.908 |
| C: both | **0.0117** (0.008–0.016) | 0.158 (0.125–0.188) | 0.911 |
| C, June → Oct 14 only | 0.0126 (0.009–0.017) | 0.103 (0.055–0.150) | 0.916 |

Model A reproduces the plant study's 0.020/h. Pricing real-turn cache reads removes about 40%
of it. The 0.012/h that remains sits in windows whose keep-alive fires the stats file cannot
see, and keep-alive ran through that period: the engine's own comment records "31 506
служебных ударов" logged on 2026-08-29. The October keep-alive intensity of 0.007–0.012/h per
active org covers that remainder. A window fit that includes keep-alive reads cannot be done
yet, because only 8 windows have itemized fires, and the cross-org fit is confounded by the
model mix (02b4bfd1 ran mostly Sonnet, which the pooled model over-predicts by about 0.1–0.3
per window with or without keep-alive).

### Test 4 — out-of-proxy clients: no evidence

The silent-gap test looked at real turns on the same org and window separated by ≥ 10 min with
no turn in between, quiet for 5 minutes before (< 20k work tokens), and peak < 0.95. It found
**87 gaps, 52 gap-hours, Σ Δ = −0.34 (≈ 0/h)**. Per org: f9420373 0.0056/h (29 h), 02b4bfd1
0.009/h (17 h), 35140078 0 (2 h). Those small positives are within meter lag. They are also an
upper bound that still includes keep-alive fires, since keep-alive is invisible in this file.
Synthetic `org-xxxxxxxx` keys show impossible negative jumps inside one window, so they mix
accounts and were excluded from every org-level test.

### Test 5 — web search / web fetch

The stats file writes `webSearch`/`webFetch` only on turns where they are non-zero: 121 turns,
79 searches and 59 fetches, all `claude-haiku-4-5`, 2026-09-05 → 10-09, mostly session
`kiberos-websearch*`. The comparison used isolated turns with 2k–20k input+cacheWrite tokens,
≤ 2k output, and no ≥ 20k-token neighbour within ±3 min:

| group | n | mean Δutil within 3 min | share stepping ≥ 0.01 |
|---|---|---|---|
| web tool used | 65 | 0.0052 | 0.46 |
| same-size Haiku, no web tool | 2,129 | 0.0060 | 0.55 |

The difference is not detectable at about ±0.0015 (SE). The bursts sit inside busy windows
(99–903 other turns in [−15 m, +5 m]), so they cannot be isolated better than this. Read it as
"no per-call surcharge large enough to see". It is not a proof of zero, because the fetched
pages enter as ordinary input tokens and are billed as such.

## Caveats

- **Missing ≠ zero.** The stats file omits every keep-alive fire (the bug above). It also omits
  turns without `org`/`util5h` and everything outside the proxy. Keep-alive is itemized for only
  ~28 h of one busy org plus ~3.5 h today.
- **Quantization 0.01.** The meter steps in whole points, so a single fire (≈ 0.005 points) is
  invisible. Only volume regressions resolve it.
- **Meter lag ≈ 36 s** contaminates any interval that starts near a real turn. That is why
  Test 1 is uninformative and Test 2 includes a lag term.
- The keep-alive price comes from one org and mostly Sonnet keep-alive reads (1.47B of 1.82B).
  The Opus keep-alive price is assumed equal to the Opus read price and was not measured
  separately.
- 2026-10-16 → 11-11 has no Anthropic turns in the stats file at all, so a "keep-alive off"
  control period does not exist in this data.

## Consequences

- The placement controller should model keep-alive as **session cost that continues while the
  session idles** (≈ lineage size × fires/hour × 0.17 per B reads), not as a free background
  term. A fleet of 36 live keep-alive sessions at about 270k tokens each cost ≈ 0.012/h on
  02b4bfd1.
- The plant model's 0.0203/h intercept should be replaced by a priced cacheRead term
  (≈ 0.10–0.17 per B ≈ 60–100M tokens per point). Keep-alive reads should enter the same term
  once they reach the stats file.
- The stats emitter bug blocks all of this from being measured continuously. It belongs to this
  repo, and fixing it is the next step.

Analysis scripts used for this report were kept outside the repo (`/tmp/quota-ka/*.py`,
regenerable from the logs above) because the brief limited changes to this one file.
