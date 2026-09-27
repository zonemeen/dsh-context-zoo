/** Context compaction plugin based on the Cline SDK workflow. */
import { createContextPlugin, type ContextStrategy } from 'dsh-context-core';
import { createPipeline, SUMMARY_INSTRUCTIONS } from './pipeline.js';
export { createPipeline } from './pipeline.js';

export const strategy: ContextStrategy = {
  id: 'cline',
  name: 'Cline',
  source: {
    url: 'https://github.com/cline/cline',
    revision: '252082b9e93b4f91253876391e35b4c13326f5e6',
    license: 'Apache-2.0',
  },
  limitations: [
    'Adapts the default agentic summary path and deterministic basic recovery to DSH contiguous checkpoints; preserved basic user prompts and assistant text become checkpoint blocks.',
    'Uses serialized DSH messages, protected instructions and tool schemas for input estimates. Provider-specific Cline request encoders and native usage metadata require the Cline runtime.',
    'DSH replay restores checkpoints and retry state; Cline sidecar files, prefix hashes, UI metadata and custom compaction hooks are not imported.',
    'Thinking controls and separate summarizer model capabilities are unavailable through ContextHost; a separate route uses a conservative 1024-token input budget.',
    'Summary input projection preserves user text and skips requests that cannot fit. DSH rejects truncated, non-text and non-shrinking summaries.',
  ],
  budget(input) {
    const usable = input.contextWindow * 0.9;
    return {
      triggerTokens: Math.max(0, Math.floor(Math.min(usable * (input.thresholdRatio ?? 0.9), usable - (input.reserveTokens ?? 0)))),
      retainTokens: input.keepRecentTokens ?? 20_000,
    };
  },
  summaryInstructions: SUMMARY_INSTRUCTIONS,
  maxSummaryTokens: 8_192,
  summaryToolChars: 2_000,
  prune: { enabled: false, keepRecentTools: 0, protectTokens: 0, minSavingsTokens: 0 },
};

export default createContextPlugin({ id: strategy.id, create: createPipeline });
