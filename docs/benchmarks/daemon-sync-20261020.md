# Request-thread checkpoint comparison, 2026-10-20

**Outcome: moving checkpoints off the request thread was measured and not adopted.** Every candidate lowered the request thread's COMMIT tail, but none lowered its event-loop tail consistently, and that tail is what a client of the daemon feels: the worst-window loop p99 was lower in 4, 2, 3 and 3 of six pairs and the loop maximum in 4, 5, 3 and 4 (`7910d11ef`, `f42b74085`, `6cded9b17` and the 64 MiB variant, in that order). A WAL can be reused only at a moment when nobody writes, so the final backfill of each cycle and its two full syncs (WAL, then database) need the writer lock wherever they run. On base the committing request runs them inside its COMMIT; with the flusher owning checkpoints, its RESTART holds the writer lock for the same syncs and the request thread waits in BEGIN instead (`store.begin_immediate`, 44.8–117.0 ms across the three RESTART candidates). The stall moves; it does not disappear. The engine keeps the base checkpointing; the per-route request timing, the worst synchronous sections (including the BEGIN label), skipping work for hung-up clients and the opt-in store identity ship without it.

Base: `0919faac45dc34f67439bfb55443777143c9cfd0` (main autocheckpoint at 4,000 frames with `checkpoint_fullfsync=1`, flusher PASSIVE every pass). Candidates, all in this branch's history:

- `7910d11ef`: flusher PASSIVE every pass and RESTART (`busy_timeout=0`) at 4,000 frames; main `wal_autocheckpoint=0`, `checkpoint_fullfsync=0`. Rejected in review: the COMMIT that restarts the WAL then syncs the new header with a plain fsync, which macOS may persist after later frames (SQLite ticket ff5be73dee).
- `f42b74085`: as above with main `checkpoint_fullfsync=1` and a 5 s backfill cadence below the trigger.
- `6cded9b17`: as `7910d11ef` with main `checkpoint_fullfsync=1`.
- A base-design variant (the `6cded9b17` tree with main `wal_autocheckpoint=16000`, the 64 MiB reuse target, and the worker RESTART disabled; not committed).

macOS, Node 24.16.0, shared host. No managed daemon was contacted or changed.

## Reproduction

With the repository’s cached dependencies and supported Node installed:

```sh
node scripts/daemon-load-bench.mjs --base 0919faac4 --seconds 30 --rounds 6 --out results/acceptance.json
```

Both `--rounds N` and `--rounds=N` are accepted. A round is a pair of trials: AB, then BA, repeating, where A is base and B is candidate. Six rounds run twelve trials in three ABBA blocks; the default remains two rounds (one ABBA block). Any positive integer pair count is accepted. Use a process-tree watchdog sized for the requested count, allowing at least `2 * rounds * (seconds + 30)` seconds plus build time. The historical two-round runs below used a 300-second watchdog.

Each build gets its own temporary root and HOME; the script stops its exact child PID and removes that root. The script archives the exact base and bundles each tree’s store, health, loop-facts and HTTP code. This is an isolated daemon composition with synthetic producers, not full provider/CLI bootstrap. Both trees use the same installed lockfile.

Each 30-second trial performs 6,000 model-shaped transactions over nine partitions, including a distinct 200 KiB external body every twentieth write, concurrently with 1,800 real run-detail requests from four paced clients. Detail parses a 100-event fixture, whose cursor the client checks. Status is polled every 250 ms through `GET /v2/daemon/status`, including the final completed ten-second loop window. Order is base/candidate, then candidate/base. Every trial completed all work with 6,001 COMMIT attempts (including setup), zero COMMIT failures and no flusher deaths. No separate disk stressor was added on the shared host.

The base predates COMMIT percentiles. An identical benchmark-only histogram observes the existing measured native COMMIT durations on both trees, after the timed call, and adds p50/p99 to the base status schema. It changes no SQL calls or pragmas. The candidate’s production request/synchronous timings remain enabled. Percentiles use two-significant-digit microsecond histograms; maxima are direct measurements. All numbers below come from status; loop maximum is the largest completed-window maximum, not an average of maxima.

