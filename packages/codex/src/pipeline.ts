/** Codex's local summarization, user retention, and context-window retry policy. */
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Checkpoint, ContextConfig, ContextEntry, ContextHost, ContextPipeline, ContextSnapshot, SummaryResponse } from '@dsh-context-zoo/core';

/** Independently written handoff instructions for Codex's local compaction path. */
export const summaryInstruction = 'Write a compact handoff for the assistant that will continue this task. Include the user’s objective, completed work, decisions, constraints and preferences, remaining steps, and the exact references needed to proceed. Keep concrete facts and unresolved requests. Treat the conversation as source material; do not continue its work or call tools. Return only the structured handoff.';

/** Identifies this adaptation's handoff text without imitating provider-native compaction items. */
export const summaryPrefix = 'Context checkpoint for continuing this task. Use the retained user messages and this handoff to continue from the recorded progress:';

const checkpoint = (entry: ContextEntry): boolean => entry.message.source.kind === 'compact-checkpoint';
const protectedEntry = (entry: ContextEntry): boolean => entry.message.role === 'system' || entry.message.role === 'developer';
const userText = (content: readonly ContentBlock[]): string => content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
const fingerprint = (content: readonly ContentBlock[]): string => createHash('sha256').update(JSON.stringify(content)).digest('hex');

/** Estimate text tokens from UTF-8 bytes using Codex's four-byte approximation. */
export function approximateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

/** Keep both ends at UTF-8 boundaries; the truncation notice is outside the retained byte budget. */
export function truncateTokens(text: string, maxTokens: number): string {
  const bytes = Buffer.from(text, 'utf8');
  const budget = Math.max(0, Math.floor(maxTokens)) * 4;
  if (bytes.length <= budget) return text;
  let head = Math.floor(budget / 2);
  let tail = bytes.length - (budget - head);
  while (head > 0 && (bytes[head]! & 0xc0) === 0x80) head--;
  while (tail < bytes.length && (bytes[tail]! & 0xc0) === 0x80) tail++;
  const removed = Math.ceil((bytes.length - budget) / 4);
  return `${bytes.subarray(0, head).toString('utf8')}…${removed} tokens truncated…${bytes.subarray(tail).toString('utf8')}`;
}

/** Price visible text, tool arguments, and default-detail images; plaintext reasoning is uncharged. */
export function estimateTokens(entry: ContextEntry): number {
  let bytes = entry.message.role === 'tool' ? Buffer.byteLength(entry.message.toolCallId + (entry.toolName ?? ''), 'utf8') : 0;
  for (const block of entry.message.content) {
    if (block.type === 'text') bytes += Buffer.byteLength(block.text, 'utf8');
    else if (block.type === 'tool-call') bytes += Buffer.byteLength(block.name + block.arguments, 'utf8');
    else if (block.type === 'image') bytes += block.offloaded ? Buffer.byteLength(JSON.stringify(block.attachment), 'utf8') : 7_373;
    else if (block.type === 'file') bytes += Buffer.byteLength(JSON.stringify(block.attachment), 'utf8');
  }
  return Math.ceil(bytes / 4);
}

/** Add local growth to the latest valid usage report produced after every live checkpoint. */
export function contextTokens(snapshot: ContextSnapshot): number {
  const entries = snapshot.entries;
  const lastCheckpoint = entries.reduce((latest, entry) => checkpoint(entry) ? Math.max(latest, entry.seq) : latest, -1);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.message.role !== 'assistant' || entry.seq < lastCheckpoint || entry.finish === 'error' || entry.finish === 'aborted' || !entry.usage) continue;
    const usage = entry.usage;
    // DSH reports disjoint uncached and cached input, unlike Codex's aggregate input counter.
    const tokens = usage.totalTokens ?? usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens;
    if (!Number.isFinite(tokens) || tokens <= 0) continue;
    return tokens + entries.slice(index + 1).reduce((sum, value) => sum + estimateTokens(value), 0);
  }
  return entries.reduce((sum, entry) => sum + estimateTokens(entry), 0);
}

/** Retain newest genuine user messages in order, flattening media and truncating one boundary message. */
export function retainUserMessages(messages: readonly (readonly ContentBlock[])[], maxTokens: number): ContentBlock[][] {
  const retained: ContentBlock[][] = [];
  let remaining = Math.max(0, Math.floor(maxTokens));
  for (const content of [...messages].reverse()) {
    if (remaining === 0) break;
    const text = userText(content);
    const tokens = approximateTokens(text);
    retained.push(tokens <= remaining && content.every(block => block.type === 'text')
      ? content.map(block => ({ ...block }))
      : [{ type: 'text', text: truncateTokens(text, remaining) }]);
    if (tokens > remaining) break;
    remaining -= tokens;
  }
  return retained.reverse();
}

