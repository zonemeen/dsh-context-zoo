/** Cordis registration and lifecycle delegation, without agent-specific decisions. */
import { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import { CompactionEngine, ManualCompactionError } from '@deepseek-ai/dsh-compaction';
import type { CompactionAgentContext, CompactionResult, CompactionTrigger, ManualCompactAgentContext } from '@deepseek-ai/dsh-compaction';
import type { CommandId } from '@deepseek-ai/dsh-commands/brand';
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import type { SessionSeq } from '@deepseek-ai/dsh-session';
import { validateConfig } from './config.js';
import { createHost } from './host.js';
import { assertInactive } from './transaction.js';
import type { ContextConfig } from './types.js';
import type { ContextPipeline, ContextTrigger, PipelineDefinition } from './pipeline.js';

/** Cordis plugin providing one context engine. */
export interface ContextPlugin {
  name: string;
  inject: string[];
  apply(ctx: Context, config?: ContextConfig): void;
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Summarize an explicit abandoned branch under the caller's maintenance lock.
     * @param agent - idle session owner whose durable log contains the selected events.
     * @param seqs - branch message events in conversation order.
     * @param signal - cancellation forwarded to the summary provider.
     * @param next - delegate if this context plugin has no branch workflow.
     * @mode waterfall
     */
    'context-zoo/summarize-branch'(agent: CompactionAgentContext, seqs: readonly SessionSeq[], signal: AbortSignal, next: () => Promise<string | undefined>): Promise<string | undefined>;
  }
}

/**
 * Run a plugin's explicit branch workflow and flush its durable summary metadata.
 * The navigation integration inserts the returned text in its new branch as a logged message.
 * @param ctx - Cordis context with the selected plugin.
 * @param agent - idle agent containing the abandoned branch events.
 * @param seqs - message sequence numbers in branch order.
 * @param signal - caller cancellation.
 * @returns the branch summary, or undefined when the plugin has no branch workflow.
 */
export function summarizeBranch(ctx: Context, agent: ManualCompactAgentContext, seqs: readonly SessionSeq[], signal: AbortSignal): Promise<string | undefined> {
  signal.throwIfAborted();
  return agent.runMaintenance(async agentSignal => {
    const operationSignal = AbortSignal.any([agentSignal, signal]);
    let summary: string | undefined;
    let failed = false;
    let failure: unknown;
    try { summary = await ctx.waterfall('context-zoo/summarize-branch', agent, seqs, operationSignal, async () => undefined); }
    catch (error) { failed = true; failure = error; }
    try { await ctx.sessions.flush(agent.session); }
    catch (error) { if (!failed) { failed = true; failure = error; } }
    operationSignal.throwIfAborted();
    if (failed) throw failure;
    return summary;
  });
}

