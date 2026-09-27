# dsh-context-zoo

English | [简体中文](README.zh-CN.md)

Context management workflows from Claude Code, Codex, OpenCode, Pi, Qwen Code, ZCode, Kimi Code, and Cline, implemented as [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugins. In this TypeScript and pnpm monorepo, each plugin handles token accounting, triggers, history selection, input preparation, summarization, retries, and recovery.

`core` provides DSH service integration, model calls, file reads, and session transactions. Each plugin implements its compaction algorithm. DSH supplies the interface, tool runtime, and session storage used by the adapted workflow.

## Eight independent plugins

| Plugin | Main workflow |
| --- | --- |
| [`dsh-context-claude-code`](packages/claude-code/README.md) | Usage anchors, idle microcompaction, full summaries, retries over complete message groups, file and skill recovery, failure limits |
| [`dsh-context-codex`](packages/codex/README.md) | Usage anchors, local summaries, newest user-text retention, UTF-8 truncation, paired input reduction on summary overflow, retry backoff |
| [`dsh-context-opencode`](packages/opencode/README.md) | Native budgets, optional tool pruning, whole-turn and partial-turn retention, summary merging, user messages and attachments after overflow |
| [`dsh-context-pi`](packages/pi/README.md) | Native estimates and usage, cut selection, separate history and turn-prefix summaries, cumulative file lists, branch summaries, transient-error backoff |
| [`dsh-context-qwen-code`](packages/qwen-code/README.md) | Idle and size-based microcompaction, screenshot triggers, XML validation, summary-model fallback, file and image recovery, HTTP 413 handling |
| [`dsh-context-zcode`](packages/zcode/README.md) | Assistant rounds, grouped microcompaction, nine-section summaries, overflow reduction, plan and file recovery, failure limits |
| [`dsh-context-kimi-code`](packages/kimi-code/README.md) | Full-history summaries, input reduction before dispatch, model overflow retries, original user input restoration, TODO and log recovery information |
| [`dsh-context-cline`](packages/cline/README.md) | Model summaries by default, about 20k tokens of recent history, file operation records, fallback without a model call after summary errors or context overflow |

Each package implements its workflow in `src/pipeline.ts`. Its exported `createPipeline()` can run against a separate test host, while `strategy` exposes the pinned source and budget metadata. `strategy.source.url` links to the original project; `revision` and `license` describe the inspected local reference, including forks and source reconstructions. ZCode and Kimi were checked against local clones at `29628c9` and `be7d5f5` respectively.

The [Cline](https://github.com/cline/cline) reference is pinned to commit [`252082b9e93b4f91253876391e35b4c13326f5e6`](https://github.com/cline/cline/commit/252082b9e93b4f91253876391e35b4c13326f5e6).

The Claude Code reference is an unofficial reconstruction of version 2.1.88 and cannot establish the complete official implementation. Each package README identifies the parts that require native host support. Cache APIs, REPL state, and log locations are reported only when the host actually provides them.

The Codex plugin implements the local summary workflow. Its [README](packages/codex/README.md#host-adaptation-and-limits) describes the native Codex modes that require additional host capabilities.

## Build and check

Repository development requires Node.js `^22.22.2 || ^24.15.0 || >=26.0.0` and pnpm `11.9.0`. Published packages support Node.js `^22.19.0 || >=24.0.0`.

```sh
pnpm install
pnpm check
```

`check` builds every package and runs workflow tests, package checks, and integration tests through the real Cordis Loader and DSH services, including `/compact` and automatic compaction. Tests use controlled model adapters and need no API key. `pnpm compare` compares the eight plugins' budget metadata; it does not evaluate model summary quality.

To check generated overlays against the actual shipped headless and Web configurations in a local DSH checkout:

```sh
DSH_SOURCE_DIR=/path/to/deepseek-harness pnpm test:profiles
```

This optional check covers configuration composition. Full Web/Electron startup and external model calls are outside its scope.

### Live DeepSeek checks and credentials

The [2026-09-26 results](reports/deepseek/2026-09-26/README.md) combine final observations for the seven plugins available at that time from separate executions, with selected API usage, test limits, and a combined `results.json` file. Cline passed a separate [live check on 2026-09-27](reports/deepseek/2026-09-27/README.md), including manual compaction, session replay, and 10/10 factual recall. Its estimated context size fell from 5,506 to 1,844 tokens (66.5%).

With `DEEPSEEK_API_KEY` supplied to the test process, run:

```sh
pnpm test:deepseek
```

The [runner](scripts/check-deepseek.mjs) uses DSH's official DeepSeek adapter, `https://api.deepseek.com/anthropic`, and `deepseek-flash`. It measures factual recall before compaction, then runs all eight plugins' `/compact` by default, restores each session from recorded events, and checks recall again. With one summary call per plugin, a full run makes 17 HTTP requests; the limit is 18. It uses synthetic text history and sets `keepRecentTokens: 256` and `maxSummaryAttempts: 1`, with a default summary cap of `maxSummaryTokens: 2048`. These checks cover manual compaction and recall; default trigger policies, actual context overflow, and full application startup require separate tests. Token reductions are estimates; the report also records API usage.

The runner writes `report.json` to a temporary results directory and prints its path. Choose a directory with `pnpm test:deepseek --output /absolute/path/to/results`. The runner reads the key from the process environment and does not write credential files or live DSH profiles.

To select Codex with a 4,096-token summary cap and skip the initial uncompressed recall baseline:

```sh
pnpm test:deepseek --agent codex --max-summary-tokens 4096 --skip-baseline
```

The selected plugin still runs `/compact` and the post-replay recall check.

For local file storage, set `DEEPSEEK_API_KEY` in `.env.local`, which Git ignores. The runner does not load `.env` files automatically; load it explicitly with Node:

```sh
node --env-file=.env.local scripts/check-deepseek.mjs --agent cline
```

For persistent storage on macOS, use **Keychain Access** to create a password item with service/name `dsh-context-zoo-deepseek` and your login name as the account. Enter the key in the GUI, then supply it only when launching the test:

```sh
DEEPSEEK_API_KEY="$(security find-generic-password -a "$USER" -s dsh-context-zoo-deepseek -w)" pnpm test:deepseek
```

This keeps the literal key out of shell history. Keychain storage is managed by macOS; DSH's supported native store is `$DSH_HOME/.credentials.yaml` (default `~/.dsh/.credentials.yaml`), a plaintext file protected by `0600` permissions, without encryption or Keychain integration. Keep credentials out of Git-tracked files and rotate any key exposed in chat.

## Publish to npm

The nine packages use one version; the root stays private. Run either command on a clean `main` branch to select a version, update all packages, run checks, commit, and tag:

- `pnpm release`: push the release and let GitHub Actions publish. Configure the repository's `NPM_TOKEN` secret first.
- `pnpm release:local`: publish using your local npm login, keeping the release commit and tag local.

Both routes use `latest` for stable versions and `next` for prereleases. Add `--no-increment` for the first `0.1.0` release or `--dry-run` to preview. `pnpm release:check` verifies tarballs without publishing; `pnpm release:publish` retries the current tagged version locally. See the [publishing guide](docs/publishing.md) for authentication, Git synchronization, and retries.

## Use with DSH

The target version is DSH `0.1.7-rc.2`. **This version requires a Session writer patch.** Plugin state and auxiliary model calls must be recorded as ignorable events, but the original writer cannot set that marker. Installing this repository applies the patch to its dependencies. Apply it to the actual DSH host as described in [patches/README.md](patches/README.md) as well. The plugin checks the active Session implementation before writing.

After patching the host, build and install one plugin from this repository's root. Each package declares `dsh.bundle.patch: []` in `package.json`, so DSH recognizes it as a bundle without default configuration layers. An explicit generated overlay activates it in the profile's existing compaction scopes.

```sh
pnpm build
dsh plugin --profile web add link:./packages/pi
dsh --profile web --dump-config > /tmp/dsh-web.yml
node scripts/create-profile-patch.mjs pi /tmp/dsh-web.yml > /tmp/dsh-web-pi.patch.yml
dsh --profile web --patch /tmp/dsh-web-pi.patch.yml
```

Use the desired agent id and package path, such as `codex` and `./packages/codex`. `link:` uses this checkout's build output, so rebuild after source changes. Use one context strategy per profile.

The generator reads the resolved profile and replaces each active compaction engine in its own scope, disabling the associated native tool-result pruner. It preserves the other configuration rows and `!!js` expressions. Root/headless activation inserts `context-zoo-engine` inside a `context-zoo` group; Web activation keeps the `compaction-basic` id inside each active preset's compaction group. Presets without compaction, including the shipped `minimal` preset, stay unchanged. Image offload and spill policies remain independent.

The generated overlay is a delta to the configuration that was dumped. To switch strategies, remove the previous package, install the new one, and regenerate from the base profile dump without the previous transient overlay. For persistent activation, append the generated patch entries after the existing entries in the profile's `cordis.patch.yml`. When switching a persistent setup, remove its previous generated entries before dumping and generating the replacement. Regenerate whenever the preset configuration changes: DSH replaces complete `config` objects, so the generated preset overrides contain their full configuration.

File recovery uses the DSH `fs` service and follows the host's file permissions. When the service is missing or a read is denied, the plugin records the reason and skips that read.

## Configuration

In the generated overlay, find each row named after the selected plugin, such as `dsh-context-pi`, and edit that row's `config`. This example is a config fragment:

```yaml
config:
  auto: true
  maxSummaryTokens: 8000
  maxOverflowRetries: 2
```

Include the desired settings together because DSH replaces the entire `config` object. Keep the surrounding group and preset configuration from the generated overlay.

See the [core README](packages/core/README.md) for all settings and each plugin README for defaults and supported fields. The same field can have different algorithmic meaning: Pi may retain part of a turn and summarize its removed prefix separately, while ZCode retains the complete last round by default.

`/compact` runs the selected plugin's manual workflow. The summary and recovered context are committed together. If the workflow ultimately fails, is cancelled, detects changed input, or produces an expanded result, it leaves the selected history intact. Cline can recover from a summary error by applying its fallback without another model call. Completed microcompaction has its own log records, and the original messages remain in DSH session storage.

## Extend and verify

To add an agent, create a package that implements `ContextPipeline.run()` and `summarizeRange()`, then register it with `createContextPlugin({ id, create })`. Keep DSH primitives in core and source-specific workflows in their packages. Test triggers, call order, recovery output, and failure paths.

Pi branch summarization is available through the public `summarizeBranch()` function. External runtime recovery information is supplied through `context-zoo/recovery`. See the [core README](packages/core/README.md) for both integrations.

Use `README.md` for English and `README.zh-CN.md` for Chinese, with links between them. English is the primary documentation language. Write code comments in English.

New code in this repository is licensed under [MIT](LICENSE).
