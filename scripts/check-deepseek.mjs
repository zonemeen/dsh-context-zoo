/** Run bounded real DeepSeek summaries and factual recall through the DSH Loader. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { Context } from '@deepseek-ai/cordis';
import Loader, { EntryTree, Group } from '@deepseek-ai/cordis-plugin-loader';
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include';
import LlmRuntime, { BlockAssembler } from '@deepseek-ai/dsh-llm';
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key';
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import CommandRuntime from '@deepseek-ai/dsh-commands';
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence';
import { createProfilePatch } from './create-profile-patch.mjs';
import { assertToolPairs } from '../tests/helpers/context-harness.mjs';
import { seedQualityConversation, recallPrompt, scoreRecall } from '../tests/helpers/deepseek-quality-fixture.mjs';

const { values } = parseArgs({ options: { 'key-stdin': { type: 'boolean' }, 'skip-baseline': { type: 'boolean' }, model: { type: 'string', default: 'deepseek-flash' }, output: { type: 'string' }, agent: { type: 'string' }, 'max-summary-tokens': { type: 'string', default: '2048' } } });
const ids = ['claude-code', 'codex', 'opencode', 'pi', 'qwen-code', 'zcode', 'kimi-code', 'cline'];
if (values.agent && !ids.includes(values.agent)) throw new Error('Unknown context plugin id.');
const selectedIds = values.agent ? [values.agent] : ids;
const maxSummaryTokens = Number(values['max-summary-tokens']);
if (!Number.isSafeInteger(maxSummaryTokens) || maxSummaryTokens < 1 || maxSummaryTokens > 8192) throw new Error('max-summary-tokens must be an integer between 1 and 8192.');
const provider = 'deepseek-official';
const model = values.model;
const settings = { auto: false, keepRecentTokens: 256, maxSummaryTokens, maxSummaryAttempts: 1, maxOverflowRetries: 0 };
let key = process.env.DEEPSEEK_API_KEY;
if (values['key-stdin']) {
  if (process.stdin.isTTY && !process.env.CONTEXT_ZOO_STDIN_ECHO_DISABLED) throw new Error('Disable terminal echo before supplying a key over terminal stdin.');
  process.stdout.write('Credential input ready.\n');
  const input = createInterface({ input: process.stdin, terminal: false });
  for await (const line of input) { key = line.trim(); input.close(); break; }
  process.stdin.pause();
}
if (!key) throw new Error('Set DEEPSEEK_API_KEY in the test process or use --key-stdin.');
process.env.DEEPSEEK_API_KEY = key;
const home = await mkdtemp(join(tmpdir(), 'context-zoo-deepseek-home-'));
const output = values.output ? resolve(values.output) : await mkdtemp(join(tmpdir(), 'context-zoo-deepseek-results-'));
await mkdir(output, { recursive: true, mode: 0o700 });
process.env.DSH_HOME = home;
const originalFetch = globalThis.fetch;
const requests = [];
let phase = 'baseline';
const started = Date.now();
const report = { startedAt: new Date().toISOString(), provider, model, settings, limits: { httpRequests: 18, requestTimeoutMs: 90000 }, credentialStorage: 'Supplied via environment or stdin; the runner does not write credentials to reports, session records, or DSH profiles.', scope: 'Synthetic text-only history; manual compaction and post-replay recall. Not a full application launch, default-threshold or actual context-overflow test.', requests, results: [] };
const safeError = error => String(error instanceof Error ? error.message : error).replaceAll(key, '[REDACTED]');

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin !== 'https://api.deepseek.com') throw new Error('This test only permits the official DeepSeek origin.');
  if (requests.length >= report.limits.httpRequests) throw new Error('Real API test request budget exhausted.');
  if (typeof init.body === 'string' && init.body.includes(key)) throw new Error('A credential unexpectedly appeared in request content.');
  const request = { phase, path: url.pathname, startedAt: new Date().toISOString() };
  requests.push(request);
  const time = Date.now();
  try {
    const response = await originalFetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(report.limits.requestTimeoutMs), ...init.signal ? [init.signal] : []]) });
    request.status = response.status;
    return response;
  } finally { request.headersReceivedMs = Date.now() - time; }
};

class MemoryTree extends EntryTree { write() {} }
async function runtime(id) {
  const ctx = new Context();
  try {
    for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, TokenMeter, CommandRuntime]) await ctx.plugin(plugin);
    await ctx.plugin(DeepSeek, { baseURL: 'https://api.deepseek.com/anthropic', apiKeyEnv: 'DEEPSEEK_API_KEY', thinking: 'disabled', reasoningEffort: 'off', maxTokens: maxSummaryTokens, streamIdleTimeoutMs: 60000, retryPolicy: { mode: 'normal', maxRetries: 0 } });
    if (id) {
      await ctx.plugin(Loader, { baseUrl: new URL('../', import.meta.url).href });
      ctx.loader.builtins.group = Group;
      const native = [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      ];
      const entries = applyEntryPatches(native, createProfilePatch(native, id), message => { throw new Error(message); });
      entries.find(entry => entry.id === 'context-zoo').config[0].config = settings;
      await ctx.plugin({ inject: ['loader'], async apply(owner) {
        const tree = new MemoryTree(owner);
        owner.effect(() => () => tree.root.stop());
        await tree.root.update(entries);
        await tree.await();
        for (const entry of tree.entries()) if (!entry.disabled) await entry.fiber?.await();
        assert.equal([...tree.entries()].filter(entry => !entry.disabled && entry.options.name === `dsh-context-${id}`).length, 1);
      } });
      assert.equal(ctx.compaction.constructor.name, 'PipelineEngine');
      assert.equal(ctx.get('toolResultPruner'), undefined);
    }
    return ctx;
  } catch (error) { await ctx.fiber.dispose(); throw error; }
}

function seed(ctx, id) {
  const session = ctx.sessions.create(SessionId(`deepseek-quality-${id}`));
  seedQualityConversation(session, { provider, model, maxTokens: maxSummaryTokens });
  return session;
}

async function recall(ctx, session) {
  const assembler = new BlockAssembler();
  const time = Date.now();
  for await (const chunk of ctx.llm.stream({ provider, model, maxTokens: 1024, messages: [...session.deriveMessages(), { role: 'user', content: [{ type: 'text', text: recallPrompt }] }], sessionId: session.id, signal: AbortSignal.timeout(90000) })) assembler.push(chunk);
  assert.equal(assembler.finish.kind, 'stop', 'Recall response must finish without truncation or error.');
  const text = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('\n');
  return { text, usage: assembler.usage, elapsedMs: Date.now() - time, score: scoreRecall(text) };
}

try {
  if (!values['skip-baseline']) {
    const baselineContext = await runtime();
    try {
      const session = seed(baselineContext, 'baseline');
      report.sourceEstimatedTokens = baselineContext.tokenMeter.measure(session).totalTokens;
      report.baseline = await recall(baselineContext, session);
      process.stdout.write(`Baseline recall: ${report.baseline.score.passed}/${report.baseline.score.total}\n`);
    } finally { await baselineContext.fiber.dispose(); }
  }
  for (const id of selectedIds) {
    const result = { id };
    report.results.push(result);
    let ctx;
    try {
      ctx = await runtime(id);
      const session = seed(ctx, id);
      result.beforeEstimatedTokens = ctx.tokenMeter.measure(session).totalTokens;
      const originalMessages = session.deriveMessages();
      const beforeSystem = session.deriveMessages().filter(message => message.role === 'system' || message.role === 'developer');
      const agent = { ctx, session, options: { provider, model }, runMaintenance: task => task(new AbortController().signal) };
      phase = `${id}:summary`;
      const time = Date.now();
      const command = await ctx.commands.execute(agent, '/compact', [], AbortSignal.timeout(120000));
      result.compactionElapsedMs = Date.now() - time;
      result.commandResult = command?.result;
      const events = structuredClone(session.snapshotEvents());
      result.afterEstimatedTokens = ctx.tokenMeter.measure(session).totalTokens;
      result.historyUnchanged = JSON.stringify(session.deriveMessages()) === JSON.stringify(originalMessages);
      result.replaceGeneration = session.surface.replaceGeneration;
      if (command?.result.kind !== 'success') assert.equal(result.historyUnchanged, true, 'A failed summary must preserve the original history.');
      result.summaryCalls = events.filter(event => event.type === 'context-zoo/state' && event.data.kind === 'model-result').map(event => event.data.data);
      assert.equal(command?.result.kind, 'success', 'The selected /compact workflow must succeed.');
      assert.ok(session.surface.replaceGeneration > 0, 'Compaction must replace history.');
      assert.deepEqual(session.deriveMessages().filter(message => message.role === 'system' || message.role === 'developer'), beforeSystem);
      assertToolPairs(session.deriveMessages());
      validateStoredEvents(session.header, events);
      const restored = Session.create(session.id, events, session.header, session.inheritedEventCount, ctx.sessions.messageProjections);
      assert.deepEqual(restored.deriveMessages(), session.deriveMessages());
      result.afterEstimatedTokens = ctx.tokenMeter.measure(restored).totalTokens;
      result.reductionPercent = Number((100 * (1 - result.afterEstimatedTokens / result.beforeEstimatedTokens)).toFixed(1));
      result.checkpointText = restored.deriveMessages().filter(message => message.source.kind === 'compact-checkpoint').flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n');
      phase = `${id}:recall`;
      result.recall = await recall(ctx, restored);
      result.status = result.recall.score.passed === result.recall.score.total ? 'passed' : 'recall-loss';
      process.stdout.write(`${id}: ${result.beforeEstimatedTokens} -> ${result.afterEstimatedTokens} estimated tokens; recall ${result.recall.score.passed}/${result.recall.score.total}; ${result.status}\n`);
    } catch (error) {
      result.status = 'failed'; result.error = safeError(error);
      process.stdout.write(`${id}: failed (${result.error})\n`);
      if (requests.some(request => [401, 402, 403].includes(request.status))) break;
    } finally { await ctx?.fiber.dispose(); }
  }
} catch (error) { report.error = safeError(error); process.exitCode = 1; }
finally {
  report.elapsedMs = Date.now() - started;
  const usages = [report.baseline?.usage, ...report.results.flatMap(result => [...result.summaryCalls?.map(call => call.usage) ?? [], result.recall?.usage])].filter(Boolean);
  report.totalUsage = Object.fromEntries(['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'].map(field => [field, usages.reduce((sum, usage) => sum + (usage[field] ?? 0), 0)]));
  const json = JSON.stringify(report, null, 2) + '\n';
  if (json.includes(key)) throw new Error('Refusing to write a report containing credentials.');
  await writeFile(join(output, 'report.json'), json, { mode: 0o600 });
  process.stdout.write(`Report: ${join(output, 'report.json')}\n`);
  globalThis.fetch = originalFetch;
  delete process.env.DEEPSEEK_API_KEY;
  key = undefined;
  await rm(home, { recursive: true, force: true });
  if (values['key-stdin']) process.stdin.destroy();
  if (report.results.length !== selectedIds.length || report.results.some(result => result.status !== 'passed')) process.exitCode = 1;
}