## Quiet-host comparisons

Each run is `--seconds 30 --rounds 6`: twelve trials in three ABBA blocks. Every trial completed 6,000 writes and 1,800 detail reads with 6,001 COMMIT attempts, zero COMMIT failures and no flusher deaths. Times are milliseconds; a section label is the longest measured section in the loop-max window, not proof of the cause of that delay.

### `6cded9b17` (per-pass PASSIVE, RESTART at 4,000 frames, ordered restart header)

Run 08:15–08:23 local time, load1 2.8–6.3. Every candidate COMMIT p99 (3.71–5.63) was below every base p99 (6.05–8.64) and COMMIT max was lower in every pair, but the worst-window event-loop p99 was lower in only three of six pairs (worst window 63.3 against 49.4) and the loop maximum in three of six (worst 141.8 against 180.9). The candidate's loop-max windows were led by `store.begin_immediate` in every trial; WAL peaked at 19.6–24.3 MiB against 16 MiB.

| Order | Build | Round | COMMIT p99 | COMMIT max | Loop worst-window p99 | Loop max | Longest labelled section in the loop-max window | WAL max MiB | load1 start → end |
|---:|---|---:|---:|---:|---:|---:|---|---:|---|
| 1 | base | 1 | 6.815 | 51.888 | 49.414 | 101.974 | `store.commit` 38.844 | 16.21 | 3.57 → 2.87 |
| 2 | candidate | 1 | 4.799 | 26.961 | 43.975 | 76.677 | `store.begin_immediate` 49.581 | 21.91 | 2.87 → 3.35 |
| 3 | candidate | 2 | 5.247 | 35.160 | 41.714 | 141.820 | `store.begin_immediate` 111.277 | 19.59 | 3.35 → 3.39 |
| 4 | base | 2 | 6.143 | 53.903 | 40.894 | 79.233 | `store.commit` 53.903 | 15.88 | 3.39 → 2.77 |
| 5 | base | 3 | 6.047 | 57.690 | 41.320 | 86.639 | `store.commit` 27.365 | 15.89 | 2.77 → 6.26 |
| 6 | candidate | 3 | 4.063 | 21.276 | 34.374 | 107.217 | `store.begin_immediate` 79.592 | 20.69 | 6.08 → 4.60 |
| 7 | candidate | 4 | 3.711 | 19.471 | 30.441 | 94.110 | `store.begin_immediate` 75.274 | 20.73 | 4.60 → 3.87 |
| 8 | base | 4 | 7.327 | 56.939 | 37.585 | 94.503 | `store.commit` 56.939 | 15.82 | 3.87 → 3.09 |
| 9 | base | 5 | 6.239 | 62.214 | 36.930 | 96.469 | `store.commit` 62.214 | 15.88 | 3.09 → 3.17 |
| 10 | candidate | 5 | 5.247 | 20.054 | 42.303 | 102.629 | `store.begin_immediate` 78.375 | 24.27 | 3.17 → 3.01 |
| 11 | candidate | 6 | 5.631 | 30.544 | 63.308 | 103.023 | `store.begin_immediate` 72.453 | 21.13 | 3.01 → 3.18 |
| 12 | base | 6 | 8.639 | 64.552 | 49.381 | 180.879 | `store.commit` 60.181 | 15.85 | 3.18 → 3.07 |

### `f42b74085` (5 s backfill cadence)

Run 08:04–08:12, load1 2.2–3.2. The cadence lets about five seconds of writes accumulate between checkpoints: WAL 84–89 MiB against 16 MiB, so readers search a larger WAL index. COMMIT p99 was lower in four of six pairs, the worst-window loop p99 in two of six.

