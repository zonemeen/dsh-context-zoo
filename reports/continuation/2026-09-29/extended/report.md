# Coding continuation evaluation

Task: `invoice-import-v2`; model: `deepseek-flash`; started: 2026-09-29T07:53:54.332Z.

All eight plugins use the same task and scoring. One baseline is shared across budget modes in each repetition. Results below retain every attempted trial.

Development stages: 10; compaction boundaries: 3, 6, 9. A complete pass requires correct final code, edits and development tests in every stage, three committed summaries, three disk replays, and a further source change after the third summary.

A protected skip or rejected summary permits continued work, but earns no compaction credit. “—” means the final stage was not reached. Each mode uses a fresh project; the baseline is repeated in each table for comparison.

## fixed

| Plugin / repeat | Task acceptance | Task status | Summaries | Replays | Complete protocol |
| --- | --- | --- | --- | --- | --- |
| Baseline / 1 | 43/43 | passed | 0/0 | 3/3 | passed |
| Claude Code / 1 | 43/43 | passed | 2/3 | 3/3 | compaction-incomplete |
| Codex / 1 | 43/43 | passed | 2/3 | 3/3 | compaction-incomplete |
| OpenCode / 1 | 43/43 | passed | 2/3 | 3/3 | compaction-incomplete |
| Pi / 1 | 43/43 | passed | 3/3 | 3/3 | passed |
| Qwen Code / 1 | 37/43 | failed | 2/3 | 3/3 | task-failed |
| ZCode / 1 | — | not-completed | 0/3 | 0/3 | runtime-error |
| Kimi Code / 1 | 43/43 | passed | 3/3 | 3/3 | passed |
| Cline / 1 | 43/43 | passed | 3/3 | 3/3 | passed |

## plugin-defaults

| Plugin / repeat | Task acceptance | Task status | Summaries | Replays | Complete protocol |
| --- | --- | --- | --- | --- | --- |
| Baseline / 1 | 43/43 | passed | 0/0 | 3/3 | passed |
| Claude Code / 1 | 43/43 | passed | 3/3 | 3/3 | passed |
| Codex / 1 | 43/43 | passed | 3/3 | 3/3 | passed |
| OpenCode / 1 | 43/43 | passed | 1/3 | 3/3 | compaction-incomplete |
| Pi / 1 | 43/43 | passed | 0/3 | 3/3 | compaction-incomplete |
| Qwen Code / 1 | 43/43 | passed | 3/3 | 3/3 | passed |
| ZCode / 1 | 43/43 | passed | 3/3 | 3/3 | passed |
| Kimi Code / 1 | 43/43 | passed | 3/3 | 3/3 | passed |
| Cline / 1 | 43/43 | passed | 2/3 | 3/3 | compaction-incomplete |

## Skips and errors

| Mode / plugin / repeat | After stage | Outcome | Reason |
| --- | --- | --- | --- |
| fixed / Claude Code / 1 | 3 | skipped-short-history | Estimated context 3756 is below minimum 4096. |
| fixed / Codex / 1 | 3 | skipped-short-history | Estimated context 3924 is below minimum 4096. |
| fixed / OpenCode / 1 | 3 | skipped-short-history | Estimated context 4079 is below minimum 4096. |
| fixed / Qwen Code / 1 | 9 | summary-truncated | Summary response stopped at its output limit |
| plugin-defaults / OpenCode / 1 | 6 | skipped-no-eligible-history | No compactable history yet. |
| plugin-defaults / OpenCode / 1 | 9 | skipped-no-eligible-history | No compactable history yet. |
| plugin-defaults / Pi / 1 | 3 | skipped-short-history | Estimated context 3679 is below minimum 4096. |
| plugin-defaults / Pi / 1 | 6 | skipped-no-eligible-history | No compactable history yet. |
| plugin-defaults / Pi / 1 | 9 | skipped-no-eligible-history | No compactable history yet. |
| plugin-defaults / Cline / 1 | 3 | skipped-short-history | Estimated context 4049 is below minimum 4096. |

