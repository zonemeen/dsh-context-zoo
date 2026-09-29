# Ten-stage coding continuation evaluation

English | [简体中文](README.zh-CN.md)

Date: 2026-09-29. Task: `invoice-import-v2`. Model: `deepseek-flash`, thinking disabled. All eight plugins ran with fixed budgets and plugin defaults, sharing one uncompressed baseline: 17 trials, each with a fresh project and session.

## Results

| Mode | Task passed | Complete protocol passed |
| --- | --- | --- |
| Shared baseline | 1/1 | 1/1, exempt from compaction |
| Fixed budget | 6/8 | 3/8 |
| Plugin defaults | 8/8 | 5/8 |

The complete protocol also requires three committed summaries, three disk replays, and a source change after the third compaction. A correct task with fewer summaries is reported as incomplete compaction.

Each cell below lists final acceptance and successful compactions. Every trial reaching the final stage completed all three disk replays.

| Plugin | Fixed budget | Plugin defaults |
| --- | --- | --- |
| Claude Code | 43/43; 2 summaries | 43/43; 3 summaries |
| Codex | 43/43; 2 summaries | 43/43; 3 summaries |
| OpenCode | 43/43; 2 summaries | 43/43; 1 summary |
| Pi | 43/43; 3 summaries | 43/43; 0 summaries |
| Qwen Code | 37/43; 2 summaries | 43/43; 3 summaries |
| ZCode | Final stage not reached; 0 summaries | 43/43; 3 summaries |
| Kimi Code | 43/43; 3 summaries | 43/43; 3 summaries |
| Cline | 43/43; 3 summaries | 43/43; 2 summaries |

## What the outcomes distinguish

- **Short history:** fixed-budget Claude Code, Codex, and OpenCode, plus default-configured Cline, were below the 4,096-token floor at the first boundary. They continued, completed the task, and later committed two summaries.
- **Retention selected no eligible history:** default-configured OpenCode and Pi found no compactable history at their last two boundaries. Pi also skipped its first boundary for short history. They completed the task with one and zero summaries respectively.
- **Truncation and code defects are retained independently:** fixed-budget Qwen Code hit the 4,096-token cap at its third summary and still continued through stage 10. Six final cases failed, involving retry attempt semantics, forced refresh, and retry hints. Retry errors already appeared at stage 1, before any compaction, so they cannot be attributed to compaction.
- **Step budget exhausted:** fixed-budget ZCode used all 12 model requests in stage 1 without returning its stage-completion response. Its last development tests passed. Rechecking saved source also passed stage 1's 4/4 acceptance cases, but the remaining nine stages never ran, so the complete task did not pass.

Each mode has one stochastic trial per plugin, with independently generated code and history. These differences cannot establish a better budget or strategy. Plugin defaults remain constrained by the shared 8,192-token model route ceiling. Manual boundaries do not evaluate default automatic trigger policies.

All 694 HTTP requests returned 200; elapsed time was 1,242.415 seconds. Every call reported API usage. See the [full report](report.md) for request caps, stage acceptance, timings, and repeated reads.

## Changes and reproduction

- Expanded the four-stage task to ten stages and 24 final cases to 43. Compaction is checked after stages 3, 6, and 9; stage 10 adds batch cancellation.
- Protective skips and rejected summaries allow integrity checks, disk replay, and continued work. Successful-summary counting stays strict.
- Reports distinguish task, compaction, and replay outcomes, and automatically export bilingual summaries and final sources.
- The earlier task and [earlier report](../README.md) remain available separately.

```sh
pnpm build
node --env-file=.env.local scripts/check-deepseek-continuation.mjs \
  --budget-mode both --output .artifacts/continuation/new-extended-run
```

The [evaluation guide](../../../../docs/continuation-evaluation.md) explains modes, classifications, limits, and flow diagrams.

## Evidence

- [report.json](report.json): exact original runner output.
- [final-sources.json](final-sources.json): all 17 final source sets, including unfinished projects.
- [verification.json](verification.json): source hashes, reproduced acceptance, summary events, and boundary-snapshot checks; partial-project grades are diagnostic and do not alter the original score.
- Full local sessions and intermediate code: `.artifacts/continuation/2026-09-29/extended-both-live/` (Git ignored).

`pnpm check` passed 269 tests and all nine package checks. All live task failures remain in the results.