| Order | Build | Round | COMMIT p99 | COMMIT max | Loop worst-window p99 | Loop max | Longest labelled section in the loop-max window | WAL max MiB | load1 start → end |
|---:|---|---:|---:|---:|---:|---:|---|---:|---|
| 1 | base | 1 | 6.943 | 40.219 | 30.245 | 72.679 | `store.commit` 31.810 | 15.86 | 2.18 → 2.31 |
| 2 | candidate | 1 | 6.143 | 42.356 | 48.628 | 95.617 | `store.begin_immediate` 49.580 | 89.48 | 2.31 → 2.37 |
| 3 | candidate | 2 | 6.527 | 37.839 | 48.071 | 69.403 | `store.begin_immediate` 46.031 | 86.34 | 2.37 → 2.78 |
| 4 | base | 2 | 7.071 | 240.577 | 34.767 | 285.737 | `store.commit` 240.577 | 15.99 | 2.78 → 2.50 |
| 5 | base | 3 | 6.847 | 43.674 | 34.570 | 88.080 | `store.commit` 43.674 | 15.91 | 2.50 → 2.82 |
| 6 | candidate | 3 | 6.751 | 54.048 | 55.443 | 77.332 | `store.commit` 54.048 | 87.38 | 2.68 → 3.06 |
| 7 | candidate | 4 | 6.623 | 34.228 | 38.044 | 72.810 | `store.begin_immediate` 44.761 | 88.50 | 3.06 → 2.62 |
| 8 | base | 4 | 5.407 | 48.669 | 32.178 | 75.104 | `store.commit` 48.669 | 15.94 | 2.62 → 3.17 |
| 9 | base | 5 | 9.663 | 54.109 | 50.070 | 118.161 | `store.commit` 54.109 | 15.83 | 3.17 → 2.92 |
| 10 | candidate | 5 | 6.879 | 40.606 | 41.452 | 76.087 | `store.external_write` 57.316 | 84.17 | 2.92 → 2.84 |
| 11 | candidate | 6 | 7.007 | 43.802 | 30.523 | 72.614 | `store.begin_immediate` 46.686 | 84.40 | 2.84 → 2.82 |
| 12 | base | 6 | 6.751 | 46.142 | 45.318 | 82.444 | `store.commit` 43.687 | 15.83 | 2.82 → 2.97 |

### Base design with a 64 MiB autocheckpoint (variant, not committed)

Run 08:42–08:50 while the host application restarted twice, load1 3.6–6.0. Reusing the WAL four times less often lowered COMMIT p99 in four of six pairs and the worst-window loop p99 in three of six (35.8 against 35.2 in the worst window).

| Order | Build | Round | COMMIT p99 | COMMIT max | Loop worst-window p99 | Loop max | Longest labelled section in the loop-max window | WAL max MiB | load1 start → end |
|---:|---|---:|---:|---:|---:|---:|---|---:|---|
| 1 | base | 1 | 6.111 | 60.795 | 34.669 | 111.935 | `store.commit` 60.795 | 15.82 | 3.61 → 3.71 |
| 2 | candidate | 1 | 5.375 | 45.291 | 28.688 | 75.629 | `store.commit` 45.291 | 62.94 | 3.71 → 5.37 |
| 3 | candidate | 2 | 5.247 | 54.393 | 35.521 | 121.307 | `store.commit` 41.325 | 63.13 | 5.18 → 4.87 |
| 4 | base | 2 | 5.087 | 56.922 | 35.226 | 104.530 | `store.commit` 56.922 | 15.83 | 4.87 → 5.17 |
| 5 | base | 3 | 5.215 | 44.925 | 34.406 | 98.566 | `store.commit` 44.925 | 15.87 | 5.17 → 5.44 |
| 6 | candidate | 3 | 4.543 | 38.620 | 30.392 | 70.844 | `store.commit` 27.726 | 62.93 | 5.44 → 4.65 |
| 7 | candidate | 4 | 3.615 | 33.832 | 26.755 | 54.231 | `store.external_write` 41.480 | 62.94 | 4.65 → 4.13 |
| 8 | base | 4 | 4.703 | 44.038 | 32.850 | 79.757 | `store.commit` 42.872 | 15.91 | 4.13 → 5.17 |
| 9 | base | 5 | 4.415 | 40.439 | 24.084 | 59.703 | `store.commit` 40.439 | 15.83 | 5.00 → 5.65 |
| 10 | candidate | 5 | 4.991 | 53.034 | 35.783 | 97.911 | `store.commit` 46.748 | 62.94 | 5.65 → 5.15 |
| 11 | candidate | 6 | 5.215 | 29.277 | 35.586 | 78.905 | `store.commit` 29.277 | 62.94 | 5.15 → 5.98 |
| 12 | base | 6 | 5.855 | 59.664 | 32.965 | 95.158 | `store.commit` 59.664 | 15.87 | 5.98 → 5.88 |

