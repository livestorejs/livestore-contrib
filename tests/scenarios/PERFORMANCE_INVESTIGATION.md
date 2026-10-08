# Serialized sync stack performance investigation

Status: investigation pending before landing. Measurements below were collected
on 2026-10-08. Related work: [slashv/livestore#8](https://github.com/slashv/livestore/pull/8)
and [livestorejs/livestore#1265](https://github.com/livestorejs/livestore/issues/1265).

## Reproduce

Use the contrib branch `codex/test-serialized-sync-pr8`, which contains the
benchmark runner, viewer comparison, browser schema fix, and 512 KiB payload
scenario. Its dependency preparation commit updates the core pin and generated
workspace manifests to Effect 4.0.0. This is a test environment, not a separately
validated repository-wide dependency upgrade for landing.

Use Node 24, the pinned pnpm, and the Full Setup described in the contributor
guide for browser support. The original environment used Node 24.13.1,
pnpm 12.7.0, Playwright 1.63.0 / Chromium 1243 on an Apple M1 Pro.
Run from the contrib checkout root; do not run in the core repository root.
The two commits must be available in the materialized core Git repository:

```sh
git -C repos/livestore fetch https://github.com/slashv/livestore.git \
  3cb74e62017c463f49323d296ba73450efc60007 \
  1ae1b9fa77ef46b8e37084cf20cea5c4822c729d

pnpm --dir tests/scenarios benchmark \
  --baseline 3cb74e62017c463f49323d296ba73450efc60007 \
  --candidate 1ae1b9fa77ef46b8e37084cf20cea5c4822c729d \
  --scenario many-writer-convergence --scenario pending-tail-recovery \
  --profile in-process --profile process --profile browser \
  --samples 10 --warmups 1
```

This runs 120 measured samples plus 12 warmups, sequentially, with alternating
baseline/candidate order. Defaults retain the 426-event many-writer workload,
400-event pending tail, and seed 0. Keep the machine otherwise idle and do not
edit the harness or lockfile during a campaign. Do not run another source
selection or modify `repos/livestore` concurrently: the launcher temporarily
projects each selected revision there and restores the original afterward.

For a new committed core fix, fetch its commit into `repos/livestore` and replace
only `--candidate`. Uncommitted edits in another core checkout are not selected
by this command. Dependency-incompatible revisions require a matching installed
environment; do not bypass the compatibility check.

Campaign manifests and raw evidence are in
`tests/scenarios/artifacts/benchmarks/<campaign-id>/`. Refresh the viewer and
select **Saved runs → Compare**, then the campaign. Inspect both **Writes →
settled** and **Time to pass**, counts, medians, and min–max ranges.
Correctness failures produce nonzero exit status but retain the completed
campaign; inspect the manifest before treating a nonzero exit as infrastructure
failure. See [the measurement contract](./README.md#compare-correctness-and-performance).

## Preliminary evidence, not confirmed performance conclusions

Baseline: `3cb74e62017c463f49323d296ba73450efc60007` (common ancestor).
Candidate: `1ae1b9fa77ef46b8e37084cf20cea5c4822c729d` (PR stack snapshot).
The earlier correctness campaign was not an alternating paired benchmark.
Numbers below measure first action through terminal settlement, including
scripted waits and observation overhead. Negative changes mean shorter duration.

| Scenario / profile | Samples per revision | Baseline median | Candidate median | Change |
| --- | --- | --- | --- | --- |
| Many writers / in-process | 3 | 1.581 s | 2.675 s | +69.1% |
| Many writers / process | 3 | 17.570 s | 15.026 s | -14.5% |
| Pending tail / browser | 1 | 3.567 s | 2.122 s | -40.5% |
| Pending tail / in-process | 1 | 1.089 s | 1.662 s | +52.6% |
| Pending tail / process | 1 | 1.538 s | 2.710 s | +76.2% |

All three in-process many-writer candidate samples were slower than all three
baseline samples. Prioritize reproducing this, then the pending-tail differences.
Browser many-writer passed 1/3 on baseline and 3/3 on candidate; do not infer a
speedup from the failing baseline. The hotel conflict is an expected correctness
failure and is deliberately outside this performance matrix.

The paired offline-browser smoke campaign
`2026-10-08T18-53-57-616Z-47dd2bd0` has two measured samples per revision:
workload 480 → 464 ms (-3.4%), total time 3.534 → 3.624 s (+2.5%). This validates
the runner, not a speed difference. Settlement polls every 100 ms, plus observation
time; small changes are noise candidates.

Existing raw correctness artifacts use `artifacts/pr8-*.json`; local campaign
scripts/report also remain under the ignored `tasks/pr8/` directory. Generated
artifacts are local evidence and are not committed. This document and the runner
are the portable reproduction instructions.

## Investigation goal

Confirm or reject the apparent regressions with the paired campaign before
landing. For reproduced regressions, inspect action/recovery trace intervals and
profile core processing separately to distinguish sync work from harness waits,
polling, and observation. Preserve correctness outcomes, report sample spread,
and rerun the same workload against any proposed committed fix. Avoid a single
aggregate speedup across profiles or failed runs.
