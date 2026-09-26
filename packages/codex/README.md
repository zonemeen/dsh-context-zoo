# dsh-context-codex

English | [简体中文](README.zh-CN.md)

This package adapts Codex's local summary workflow to DeepSeek Harness. It owns token accounting, pressure checks, summary requests, history reduction, retries, and recent user-text retention. The default export is a DSH Cordis plugin; `createPipeline(config)` provides a standalone pipeline, and `strategy` exposes budgets and source metadata.

## Install

Use DSH `0.1.7-rc.2` with the [Session writer patch](../../patches/README.md) applied to the actual host. Follow the root [installation and activation instructions](../../README.md#use-with-dsh), using `./packages/codex` as the package path and `codex` as the overlay generator's agent id.

The package declares `dsh.bundle.patch: []` in `package.json`, so DSH recognizes it as a bundle without default configuration layers. Activate Codex with the generated overlay after installation. The generator places the plugin in the profile's active compaction scopes and disables their native tool-result pruner. Use one context strategy per profile and rebuild this checkout after source changes. Persistent activation and strategy switching are covered in the root instructions.

```ts
import codexContext from 'dsh-context-codex';

ctx.plugin(codexContext);
```

## Workflow

1. Estimate each message from its model-visible UTF-8 bytes at roughly four bytes per token. Plaintext reasoning does not add to the estimate. Images use a fixed estimate rather than their data URL length. Use the latest valid assistant usage after the live checkpoints as an anchor and add estimates for messages appended afterward; cache usage is counted once.
2. Trigger automatic compaction at 90% of the context window by default. The output-token limit is not subtracted from this threshold. Manual compaction bypasses the pressure check. Overflow or HTTP 413 from an ordinary model request is left to the host.
3. Select one completed contiguous span, preserving system/developer messages and unfinished tool calls. Prepare a local summary request with that span plus the live system/developer messages. The summary instruction is authored independently for this plugin. Model calls and results are recorded in the DSH session.
4. If the summary request exceeds the context window, remove the oldest input item together with its tool-call or tool-result counterpart, then retry with the reduced input. Each reduction resets the ordinary error retry budget. Ordinary model-call errors allow five retries by default, with exponential backoff and jitter; cancellation stops the operation.
5. Retain the newest real user text within a default 20000-token budget, excluding contextual injections. When the oldest retained text exceeds the remaining budget, preserve its head and tail at valid UTF-8 boundaries and insert a truncation marker. The marker itself is additional to the text budget. Retained user content is text-only; images are not reattached. Recognized instructions, catalogs, snapshots, skills, plans, and agent context are preserved separately from the user-text budget. Newer snapshots, catalogs, and plans supersede earlier entries with the same source kind and form; distinct instruction and skill sources remain separate.
6. Commit the retained user text and summary together as a DSH checkpoint. A failed, cancelled, empty, truncated, or expanded summary leaves the selected history intact. Summary output containing tool calls or media is rejected. DSH also rejects a commit if the selected input changed during summarization. Retained user text remains available after session reload for both ordinary and explicit range compaction.

## Configuration

Find each `dsh-context-codex` row in the generated overlay and edit its `config`. The row is nested inside the selected group or preset; its id depends on that scope. DSH replaces the whole config object, so include the desired settings together. Example config fragment:

```yaml
config:
  auto: true
  thresholdRatio: 0.9
  keepRecentTokens: 20000
  maxSummaryAttempts: 6
  summaryRetryDelayMs: 200
  restoreContext: true
```

| Setting | Default and behavior |
| --- | --- |
| `auto` | `true`; enables pressure-triggered compaction |
| `thresholdRatio` | `0.9`; lower ratios trigger earlier, values above `0.9` remain capped at `0.9` |
| `reserveTokens` | `0`; caps the trigger at `contextWindow - reserveTokens` |
| `keepRecentTokens` | `20000`; budget for retained real user text |
| `maxSummaryTokens` | The active model route's output-token limit |
| `maxSummaryAttempts` | `6`; one initial request and up to five ordinary error retries, reset after each input reduction |
| `summaryRetryDelayMs` | `200`; initial exponential-backoff delay, with 10% jitter in either direction and a 60-second cap |
| `restoreContext` | `true`; preserves recognized injected context already recorded by DSH |
| `summarizationProvider`, `summarizationModel` | The active model route; set both to use a separate summary model |

This pipeline performs no tool-result pruning. `prune`, `summaryToolChars`, `maxOverflowRetries`, and `maxConsecutiveFailures` have no effect here. Summary input reduction continues until no removable item remains; it does not consume the ordinary error retry budget.

## Host adaptation and limits

DSH preserves its system/developer messages and unfinished tool calls. Retained user text is stored in checkpoint blocks, while native Codex rebuilds separate user-role items. Codex's initial-context reinjection depends on its world state and turn context; this plugin uses the messages recorded by DSH and cannot manufacture that native state.

The following native Codex modes are unsupported by this plugin:

- Remote V2 compaction with native `CompactionTrigger` and opaque `Compaction` response items.
- Token-budget resets that rebuild Codex initial context and world state.
- Before-turn compaction using the previous model and native context reinjection.
- Optional compaction after completed assistant output, which requires a matching DSH lifecycle hook and is disabled by default upstream.

Encrypted reasoning and opaque native response items are not represented by the DSH message format. File blocks and offloaded images are estimated from serialized attachment metadata, which can differ from the content sent by the provider. Original-detail image sizing is unavailable; inline images use a fixed default estimate. Native compact hooks, model-compatibility hashes, provider transport retries, and token accounting that excludes the context prefix also remain outside this plugin. The plugin implements the local summary workflow within these host capabilities; it does not implement every compaction mode in current Codex.

## Source

Original project: [openai/codex](https://github.com/openai/codex), inspected at [`e72da2b53805894878023d01949a25a082e0a5cb`](https://github.com/openai/codex/tree/e72da2b53805894878023d01949a25a082e0a5cb), licensed under [Apache-2.0](https://github.com/openai/codex/blob/e72da2b53805894878023d01949a25a082e0a5cb/LICENSE). The reference includes `codex-rs/core/src/compact.rs`, `codex-rs/core/src/context_manager/history.rs`, and `codex-rs/utils/output-truncation/src/lib.rs`. The TypeScript implementation and summary prompts were written for this repository.
