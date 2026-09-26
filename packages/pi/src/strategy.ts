/** Pi context-budget, recent-history, and structured-summary strategy. */
import type { ContextStrategy } from '@dsh-context-zoo/core';

/** Adaptation of the pinned Pi coding-agent compaction implementation. */
export const strategy: ContextStrategy = {
  id: 'pi',
  name: 'Pi',
  source: {
    url: 'https://github.com/earendil-works/pi',
    revision: '8a7b0c03dfb702663acafb6dc29f8acaa4ffe391',
    license: 'MIT',
  },
  limitations: [
    'DSH owns session persistence; Pi branches are supplied explicitly to summarizeBranch rather than discovered through a Pi session-tree UI.',
    'Cache-write suppression needs a provider capability that the DSH model interface does not expose.',
    'Pi extension handlers require the Pi runtime; this package exposes its own pipeline methods and configuration.',
  ],
  budget(input) {
    const usable = Math.max(0, input.contextWindow - (input.reserveTokens ?? 16_384));
    return {
      triggerTokens: Math.floor(usable * (input.thresholdRatio ?? 1)),
      retainTokens: input.keepRecentTokens ?? 20_000,
      strict: true,
      tailMode: 'minimum',
    };
  },
  summaryInstructions: `Create a concise checkpoint with these headings in order:
## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context

Capture all unfinished user requests and the facts needed for the next step. Preserve relevant prior-summary information, exact paths, commands, symbols, and error text. Reflect newly completed work and resolved blockers. List actions in execution order. Use short bullets; mark completed progress with [x] and pending progress with [ ].`,
  maxSummaryTokens: 13_107,
  summaryToolChars: 2_000,
  prune: {
    enabled: false,
    keepRecentTools: 0,
    protectTokens: 0,
    minSavingsTokens: 0,
  },
};
