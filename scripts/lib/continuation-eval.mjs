/** Bounded file tools, executable acceptance checks, and repeated DSH compaction. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Context } from '@deepseek-ai/cordis';
import Loader, { EntryTree, Group } from '@deepseek-ai/cordis-plugin-loader';
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include';
import LlmRuntime, { AssistantStreamAccumulator, BlockAssembler, createSystemMessage, createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import CommandRuntime from '@deepseek-ai/dsh-commands';
import { FileSystem } from '@deepseek-ai/dsh-fs';
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence';
import { createProfilePatch } from '../create-profile-patch.mjs';
import { editablePaths } from './continuation-task.mjs';
import { getTask } from './continuation-tasks.mjs';
import { compactionOutcome, scoreContinuation } from './continuation-outcomes.mjs';

export const agentIds = ['claude-code', 'codex', 'opencode', 'pi', 'qwen-code', 'zcode', 'kimi-code', 'cline'];
export const defaultSettings = { auto: false, maxSummaryTokens: 4096, maxSummaryAttempts: 1, maxOverflowRetries: 0 };
export function evaluationSettings(id, budgetMode = 'fixed', overrides = {}) {
  assert.ok(['fixed', 'plugin-defaults'].includes(budgetMode), 'Unknown budget mode.');
  return budgetMode === 'fixed'
    ? { keepRecentTokens: ['claude-code', 'qwen-code'].includes(id) ? 0 : 256, ...defaultSettings, ...overrides, auto: false }
    : { ...overrides, auto: false };
}
export const tools = [
  { name: 'read_file', description: 'Read README.md or one of the three project source files.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { name: 'write_file', description: 'Replace one project source file with complete JavaScript module content.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } },
  { name: 'run_tests', description: 'Execute the development tests available at the current stage against the current source files.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
];
const hash = value => createHash('sha256').update(value).digest('hex');
const worker = fileURLToPath(new URL('./continuation-worker.mjs', import.meta.url));
const taskModules = ['continuation-task.mjs', 'continuation-task-v2.mjs', 'continuation-tasks.mjs'].map(name => fileURLToPath(new URL(name, import.meta.url)));

export async function gradeFiles(files, phase, acceptance = false, timeoutMs = 5000, taskId = 'invoice-import-v1') {
  const expected = getTask(taskId).taskCases(phase, acceptance).map(test => test.name);
  return new Promise((resolveResult, reject) => {
    // Credentials and parent environment are never inherited by generated code.
    const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${worker}`, ...taskModules.map(path => `--allow-fs-read=${path}`), '--experimental-vm-modules', '--disable-proto=throw', '--max-old-space-size=96', worker], {
      env: { TZ: 'UTC', NODE_NO_WARNINGS: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', errors = '', killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 100_000) { killed = true; child.kill('SIGKILL'); } });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(0, 2000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      let checks;
      try {
        if (killed || code !== 0) throw new Error(killed ? 'Execution limit exceeded.' : `Worker failed (${code}): ${errors}`);
        checks = JSON.parse(output).checks;
        assert.deepEqual(checks.map(test => test.name), expected);
        assert.ok(checks.every(test => typeof test.passed === 'boolean'));
      } catch (error) { checks = expected.map(name => ({ name, passed: false, error: String(error.message).slice(0, 500) })); }
      resolveResult({ passed: checks.filter(test => test.passed).length, total: checks.length, checks });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ files, phase, acceptance, taskId }));
  });
}

export class TaskWorkspace {
  constructor(root, task = getTask('invoice-import-v1')) { this.root = resolve(root); this.operations = []; this.phase = 1; this.task = task; }
  async initialize() {
    await mkdir(join(this.root, 'src'), { recursive: true, mode: 0o700 });
    for (const [path, content] of Object.entries(this.task.initialFiles)) await writeFile(join(this.root, path), content, { flag: 'wx', mode: 0o600 });
  }
  path(value, write = false) {
    if (typeof value !== 'string') throw new Error('A project file path is required.');
    const path = relative(this.root, resolve(this.root, value));
    if (!(write ? editablePaths : Object.keys(this.task.initialFiles)).includes(path)) throw new Error('Path is outside the allowed project files.');
    return path;
  }
  async regularPath(value, write = false) {
    const path = this.path(value, write);
    const file = join(this.root, path);
    if (!(await lstat(file)).isFile() || relative(await realpath(this.root), await realpath(file)) !== path) throw new Error('Expected a regular file inside the project.');
    return path;
  }
  async read(value, source = 'tool') {
    const path = await this.regularPath(value);
    const content = await readFile(join(this.root, path), 'utf8');
    this.operations.push({ phase: this.phase, kind: 'read', source, path, bytes: Buffer.byteLength(content), hash: hash(content) });
    return content;
  }
  async files() { return Object.fromEntries(await Promise.all(editablePaths.map(async path => [path, await readFile(join(this.root, await this.regularPath(path)), 'utf8')]))); }
  async execute(name, args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
    if (name === 'read_file') return this.read(args.path);
    if (name === 'write_file') {
      const path = await this.regularPath(args.path, true);
      if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > 64_000) throw new Error('Source content must be a string of at most 64,000 bytes.');
      const before = await readFile(join(this.root, path), 'utf8');
      await writeFile(join(this.root, path), args.content, { mode: 0o600 });
      this.operations.push({ phase: this.phase, kind: 'write', path, changed: before !== args.content, bytes: Buffer.byteLength(args.content), hash: hash(args.content) });
      return `Wrote ${path} (${Buffer.byteLength(args.content)} bytes).`;
    }
    if (name === 'run_tests') {
      const result = await gradeFiles(await this.files(), this.phase, false, 5000, this.task.taskId);
      this.operations.push({ phase: this.phase, kind: 'test', passed: result.passed, total: result.total });
      return JSON.stringify(result);
    }
    throw new Error('Unknown project tool.');
  }
}

class MemoryTree extends EntryTree { write() {} }
export async function createEvaluationRuntime({ id, workspace, provider, model, configureModel, settings, calls }) {
  const ctx = new Context();
  try {
    for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, TokenMeter, CommandRuntime]) await ctx.plugin(plugin);
    class ProjectFiles extends FileSystem {
      async resolve(path) { return { targetKey: workspace.path(path), path: workspace.path(path) }; }
      async *streamText(target) { yield await workspace.read(target.path, 'restore'); }
    }
    await ctx.plugin(ProjectFiles);
    await configureModel(ctx);
    ctx.on('llm/stream', async function* (options, next) {
      const call = { phase: workspace.phase, purpose: options.purpose ?? 'task', maxTokens: options.maxTokens, startedAt: new Date().toISOString() };
      calls.push(call);
      const started = Date.now();
      try {
        for await (const chunk of next()) {
          if (chunk.type === 'usage') call.usage = chunk.usage;
          if (chunk.type === 'finish') {
            call.finish = chunk.reason.kind;
            if (chunk.reason.failure) call.failure = chunk.reason.failure;
          }
          yield chunk;
        }
      } catch (error) { call.error = String(error.message); throw error; }
      finally { call.elapsedMs = Date.now() - started; }
    });
    if (id !== 'baseline') {
      assert.ok(agentIds.includes(id), 'Unknown plugin.');
      await ctx.plugin(Loader, { baseUrl: new URL('../../', import.meta.url).href });
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

export function assertBalanced(messages) {
  const pending = new Set();
  for (const message of messages) {
    for (const block of message.content) if (block.type === 'tool-call') { assert.ok(!pending.has(block.id)); pending.add(block.id); }
    if (message.role === 'tool') { assert.ok(pending.has(message.toolCallId), 'Orphan tool result.'); pending.delete(message.toolCallId); }
  }
  assert.equal(pending.size, 0, 'Unfinished tool call at a phase boundary.');
}

export async function runContinuation({ id, output, provider = 'fixture', model = 'fixture', configureModel, settings = {}, budgetMode = 'fixed', taskId = 'invoice-import-v2', minContextTokens = 4096, maxSteps = 12, maxTaskTokens = 4096, summaryCeiling = 8192, timeoutMs = 90_000, onProgress = () => {} }) {
  const started = Date.now();
  const task = getTask(taskId);
  const { phases, systemPrompt } = task;
  settings = evaluationSettings(id, budgetMode, settings);
  assert.ok(summaryCeiling >= (settings.maxSummaryTokens ?? 0), 'Summary ceiling must cover the configured summary budget.');
  const workspace = new TaskWorkspace(join(output, 'project'), task);
  await workspace.initialize();
  const result = { id, task: taskId, budgetMode, settings, limits: { minContextTokens, maxTaskTokens, summaryCeiling, maxSteps }, boundaries: task.compactAfter, status: 'running', phases: [], compactions: [], calls: [], operations: workspace.operations };
  let ctx, session;
  const boot = () => createEvaluationRuntime({ id, workspace, provider, model, configureModel, settings, calls: result.calls });
  try {
    ctx = await boot();
    session = ctx.sessions.create(SessionId(`continuation-${id}`), { meta: { cwd: workspace.root } });
    for (let index = 0; index < phases.length; index++) {
      const turn = index + 1;
      workspace.phase = turn;
      const progress = { id: phases[index].id, modelSteps: 0, toolCalls: 0, toolErrors: 0 };
      result.phases.push(progress);
      onProgress(`${id}: stage ${turn}/${phases.length}`);
      session.append('turn/start', { turn });
      if (index === 0) {
        session.append('system/message', { turn, step: 1, message: createSystemMessage(systemPrompt) }, { surfaceOp: 'append' });
        // The route advertises the summary ceiling; each task call still has
        // its independent maxTaskTokens limit. Record actual call caps above.
        session.append('request/header', { header: { config: { provider, model, maxTokens: summaryCeiling }, tools }, reason: 'initial' });
      }
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: phases[index].prompt }], source: { kind: 'user' } }), { surfaceOp: 'append' });
      let finished = false;
      for (let step = 1; step <= maxSteps; step++) {
        progress.modelSteps++;
        session.append('step/start', { turn, step });
        const assembler = new BlockAssembler(), stream = new AssistantStreamAccumulator();
        for await (const chunk of ctx.llm.stream({ provider, model, maxTokens: maxTaskTokens, tools, messages: session.deriveMessages(), toolHistory: session.toolHistory(), sessionId: session.id, signal: AbortSignal.timeout(timeoutMs) })) {
          assembler.push(chunk); stream.push({ time: Date.now(), chunk });
        }
        assert.ok(['stop', 'tool-calls'].includes(assembler.finish.kind), `Task response did not finish: ${assembler.finish.kind}${assembler.finish.failure ? ` (${assembler.finish.failure.message})` : ''}`);
        const message = assembler.message({ provider, model });
        session.append('assistant/message', { turn, step, stream: stream.snapshot(), message, ...assembler.usage ? { usage: assembler.usage } : {} }, { surfaceOp: 'append' });
        const calls = message.content.filter(block => block.type === 'tool-call');
        assert.ok(calls.length <= 8, 'Too many tools in a single model response.');
        for (const call of calls) {
          progress.toolCalls++;
          session.append('tool/call', { turn, step, callId: call.id, name: call.name, arguments: call.arguments });
          let content, isError = false;
          try { content = await workspace.execute(call.name, JSON.parse(call.arguments)); }
          catch (error) { isError = true; progress.toolErrors++; content = String(error.message); workspace.operations.push({ phase: turn, kind: 'tool-error', name: call.name, error: content }); }
          session.append('tool/result', { turn, step, message: createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: content }], isError }) }, { surfaceOp: 'append' });
        }
        session.append('step/end', { turn, step });
        if (!calls.length) {
          progress.finalText = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
          finished = true; break;
        }
      }
      assert.ok(finished, 'Stage model-step budget exhausted.');
      session.append('turn/end', { turn, reason: { kind: 'completed' } });
      assertBalanced(session.deriveMessages());
      const operations = workspace.operations.filter(op => op.phase === turn);
      const lastWrite = operations.findLastIndex(op => op.kind === 'write');
      progress.changedFiles = [...new Set(operations.filter(op => op.kind === 'write' && op.changed).map(op => op.path))];
      progress.testsAfterLastWrite = operations.some((op, i) => i > lastWrite && op.kind === 'test');
      // Acceptance feedback stays outside the conversation, including later stages.
      progress.acceptance = await gradeFiles(await workspace.files(), turn, true, 5000, taskId);
      await writeFile(join(output, `stage-${turn}-source.json`), JSON.stringify(await workspace.files(), null, 2), { mode: 0o600 });
      onProgress(`${id}: stage ${turn} acceptance ${progress.acceptance.passed}/${progress.acceptance.total}`);
      if (task.compactAfter.includes(turn)) {
        if (id !== 'baseline') {
          const compact = { afterPhase: turn, beforeEstimatedTokens: ctx.tokenMeter.measure(session).totalTokens };
          result.compactions.push(compact);
          const generation = session.surface.replaceGeneration;
          const eventCount = session.snapshotEvents().length;
          const callCount = result.calls.length;
          const visibleBefore = session.deriveMessages();
          const protectedBefore = visibleBefore.filter(message => ['system', 'developer'].includes(message.role));
          const begin = Date.now();
          let command, thrown;
          if (compact.beforeEstimatedTokens < minContextTokens) {
            compact.outcome = 'skipped-short-history';
            compact.reason = `Estimated context ${compact.beforeEstimatedTokens} is below minimum ${minContextTokens}.`;
          } else {
            const agent = { ctx, session, options: { provider, model }, runMaintenance: task => task(AbortSignal.timeout(timeoutMs)) };
            try { command = await ctx.commands.execute(agent, '/compact', [], AbortSignal.timeout(timeoutMs)); }
            catch (error) { thrown = error; }
          }
          compact.elapsedMs = Date.now() - begin;
          compact.commandResult = command?.result;
          const events = session.snapshotEvents().slice(eventCount);
          const summaries = events.filter(event => event.type === 'compaction/summary');
          compact.surfaceChanged = session.surface.replaceGeneration > generation;
          compact.committed = compact.surfaceChanged && summaries.length === 1;
          if (compact.committed) compact.summarySeq = summaries.at(-1).seq;
          compact.afterEstimatedTokens = ctx.tokenMeter.measure(session).totalTokens;
          compact.historyPreserved = JSON.stringify(session.deriveMessages()) === JSON.stringify(visibleBefore);
          if (!compact.outcome) Object.assign(compact, compactionOutcome({ ...compact, events, calls: result.calls.slice(callCount), thrown }));
          assert.deepEqual(session.deriveMessages().filter(message => ['system', 'developer'].includes(message.role)), protectedBefore);
          assertBalanced(session.deriveMessages());
          assert.ok(summaries.length <= 1, 'Unexpected checkpoint count at compaction boundary.');
          onProgress(`${id}: compaction after stage ${turn}: ${compact.outcome}`);
          if (['provider-error', 'runtime-error'].includes(compact.outcome)) throw new Error(`${compact.outcome}: ${compact.reason}`);
        }
        const saved = { header: session.header, events: structuredClone(session.snapshotEvents()), inheritedEventCount: session.inheritedEventCount };
        validateStoredEvents(saved.header, saved.events);
        const path = join(output, `session-after-${turn}.json`);
        await writeFile(path, JSON.stringify(saved), { mode: 0o600 });
        const before = session.deriveMessages();
        await ctx.fiber.dispose(); ctx = undefined;
        ctx = await boot();
        const restored = JSON.parse(await readFile(path, 'utf8'));
        validateStoredEvents(restored.header, restored.events);
        session = Session.create(SessionId(restored.header.id), restored.events, restored.header, restored.inheritedEventCount, ctx.sessions.messageProjections);
        ctx.effect(() => ctx.sessions.enter(session));
        ctx.sessions.announce(session);
        assert.deepEqual(session.deriveMessages(), before);
        assertBalanced(session.deriveMessages());
        progress.replayed = true;
      }
    }
  } catch (error) { result.error = String(error.message); }
  finally {
    scoreContinuation(result, task);
    if (session) {
      await writeFile(join(output, 'session-final.json'), JSON.stringify({ header: session.header, events: session.snapshotEvents(), inheritedEventCount: session.inheritedEventCount }), { mode: 0o600 });
    }
    await ctx?.fiber.dispose();
    result.elapsedMs = Date.now() - started;
    result.finalFiles = Object.fromEntries(Object.entries(await workspace.files()).map(([path, content]) => [path, { bytes: Buffer.byteLength(content), sha256: hash(content) }]));
    result.totalUsage = Object.fromEntries(['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'].map(field => [field, result.calls.reduce((sum, call) => sum + (call.usage?.[field] ?? 0), 0)]));
    result.callsWithoutUsage = result.calls.filter(call => !call.usage).length;
    result.repeatedReads = workspace.operations.filter((op, i, all) => op.kind === 'read' && all.slice(0, i).some(prior => prior.kind === 'read' && prior.path === op.path && prior.hash === op.hash)).length;
  }
  return result;
}
