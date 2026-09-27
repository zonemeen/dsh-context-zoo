# dsh-context-cline

English | [简体中文](README.zh-CN.md)

Context management for DeepSeek Harness based on the Cline SDK workflow. The plugin creates model summaries, preserves recent conversation, records file activity, and uses deterministic compaction after summary-call errors or context overflow. The default export is a DSH Cordis plugin; `createPipeline(config)` provides the pipeline and `strategy` exposes budgets and source metadata.

## Installation

After release, install with `dsh plugin --profile web add dsh-context-cline`. Apply the host Session patch and generate the activation overlay as described in the [npm guide](https://github.com/zonemeen/dsh-context-zoo/blob/main/docs/publishing.md#using-the-published-packages).

For a source checkout, follow the [root installation instructions](https://github.com/zonemeen/dsh-context-zoo/blob/main/README.md#use-with-dsh), using `./packages/cline` as the package path and `cline` as the profile generator's agent id. Use DSH `0.1.7-rc.2` with the supplied Session patch. The package declares `dsh.bundle.patch: []`; install it and apply a generated overlay to replace the active compaction engine. Use one strategy per profile.

```ts
import clineContext from 'dsh-context-cline';

ctx.plugin(clineContext, {
  keepRecentTokens: 20000,
  maxSummaryTokens: 8192,
});
```

## Workflow

1. Estimate serialized messages at three characters per token. Include system/developer messages and tool schemas in the request budget. With an explicit input limit, use the smaller of that limit and the context window; otherwise use 90% of the window. Automatic compaction starts at 90% of this input budget (81% of the window when no input limit is supplied).
2. Calibrate the input budget against the latest valid assistant input usage, reducing it by at most a factor of four. DSH cache counters contribute once; output usage is excluded. Usage from before a live checkpoint, a different model, or an earlier observed turn is excluded.
3. Automatic target size is 70% of the trigger budget. After at least five user/assistant pairs, it becomes 50% of the usable input budget if the model output limit is smaller than that budget. Manual and overflow targets are half the current message estimate, capped at the trigger. Subtract protected instructions and tool-schema overhead from the message budget.
4. Retain about 20,000 recent tokens, capped by the target. Keep the complete latest user turn when a later user prompt exists; a single long initial turn can be split. Move the cut before any tool exchange it would split. System/developer messages divide history into separate spans and remain unchanged. Earlier spans can be summarized in full; existing checkpoints without new history are skipped.
5. Send a text transcript with previous checkpoints and file activity in one auxiliary request, without tools. Strip reasoning; limit each tool-result text and serialized attachment to 2,000 characters by default. If needed, shorten tool text further and omit older complete assistant/tool groups from this input copy. Preserve user text and previous checkpoints; skip summarization if they cannot fit. A separately configured model uses a conservative 1,024-token input budget because the host cannot report its capabilities.
6. Request Goal, State, Highlights, Next, and Files sections. Append recognizable file activity from the selected range when the response has no Files section. The default output cap is 8,192 tokens, reduced by the active route's output limit; an explicit `maxSummaryTokens` overrides this default. Commit a `Context summary` checkpoint with the recent tail left in place. Empty summaries skip compaction. Nonempty truncated, failed, non-text, or non-shrinking results are rejected.
7. If the summary call throws, use deterministic recovery for the selected range. Preserve recorded user text, injected context, earlier checkpoints, and any of the latest three assistant texts within that range. Preserve attachments on the latest user prompt; omit older user attachments. Record file reads, edit attempts, and commands, including failed results. Cancellation propagates without recovery.
8. Context overflow and HTTP 413 use deterministic recovery directly. Prefer a complete recent suffix that fits alongside the checkpoint. Permit one recovery attempt per observed turn by default, with the count stored in the DSH session. Retry only if the resulting context is smaller and fits the recovery target. If mandatory preserved content prevents this, leave the selected history unchanged.

## Configuration

Edit the `config` on each generated `dsh-context-cline` row. DSH replaces the whole config object, so include all desired settings together.

| Setting | Default and behavior |
| --- | --- |
| `auto` | `true`; controls automatic DSH hooks; explicit pipeline calls remain available |
| `thresholdRatio` | `0.9` of usable input, after usage calibration |
| `reserveTokens` | `0`; an additional cap of `usableInput - reserveTokens` |
| `keepRecentTokens` | `20000`; minimum recent-token target for the model-summary cut, subject to complete turns and the message budget; `0` still retains the final message or its complete exchange |
| `maxSummaryTokens` | `8192`, capped by the active route's output limit by default; explicit values take precedence |
| `summaryToolChars` | `2000`; per-tool text limit in the auxiliary request; `0` preserves text initially, but budget projection can still shorten it |
| `summarizationProvider`, `summarizationModel` | Active route; set both to override it |
| `maxOverflowRetries` | `1` per observed turn; uses the request series when the host has no turn key; `0` disables overflow recovery |
| `maxConsecutiveFailures` | Unlimited; an optional limit pauses pressure-triggered compaction after failures; manual calls remain available |

There is one summary attempt per compaction. `maxSummaryAttempts`, `summaryRetryDelayMs`, pruning, and file-reload settings do not affect this workflow. Basic recovery does not read workspace files or call the model.

## Host adaptation and limits

DSH replaces one contiguous range with one user checkpoint. Native Cline basic compaction can return multiple role-preserving messages; this adaptation stores preserved prompts and assistant text in checkpoint blocks and retains an intact recent suffix. Older final answers outside the latest three may be omitted. Native budget projection can trim more message and attachment forms; this plugin skips requests that cannot fit while preserving user text. These differences can reduce the amount of history that can be compacted.

The current DSH host adapter provides a context window but no separate input limit. Custom `ContextHost` implementations may provide `inputLimit`. Estimates use DSH message serialization rather than Cline provider encoders. DSH does not expose per-request thinking controls, separate summary-model metadata, the native max-output recovery trigger, Cline compaction hooks, UI metadata, or session-sidecar import. Session replay uses DSH checkpoints and durable plugin events. It does not reconstruct the Cline runtime.

## Source and validation

Reference: [cline/cline](https://github.com/cline/cline/tree/252082b9e93b4f91253876391e35b4c13326f5e6), revision `252082b9e93b4f91253876391e35b4c13326f5e6`, licensed under [Apache-2.0](https://github.com/cline/cline/blob/252082b9e93b4f91253876391e35b4c13326f5e6/LICENSE). Main reference files are `sdk/packages/core/src/extensions/context/{compaction,agentic-compaction,basic-compaction,compaction-shared}.ts`, `budget-projection/project.ts`, and `sdk/packages/core/src/session/models/session-compaction.ts`.

Local automated tests cover the adapted pipeline and DSH integration. Cline passed the [2026-09-27 live DeepSeek check](https://github.com/zonemeen/dsh-context-zoo/blob/main/reports/deepseek/2026-09-27/README.md): manual compaction reduced the estimated context from 5,506 to 1,844 tokens (66.5%), and factual recall scored 10/10 both before compaction and after session replay. The summary output cap was 2,048 tokens; all three requests returned HTTP 200. To rerun with configured credentials: `pnpm test:deepseek --agent cline`.