/** Select one contiguous, completed span while preserving every system/developer message and tool pair. */
function select(entries: readonly ContextEntry[]): readonly ContextEntry[] | undefined {
  const pending = new Set<string>();
  let start = -1;
  let end = -1;
  const candidate = (): readonly ContextEntry[] | undefined => {
    if (start < 0 || end <= start) return undefined;
    const span = entries.slice(start, end);
    return span.some(entry => entry.message.role === 'assistant' || entry.message.role === 'tool') ? span : undefined;
  };
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (protectedEntry(entry)) {
      const span = candidate();
      if (span) return span;
      start = -1;
      end = -1;
      continue;
    }
    if (start < 0 && pending.size === 0 && entry.message.role !== 'tool') start = index;
    for (const block of entry.message.content) if (block.type === 'tool-call') pending.add(block.id);
    if (entry.message.role === 'tool') pending.delete(entry.message.toolCallId);
    if (start >= 0 && pending.size === 0) end = index + 1;
  }
  return candidate();
}

/** Drop one oldest request item together with all tool counterparts it would orphan. */
function dropOldest(entries: readonly ContextEntry[]): ContextEntry[] | undefined {
  const first = entries.find(entry => !protectedEntry(entry));
  if (!first) return undefined;
  const removed = new Set([first.seq]);
  const calls = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      const ids = entry.message.content.flatMap(block => block.type === 'tool-call' ? [block.id] : []);
      if (entry.message.role === 'tool') ids.push(entry.message.toolCallId);
      if (!removed.has(entry.seq) && ids.some(id => calls.has(id))) { removed.add(entry.seq); changed = true; }
      if (removed.has(entry.seq)) for (const id of ids) if (!calls.has(id)) { calls.add(id); changed = true; }
    }
  }
  return entries.filter(entry => !removed.has(entry.seq));
}

function errorCode(error: unknown): string {
  return error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : '';
}

function contextOverflow(error: unknown): boolean {
  return /CONTEXT.*(EXCEED|OVERFLOW|LENGTH)|PROMPT_TOO_LONG/.test(errorCode(error).toUpperCase())
    || (error instanceof Error && /context.{0,35}(exceed|overflow|limit)|prompt.{0,16}too.?long|maximum context length/i.test(error.message));
}

function terminal(error: unknown): boolean {
  return /ABORT|CANCEL|INTERRUPT|SESSION_BUDGET_EXCEEDED/.test(errorCode(error).toUpperCase())
    || error instanceof Error && error.name === 'AbortError';
}

interface RetainedContext { key: string; seq: number; content: ContentBlock[] }
interface RetainedState { users: ContentBlock[][]; context: RetainedContext[] }

function injectedContext(entry: ContextEntry): RetainedContext | undefined {
  const source = entry.message.source;
  if (entry.message.role !== 'user' || source.kind === 'user' || source.kind === 'compact-checkpoint') return undefined;
  const form = 'form' in source ? source.form : undefined;
  if (form !== 'instructions' && form !== 'catalog' && form !== 'snapshot' && !/skill|plan|subagent|agent-instructions/.test(source.kind)) return undefined;
  const key = form === 'snapshot' || form === 'catalog' || /plan/.test(source.kind)
    ? JSON.stringify([source.kind, form ?? null]) : JSON.stringify(source);
  return { key, seq: entry.seq, content: entry.message.content.filter(block => block.type === 'text') };
}

/** Recover only state whose complete checkpoint content matches a live surface message. */
function retainedState(host: ContextHost, entries: readonly ContextEntry[]): RetainedState {
  const users: ContentBlock[][] = [];
  const context: RetainedContext[] = [];
  for (const entry of entries) {
    const source = entry.message.source;
    if (source.kind === 'compact-checkpoint') {
      const hash = fingerprint(entry.message.content);
      const saved = host.records('codex/checkpoint').findLast(record => record.fingerprint === hash
        && typeof record.preparedAfterSeq === 'number' && record.preparedAfterSeq < entry.seq);
      if (!saved) continue;
      if (Array.isArray(saved.users)) for (const message of saved.users) {
        if (Array.isArray(message) && message.every(text => typeof text === 'string')) users.push(message.map(text => ({ type: 'text', text })));
      }
      if (Array.isArray(saved.context)) for (const raw of saved.context) {
        const value: unknown = raw;
        if (value && typeof value === 'object' && 'key' in value && typeof value.key === 'string'
          && 'seq' in value && typeof value.seq === 'number' && Number.isSafeInteger(value.seq)
          && 'texts' in value && Array.isArray(value.texts)) {
          const texts = value.texts.filter((text: unknown): text is string => typeof text === 'string');
          if (texts.length === value.texts.length) context.push({ key: value.key, seq: value.seq, content: texts.map(text => ({ type: 'text', text })) });
        }
      }
    } else if (entry.message.role === 'user' && source.kind === 'user') {
      if (!userText(entry.message.content).startsWith(summaryPrefix)) users.push([...entry.message.content]);
    } else {
      const injected = injectedContext(entry);
      if (injected) context.push(injected);
    }
  }
  return { users, context };
}

