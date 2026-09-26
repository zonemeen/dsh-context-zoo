/** DSH observations and transport for independently implemented context pipelines. */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-fs';
import type { CommandId } from '@deepseek-ai/dsh-commands/brand';
import type { CompactionAgentContext } from '@deepseek-ai/dsh-compaction';
import { assembleAssistantStream, BlockAssembler, freezeMessage, LlmError } from '@deepseek-ai/dsh-llm';
import type { RequestMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session';
import type { ContextConfig } from './types.js';
import type { ContextEntry, ContextHost, ContextRecovery, SummaryResponse } from './pipeline.js';
import { assertInactive, compactTransaction } from './transaction.js';

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'context-zoo/state': { plugin: string; kind: string; data: Record<string, unknown> };
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Supply observed external runtime state, such as an actual transcript location.
     * @param agent - session owner requesting recovery observations.
     * @param signal - operation cancellation.
     * @param next - delegate when this integration has no observations.
     * @mode waterfall
     */
    'context-zoo/recovery'(agent: CompactionAgentContext, signal: AbortSignal, next: () => Promise<ContextRecovery | undefined>): Promise<ContextRecovery | undefined>;
  }
}

const checkedSessionClasses = new WeakSet<Function>();

function checkSessionWriter(session: Session, plugin: string): void {
  const implementation = session.constructor as typeof Session;
  if (checkedSessionClasses.has(implementation)) return;
  const probe = implementation.create(SessionId('context-zoo-runtime-probe'));
  const marker = probe.append('context-zoo/state', { plugin, kind: 'probe', data: {} }, { ignorable: true });
  if (marker.ignorable !== true) throw new Error('The active DSH Session implementation needs the supplied ignorable-event patch; see dsh-context-zoo patches/README.md');
  checkedSessionClasses.add(implementation);
}

