# DeepSeek context plugin test results

English | [简体中文](README.zh-CN.md)

Date: 2026-09-26. Model: `deepseek-flash`, thinking disabled. Provider: the DSH official DeepSeek API-key adapter, calling `https://api.deepseek.com/anthropic/v1/messages`.

## Results

These final results combine successful observations from separate executions. All seven plugins completed manual compaction and preserved all 10 scored facts in a real model response after session event replay. The summary output cap was 2,048 tokens for six plugins and 4,096 for Qwen Code.

The same synthetic history contained 22 messages and 5,506 DSH-estimated tokens before compaction. The retained uncompressed baseline recall scored 10/10.

| Plugin | Summary output cap | Estimated tokens after | Reduction | Recall |
| --- | ---: | ---: | ---: | ---: |
| Claude Code | 2,048 | 1,937 | 64.8% | 10/10 |
| Codex | 2,048 | 1,366 | 75.2% | 10/10 |
| OpenCode | 2,048 | 1,132 | 79.4% | 10/10 |
| Pi | 2,048 | 1,594 | 71% | 10/10 |
| Qwen Code | 4,096 | 2,706 | 50.9% | 10/10 |
| ZCode | 2,048 | 5,236 | 4.9% | 10/10 |
| Kimi Code | 2,048 | 1,646 | 70.1% | 10/10 |

Token reduction uses the same DSH token estimator for every plugin. It does not represent API billing tokens. These are individual observations on one fixture, not a comparative ranking or a guarantee for future runs.

## ZCode restoration

ZCode reduced this fixture by only 4.9%. Its restoration stage reinserted successful earlier file-read content: the generated summary was 6,798 characters, while the final checkpoint was 20,306 characters. This retained content accounts for the smaller reduction and remains part of the plugin workflow.

## Coverage and limits

The runner applies the generated replacement overlay through the real Cordis Loader, confirms the selected compaction engine and absence of the native tool-result pruner, executes the actual DSH `/compact` command, validates persisted events and tool pairs, restores the session, and checks a fresh model response against 10 known facts. Checks cover a corrected retention decision, idempotency header, retry policy, unique fields, migration path, observed test result, pending regression test, and production/migration restrictions. All content sent to DeepSeek was a synthetic task; no real repository contents were submitted and no task tools were executed.

These checks do not cover full headless/Web application launches, default automatic thresholds, context-window saturation, repeated long-session compaction, or complete equivalence with every upstream agent. The existing DSH Session compatibility patch is required by the current integration; it was used through the zoo dependency patch and was not applied to the sibling DSH source checkout.

Local verification: `PNPM_MANAGE_PACKAGE_MANAGER_VERSIONS=false pnpm check` passed, including build, 203 keyless tests, and checks for all eight packages. No DSH source files or persistent application profiles were changed.

## API usage

The combined results retain 15 model requests: one baseline recall, seven summaries, and seven recall checks after session replay. All retained requests returned HTTP 200.

- Uncached input tokens: 33,832.
- Cached input tokens: 12,544.
- Cache-write tokens: 0.
- Output tokens: 9,575.

These reported usage totals cover only the selected calls stored in `results.json`, with each call counted once. Currency cost was not calculated.

## Credentials

The results contain no API key. See the [credential setup instructions](../../../README.md#live-deepseek-checks-and-credentials) for future checks.

## Combined final results

[results.json](results.json) contains one retained baseline and the final successful observation for each plugin, combined from separate executions with each plugin's summary cap preserved.
