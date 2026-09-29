# Repeated-compaction coding evaluation

English | [简体中文](README.zh-CN.md)

Date: 2026-09-29. Model: `deepseek-flash`, thinking disabled, using the official DeepSeek Anthropic-compatible endpoint. Task: `invoice-import-v1`. One unified run covers all eight plugins and one shared uncompressed baseline, with one trial per condition. All use the same task, acceptance cases, and report format.

## Results

| Condition | Successful compactions | Disk replays | Final acceptance | Status | Model calls | Elapsed (s) |
| --- | --- | --- | --- | --- | --- | --- |
| Uncompressed baseline | 0 | 3/3 | 24/24 | Passed | 17 | 23.318 |
| Claude Code | 2/3 | 2/3 | — | Evaluation failed | 18 | 37.727 |
| Codex | 3/3 | 3/3 | 24/24 | Passed | 21 | 39.037 |
| OpenCode | 3/3 | 3/3 | 24/24 | Passed | 25 | 43.095 |
| Pi | 3/3 | 3/3 | 24/24 | Passed | 23 | 39.845 |
| Qwen Code | 0/3 | 0/3 | — | Evaluation failed | 6 | 11.822 |
| ZCode | 0/3 | 0/3 | — | Evaluation failed | 9 | 15.542 |
| Kimi Code | 0/3 | 0/3 | — | Evaluation failed | 6 | 10.258 |
| Cline | 3/3 | 3/3 | 24/24 | Passed | 18 | 28.468 |

5/9 conditions passed the complete protocol. A pass requires all 24 final acceptance cases, actual source edits and development tests in every stage, all required compactions, and three disk replays. “—” means that the final stage was not reached; earlier acceptance is shown below. Failed trials were retained without retrying or changing their budgets.

| Condition | Stage 1: retry | Stage 2: store | Stage 3: import | Stage 4: batch |
| --- | --- | --- | --- | --- |
| Uncompressed baseline | 4/4 | 10/10 | 20/20 | 24/24 |
| Claude Code | 4/4 | 10/10 | 20/20 | — |
| Codex | 4/4 | 10/10 | 20/20 | 24/24 |
| OpenCode | 4/4 | 10/10 | 20/20 | 24/24 |
| Pi | 4/4 | 10/10 | 20/20 | 24/24 |
| Qwen Code | 4/4 | — | — | — |
| ZCode | 4/4 | — | — | — |
| Kimi Code | 4/4 | — | — | — |
| Cline | 4/4 | 10/10 | 20/20 | 24/24 |

## Failure observations

- **Claude Code**: Compaction after stage 3 failed. `Summary response stopped at its output limit`.
- **Qwen Code**: Compaction after stage 1 failed. `Qwen summary and restored context would increase history tokens`.
- **ZCode**: Compaction after stage 1 failed. `Summary and recovered context are not smaller than the selected history`.
- **Kimi Code**: Compaction after stage 1 failed. `Summary and recovered context are not smaller than the selected history`.

Exact compaction failure events are retained in [compaction-errors.json](compaction-errors.json). A successful summary alone does not imply successful task continuation. One stochastic trial per condition cannot establish a quality ranking or attribute a code defect to compaction.

Claude Code's third summary hit the 2,048-token output cap. Qwen Code, ZCode, and Kimi Code rejected their first summaries because the summary and restored context would not reduce the selected history. Their original context was preserved. These outcomes reflect forced compaction of short histories under this run's budget; they do not measure the plugins' default automatic policies.

## Context and usage

| Plugin | Compaction 1 | Compaction 2 | Compaction 3 |
| --- | --- | --- | --- |
| Claude Code | 2,577 → 2,551 | 4,441 → 3,282 | 4,715 → 4,715 (not committed) |
| Codex | 1,896 → 1,869 | 3,771 → 2,377 | 4,241 → 2,465 |
| OpenCode | 2,729 → 1,624 | 3,470 → 1,741 | 4,361 → 2,122 |
| Pi | 1,901 → 1,563 | 3,488 → 2,431 | 4,594 → 2,865 |
| Qwen Code | 1,984 → 1,984 (not committed) | — | — |
| ZCode | 2,806 → 2,806 (not committed) | — | — |
| Kimi Code | 1,897 → 1,897 (not committed) | — | — |
| Cline | 1,850 → 1,399 | 3,212 → 3,086 | 4,113 → 2,773 |

Context values are DSH token estimates before and after each attempted compaction, not billable token counts. An uncommitted summary leaves the original context in place.

| Condition | Uncached input | Cached input | Output | Summary calls | Repeated reads |
| --- | --- | --- | --- | --- | --- |
| Uncompressed baseline | 3,655 | 46,976 | 3,690 | 0 | 0 |
| Claude Code | 19,276 | 31,488 | 8,570 | 3 | 9 |
| Codex | 19,746 | 38,016 | 7,984 | 3 | 8 |
| OpenCode | 19,822 | 45,312 | 8,410 | 3 | 9 |
| Pi | 18,256 | 37,888 | 7,821 | 5 | 5 |
| Qwen Code | 2,635 | 5,632 | 2,384 | 1 | 3 |
| ZCode | 1,938 | 14,464 | 2,928 | 1 | 1 |
| Kimi Code | 1,159 | 7,424 | 2,020 | 1 | 0 |
| Cline | 13,741 | 27,136 | 5,773 | 3 | 3 |

All 143 HTTP requests returned 200. Whole-run elapsed time: 249.127 seconds. Cache-write tokens: 0. Calls without reported usage: 0. Usage includes task and summary calls; no monetary cost is calculated. Pi can summarize history and a split turn separately, so its three compactions used five summary calls.

## Earlier observations

The initial partial run is preserved unchanged in [initial-results.json](initial-results.json) and [initial-final-sources.json](initial-final-sources.json): baseline 24/24, Cline 22/24. Its two failed cases were `retry-schedule` and `attempt-limit`; the importer supplied the next attempt number to a helper expecting the completed attempt number. It waited 500 ms before attempt 2 and stopped before attempt 3. This observation remains available alongside the new complete run. The runs are not pooled as equal repetitions because their strategy coverage differs.

The initial network attempt failed before any model response (two `fetch failed` errors); [connection-attempt.json](connection-attempt.json) retains that infrastructure failure.

## Artifacts and reproduction

- [results.json](results.json): exact report for the unified nine-condition run, including unsuccessful trials.
- [final-sources.json](final-sources.json): exact final source files for every condition, including unfinished projects.
- Full local projects, intermediate source and session snapshots: `.artifacts/continuation/2026-09-29/all-plugins-live/` (Git ignored).

```sh
pnpm build
node --env-file=.env.local scripts/check-deepseek-continuation.mjs \
  --output .artifacts/continuation/new-run
```

The command defaults to all eight plugins and one shared baseline. `--agent <id>` selects any one plugin; `--repeats` repeats the complete selection.

Shared settings: summary output cap 2,048; task output cap 4,096; at most 12 model steps per stage; `maxSummaryAttempts: 1`; no provider transport retries. `keepRecentTokens` is 256 except Claude Code and Qwen Code, which use their default full-history value of 0. Actual settings are recorded per trial. The workload is a controlled small project with forced manual compactions; automatic thresholds and actual context exhaustion were not tested. Use more repetitions and task families before comparing strategy quality. See the [evaluation guide](../../../docs/continuation-evaluation.md).
