# Pi Context Strategy

English | [简体中文](README.zh-CN.md)

This package owns Pi's usage estimation, cut-point selection, history and turn-prefix summaries, file-operation records, branch summaries, and recovery. DSH provides session observations, model calls, and commit operations.

## Default behavior

- Reads the latest valid assistant usage, excluding errors, cancellations, and zero usage, then adds character-based estimates for subsequent messages. Text, reasoning, tool names, and arguments are counted by dividing their character count by 4 and rounding up; each image counts as 1,200 tokens. Usage from messages before compaction does not trigger another compaction.
- Reserves 16,384 tokens by default and triggers when usage strictly exceeds the context window minus the reserve.
- Counts backward through roughly 20,000 tokens and cuts at a user or assistant message; a tool result cannot start the retained tail. Keeps the current history when no safe cut point exists.
- When the cut falls inside a turn, uses separate model calls to summarize earlier history and the turn prefix, then combines the results. The prefix uses Original Request, Early Progress, and Context for Suffix headings to support continued work from the retained part of the turn.
- Uses Goal, Constraints & Preferences, Progress, Key Decisions, Next Steps, and Critical Context headings for ordinary history summaries, merging any previous summary. The default output budget is 80% of the reserve for history and 50% for a turn prefix, both capped by the model's output limit.
- Limits each tool output in the summary input to 2,000 characters by default. This does not change older tool results in the live context.
- Accumulates file paths from `read`, `edit`, and `write` operations in `<read-files>` and `<modified-files>` records. Modified files are removed from the read-only list, and later compactions inherit these records.
- Retries transient network or provider errors up to 3 times by default, with delays of 2, 4, and 8 seconds and a 60-second delay cap. Quota, billing, cancellation, truncation, and tool-call responses are not retried as transient failures. If any summary fails, no partial result is committed.
- Performs only one overflow recovery per request sequence by default. Failed requests that DSH has not committed remain in the attempt log and do not enter the next model context.

`reserveTokens`, `thresholdRatio`, and `keepRecentTokens` override the budgets; the ratio applies to the window after subtracting the reserve. `maxSummaryTokens` overrides the output budgets for both history and turn prefixes. `maxSummaryAttempts` includes the initial request and defaults to 4; `summaryRetryDelayMs` adjusts the base retry delay. `maxConsecutiveFailures` can limit consecutive failures in automatic processing; a successful manual compaction resets the count. `auto: false` disables only the automatic hooks.

## Branch summaries

`createPipeline(config).summarizeBranch(host, entries)` summarizes branch records supplied by the caller. When the input is too long, it selects records from newest to oldest and gives existing checkpoints priority when enough budget remains. The default output limit is 4,096 tokens, and file-operation records from existing summaries are accumulated. The returned text can be injected into the destination branch; this method does not replace the current session history.

## Implementation scope

DSH handles persistence and request routing; this package maintains all selection and transformation steps. Pi's session-tree UI and third-party extension handlers require the Pi runtime. This package exposes entry points through explicit branch methods and configuration. Disabling cache writes for Pi's auxiliary requests requires provider support, which the current DSH model interface does not expose.

DSH's system and developer messages stay in place. The plugin runs Pi's cut-point algorithm within each contiguous history segment, skipping segments with no compactable prefix. Usage accounting covers the full context. Summaries and file-operation records inherit every checkpoint in the current context and fall back to plugin state records only when the context has no checkpoints. Usage recorded before any current checkpoint is treated as stale.

Original project: [earendil-works/pi](https://github.com/earendil-works/pi). The inspected local fork is pinned to `8a7b0c03dfb702663acafb6dc29f8acaa4ffe391`. The source project uses the MIT license. The reference entry point is `packages/coding-agent/src/core/compaction/compaction.ts`. This project uses rewritten summary instructions.
