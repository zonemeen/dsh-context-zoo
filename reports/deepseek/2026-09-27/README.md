# Cline DeepSeek live test results

English | [简体中文](README.zh-CN.md)

Date: 2026-09-27. Model: `deepseek-flash`, thinking disabled. Provider: the DSH official DeepSeek API-key adapter, calling `https://api.deepseek.com/anthropic/v1/messages`.

## Results

Cline completed manual compaction and preserved all 10 scored facts in a fresh model response after session event replay. Uncompressed baseline recall also scored 10/10.

| Plugin | Summary output cap | Estimated tokens before | Estimated tokens after | Reduction | Recall after replay |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cline | 2,048 | 5,506 | 1,844 | 66.5% | 10/10 |

One summary request completed normally with 1,132 output tokens. Compaction took 4.94 seconds; the complete check took 7.345 seconds. All three HTTP requests returned 200: baseline recall, compaction summary, and recall after replay.

The settings were `auto: false`, `keepRecentTokens: 256`, `maxSummaryTokens: 2048`, `maxSummaryAttempts: 1`, and `maxOverflowRetries: 0`. The 256-token retention setting is a test setting, not the plugin's 20,000-token default.

Token reduction uses the DSH estimator. It does not represent API billing tokens. This is one observation on a synthetic fixture; the earlier [seven-plugin report](../2026-09-26/README.md) remains a separate set of runs.

## Coverage and limits

The runner loads the generated profile overlay through Cordis Loader, verifies that the selected engine is active and the native tool-result pruner is absent, and invokes DSH `/compact`. It checks protected instructions and tool-call pairing, validates stored events, restores the session, and compares a fresh answer with 10 expected facts.

The facts include the final 48-hour retention decision, idempotency header, retry statuses and schedule, tenant-scoped uniqueness, migration path, recorded local test results, pending tenant-isolation regression, and production/migration restrictions. Only synthetic conversation content was sent to the API; no task tools were executed.

This check covers manual model summarization and recall after replay. It does not exercise default automatic thresholds, actual context overflow, deterministic fallback, long-session behavior, or full headless/Web application startup. Separate local tests cover automatic thresholds, overflow handling, and profile overlays; they do not establish full application startup or long-session performance.

## API usage

| Request | Uncached input | Cached input | Output |
| --- | ---: | ---: | ---: |
| Baseline recall | 233 | 4,352 | 182 |
| Cline summary | 2,690 | 0 | 1,132 |
| Recall after replay | 1,670 | 0 | 174 |
| Total | 4,593 | 4,352 | 1,488 |

Cache-write tokens were zero. These provider-reported usage figures count each of the three requests once. Currency cost was not calculated.

## Reproduce

Configure `DEEPSEEK_API_KEY` in the Git-ignored `.env.local`, then run from the repository root:

```sh
node --env-file=.env.local scripts/check-deepseek.mjs --agent cline
```

Node loads the local environment file explicitly. The key is not included in this report, recorded session data, or a DSH profile. [results.json](results.json) contains the complete observation, including settings, request statuses, model outputs, and scored facts.