/** Build low-level operations scoped to one run and its cancellation signal. */
export function createHost(ctx: Context, agent: CompactionAgentContext, id: string, config: ContextConfig, signal: AbortSignal, manual = false, sourceCommandId?: CommandId): ContextHost {
  const session = agent.session;
  checkSessionWriter(session, id);
  const calls: Array<SummaryResponse | undefined> = [];
  const target = () => {
    const request = session.requestHeader()?.config;
    const provider = request?.provider ?? agent.options.provider;
    const model = request?.model ?? agent.options.model;
    if (!provider || !model) throw new Error('Context management needs a routed provider and model');
    return { provider, model, maxTokens: request?.maxTokens };
  };
  const record: ContextHost['record'] = (kind, data) => {
    // Durable metadata must contain JSON values, including no undefined properties.
    const durable: Record<string, unknown> = JSON.parse(JSON.stringify(data));
    const event = session.append('context-zoo/state', { plugin: id, kind, data: durable }, { ignorable: true });
    if (event.ignorable !== true) throw new Error('DSH Session.append needs the supplied ignorable-event patch; see patches/README.md');
  };
  const host: ContextHost = {
    signal,
    record,
    records: kind => session.snapshotEvents().flatMap(event => event.type === 'context-zoo/state' && event.data.plugin === id && event.data.kind === kind ? [event.data.data] : []),
    async snapshot() {
      signal.throwIfAborted();
      const route = target();
      const info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal);
      signal.throwIfAborted();
      if (!info.context) throw new Error(`No context window configured for ${route.provider}/${route.model}`);
      const recovery = await ctx.waterfall('context-zoo/recovery', agent, signal, async () => undefined);
      signal.throwIfAborted();
      const measurement = ctx.tokenMeter.measure(session);
      const prices = new Map(measurement.nodes.map(node => [node.seq, node.tokens]));
      const tools = new Map<string, { name: string; arguments: string }>();
      let requestSeries = 'initial';
      let turnKey: string | undefined;
      const archive: ContextEntry[] = [];
      for (const event of session.snapshotEvents()) {
        if (event.type === 'turn/start') { turnKey = `turn:${event.seq}`; requestSeries = turnKey; }
        if (event.type === 'tool/call') tools.set(event.data.callId, event.data);
        const message = session.deriveEventMessage(event) ?? (event.type === 'system/message' || event.type === 'developer/message' ? event.data.message : null);
        if (message === null) continue;
        for (const block of message.content) if (block.type === 'tool-call') tools.set(block.id, { name: block.name, arguments: block.arguments });
        const assembled = event.type === 'assistant/message' ? assembleAssistantStream(event.data.stream) : undefined;
        if (event.type === 'assistant/message' && assembled?.finish.kind !== 'error' && assembled?.finish.kind !== 'aborted') requestSeries = `response:${event.seq}`;
        const usage = event.type === 'assistant/message' ? event.data.usage ?? assembled?.usage : undefined;
        const tool = message.role === 'tool' ? tools.get(message.toolCallId) : undefined;
        archive.push({
          seq: event.seq, message, time: event.time, tokens: prices.get(event.seq) ?? ctx.tokenMeter.estimateMessage(message),
          ...assembled === undefined ? {} : { finish: assembled.finish.kind, ...usage === undefined ? {} : { usage } },
          ...tool === undefined ? {} : { toolName: tool.name, toolArguments: tool.arguments },
        });
      }
      const bySeq = new Map(archive.map(entry => [entry.seq, entry]));
      const entries = session.surface.nodes.map(seq => {
        const entry = bySeq.get(seq);
        if (!entry) throw new Error(`Missing message for surface event ${seq}`);
        return entry;
      });
      return {
        entries, archive, contextWindow: info.context.contextWindow,
        maxOutputTokens: route.maxTokens ?? info.defaultMaxTokens ?? 32_000,
        provider: route.provider, model: route.model, tools: session.requestHeader()?.tools ?? [],
        measuredTokens: measurement.totalTokens, now: Date.now(), cwd: session.header.cwd ?? '', sessionId: session.id, requestSeries, ...turnKey === undefined ? {} : { turnKey },
        ...recovery === undefined ? {} : { recovery },
      };
    },
    async summarize(request) {
      signal.throwIfAborted();
      const route = target();
      const provider = request.provider ?? config.summarizationProvider ?? route.provider;
      const model = request.model ?? config.summarizationModel ?? route.model;
      const messages: RequestMessage[] = [...request.messages, { role: 'user', content: [{ type: 'text', text: request.instruction }] }];
      const tools = request.includeTools ? session.requestHeader()?.tools : undefined;
      const requestData = { provider, model, maxTokens: request.maxTokens, messages, ...(tools === undefined ? {} : { tools }) };
      const callId = `${id}:${session.seq}`;
      record('model-request', { callId, ...requestData });
      const callIndex = calls.push(undefined) - 1;
      try {
        const assembler = new BlockAssembler();
        for await (const chunk of ctx.llm.stream({ ...requestData, toolHistory: session.toolHistory(), sessionId: session.id, purpose: 'compaction', signal })) assembler.push(chunk);
        signal.throwIfAborted();
        const finish = assembler.finish;
        const content = assembler.blocks();
        const response: SummaryResponse = {
          provider, model, maxTokens: request.maxTokens, content,
          text: content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
          finish: finish.kind, ...assembler.usage === undefined ? {} : { usage: assembler.usage },
        };
        record('model-result', { callId, ...response, ...(finish.kind === 'error' || finish.kind === 'aborted' ? { failure: finish.failure } : {}) });
        calls[callIndex] = response;
        if (finish.kind === 'error' || finish.kind === 'aborted') throw new LlmError(finish.failure.message, finish.failure.code, finish.failure);
        return response;
      } catch (error) {
        record('model-error', { callId, message: error instanceof Error ? error.message : String(error), ...error instanceof LlmError ? { failure: error.failure } : {} });
        signal.throwIfAborted();
        throw error;
      }
    },
    replace(replacements) {
      signal.throwIfAborted();
      assertInactive(session);
      const seen = new Set<SessionSeq>();
      const changes = replacements.map(replacement => {
        if (seen.has(replacement.seq)) throw new Error('Duplicate tool replacement');
        seen.add(replacement.seq);
        const event = session.eventAt(replacement.seq);
        if (!session.surface.nodes.includes(replacement.seq) || (event?.type !== 'tool/result' && event?.type !== 'user/message')) throw new Error('Replacement must target a current user message or tool result');
        const original = event.type === 'tool/result' ? event.data.message : event.data;
        const message = freezeMessage({ ...original, content: [...replacement.content] });
        return { event, message, price: ctx.tokenMeter.estimateMessage(original) };
      });
      for (const { event, message, price } of changes) {
        session.append('compaction/prune', { shadowedRange: { start: event.seq, end: event.seq }, shadowedSeqs: [event.seq], shadowedTokenCount: price });
        const options = { surfaceOp: { op: 'replace' as const, startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq] };
        if (event.type === 'tool/result' && message.role === 'tool') session.append('tool/result', { ...event.data, message }, options);
        else if (event.type === 'user/message' && message.role === 'user') session.append('user/message', message, options);
      }
    },
    compact(entries, summarize) {
      const firstCall = calls.length;
      return compactTransaction({ session, meter: ctx.tokenMeter, entries, signal, manual, sourceCommandId, summarize, calls: () => calls.slice(firstCall), target: target() });
    },
    async readFile(path, maxChars) {
      signal.throwIfAborted();
      const fs = ctx.get('fs');
      if (!fs) { record('file-unavailable', { path, reason: 'No DSH filesystem provider is installed' }); return null; }
      try {
        const target = await fs.resolve(path, { cwd: session.header.cwd, signal });
        const chunks = await fs.streamText(target, signal);
        let text = '';
        for await (const chunk of chunks) {
          signal.throwIfAborted();
          text += chunk.slice(0, Math.max(0, maxChars - text.length));
          if (text.length >= maxChars) break;
        }
        signal.throwIfAborted();
        return text;
      } catch (error) {
        signal.throwIfAborted();
        record('file-unavailable', { path, reason: error instanceof Error ? error.message : String(error) });
        return null;
      }
    },
  };
  return host;
}
