/** Inputs shared by the source-specific budget functions. */
export interface BudgetInput {
  contextWindow: number;
  maxOutputTokens: number;
  reserveTokens?: number;
  thresholdRatio?: number;
  keepRecentTokens?: number;
}

/** Source-specific budget metadata; the pipeline owns its token estimator and retention semantics. */
export interface ContextBudget {
  triggerTokens: number;
  retainTokens: number;
  strict?: boolean;
  /** Minimum recent messages, subject to retainTokens when tailMode is maximum. */
  minRecentMessages?: number;
  tailMode?: 'minimum' | 'maximum';
  retainLastRound?: boolean;
}

/** Optional model-free removal of old textual tool results. */
export interface PrunePolicy {
  enabled: boolean;
  keepRecentTools: number;
  protectTokens: number;
  minSavingsTokens: number;
  strictSavings?: boolean;
  keepRecentTurns?: number;
  protectedTools?: readonly string[];
  eligibleTools?: readonly string[];
  groupByAssistant?: boolean;
  triggerRatio?: number;
  triggerBufferTokens?: number;
}

/** One independently implemented adaptation of a pinned agent strategy. */
export interface ContextStrategy {
  id: string;
  name: string;
  /** Original project URL; revision and license describe the inspected local fork or source reference. */
  source: { url: string; revision: string; license: string };
  /** What this adaptation deliberately leaves to the host or upstream product. */
  limitations: readonly string[];
  budget(input: BudgetInput): ContextBudget;
  summaryInstructions: string;
  maxSummaryTokens: number;
  /** Maximum tool-result characters in the auxiliary summary request; zero leaves them intact. */
  summaryToolChars: number;
  prune: PrunePolicy;
}

/** User overrides for a strategy plugin. All token values are integers. */
export interface ContextConfig {
  auto?: boolean;
  reserveTokens?: number;
  thresholdRatio?: number;
  keepRecentTokens?: number;
  maxSummaryTokens?: number;
  summaryToolChars?: number;
  summarizationProvider?: string;
  summarizationModel?: string;
  maxOverflowRetries?: number;
  maxConsecutiveFailures?: number;
  prune?: boolean;
  keepRecentTools?: number;
  protectToolTokens?: number;
  minPruneTokens?: number;
  screenshotTriggerImages?: number;
  tailTurns?: number;
  summaryRetryDelayMs?: number;
  idleMinutes?: number;
  toolHighWaterChars?: number;
  toolLowWaterChars?: number;
  maxSummaryAttempts?: number;
  maxRestoredFiles?: number;
  maxFileTokens?: number;
  maxRestoreTokens?: number;
  maxRestoredImages?: number;
  maxSkillTokens?: number;
  restoreContext?: boolean;
}
