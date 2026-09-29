/** Live coding continuation after three compactions, with an uncompressed baseline. */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key';
import { agentIds, defaultSettings, runContinuation } from './lib/continuation-eval.mjs';
import { getTask, taskIds } from './lib/continuation-tasks.mjs';
import { writeContinuationArtifacts } from './lib/continuation-report.mjs';

const { values } = parseArgs({ options: {
  help: { type: 'boolean' }, agent: { type: 'string', default: 'all' }, model: { type: 'string', default: 'deepseek-flash' },
  output: { type: 'string' }, repeats: { type: 'string', default: '1' }, 'skip-baseline': { type: 'boolean' },
  'max-steps': { type: 'string', default: '12' }, 'max-summary-tokens': { type: 'string' },
  task: { type: 'string', default: 'invoice-import-v2' }, 'budget-mode': { type: 'string', default: 'fixed' },
  'min-context-tokens': { type: 'string', default: '4096' }, 'summary-ceiling': { type: 'string', default: '8192' },
  'max-http-requests': { type: 'string' },
} });
if (values.help) {
  process.stdout.write(`Usage: node --env-file=.env.local scripts/check-deepseek-continuation.mjs [options]
  --agent all|${agentIds.join('|')} (default all)
  --task ${taskIds.join('|')} (default invoice-import-v2)
  --budget-mode fixed|plugin-defaults|both (default fixed)
  --repeats 1..5                 Independent fresh projects per strategy (default 1)
  --skip-baseline                Omit the uncompressed run
  --max-steps 3..30              Model requests per development stage (default 12)
  --max-summary-tokens 256..8192 Fixed-mode summary cap (default 4096)
  --summary-ceiling 4096..32768  Model route output ceiling (default 8192)
  --min-context-tokens 0..128000 Minimum context at a boundary (default 4096)
  --max-http-requests 1..2000    Global HTTP budget; otherwise derived from run count
  --model deepseek-flash
  --output /new/result/directory

Executes model-written JavaScript with restricted imports and a permission-limited
test subprocess. Makes real API requests. The default task has ten development
stages and three compaction boundaries, followed by disk replay even after a
protective skip or rejected summary. A pass still requires three committed summaries.
`);
} else {
  const integer = (name, min, max) => {
    const value = Number(values[name]);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
    return value;
  };
  if (values.agent !== 'all' && !agentIds.includes(values.agent)) throw new Error('Unknown context plugin id.');
  const repeats = integer('repeats', 1, 5), maxSteps = integer('max-steps', 3, 30);
  const task = getTask(values.task);
  if (!['fixed', 'plugin-defaults', 'both'].includes(values['budget-mode'])) throw new Error('Unknown budget mode.');
  if (values['budget-mode'] === 'plugin-defaults' && values['max-summary-tokens'] !== undefined) throw new Error('max-summary-tokens applies only to fixed mode.');
  const maxSummaryTokens = values['max-summary-tokens'] === undefined ? defaultSettings.maxSummaryTokens : integer('max-summary-tokens', 256, 8192);
  const summaryCeiling = integer('summary-ceiling', 4096, 32768), minContextTokens = integer('min-context-tokens', 0, 128000);
  if (values['budget-mode'] !== 'plugin-defaults' && summaryCeiling < maxSummaryTokens) throw new Error('summary-ceiling must cover max-summary-tokens.');
  const budgetModes = values['budget-mode'] === 'both' ? ['fixed', 'plugin-defaults'] : [values['budget-mode']];
  const selected = values.agent === 'all' ? agentIds : [values.agent];
  const trials = [...values['skip-baseline'] ? [] : [{ id: 'baseline', budgetMode: budgetModes[0] }], ...budgetModes.flatMap(budgetMode => selected.map(id => ({ id, budgetMode })))];
  const httpLimit = values['max-http-requests'] === undefined ? Math.min(2000, trials.length * repeats * (task.phases.length * maxSteps + 30)) : integer('max-http-requests', 1, 2000);
  let key = process.env.DEEPSEEK_API_KEY?.trim();
  if (!key) throw new Error('Set DEEPSEEK_API_KEY in the environment.');
  process.env.DEEPSEEK_API_KEY = key;
  const output = values.output ? resolve(values.output) : await mkdtemp(join(tmpdir(), 'context-zoo-continuation-'));
  if (values.output) { await mkdir(dirname(output), { recursive: true }); await mkdir(output, { mode: 0o700 }); }
  const home = await mkdtemp(join(tmpdir(), 'context-zoo-continuation-home-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const report = {
    schemaVersion: 2, task: task.taskId, startedAt: new Date().toISOString(), provider: 'deepseek-official', model: values.model,
    budgetModes, boundaries: task.compactAfter, phaseCount: task.phases.length, selection: { agents: selected, repeats, skipBaseline: !!values['skip-baseline'] },
    limits: { httpRequests: httpLimit, maxStepsPerPhase: maxSteps, requestTimeoutMs: 90_000, fixedSummaryTokens: maxSummaryTokens, summaryCeiling, minContextTokens },
    scope: 'Executable isolated coding fixture with three manual compaction boundaries and disk replay. Fixed and plugin-default settings are reported separately under a shared model output ceiling. Skipped/rejected summaries permit task continuation without earning compaction credit. Small source project, not an external repository benchmark, automatic-policy or actual-overflow test. Acceptance results never enter model history.',
    requests: [], results: [],
  };
  const redact = text => String(text).replaceAll(key, '[REDACTED]');
  const save = () => writeFile(join(output, 'report.json'), redact(JSON.stringify(report, null, 2)) + '\n', { mode: 0o600 });
  const originalFetch = globalThis.fetch;
  let active;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== 'https://api.deepseek.com') throw new Error('Only the official DeepSeek API origin is allowed.');
    if (report.requests.length >= httpLimit) throw new Error('HTTP request budget exhausted.');
    if (typeof init.body === 'string' && init.body.includes(key)) throw new Error('Credential found in request content.');
    const request = { ...active, path: url.pathname, startedAt: new Date().toISOString() };
    report.requests.push(request);
    const start = Date.now();
    try {
      const response = await originalFetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(90_000), ...init.signal ? [init.signal] : []]) });
      request.status = response.status;
      return response;
    } catch (error) { request.error = redact(error.message); throw error; }
    finally { request.headersReceivedMs = Date.now() - start; }
  };
  const started = Date.now();
  try {
    outer: for (let repeat = 1; repeat <= repeats; repeat++) for (const { id, budgetMode } of trials) {
      active = { id, repeat, budgetMode };
      const artifactDirectory = `${repeat}-${id === 'baseline' ? id : `${budgetMode}-${id}`}`;
      const directory = join(output, artifactDirectory);
      const settings = budgetMode === 'fixed' ? { maxSummaryTokens } : {};
      const result = await runContinuation({ id, output: directory, provider: 'deepseek-official', model: values.model, settings, budgetMode, taskId: task.taskId, minContextTokens, summaryCeiling, maxSteps,
        configureModel: ctx => ctx.plugin(DeepSeek, { baseURL: 'https://api.deepseek.com/anthropic', apiKeyEnv: 'DEEPSEEK_API_KEY', thinking: 'disabled', reasoningEffort: 'off', maxTokens: summaryCeiling, streamIdleTimeoutMs: 60_000, retryPolicy: { mode: 'normal', maxRetries: 0 } }),
        onProgress: message => process.stdout.write(`[${budgetMode}] ${redact(message)}\n`),
      });
      report.results.push({ repeat, artifactDirectory, ...result });
      await save();
      process.stdout.write(`[${budgetMode}] ${id}: ${result.status}; task ${result.taskStatus}; compactions ${result.successfulCompactions}/${result.requiredCompactions}; replay ${result.replayStatus}${result.error ? ` (${redact(result.error)})` : ''}\n`);
      if (report.requests.some(request => [401, 402, 403].includes(request.status)) || report.requests.length >= httpLimit) break outer;
    }
  } catch (error) { report.error = redact(error.message); process.exitCode = 1; }
  finally {
    report.elapsedMs = Date.now() - started;
    report.totalUsage = Object.fromEntries(['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'].map(field => [field, report.results.reduce((sum, result) => sum + result.totalUsage[field], 0)]));
    report.callsWithoutUsage = report.results.reduce((sum, result) => sum + result.callsWithoutUsage, 0);
    report.comparisons = budgetModes.flatMap(budgetMode => selected.map(id => {
      const runs = report.results.filter(result => result.id === id && result.budgetMode === budgetMode);
      const outcomes = runs.flatMap(result => result.compactions.map(item => item.outcome));
      return { id, budgetMode, completedRuns: runs.length, passedRuns: runs.filter(result => result.status === 'passed').length, taskPassedRuns: runs.filter(result => result.taskStatus === 'passed').length,
        compactionOutcomes: Object.fromEntries([...new Set(outcomes)].map(outcome => [outcome, outcomes.filter(value => value === outcome).length])),
        pairedBaseline: runs.map(result => ({ repeat: result.repeat, baselineStatus: report.results.find(base => base.id === 'baseline' && base.repeat === result.repeat)?.status ?? 'not-run', strategyStatus: result.status })) };
    }));
    await save();
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
    await writeContinuationArtifacts(JSON.parse(redact(JSON.stringify(report))), output);
    process.stdout.write(`Report: ${join(output, 'report.json')}\n`);
    if (report.results.length !== trials.length * repeats || report.results.some(result => result.status !== 'passed')) process.exitCode = 1;
    delete process.env.DEEPSEEK_API_KEY;
    key = undefined;
  }
}