### `7910d11ef` (plain-fsync restart header; rejected in review)

`--seconds 30 --rounds 6`, run 05:33–05:41 local time. Every trial completed 6,000 writes and 1,800 detail reads with 6,001 COMMIT attempts, zero COMMIT failures and no flusher deaths. Main-connection pragmas read back 4000/1/0 (`wal_autocheckpoint`/`checkpoint_fullfsync`/`fullfsync`) on base and 0/0/0 on the candidate in every trial. Times are milliseconds.

| Order | Build | Round | COMMIT p99 | COMMIT max | Loop worst-window p99 | Loop max | Longest labelled section in the loop-max window | WAL max MiB | load1 start → end |
|---:|---|---:|---:|---:|---:|---:|---|---:|---|
| 1 | base | 1 | 6.079 | 147.674 | 75.760 | 190.841 | `store.commit` 147.674 | 15.95 | 8.13 → 7.88 |
| 2 | candidate | 1 | 3.327 | 20.503 | 26.526 | 78.774 | `store.begin_immediate` 62.906 | 22.56 | 7.88 → 7.95 |
| 3 | candidate | 2 | 4.319 | 89.633 | 32.408 | 146.538 | `store.commit` 89.633 | 30.05 | 7.95 → 8.17 |
| 4 | base | 2 | 6.303 | 54.244 | 32.719 | 81.461 | `store.commit` 54.244 | 15.85 | 8.17 → 7.78 |
| 5 | base | 3 | 7.807 | 56.479 | 46.629 | 118.292 | `store.external_write` 96.402 | 15.89 | 7.78 → 8.30 |
| 6 | candidate | 3 | 3.983 | 27.706 | 36.864 | 106.562 | `store.begin_immediate` 92.906 | 20.62 | 7.96 → 8.13 |
| 7 | candidate | 4 | 3.935 | 25.052 | 45.318 | 131.465 | `store.begin_immediate` 116.959 | 22.75 | 8.13 → 5.84 |
| 8 | base | 4 | 7.551 | 196.407 | 42.959 | 365.429 | `store.external_write` 237.227 | 15.83 | 5.84 → 5.85 |
| 9 | base | 5 | 7.423 | 136.346 | 63.668 | 176.161 | `store.commit` 136.346 | 16.14 | 5.85 → 6.75 |
| 10 | candidate | 5 | 4.799 | 41.019 | 32.571 | 88.801 | `store.begin_immediate` 62.692 | 21.01 | 6.45 → 7.81 |
| 11 | candidate | 6 | 4.895 | 121.053 | 51.282 | 363.069 | `store.commit` 121.053 | 44.03 | 7.81 → 6.01 |
| 12 | base | 6 | 6.783 | 159.462 | 41.681 | 199.492 | `store.commit` 159.462 | 15.87 | 6.01 → 6.66 |

| Build | Worst trial COMMIT p99 | COMMIT max | Worst window loop p99 | Loop max | Longest labelled section in that window |
|---|---:|---:|---:|---:|---|
| base | 7.807 | 196.407 | 75.760 | 365.429 | `store.external_write` 237.227 |
| candidate | 4.895 | 121.053 | 51.282 | 363.069 | `store.commit` 121.053 |