- fixed / Qwen Code / 1: retry-example, retry-all-statuses-and-attempts, refresh-example, refresh-restarts-retention, retry-hint-example, retry-hint-bounds-and-fallback

- fixed / ZCode / 1: Stage model-step budget exhausted.

## Usage

| Mode / plugin / repeat | Task calls | Summary calls | Summary request caps | Input | Cached input | Output | Repeated reads | Time (s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| shared / Baseline / 1 | 32 | 0 | — | 7082 | 174592 | 8780 | 0 | 49.293 |
| fixed / Claude Code / 1 | 35 | 2 | 4096 | 31896 | 156544 | 13767 | 9 | 67.039 |
| fixed / Codex / 1 | 38 | 2 | 4096 | 30161 | 153216 | 12526 | 3 | 66.003 |
| fixed / OpenCode / 1 | 37 | 2 | 4096 | 26596 | 136704 | 11397 | 3 | 58.989 |
| fixed / Pi / 1 | 46 | 6 | 4096 | 41353 | 195968 | 17162 | 4 | 86.692 |
| fixed / Qwen Code / 1 | 56 | 3 | 4096 | 56295 | 480256 | 25610 | 12 | 127.511 |
| fixed / ZCode / 1 | 12 | 0 | — | 2328 | 23552 | 1740 | 0 | 12.162 |
| fixed / Kimi Code / 1 | 44 | 3 | 4096 | 20078 | 202752 | 15923 | 10 | 84.360 |
| fixed / Cline / 1 | 42 | 3 | 4096 | 32368 | 156800 | 14167 | 0 | 72.842 |
| plugin-defaults / Claude Code / 1 | 43 | 3 | 8192 | 44395 | 212608 | 17193 | 11 | 83.445 |
| plugin-defaults / Codex / 1 | 38 | 3 | 8192 | 35852 | 146304 | 14990 | 7 | 75.496 |
| plugin-defaults / OpenCode / 1 | 37 | 1 | 8192 | 12129 | 182784 | 11699 | 1 | 63.399 |
| plugin-defaults / Pi / 1 | 34 | 0 | — | 6809 | 179200 | 8259 | 0 | 49.871 |
| plugin-defaults / Qwen Code / 1 | 39 | 3 | 8192 | 46144 | 193152 | 20423 | 9 | 91.257 |
| plugin-defaults / ZCode / 1 | 45 | 3 | 8192 | 27332 | 276352 | 23938 | 4 | 107.925 |
| plugin-defaults / Kimi Code / 1 | 42 | 3 | 8192 | 19437 | 186880 | 13842 | 10 | 76.446 |
| plugin-defaults / Cline / 1 | 35 | 2 | 8192 | 25482 | 157440 | 11817 | 1 | 69.626 |

HTTP requests: 694; responses: {"200":694}. Calls without reported usage: 0. Elapsed: 1242.415 s. Input is uncached input; summaries and repeated reads are included.

## Configuration and evidence

Fixed summary cap: 4096; model route ceiling: 8192; task call cap: 4096; minimum estimated context at a boundary: 4096. Fixed mode uses one summary attempt and a 256-token recent tail (0 for Claude/Qwen). Plugin-default mode passes only auto:false and uses the plugin's default retention and retry behavior within the shared model route ceiling. Actual settings and request caps are recorded for every trial.

Manual checkpoints do not measure automatic trigger policies or actual context exhaustion. One trial per mode cannot rank strategies or establish that compaction caused a defect. Task versions and budget modes must be compared separately.

- [report.json](report.json)
- [final-sources.json](final-sources.json)

The JSON report records per-stage checks, compaction reasons and durable failure events, token estimates, actual source hashes, API calls, and replay outcomes. Local run directories retain source and session snapshots. Earlier reports are preserved separately.
