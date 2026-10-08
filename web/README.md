# Context Atlas

English | [简体中文](README.zh-CN.md)

A standalone, bilingual Next.js interface for exploring the eight `dsh-context-zoo` adapters and native DeepSeek Harness context management. It includes an animated, step-by-step context walkthrough, default-budget explanations, mechanism comparisons, engineering scenarios, and published model observations.

## Run independently

Use pnpm 11.9.0, pinned in `package.json`. The local `pnpm-workspace.yaml` gives this frontend its own workspace boundary and lockfile.

Use Node.js 22.22.2 or newer in the Node 22 line, or a supported newer LTS release. This directory has its own `package.json` and pnpm lockfile. It is intentionally outside the parent pnpm workspace; no zoo package build, local Harness clone, API key, or backend is required.

```sh
cd web
pnpm install --frozen-lockfile
pnpm dev
```

Open http://localhost:3000. For a production check:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

The browser tests use Playwright. Install Chromium once, then run them:

```sh
pnpm exec playwright install chromium
pnpm test:e2e
```

To use an installed Google Chrome instead of downloading Chromium, run `PLAYWRIGHT_CHANNEL=chrome pnpm test:e2e`.

## Deploy to Vercel

1. Import the repository into Vercel and set **Root Directory** to `web`.
2. Select the **Next.js** framework and Node.js **22.x** (or a supported newer LTS).
3. Use `pnpm install --frozen-lockfile` to install and `pnpm build` to build. Keep the output directory at the Next.js default. These commands are also declared in `vercel.json`.
4. Set the build environment variable `ENABLE_EXPERIMENTAL_COREPACK=1` so Vercel uses the pinned pnpm version ([Vercel Corepack documentation](https://vercel.com/docs/builds/configure-a-build#corepack)).
5. Deploy. No application secrets, API keys, or databases are needed.

Alternatively, copy this entire directory into a separate repository, preserving `pnpm-lock.yaml`; then use the repository root as the Vercel Root Directory. Nothing imports files outside this folder.

Next.js is used for Vercel integration, build-time rendering, metadata, and future detail pages. The interactive surface is React with TypeScript and CSS/SVG motion. There is no runtime model integration.

## Content and localization

- `src/lib/strategies.ts`: nine strategies, default-budget formulas, bilingual explanations, source references, and historical report observations.
- `src/lib/i18n.ts`: Chinese and English interface copy, cases, and evidence notes.
- `src/lib/simulation.ts`: deterministic teaching fixtures. They do not execute real compaction pipelines or estimate production savings.
- `src/components/`: interactive visualizations and views.
- `src/app/globals.css`: responsive styling and reduced-motion handling.

Language selection is saved only in this browser's local storage. Switching languages preserves the current strategy and playback position. The UI updates the document language and title. If storage is unavailable, switching still works for the current session.

Native Harness content was checked against local revision `5badb15009ae1756c3afe0ae0cef1faafc290ccc`. The eight adapters describe this repository's implementations and their pinned reference versions. Claude Code uses unofficial recovered source; OpenCode and Qwen descriptions refer to the local forks specified by the adapter READMEs. The UI labels these differences.

## Evidence and limits

The animated blocks, summary sizes, and restored-state amounts are illustrative. The walkthrough follows one successful compaction path; it does not simulate every guard, failure, provider, or automatic trigger. Native pruning assumes its optional pruner is mounted; Qwen illustrates a cleanup-eligible path; ZCode illustrates manual compaction without pruning. Default trigger budgets are separately calculated from documented formulas, with an 8,192-token output allowance and no separate input limit.

Reported observations are sourced from:

- [`2026-09-26` single-compaction recall](https://github.com/zonemeen/dsh-context-zoo/blob/main/reports/deepseek/2026-09-26/README.md)
- [`2026-09-27` Cline recall](https://github.com/zonemeen/dsh-context-zoo/blob/main/reports/deepseek/2026-09-27/README.md)
- [`2026-09-29` ten-stage continuation](https://github.com/zonemeen/dsh-context-zoo/blob/main/reports/continuation/2026-09-29/extended/README.md)

These are real model calls on synthetic tasks, not customer production traces or a ranking. Native Harness was not evaluated in these reports. Engineering scenarios are explicitly labeled as illustrations. Source snapshots are curated, not automatically synchronized; update both locales and relevant tests when refreshing them.