Base loop-max windows were led by `store.commit` in four trials and by `store.external_write` (O_DSYNC body files, which this change does not touch) in two. Candidate loop-max windows were led by `store.begin_immediate` in four trials (62.7–117.0 ms), that is, the request thread waiting for the writer lock, which the worker holds while it checkpoints, and by `store.commit` in two. The tied loop maximum belongs to different sections on the two builds: an external write in base round 4, a COMMIT in candidate round 6, whose WAL also peaked at 44.0 MiB against 20.6–30.1 MiB in the other candidate trials. As below, a label is the longest measured section in the same window, not proof of the exact cause of its maximum delay.

Raw per-trial status samples and every loop window are kept with the run (`acceptance.json` and its sibling status files); each run above is a phase of [daemon-sync-20261020.json](daemon-sync-20261020.json), named after its candidate.

## Harness output

The updated harness prints one JSON `run_summary` line per trial to stdout, with separate `commit` p99/max and `eventLoop` tails, plus WAL and host-load observations. Start/stop PID messages go to stderr. The result file retains every trial, whether the candidate tree had uncommitted changes (`candidateDirty`), raw status samples in sibling files, and two `build_summary` records (also printed at the end). Build summaries report `worstRunP99Ms` for COMMIT, `worstWindowP99Ms` for the loop, and maxima separately. These are explicitly worst observed percentiles, not pooled p99s or averages; individual trial/window values remain available for comparison.

Every completed native loop window retains its worst labelled synchronous section and the maximum for each instrumented operation. An identical benchmark observer wraps the actual external-file writer and run-detail function bodies on both source trees, observes the already-timed native COMMIT, and times `BEGIN IMMEDIATE`. It records one maximum per label and resets at the same loop-roll boundary as status, then sends that window via IPC; HTTP polling cannot lose a window or its smaller later stalls. The last captured window is checked against the status response. Source instrumentation fails if either function is renamed or becomes asynchronous; it changes no SQL, pragmas, native sync calls or worker behavior.

Labels distinguish `store.external_write` (including O_DSYNC writes, which no candidate changed), `store.commit` (including base autocheckpoints/WAL-header syncs), `store.begin_immediate` (including writer-lock waits), and `control.run_detail`. The summary's maximum-loop window includes its worst section's label, duration and timestamps; each trial's `loops` array retains that attribution for every window. A worker checkpoint runs on another thread, so it is not labelled as a synchronous request-thread stall; any writer-lock wait appears under BEGIN. These labels identify the longest measured section **in the same window**, not proof that it caused the exact maximum delay sample. GC, uninstrumented work and host scheduling can also contribute. This attribution is available on both builds and does not depend on the production lifetime top-32 list.

## Earlier loaded-host comparisons

These trials ran while eight implementation lanes shared the Mac. Their tables and JSON phases are unchanged.

### COMMIT latency (milliseconds)

| Candidate phase | Trial | Build | p99 | Max |
|---|---:|---|---:|---:|
| PASSIVE only | 1 | base | 10.367 | 288.261 |
| PASSIVE only | 1 | candidate | 39.935 | 1194.339 |
| PASSIVE only | 2 | candidate | 20.863 | 924.914 |
| PASSIVE only | 2 | base | 8.063 | 137.756 |
| RESTART at 64 MiB | 1 | base | 5.855 | 439.710 |
| RESTART at 64 MiB | 1 | candidate | 15.103 | 140.269 |
| RESTART at 64 MiB | 2 | candidate | 8.319 | 119.876 |
| RESTART at 64 MiB | 2 | base | 7.935 | 141.672 |
| RESTART at 4,000 frames (final) | 1 | base | 20.863 | 1295.484 |
| RESTART at 4,000 frames (final) | 1 | candidate | 21.375 | 269.633 |
| RESTART at 4,000 frames (final) | 2 | candidate | 18.687 | 393.881 |
| RESTART at 4,000 frames (final) | 2 | base | 28.671 | 2585.840 |