function validateSummary(response: SummaryResponse): void {
  if (response.finish === 'max-tokens' || response.finish === 'length') throw new Error('Codex summary was truncated at its output limit');
  if (response.finish === 'error' || response.finish === 'aborted') throw new Error(`Codex summary ${response.finish}`);
  if (response.content.some(block => block.type !== 'text' && block.type !== 'reasoning')) throw new Error('Codex summary must contain text without tool calls or media');
  if (!response.text.trim()) throw new Error('Codex returned an empty context summary');
}

/** Create Codex's local pipeline; provider-native remote compaction requires a different host transport. */
export function createPipeline(config: ContextConfig = {}): ContextPipeline {
  async function prepare(host: ContextHost, entries: readonly ContextEntry[]): Promise<Checkpoint> {
    host.signal.throwIfAborted();
    const snapshot = await host.snapshot();
    const preparedAfterSeq = snapshot.archive.reduce((latest, entry) => Math.max(latest, entry.seq), -1);
    const selected = new Set(entries.map(entry => entry.seq));
    let requestEntries = snapshot.entries.filter(entry => protectedEntry(entry) || selected.has(entry.seq));
    const original = retainedState(host, entries);
    const contexts = new Map<string, RetainedContext>();
    for (const value of original.context) if (!contexts.has(value.key) || contexts.get(value.key)!.seq < value.seq) contexts.set(value.key, value);
    for (const entry of snapshot.archive) {
      const value = injectedContext(entry);
      if (value && contexts.has(value.key) && contexts.get(value.key)!.seq < value.seq) contexts.set(value.key, value);
    }
    for (const entry of snapshot.entries) {
      const value = injectedContext(entry);
      if (value && !selected.has(entry.seq) && value.seq >= (contexts.get(value.key)?.seq ?? Infinity)) contexts.delete(value.key);
    }
    const retained: RetainedState = {
      users: retainUserMessages(original.users, config.keepRecentTokens ?? 20_000),
      context: config.restoreContext === false ? [] : [...contexts.values()].sort((left, right) => left.seq - right.seq),
    };
    let retries = 0;
    let response: SummaryResponse;
    for (;;) {
      host.signal.throwIfAborted();
      try {
        response = await host.summarize({
          messages: requestEntries.map(entry => entry.message),
          instruction: summaryInstruction,
          maxTokens: config.maxSummaryTokens ?? snapshot.maxOutputTokens,
          includeTools: false,
          ...config.summarizationProvider === undefined ? {} : { provider: config.summarizationProvider },
          ...config.summarizationModel === undefined ? {} : { model: config.summarizationModel },
        });
        break;
      } catch (error) {
        host.signal.throwIfAborted();
        if (terminal(error)) throw error;
        if (contextOverflow(error)) {
          const smaller = dropOldest(requestEntries);
          if (!smaller) throw error;
          requestEntries = smaller;
          retries = 0;
          continue;
        }
        if (retries >= (config.maxSummaryAttempts ?? 6) - 1) throw error;
        const wait = Math.min(60_000, Math.floor((config.summaryRetryDelayMs ?? 200) * 2 ** retries++ * (0.9 + Math.random() * 0.2)));
        await delay(wait, undefined, { signal: host.signal });
      }
    }
    host.signal.throwIfAborted();
    validateSummary(response);
    const beforeSummary: ContentBlock[] = [];
    const context = retained.context.flatMap(value => value.content);
    retained.users.forEach((content, index) => {
      if (index === retained.users.length - 1) beforeSummary.push(...context);
      beforeSummary.push({ type: 'text', text: `[Retained user message ${index + 1}]` }, ...content);
    });
    if (!retained.users.length) beforeSummary.push(...context);
    const summary = `${summaryPrefix}\n${response.text}`;
    // Content correlation also covers explicit range compaction, whose host owns the later commit.
    host.record('codex/checkpoint', {
      fingerprint: fingerprint([...beforeSummary, { type: 'text', text: summary }]),
      preparedAfterSeq,
      users: retained.users.map(content => content.flatMap(block => block.type === 'text' ? [block.text] : [])),
      context: retained.context.map(value => ({ key: value.key, seq: value.seq, texts: value.content.flatMap(block => block.type === 'text' ? [block.text] : []) })),
    });
    return { summary, beforeSummary };
  }

  return {
    summarizeRange: prepare,
    async run(host, trigger) {
      host.signal.throwIfAborted();
      // Upstream recovers overflow within the compaction request, not arbitrary failed user turns.
      if (trigger === 'context-overflow' || trigger === 'request-too-large') return null;
      if (trigger === 'pressure' && config.auto === false) return null;
      const snapshot = await host.snapshot();
      const threshold = Math.max(0, Math.min(
        Math.floor(snapshot.contextWindow * Math.min(0.9, config.thresholdRatio ?? 0.9)),
        snapshot.contextWindow - (config.reserveTokens ?? 0),
      ));
      if (trigger === 'pressure' && (snapshot.contextWindow <= 0 || contextTokens(snapshot) < threshold)) return null;
      const selected = select(snapshot.entries);
      if (!selected) return null;
      return host.compact(selected, () => prepare(host, selected));
    },
  };
}
