import type { ContentBlock, Message, RequestMessage, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm';
import type { CompactionResult } from '@deepseek-ai/dsh-compaction';
import type { SessionSeq } from '@deepseek-ai/dsh-session';
import type { ContextConfig } from './types.js';

/** A durable message with the host's observations; plugins choose their own prices and interpretation. */
export interface ContextEntry {
  seq: SessionSeq;
  message: Message;
  time: number;
  tokens: number;
  usage?: TokenUsage;
  finish?: string;
  toolName?: string;
  toolArguments?: string;
}

/** Immutable observations for one admitted operation. */
export interface ContextSnapshot {
  entries: readonly ContextEntry[];
  /** Full durable message history, including content replaced by earlier checkpoints. */
  archive: readonly ContextEntry[];
  contextWindow: number;
  maxOutputTokens: number;
  inputLimit?: number;
  provider: string;
  model: string;
  tools: readonly ToolSchema[];
  measuredTokens: number;
  now: number;
  /** Stable through failed retries; advances at a new turn or successful assistant response. */
  requestSeries: string;
  /** Stable for an entire user turn; absent for hosts without a turn lifecycle. */
  turnKey?: string;
  cwd: string;
  sessionId: string;
  /** Observed host recovery pointers; absent capabilities must not be claimed. */
  recovery?: ContextRecovery;
}

export type ContextTrigger = 'pressure' | 'manual' | 'context-overflow' | 'request-too-large';

/** Low-level auxiliary model call. Formatting, clipping, retry and output validation belong to the plugin. */
export interface SummaryRequest {
  messages: readonly RequestMessage[];
  instruction: string;
  maxTokens: number;
  includeTools?: boolean;
  provider?: string;
  model?: string;
}

/** One settled call, preserved even when a plugin later rejects its text. */
export interface SummaryResponse {
  text: string;
  content: ContentBlock[];
  provider: string;
  model: string;
  maxTokens: number;
  usage?: TokenUsage;
  finish?: string;
}

/** Checkpoint and recovered context that will replace the selected history atomically. */
export interface Checkpoint {
  summary: string;
  beforeSummary?: readonly ContentBlock[];
  restored?: readonly ContentBlock[];
}

/** Explicit replacement selected by a plugin's microcompaction algorithm. */
export interface ContextReplacement {
  seq: SessionSeq;
  content: readonly ContentBlock[];
}

/** Observations supplied by an installed host integration. */
export interface ContextRecovery {
  approvedPlanPath?: string;
  transcriptPath?: string;
  wirePath?: string;
  windowLines?: string;
  todos?: string;
  reminders?: readonly ContentBlock[];
  replStateCleared?: boolean;
}

/** Host primitives contain no source-agent trigger, retention, pruning or retry policy. */
export interface ContextHost {
  readonly signal: AbortSignal;
  snapshot(): Promise<ContextSnapshot>;
  summarize(request: SummaryRequest): Promise<SummaryResponse>;
  replace(replacements: readonly ContextReplacement[]): void;
  compact(entries: readonly ContextEntry[], summarize: () => Promise<Checkpoint>): Promise<CompactionResult>;
  /** Read through DSH's filesystem provider; null means absent or unavailable, never a fabricated file snapshot. */
  readFile(path: string, maxChars: number): Promise<string | null>;
  /** Append plugin state as an ignorable durable event, keeping replay independent of live plugin instances. */
  record(kind: string, data: Record<string, unknown>): void;
  records(kind: string): readonly Record<string, unknown>[];
}

/** Each package owns the complete sequence of decisions and transformations. */
export interface ContextPipeline {
  run(host: ContextHost, trigger: ContextTrigger): Promise<CompactionResult | null>;
  /** Explicit range requests still use the package's summary and recovery sequence. */
  summarizeRange(host: ContextHost, entries: readonly ContextEntry[]): Promise<Checkpoint>;
  /** Optional native branch-navigation integration, invoked explicitly by the host. */
  summarizeBranch?(host: ContextHost, entries: readonly ContextEntry[]): Promise<string>;
}

export interface PipelineDefinition {
  id: string;
  create(config?: ContextConfig): ContextPipeline;
}
