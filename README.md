# dsh-context-zoo

English | [简体中文](README.zh-CN.md)

Independent context management workflows from Claude Code, Codex, OpenCode, Pi, Qwen Code, ZCode, and Kimi Code, implemented as [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugins. This TypeScript and pnpm monorepo gives each plugin its own token accounting, triggers, history selection, input preparation, summarization, retries, and recovery.

`core` provides DSH service integration, model calls, file reads, and session transactions. Each plugin owns its compaction algorithm. DSH supplies the interface, tool runtime, and session storage used by the adapted workflow.

## Seven independent plugins

| Plugin | Main workflow |
| --- | --- |
| [`dsh-context-claude-code`](packages/claude-code/README.md) | Usage anchors, idle microcompaction, full summaries, retries over complete message groups, file and skill recovery, failure limits |
| [`dsh-context-codex`](packages/codex/README.md) | Usage anchors, local summaries, newest user-text retention, UTF-8 truncation, paired input reduction on summary overflow, retry backoff |
| [`dsh-context-opencode`](packages/opencode/README.md) | Native budgets, optional tool pruning, whole-turn and partial-turn retention, summary merging, user messages and attachments after overflow |
| [`dsh-context-pi`](packages/pi/README.md) | Native estimates and usage, cut selection, separate history and turn-prefix summaries, cumulative file lists, branch summaries, transient-error backoff |
| [`dsh-context-qwen-code`](packages/qwen-code/README.md) | Idle and size-based microcompaction, screenshot triggers, XML validation, summary-model fallback, file and image recovery, HTTP 413 handling |
| [`dsh-context-zcode`](packages/zcode/README.md) | Assistant rounds, grouped microcompaction, nine-section summaries, overflow reduction, plan and file recovery, failure limits |
| [`dsh-context-kimi-code`](packages/kimi-code/README.md) | Full-history summaries, input reduction before dispatch, model overflow retries, original user input restoration, TODO and log recovery information |

Each package implements its workflow in `src/pipeline.ts`. Its exported `createPipeline()` can run against a separate test host, while `strategy` exposes the pinned source and budget metadata. `strategy.source.url` links to the original project; `revision` and `license` describe the inspected local reference, including forks and source reconstructions. ZCode and Kimi were checked against local clones at `29628c9` and `be7d5f5` respectively.

The Claude Code reference is an unofficial reconstruction of version 2.1.88 and cannot establish the complete official implementation. Each package README identifies the parts that require native host support. Cache APIs, REPL state, and log locations are reported only when the host actually provides them.

The Codex plugin implements the local summary workflow. Its [README](packages/codex/README.md#host-adaptation-and-limits) describes the native Codex modes that require additional host capabilities.

## Build and check

Requires Node.js `^22.19.0 || >=24.0.0` and pnpm `11.9.0`.

```sh
pnpm install
pnpm check
```

`check` builds every package and runs workflow tests, integration tests using real Cordis/Session/LLM services, and package checks. Tests use controlled model adapters and need no API key. `pnpm compare` compares the seven plugins' budget metadata; it does not evaluate model summary quality.

## Use with DSH

The target version is DSH `0.1.7-rc.2`. **This version requires a Session writer patch.** Plugin state and auxiliary model calls must be recorded as ignorable events, but the original writer cannot set that marker. Installing this repository applies the patch to its dependencies. Apply it to the actual DSH host as described in [patches/README.md](patches/README.md) as well. The plugin checks the active Session implementation before writing.

After patching the host, link one plugin from this repository's root:

```sh
pnpm build
dsh plugin --profile web add link:./packages/pi
dsh --profile web --dump-config
dsh web
```

`link:` uses this checkout's build output, so rebuild after changing source files. Install one context plugin per profile; remove the previous package before switching.

Each package's `cordis.patch.yml` replaces the `compaction-basic` entry and disables the separate `tool-result-pruner`. The profile must contain those entries. File recovery uses the DSH `fs` service and follows the host's file permissions. When the service is missing or a read is denied, the plugin records the reason and skips that read.

## Configuration

Override the relevant entry in the profile's `cordis.patch.yml`. DSH replaces the entire `config` object, so include the required settings together:

```yaml
- id: compaction-basic
  config:
    auto: true
    maxSummaryTokens: 8000
    maxOverflowRetries: 2
```

See the [core README](packages/core/README.md) for all settings and each plugin README for defaults and supported fields. The same field can have different algorithmic meaning: Pi may retain part of a turn and summarize its removed prefix separately, while ZCode retains the complete last round by default.

`/compact` runs the selected plugin's manual workflow. The summary and recovered context are committed together. Failure, cancellation, changed input, or an expanded result leaves the selected history intact. Completed microcompaction has its own log records, and the original messages remain in DSH session storage.

## Extend and verify

To add an agent, create a package that implements `ContextPipeline.run()` and `summarizeRange()`, then register it with `createContextPlugin({ id, create })`. Keep DSH primitives in core and source-specific workflows in their packages. Test triggers, call order, recovery output, and failure paths.

Pi branch summarization is available through the public `summarizeBranch()` function. External runtime recovery information is supplied through `context-zoo/recovery`. See the [core README](packages/core/README.md) for both integrations.

Use `README.md` for English and `README.zh-CN.md` for Chinese, with links between them. English is the primary documentation language. Write code comments in English.

New code in this repository is licensed under [MIT](LICENSE).
