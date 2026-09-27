# ZCode Context Plugin

English | [简体中文](README.zh-CN.md)

This package adapts the ZCode workflow for usage accounting, microcompaction, conversation-turn selection, summary retries, and recovery reminders. Its default export is a DSH Cordis plugin; `createPipeline(config)` can accept a `ContextHost` directly. See the [root README](https://github.com/zonemeen/dsh-context-zoo/blob/main/README.md) for integration.

## npm installation

After release, install with `dsh plugin --profile web add dsh-context-zcode`. Apply the host Session patch and generate the activation overlay as described in the [npm guide](https://github.com/zonemeen/dsh-context-zoo/blob/main/docs/publishing.md#using-the-published-packages). Installing the package alone does not replace the active context engine.

## Default workflow

- Uses the latest assistant provider usage as a baseline and adds subsequent messages; without usage data, estimates tokens as character count divided by 4. Cached input counts toward usage. After pruning, only savings already included in the usage baseline are subtracted.
- Runs full compaction at `contextWindow - min(maxOutputTokens, 21,000) - 13,000`. Microcompaction starts earlier, at the smaller of 90% of that threshold and the threshold minus 2,000; it also runs when more than 60 minutes have passed since the last assistant message.
- Groups microcompaction candidates by assistant tool batch and keeps the five most recent groups of eligible results. It clears results only when estimated savings reach 256 tokens. Error and media results are preserved. Eligible tools include Read, Bash, Grep, Glob, WebFetch, WebSearch, Edit, Write, ApplyPatch, and explicitly listed DSH aliases.
- Uses assistant messages to start conversation turns. Automatic compaction and overflow recovery keep the last turn; manual compaction summarizes all selected history. The portion to summarize must contain at least two turns and one assistant message. Tool calls and their results remain complete.
- If summary input exceeds the limit, the automatic workflow moves more recent turns into the retained portion. The manual workflow drops only the oldest complete turns from the auxiliary summary request and adds a truncation notice. It makes at most three adjustments. If a media request fails, it retries once with media removed from the summary input; original media remains in the log.
- Automatic summarization makes at most three attempts; explicitly non-retryable errors fail immediately. Three consecutive failed operations pause automatic compaction until a manual operation succeeds. Each model step allows one overflow recovery by default. Repeated compaction stops after three consecutive cases in which the context fills again before three complete tool batches finish. This counter resets on a new user turn.
- Summaries are limited to 20,000 tokens and the model's output limit. Tool schemas are included in auxiliary requests when there are at most 100 tools. The plugin removes `<analysis>` and extracts optional `<summary>` content; it rejects blank, truncated, failed, tool-call, and media summaries.
- After success, restores an observed plan, the contents of the five most recent successful Reads, TODOs, reminders, and a log entry point. File content is limited to 5,000 tokens per file and 50,000 in total; only paths are restored when the budget is exceeded. Reads already present in the retained portion and `.git` files are excluded from restoration.

## Configuration

`reserveTokens` overrides the output reserve; `thresholdRatio` sets the full-compaction threshold directly to the context window multiplied by that ratio. `tailTurns` overrides the number of turns retained automatically, and `keepRecentTokens` can increase the retention budget. `prune`, `idleMinutes`, `keepRecentTools`, and `minPruneTokens` control microcompaction.

`maxSummaryTokens`, `maxSummaryAttempts`, `summaryToolChars`, `summarizationProvider`, and `summarizationModel` control auxiliary summarization. `summaryToolChars` defaults to 0, preserving full tool output. `maxOverflowRetries` controls recovery attempts per model step, and `maxConsecutiveFailures` controls when automatic compaction pauses after failures. `maxRestoredFiles`, `maxFileTokens`, and `maxRestoreTokens` override file-restoration budgets. `restoreContext: false` disables recovery reminders. `auto: false` disables automatic DSH hooks; explicit calls still work.

## Sources and DSH mapping

Based on the [pinned zai-org/ZCode revision](https://github.com/zai-org/ZCode/tree/29628c9acdb81b703bbd4080c207a0e7ce5e276e), commit `29628c9acdb81b703bbd4080c207a0e7ce5e276e`, under Apache-2.0. The workflow maps to `apps/zcode-cli/packages/core/src/compact/{policy,microcompact}.ts`, `runtime/helpers/compact-selection.ts`, `runtime/methods/{compact-active,turn-loop-state,turn-model-step}.ts`, and `runtime/helpers/compact-post-reminders.ts`. Summary instructions are defined in `src/pipeline.ts`.

DSH handles model transport, attachment encoding, cancellation, and session transactions. System/developer messages stay in place. The plugin applies ZCode's selection logic separately to the segments between these messages and skips segments that cannot form a summarizable range. Usage accounting covers the full context. Recovery counters, pruning savings, and Read-restoration baselines are logged and survive plugin reconstruction.

Plan restoration prefers the host's `approvedPlanPath`. Otherwise, it only tries `.zcode/plans/plan-{sessionId}.md` for the current DSH session and injects nothing if the file does not exist. It does not infer historical ZCode session IDs. Transcript paths, live reminders, and REPL cleanup status come from the host; a REPL reminder is written only after successful cleanup has been observed.

Verification: run `pnpm build` from the repository root, then `node --test tests/zcode-kimi-pipelines.test.mjs`.
