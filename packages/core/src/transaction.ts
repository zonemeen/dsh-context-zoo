/** DSH append protocol, exclusion and surface validation; selection belongs to plugins. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CompactionId, ManualCompactionError, compactCheckpointSource, toolPairingBalancedBefore, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction';
import type { CompactionResult } from '@deepseek-ai/dsh-compaction';
import type { CommandId } from '@deepseek-ai/dsh-commands/brand';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session';
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter';
import type { Checkpoint, ContextEntry, SummaryResponse } from './pipeline.js';

/** Inspect current durable ownership, excluding interrupted constructor seeds. */
export function entryState(session: Session): { active: boolean; turn: number | null } {
  let active = false;
  let turn: number | null = null;
  for (const event of session.snapshotEvents()) {
    if (event.type === 'session/end-seed') { active = false; turn = null; }
    if (event.type === 'compaction/start') active = true;
    if (event.type === 'compaction/end') active = false;
    if (event.type === 'turn/start') turn = event.data.turn;
    if (event.type === 'turn/end') turn = null;
  }
  return { active, turn };
}

/** Reject competing mutation before any surface change. */
export function assertInactive(session: Session): void {
  if (entryState(session).active) throw new ManualCompactionError('busy', 'A context compaction is already active');
}

function validateSpan(session: Session, seqs: readonly SessionSeq[]): void {
  const start = seqs[0];
  const end = seqs.at(-1);
  if (start === undefined || end === undefined) throw new Error('Cannot compact an empty range');
  const position = session.surface.nodes.indexOf(start);
  if (position < 0 || !isDeepStrictEqual(session.surface.nodes.slice(position, position + seqs.length), [...seqs])) throw new ManualCompactionError('changed', 'The selected history is no longer contiguous on the surface');
  if (!toolPairingBalancedBefore(session, start) || !toolPairingBalancedAfter(session, end)) throw new Error('The selected range splits a tool exchange or unfinished step');
  for (const seq of seqs) {
    const event = session.eventAt(seq);
    const message = event && session.deriveEventMessage(event);
    if (message?.role === 'system' || message?.role === 'developer') throw new Error('System and developer messages must remain outside the compacted range');
  }
}

export interface TransactionOptions {
  session: Session;
  meter: TokenMeter;
  entries: readonly ContextEntry[];
  signal: AbortSignal;
  manual: boolean;
  sourceCommandId?: CommandId;
  summarize(): Promise<Checkpoint>;
  calls(): readonly (SummaryResponse | undefined)[];
  target: { provider: string; model: string };
}

/** Commit the chosen range only after its summary and recovery have both succeeded. */
export async function compactTransaction(options: TransactionOptions): Promise<CompactionResult> {
  const { session, meter, entries, signal, manual, sourceCommandId } = options;
  signal.throwIfAborted();
  assertInactive(session);
  const seqs = entries.map(entry => entry.seq);
  validateSpan(session, seqs);
  const turn = entryState(session).turn;
  if (manual ? turn !== null : turn === null) throw new ManualCompactionError('busy', manual ? 'Manual compaction requires an idle session' : 'Automatic compaction requires an open turn');
  const before = meter.measure(session).nodes;
  const priced = before.filter(node => seqs.includes(node.seq));
  const shadowedRange = { start: seqs[0]!, end: seqs.at(-1)! };
  const shadowedTokenCount = priced.reduce((sum, node) => sum + node.heuristicTokens, 0);
  const compactionId = CompactionId(randomUUID());
  const lifecycle = { compactionId, turn, ...sourceCommandId === undefined ? {} : { sourceCommandId } };
  const startEvent = session.append('compaction/start', lifecycle);
  let closing = false;
  let stage: 'summary' | 'commit' = 'summary';
  try {
    const checkpoint = await options.summarize();
    signal.throwIfAborted();
    validateSpan(session, seqs);
    const after = meter.measure(session).nodes;
    if (!isDeepStrictEqual(manual ? after.filter(node => seqs.includes(node.seq)) : after, manual ? priced : before)) throw new ManualCompactionError('changed', 'Session history changed during summarization');
    const summary: ContentBlock[] = [...checkpoint.beforeSummary ?? [], { type: 'text', text: checkpoint.summary }, ...checkpoint.restored ?? []];
    const message = createUserMessage({ content: summary, source: compactCheckpointSource(compactionId, sourceCommandId) });
    if (meter.estimateMessage(message) >= priced.reduce((sum, node) => sum + node.tokens, 0)) throw new Error('Summary and recovered context are not smaller than the selected history');
    const calls = options.calls();
    const call = calls.at(-1);
    stage = 'commit';
    const callRecord = calls.length === 1 && call ? { rawOutput: call.content, llmStreamCall: true as const } : {};
    const summaryEvent = session.append('compaction/summary', {
      compactionId, ...sourceCommandId === undefined ? {} : { sourceCommandId },
      summary, shadowedRange, shadowedSeqs: seqs, shadowedTokenCount,
      provider: call?.provider ?? options.target.provider, model: call?.model ?? options.target.model,
      ...callRecord,
      ...calls.length !== 1 || call === undefined ? {} : {
        maxTokens: call.maxTokens,
        ...call.usage === undefined ? {} : { usage: call.usage },
      },
    });
    // The summary record and its replacement are adjacent in DSH's durable protocol.
    session.append('user/message', message, {
      surfaceOp: { op: 'replace', startSeq: shadowedRange.start, endSeq: shadowedRange.end },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...seqs],
    });
    closing = true;
    const endEvent = session.append('compaction/end', lifecycle);
    return {
      compactionId, ...sourceCommandId === undefined ? {} : { sourceCommandId },
      startSeq: startEvent.seq, summarySeq: summaryEvent.seq, endSeq: endEvent.seq,
      summary, shadowedRange, shadowedSeqs: seqs, shadowedTokenCount,
    };
  } catch (error) {
    let failure = error;
    if (!closing) {
      try { session.append('compaction/end', { ...lifecycle, error: error instanceof Error ? error.message : String(error) }); }
      catch (closeError) { failure = closeError; stage = 'commit'; }
    }
    signal.throwIfAborted();
    if (manual && !(failure instanceof ManualCompactionError)) throw new ManualCompactionError(stage, failure instanceof Error ? failure.message : String(failure), { cause: failure });
    throw failure;
  }
}