### Event-loop delay and WAL

| Candidate phase | Trial | Build | Loop max ms | Sampled WAL max MiB | Host load1 start → end |
|---|---:|---|---:|---:|---|
| PASSIVE only | 1 | base | 1032.323 | 16.915 | 12.24 → 16.90 |
| PASSIVE only | 1 | candidate | 1245.708 | 410.489 | 16.90 → 13.44 |
| PASSIVE only | 2 | candidate | 968.360 | 410.501 | 13.44 → 11.24 |
| PASSIVE only | 2 | base | 225.444 | 16.271 | 11.24 → 9.07 |
| RESTART at 64 MiB | 1 | base | 513.278 | 18.459 | 10.42 → 10.61 |
| RESTART at 64 MiB | 1 | candidate | 189.268 | 103.494 | 10.61 → 13.72 |
| RESTART at 64 MiB | 2 | candidate | 2420.113 | 113.556 | 14.71 → 12.87 |
| RESTART at 64 MiB | 2 | base | 176.030 | 15.870 | 12.87 → 13.44 |
| RESTART at 4,000 frames (final) | 1 | base | 1331.692 | 15.815 | 37.84 → 37.50 |
| RESTART at 4,000 frames (final) | 1 | candidate | 3539.993 | 25.441 | 36.34 → 43.17 |
| RESTART at 4,000 frames (final) | 2 | candidate | 1086.325 | 29.649 | 43.17 → 36.53 |
| RESTART at 4,000 frames (final) | 2 | base | 2661.286 | 16.726 | 36.53 → 28.38 |

### Findings

Removing the main autocheckpoint while keeping only background PASSIVE checkpoints allowed continuing writes to append past each captured checkpoint prefix. WAL grew to about 410 MiB. In the measured candidates a worker RESTART attempt prevented indefinite reuse starvation when readers and writers permitted it; their final trigger kept the 4,000-frame threshold (the shipped engine's main autocheckpoint), and the retained-file limit stayed 64 MiB. Main `wal_autocheckpoint=0`, `checkpoint_fullfsync=0` and `fullfsync=0` were verified in every candidate; base readbacks were 4000/1/0.

In those candidates RESTART could briefly exclude writers, while `busy_timeout=0` returned BUSY for an existing writer or pinned reader, so it remained a soft target; it kept checkpoint full syncs on the worker and retained the explicit WAL barrier. See [SQLite’s checkpoint mode contract](https://sqlite.org/pragma.html#pragma_wal_checkpoint). Their pinned-reader regression test exercised BUSY, release, reuse and the subsequent barrier; it was removed together with the change.

On the loaded host, the final comparison reduced worst COMMIT from 2,585.840 ms to 393.881 ms, but worst event-loop delay increased from 2,661.286 ms to 3,539.993 ms. Final p99 was slightly worse in round 1 (21.375 vs 20.863 ms), better in round 2 (18.687 vs 28.671 ms). The final candidate’s longest labelled synchronous sections were external file writes of 3,187.806 ms and 995.338 ms. These observed O_DSYNC stalls remain; moving checkpoint full syncs does not eliminate all synchronous filesystem waits. Host load1 varied substantially, reaching 43.17, so these trials cannot isolate environmental effects from the change.

All failed intermediate comparisons are retained above. At load1 up to 43 they could not separate host effects from the change; the quiet-host comparisons above supersede them. Synchronous external-file writes (O_DSYNC, unchanged here) still reach hundreds of milliseconds on a loaded host and remain a separate investigation.

The candidates' durability/compatibility validation: all 398 store tests and all 577 control-API tests passed; timing/status/scope tests, build, test typecheck and generated schema validation also passed. Physical power failure was not simulated; barrier ordering, WAL recovery, process-kill recovery, pinned readers, worker restart and close ordering were exercised.

Machine-readable measurements: [daemon-sync-20261020.json](daemon-sync-20261020.json).
