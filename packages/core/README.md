# dsh-context-core

English | [简体中文](README.zh-CN.md)

The DSH integration layer for independent context plugins. Core provides session observations, model calls, file reads subject to host permissions, and commit transactions. Each plugin chooses its thresholds, history ranges, prompts, retries, and recovery content.

DSH peer dependencies are pinned to `0.1.7-rc.2`; Cordis is `~4.0.4`. Apply the [Session patch](https://github.com/zonemeen/dsh-context-zoo/blob/main/patches/README.md) to the actual host dependencies before use.

## Published tools

The package includes the `dsh-context-patch` CLI for generating a profile overlay and exports `./compat/*` with the required Session patches, instructions, and license. The files are stored in `dist/compat/`. See the [npm guide](https://github.com/zonemeen/dsh-context-zoo/blob/main/docs/publishing.md#using-the-published-packages) for commands. Applying a host patch remains an explicit operation.

## Interface

```ts
import { createContextPlugin } from 'dsh-context-core';
import { createPipeline } from './pipeline.js';

export default createContextPlugin({ id: 'my-agent', create: createPipeline });
```

`ContextPipeline.run(host, trigger)` owns one complete workflow. The trigger is `pressure`, `manual`, `context-overflow`, or `request-too-large`; explicit range compaction uses `summarizeRange()`. Each session has its own pipeline instance. State needed after restoration is written with `host.record()` and read with `host.records()`.

`ContextHost` provides:

| Method | Behavior |
| --- | --- |
| `snapshot()` | Current messages, the full message archive, usage, routing, capacity, tools, time, and session identity |
| `summarize()` | Call the model with the plugin's messages and instructions; record the actual input, output, finish reason, and errors |
| `replace()` | Record replayable replacements for selected user/tool content while preserving role, identity, and source |
| `compact()` | Lock a selected contiguous range, run summarization and recovery, validate the result, and commit the checkpoint |
| `readFile()` | Stream a bounded number of characters through DSH `fs`; return null and record the reason if unavailable |
| `record()` / `records()` | Append and read durable state scoped to the plugin |

A `Checkpoint` can contain `beforeSummary`, `summary`, and `restored`. All three are committed in one checkpoint. The plugin must explicitly adapt recovered content when the native role structure differs. This interface does not create another agent's session tree or tool cache.

## Commit and recovery

Core checks tool-call pairing, contiguous ranges, concurrent compaction locks, and history stability after summarization. Automatic compaction requires the whole current history to remain unchanged. Manual compaction allows context to be appended outside its selected range. The replacement must be smaller than that range, and system and developer messages remain in place. When those messages occur within history, each plugin applies its selection algorithm to contiguous conversation segments, skipping segments already summarized or unable to shrink further.

Auxiliary calls are recorded individually, including Pi's two summaries, failed retries, and model fallback. `compaction/summary` carries the single-call marker only when exactly one model call occurred. The summary event and its replacement `user/message` stay adjacent; original records remain in the log.

Manual workflows run under the DSH maintenance lock and wait for the session to flush. Cancellation reaches the model and file services and prevents checkpoint submission. Model overflow requests a retry only after the plugin has durably replaced history and the operation remains active. The plugin owns retry limits and failure counts.

## Configuration

Configuration is validated at load time. These fields form the shared configuration vocabulary; a plugin uses the fields supported by its source workflow. Defaults are documented in each package README.

| Field | Purpose |
| --- | --- |
| `auto` | Enable automatic event hooks; explicit compaction methods remain available |
| `reserveTokens`, `thresholdRatio`, `keepRecentTokens` | Source-specific trigger and retention budgets |
| `maxSummaryTokens`, `summaryToolChars` | Summary output limit and auxiliary tool-text length |
| `summarizationProvider`, `summarizationModel` | Summary routing; both must be set together |
| `maxOverflowRetries`, `maxConsecutiveFailures` | Overflow recovery and consecutive-failure limits |
| `maxSummaryAttempts`, `summaryRetryDelayMs` | Model attempt count and retry delay where supported |
| `prune`, `keepRecentTools`, `protectToolTokens`, `minPruneTokens` | Microcompaction controls where supported |
| `idleMinutes`, `toolHighWaterChars`, `toolLowWaterChars` | Idle-time and tool-output size thresholds |
| `tailTurns` | OpenCode's retained turn count |
| `screenshotTriggerImages` | Qwen's tool-screenshot trigger count; 0 disables it |
| `restoreContext`, `maxRestoredFiles`, `maxFileTokens`, `maxRestoreTokens` | File and context recovery budgets |
| `maxRestoredImages`, `maxSkillTokens` | Image and skill recovery budgets |

Budgets, counts, and delays are nonnegative safe integers. Summary output, summary attempt count, and the consecutive-failure limit must be positive. Ratios must be in `(0, 1]`. Each plugin documents the meaning of zero where applicable.

## Host integration

External runtimes can return observed `approvedPlanPath`, `transcriptPath`, `wirePath`, `windowLines`, `todos`, `reminders`, or `replStateCleared` values through the `context-zoo/recovery` waterfall. Call `next()` when there are no observations. Return `replStateCleared: true` only after actually clearing the REPL. Core requires observed file locations and log recovery information.

Pi branch navigation calls:

```ts
import { summarizeBranch } from 'dsh-context-core';

const summary = await summarizeBranch(ctx, idleAgent, abandonedBranchSeqs, signal);
```

This function runs the plugin's branch workflow under the maintenance lock, records the summary, and flushes it. The navigation integration writes the returned text into a model-visible message in the target branch. Plugins without a branch workflow return `undefined`.

`ContextStrategy` and `budget()` expose metadata for budget comparisons. `ContextPipeline` executes the actual workflow. History selection and tool-pruning algorithms belong to the individual plugins.