/** Register a source-owned pipeline using the common DSH service and event protocols. */
export function createContextPlugin(definition: PipelineDefinition): ContextPlugin {
  return {
    name: `context-${definition.id}`,
    inject: ['llm', 'tokenMeter', 'sessions'],
    apply(ctx, config = {}) {
      validateConfig(config);
      const probe = Session.create(SessionId('context-zoo-capability-probe'));
      const marker = probe.append('context-zoo/state', { plugin: definition.id, kind: 'probe', data: {} }, { ignorable: true });
      if (marker.ignorable !== true) throw new Error('DSH Session.append needs the supplied ignorable-event patch; see dsh-context-core/dist/compat/README.md');
      const settings = Object.freeze({ ...config });
      const pipelines = new WeakMap<Session, ContextPipeline>();
      const pipelineFor = (session: Session): ContextPipeline => {
        let pipeline = pipelines.get(session);
        if (!pipeline) { pipeline = definition.create(settings); pipelines.set(session, pipeline); }
        return pipeline;
      };
      const run = async (agent: CompactionAgentContext, trigger: ContextTrigger, signal: AbortSignal, manual = false, sourceCommandId?: CommandId): Promise<CompactionResult | null> => {
        signal.throwIfAborted();
        assertInactive(agent.session);
        return pipelineFor(agent.session).run(createHost(ctx, agent, definition.id, settings, signal, manual, sourceCommandId), trigger);
      };
      class PipelineEngine extends CompactionEngine {
        override compactIfNeeded(agent: CompactionAgentContext, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null> {
          return run(agent, trigger, signal);
        }
        override async compactRegion(start: SessionSeq, end: SessionSeq, agent: CompactionAgentContext, signal = new AbortController().signal): Promise<CompactionResult> {
          const host = createHost(ctx, agent, definition.id, settings, signal);
          const snapshot = await host.snapshot();
          const first = snapshot.entries.findIndex(entry => entry.seq === start);
          const last = snapshot.entries.findIndex(entry => entry.seq === end);
          if (first < 0 || last < first) throw new Error('Invalid context range');
          const entries = snapshot.entries.slice(first, last + 1);
          return host.compact(entries, () => pipelineFor(agent.session).summarizeRange(host, entries));
        }
        override compactNow(agent: ManualCompactAgentContext, signal: AbortSignal, sourceCommandId?: CommandId): Promise<CompactionResult | null> {
          signal.throwIfAborted();
          try {
            return agent.runMaintenance(async agentSignal => {
              const operationSignal = AbortSignal.any([agentSignal, signal]);
              const before = agent.session.seq;
              let result: CompactionResult | null = null;
              let failed = false;
              let failure: unknown;
              try { result = await run(agent, 'manual', operationSignal, true, sourceCommandId); }
              catch (error) { failed = true; failure = error; }
              if (agent.session.seq !== before) {
                try { await ctx.sessions.flush(agent.session); }
                catch (error) { if (!failed) { failed = true; failure = new ManualCompactionError('persistence', 'Manual compaction could not be flushed', { cause: error }); } }
              }
              signal.throwIfAborted();
              if (agentSignal.aborted) throw new ManualCompactionError('cancelled', 'Manual compaction was cancelled', { cause: operationSignal.reason });
              if (failed) throw failure;
              return result;
            });
          } catch (error) {
            throw new ManualCompactionError('busy', 'Manual compaction requires an idle agent', { cause: error });
          }
        }
      }
      ctx.plugin(PipelineEngine);
      ctx.on('context-zoo/summarize-branch', async (agent, seqs, signal, next) => {
        const pipeline = pipelineFor(agent.session);
        if (!pipeline.summarizeBranch) return next();
        assertInactive(agent.session);
        const host = createHost(ctx, agent, definition.id, settings, signal, true);
        const snapshot = await host.snapshot();
        const bySeq = new Map(snapshot.archive.map(entry => [entry.seq, entry]));
        const entries = seqs.map(seq => {
          const entry = bySeq.get(seq);
          if (!entry) throw new Error(`Missing branch message ${seq}`);
          return entry;
        });
        const summary = await pipeline.summarizeBranch(host, entries);
        signal.throwIfAborted();
        host.record('branch-summary', { seqs: [...seqs], summary });
        return summary;
      });
      if (settings.auto === false) return;
      ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
        if (!signal.aborted) {
          try { await run(agent, 'pressure', signal); }
          catch (error) { if (!signal.aborted) ctx.logger.warn(`${definition.id} context preparation failed: ${error instanceof Error ? error.message : String(error)}`); }
        }
        return next();
      });
      ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
        const trigger = failure.status === 413 ? 'request-too-large' : failure.code === CONTEXT_WINDOW_EXCEEDED_CODE ? 'context-overflow' : undefined;
        if (!trigger || signal.aborted) return next();
        const generation = agent.session.surface.replaceGeneration;
        try { await run(agent, trigger, signal); }
        catch (error) { if (!signal.aborted) ctx.logger.warn(`${definition.id} context recovery failed: ${error instanceof Error ? error.message : String(error)}`); }
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) return { kind: 'retry' };
        return next();
      });
    },
  };
}
