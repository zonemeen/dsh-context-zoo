# Kimi Code Context Plugin

English | [简体中文](README.zh-CN.md)

This package adapts the Kimi Code workflow for full-history summarization, input shrinking after overflow, original user-input restoration, and session continuation. Its default export is a DSH Cordis plugin; `createPipeline(config)` can accept a `ContextHost` directly. See the [root README](https://github.com/zonemeen/dsh-context-zoo/blob/main/README.md) for integration.

## npm installation

After release, install with `dsh plugin --profile web add dsh-context-kimi-code`. Apply the host Session patch and generate the activation overlay as described in the [npm guide](https://github.com/zonemeen/dsh-context-zoo/blob/main/docs/publishing.md#using-the-published-packages). Installing the package alone does not replace the active context engine.

## Default workflow

- Triggers when context usage reaches 85% of the effective window or fewer than 50,000 tokens remain. If the reserve is at least the entire window, only the ratio applies. The model's separate input limit takes precedence. After compaction, it does not compact again until usage grows.
- Summarizes the full history of the selected segment. The upstream `fullCompactionService` actually used replaces history using `originalHistory.length`, then restores user input through `compactionHandoff`. This plugin does not use the “keep four messages” selector in `strategy.ts`, which that service does not call.
- Before auxiliary summarization, reserves at most one eighth of the window for output, then takes 85% of the remaining window and subtracts system and tool overhead. When necessary, first keeps a recent suffix that fits.
- Makes at most five summary attempts. After input overflow, shrinks the current summary history to 70%, 50%, then 35% of its token count, removing orphan tool results at the start. Only the auxiliary input shrinks; the original replacement range stays complete. Blank or truncated summaries are retried after dropping the oldest message. Rate limits, network errors, and temporary service errors use exponential backoff starting at 500 ms, capped at 32 seconds, plus up to 25% random jitter. Cancellation aborts immediately.
- After an observed overflow, lowers the model's effective capacity to 85% of the estimated request tokens. Request-body-too-large errors trigger context recovery only when usage reaches half the window. Each failed request sequence allows at most three recovery attempts by default; the count resets after a successful model step.
- Restores genuine user input before the summary, with a 20,000-token budget. If it exceeds the budget, keeps the oldest 2,000 and newest 18,000 tokens with an omission notice between them. Deduplicates by message ID and uses the latest persisted representation. Original user input from earlier checkpoints is recovered from the log. Synthetic prompts and tool output are not treated as user input.
- Includes observed TODOs, a session-log entry point, and a continuation reminder with the summary. Live TODOs take precedence; otherwise, they are restored from the latest successful TodoWrite/todo_write. Tool-call, media, or failed summary responses are rejected without committing a replacement.

## Configuration

`reserveTokens` and `thresholdRatio` override trigger budgets, and `keepRecentTokens` overrides the original user-input restoration budget. `maxSummaryTokens` overrides the model output budget; if the model has no output budget, the smaller of the context window and 128 Ki tokens is used. `summaryToolChars` defaults to 0, preserving full tool output; a positive value trims tool text only in auxiliary summary requests.

`maxSummaryAttempts`, `summaryRetryDelayMs`, and `maxOverflowRetries` control retries. `summarizationProvider` and `summarizationModel` must be set together. `restoreContext: false` disables original user-input restoration and recovery reminders; TODOs still supplement the summary. `auto: false` disables automatic DSH hooks; explicit calls still work. This workflow does not use tool-output microcompaction or recent-turn retention settings.

## Sources and DSH mapping

Based on the [pinned MoonshotAI/kimi-code revision](https://github.com/MoonshotAI/kimi-code/tree/be7d5f5fea7800778e4660cd5f36780ba783bddd), commit `be7d5f5fea7800778e4660cd5f36780ba783bddd`, under MIT. The active workflow maps to `packages/agent-core-v2/src/agent/fullCompaction/fullCompactionService.ts`, `agent/contextMemory/compactionHandoff.ts`, `llm-adapter/contract/tokens.ts`, and `_base/utils/retry.ts`. Summary instructions are defined in `src/pipeline.ts`.

The upstream service uses `tokenCounting.get(agentContext).size` to decide when to compact. This plugin uses DSH's `measuredTokens`, including the host's usage calibration. Auxiliary summary shrinking and user-input restoration use this package's estimate: ASCII character count divided by 4, plus one token per other Unicode code point, with 2,000 tokens per image. Tool names, arguments, and roles contribute to the estimate.

DSH handles model transport, attachment encoding, cancellation, and session transactions. System/developer messages stay in place. The plugin selects the first segment between these messages that contains history to process, summarizes the entire segment, and skips segments containing only checkpoints. Restored user-input blocks and the summary are written together to the DSH checkpoint; original messages remain in the log. Capacity observations, failed-request counts, and post-compaction usage are also logged.

DSH messages do not contain Kimi's source field for dynamic tool announcements, so the plugin does not guess which ordinary user text to remove. The host snapshot supplies DSH's callable tools. Wire/transcript paths and log line numbers use only real entry points supplied by the host; when no entry point is available, the continuation reminder is preserved.

Verification: run `pnpm build` from the repository root, then `node --test tests/zcode-kimi-pipelines.test.mjs`.
