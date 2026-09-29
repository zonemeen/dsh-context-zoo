import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { agentIds, evaluationSettings, gradeFiles, runContinuation, TaskWorkspace } from '../scripts/lib/continuation-eval.mjs';
import { initialFiles, taskCases, phases } from '../scripts/lib/continuation-task.mjs';
import { getTask } from '../scripts/lib/continuation-tasks.mjs';
import { compactionOutcome } from '../scripts/lib/continuation-outcomes.mjs';
import { renderContinuationReport, writeContinuationArtifacts } from '../scripts/lib/continuation-report.mjs';
import { referenceFiles, extendedReferenceFiles } from './helpers/continuation-reference.mjs';

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'continuation-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('acceptance executes source, rejects stubs and catches regressions omitted by development examples', async () => {
  for (let phase = 1; phase <= 4; phase++) {
    const result = await gradeFiles(referenceFiles(phase), phase, true);
    assert.equal(result.passed, result.total, JSON.stringify(result));
  }
  const unfinished = await gradeFiles(initialFiles, 4, true);
  assert.ok(unfinished.passed < unfinished.total);
  for (const [path, from, to, failedCase] of [
    ['src/policy.mjs', '48 * 60', '24 * 60', 'retained-after-old-expiry'],
    ['src/policy.mjs', '[429,502,503,504]', '[429,500,502,503,504]', 'no-retry-on-500'],
    ['src/store.mjs', 'JSON.stringify([x.tenantId,x.key])', 'x.key', 'tenant-isolation'],
    ['src/store.mjs', 'input.now >= entry.expiresAt', 'input.now > entry.expiresAt', 'exact-expiry-and-reuse'],
    ['src/importer.mjs', "'Idempotency-Key'", "'X-Request-ID'", 'header-and-payload'],
    ['src/importer.mjs', 'response.status>=200 && response.status<300', 'response.status>=200', 'failed-response-not-cached'],
    ['src/importer.mjs', 'for(const request of requests) responses.push(await importInvoice(request,deps));', 'responses.push(...await Promise.all(requests.map(request=>importInvoice(request,deps))));', 'batch-sequential-and-replay'],
  ]) {
    const files = referenceFiles();
    assert.ok(files[path].includes(from));
    files[path] = files[path].replace(from, to);
    const result = await gradeFiles(files, 4, true);
    assert.equal(result.checks.find(check => check.name === failedCase).passed, false, `${failedCase}: ${JSON.stringify(result)}`);
  }
});

test('generated code cannot import host modules, access credentials, or run forever', async () => {
  for (const source of [
    "import fs from 'node:fs'; export const retentionMs=1; export const retryDelay=()=>null;",
    'export const retentionMs=process.env.DEEPSEEK_API_KEY; export const retryDelay=()=>null;',
    'export const retentionMs=1; export const retryDelay=()=>null; while(true) {}',
    'export const retentionMs=1; export const retryDelay=()=>null; await new Promise(()=>{});',
  ]) {
    const result = await gradeFiles({ ...referenceFiles(), 'src/policy.mjs': source }, 1, true, 1200);
    assert.equal(result.passed, 0);
  }
});

test('tools confine writes, retain failed operations, and expose only development checks', async t => {
  const workspace = new TaskWorkspace(await directory(t));
  await workspace.initialize();
  for (const path of ['../outside', '/etc/passwd', '.env.local', 'README.md']) {
    await assert.rejects(workspace.execute('write_file', { path, content: 'bad' }));
  }
  await assert.rejects(workspace.execute('read_file', { path: '../outside' }));
  await assert.rejects(workspace.execute('shell', { command: 'env' }));
  const result = JSON.parse(await workspace.execute('run_tests', {}));
  assert.deepEqual(result.checks.map(check => check.name), taskCases(1).map(check => check.name));
  assert.ok(result.total < taskCases(1, true).length);
  await rm(join(workspace.root, 'src/policy.mjs'));
  await symlink('/etc/passwd', join(workspace.root, 'src/policy.mjs'));
  await assert.rejects(workspace.execute('read_file', { path: 'src/policy.mjs' }));
  await assert.rejects(workspace.execute('write_file', { path: 'src/policy.mjs', content: 'bad' }));
});

class CodingAdapter extends LlmAdapter {
  constructor(mode = 'success') { super(); this.mode = mode; }
  async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 128_000 }, defaultMaxTokens: 4096 }; }
  async *stream(options) {
    let blocks;
    if (options.purpose === 'compaction') {
      if (this.mode === 'provider-error') throw new Error('Provider disconnected');
      blocks = [{ type: 'text', text: this.mode === 'empty-summary' ? ' ' : this.mode === 'oversize-summary' ? 'Long checkpoint. '.repeat(16000) : '<state_snapshot>Work on invoice import remains in progress. Keep the agreed retry, tenant isolation, header and cache requirements. Retention is 48 hours after stage 2. Source files are available in the project. Finish remaining stages and verify tests.</state_snapshot>' }];
    } else {
      const position = options.messages.findLastIndex(message => message.role === 'user' && message.content.some(block => block.type === 'text' && /^Stage \d+ of (4|10):/.test(block.text)));
      const prompt = options.messages[position].content.find(block => block.type === 'text').text;
      const phase = Number(/^Stage (\d+)/.exec(prompt)[1]);
      const extended = /^Stage \d+ of 10:/.test(prompt);
      const step = options.messages.slice(position + 1).filter(message => message.role === 'assistant').length;
      let calls;
      if (step === 0) calls = Object.keys(initialFiles).map(path => ['read_file', { path }]);
      else if (step === 1) {
        const files = extended ? extendedReferenceFiles(phase) : referenceFiles(phase);
        if (this.mode === 'wrong-header') files['src/importer.mjs'] = files['src/importer.mjs'].replace("'Idempotency-Key'", "'X-Request-ID'");
        const paths = phase === 1 ? ['src/policy.mjs'] : phase === 2 ? ['src/policy.mjs', 'src/store.mjs'] : [5,6].includes(phase) ? ['src/store.mjs'] : phase === 9 ? ['src/policy.mjs','src/importer.mjs'] : ['src/importer.mjs'];
        calls = paths.map(path => ['write_file', { path, content: files[path] }]);
      } else if (step === 2) calls = [['run_tests', {}]];
      blocks = calls ? calls.map(([name, args], index) => ({ type: 'tool-call', id: `call-${phase}-${step}-${index}`, name, arguments: JSON.stringify(args) })) : [{ type: 'text', text: 'Stage edits completed; development tests passed.' }];
      if (this.mode === 'claims-only') blocks = [{ type: 'text', text: 'Everything is implemented and all tests pass.' }];
      if (this.mode === 'loop') blocks = [{ type: 'tool-call', id: `loop-${phase}-${step}`, name: 'read_file', arguments: '{"path":"README.md"}' }];
    }
    for (const [index, block] of blocks.entries()) {
      yield { type: 'block-start', index, blockType: block.type };
      yield { type: 'block-end', index, block };
    }
    yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 120 } };
    yield { type: 'finish', reason: { kind: options.purpose === 'compaction' && this.mode === 'truncated-summary' ? 'max-tokens' : blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' } };
  }
}

test('claims alone cannot pass and a model loop stops at its request budget', async t => {
  for (const mode of ['claims-only', 'loop']) {
    const output = await directory(t);
    const result = await runContinuation({ id: 'baseline', output, maxSteps: 3, configureModel: ctx => ctx.llm.registerAdapter(['fixture'], new CodingAdapter(mode)) });
    assert.notEqual(result.status, 'passed');
    if (mode === 'loop') { assert.match(result.error, /budget exhausted/); assert.equal(result.calls.length, 3); }
    else { assert.equal(result.continuedAfterLastCompaction, false); assert.ok(result.acceptance.passed < result.acceptance.total); }
    assert.ok(JSON.parse(await readFile(join(output, 'session-final.json'), 'utf8')).events.length > 0);
  }
});

test('rejected summaries retain history, replay, and finish the task without earning compaction credit', async t => {
  for (const [mode, outcome] of [['empty-summary','summary-invalid'],['truncated-summary','summary-truncated'],['oversize-summary','skipped-no-benefit']]) {
    const output = await directory(t);
    const result = await runContinuation({ id: 'codex', output, minContextTokens: 0, configureModel: ctx => ctx.llm.registerAdapter(['fixture'], new CodingAdapter(mode)) });
    assert.equal(result.status, 'compaction-incomplete', JSON.stringify(result.compactions));
    assert.equal(result.taskStatus, 'passed');
    assert.equal(result.replayStatus, 'complete');
    assert.equal(result.continuedAfterThirdCompaction, false);
    assert.equal(result.compactions.length, 3);
    assert.ok(result.compactions.every(c => c.outcome === outcome && !c.committed && c.historyPreserved));
    assert.equal(result.phases.length, 10);
    const saved = JSON.parse(await readFile(join(output, 'session-final.json'), 'utf8'));
    assert.ok(saved.events.some(event => event.type === 'user/message' && event.data.source?.kind === 'user'));
    assert.ok(!saved.events.some(event => event.type === 'compaction/summary'));
  }
});

for (const id of ['baseline', ...agentIds]) test(`${id}: executable edits continue across three disk replays`, async t => {
  const output = await directory(t);
  const result = await runContinuation({ id, output, minContextTokens: 0, configureModel: ctx => ctx.llm.registerAdapter(['fixture'], new CodingAdapter()) });
  assert.equal(result.status, 'passed', JSON.stringify({ error: result.error, compactions: result.compactions, phases: result.phases }));
  assert.equal(result.compactions.length, id === 'baseline' ? 0 : 3);
  assert.equal(result.phases.filter(phase => phase.replayed).length, 3);
  assert.ok(result.phases.every(phase => phase.acceptance.passed === phase.acceptance.total));
  assert.equal(result.continuedAfterThirdCompaction, id !== 'baseline');
  assert.equal(result.taskStatus, 'passed');
  assert.equal(result.phases.length, 10);
  assert.ok(result.calls.some(call => call.purpose === 'task'));
  assert.ok(id === 'baseline' || result.calls.some(call => call.purpose === 'compaction'));
  const saved = JSON.parse(await readFile(join(output, 'session-final.json'), 'utf8'));
  assert.ok(saved.events.some(event => event.type === 'tool/result'));
  assert.equal(saved.events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'user').length, 10);
  assert.ok(!JSON.stringify(saved).includes('batch-stops-after-exception'), 'Acceptance case names must not leak into model history.');
  assert.ok(!JSON.stringify(saved).includes('refresh-conflict-still-blocked'), 'Extended acceptance must stay hidden.');
});

test('extended acceptance validates every stage and catches new feature regressions', async () => {
  for (let phase = 1; phase <= 10; phase++) {
    const result = await gradeFiles(extendedReferenceFiles(phase), phase, true, 5000, 'invoice-import-v2');
    assert.equal(result.passed, result.total, JSON.stringify(result));
  }
  for (const [path, from, to, failedCase] of [
    ['src/store.mjs', 'entries.delete(identity(input))', 'false', 'remove-example'],
    ['src/store.mjs', 'now>=entry.expiresAt', 'now>entry.expiresAt', 'prune-boundary-and-repeat'],
    ['src/importer.mjs', "prior.kind==='hit' && !request.forceRefresh", "prior.kind==='hit'", 'refresh-example'],
    ['src/importer.mjs', 'if(options.stopOnHttpFailure', 'if(false', 'batch-stop-example'],
    ['src/policy.mjs', 'retryAfterMs>=0', 'retryAfterMs>0', 'retry-hint-bounds-and-fallback'],
    ['src/importer.mjs', 'response.status,attempt,response.retryAfterMs', 'response.status,attempt', 'retry-hint-import-integration'],
    ['src/importer.mjs', 'options.signal?.aborted', 'false', 'batch-cancel-between-items'],
  ]) {
    const files = extendedReferenceFiles();
    assert.ok(files[path].includes(from));
    files[path] = files[path].replace(from,to);
    const result = await gradeFiles(files,10,true,5000,'invoice-import-v2');
    assert.equal(result.checks.find(c=>c.name===failedCase).passed,false,failedCase);
  }
});

test('short histories defer compaction, and provider failures stop safely with a specific reason', async t => {
  const skipped = await runContinuation({id:'codex',output:await directory(t),minContextTokens:128000,configureModel:ctx=>ctx.llm.registerAdapter(['fixture'],new CodingAdapter())});
  assert.equal(skipped.taskStatus,'passed');
  assert.equal(skipped.status,'compaction-incomplete');
  assert.ok(skipped.compactions.every(c=>c.outcome==='skipped-short-history'));
  assert.ok(!skipped.calls.some(c=>c.purpose==='compaction'));
  const failed = await runContinuation({id:'codex',output:await directory(t),minContextTokens:0,configureModel:ctx=>ctx.llm.registerAdapter(['fixture'],new CodingAdapter('provider-error'))});
  assert.equal(failed.status,'runtime-error');
  assert.equal(failed.taskStatus,'not-completed');
  assert.equal(failed.compactions[0].outcome,'provider-error');
  assert.equal(failed.phases.length,3);
});

test('budget modes keep fixed overrides separate from plugin defaults; short task remains available', async t => {
  assert.equal(evaluationSettings('cline','fixed').maxSummaryTokens,4096);
  assert.deepEqual(evaluationSettings('cline','plugin-defaults'),{auto:false});
  assert.equal(evaluationSettings('qwen-code','fixed').keepRecentTokens,0);
  const result = await runContinuation({id:'baseline',output:await directory(t),taskId:'invoice-import-v1',configureModel:ctx=>ctx.llm.registerAdapter(['fixture'],new CodingAdapter())});
  assert.equal(result.status,'passed');
  assert.equal(result.phases.length,phases.length);
  assert.equal(getTask().compactAfter.length,3);
});

test('no eligible history is a skip and a committed checkpoint with a persistence error is fatal', () => {
  const evidence = {committed:false,events:[],calls:[],surfaceChanged:false};
  assert.equal(compactionOutcome({...evidence,commandResult:{kind:'success',text:'No compactable history yet.'}}).outcome,'skipped-no-eligible-history');
  assert.equal(compactionOutcome({...evidence,committed:true,commandResult:{kind:'error',text:'Could not flush session'}}).outcome,'runtime-error');
  for (const reason of ['Claude summary did not contain usable continuation text','Kimi summary contained an unsupported response','Qwen summary needs a complete non-empty state_snapshot']) {
    const event={type:'compaction/end',data:{error:reason}};
    assert.equal(compactionOutcome({...evidence,events:[event],calls:[{finish:'stop'}]}).outcome,'summary-invalid');
    assert.equal(compactionOutcome({...evidence,events:[event],calls:[{finish:'error'}]}).outcome,'provider-error');
  }
});

for (const id of agentIds) test(`${id}: plugin defaults preserve continuation when recent-history retention skips a boundary`, async t => {
  const result = await runContinuation({id,output:await directory(t),budgetMode:'plugin-defaults',minContextTokens:0,configureModel:ctx=>ctx.llm.registerAdapter(['fixture'],new CodingAdapter())});
  assert.equal(result.taskStatus,'passed',JSON.stringify({error:result.error,compactions:result.compactions}));
  assert.equal(result.replayStatus,'complete');
  assert.deepEqual(result.settings,{auto:false});
  assert.ok(['passed','compaction-incomplete'].includes(result.status));
  assert.equal(result.compactions.length,3);
});

test('reports distinguish a correct task from incomplete compaction and preserve source evidence', async t => {
  const output = await directory(t);
  const result = await runContinuation({id:'cline',output:join(output,'1-fixed-cline'),minContextTokens:128000,configureModel:ctx=>ctx.llm.registerAdapter(['fixture'],new CodingAdapter())});
  const report = {task:'invoice-import-v2',model:'fixture',startedAt:'2026-09-29',phaseCount:10,boundaries:[3,6,9],budgetModes:['fixed'],limits:{fixedSummaryTokens:4096,summaryCeiling:8192,minContextTokens:128000},results:[{...result,repeat:1,artifactDirectory:'1-fixed-cline'}],requests:[],callsWithoutUsage:0,elapsedMs:1};
  const text = renderContinuationReport(report);
  assert.match(text,/43\/43 \| passed \| 0\/3 \| 3\/3 \| compaction-incomplete/);
  assert.match(text,/skipped-short-history/);
  await writeContinuationArtifacts(report,output);
  const saved=JSON.parse(await readFile(join(output,'final-sources.json'),'utf8'));
  assert.deepEqual(saved['1-fixed-cline'],extendedReferenceFiles());
  assert.match(await readFile(join(output,'report.zh-CN.md'),'utf8'),/压缩次数不足/);
});

test('code defects and replay initialization failures remain distinct from incomplete compaction', async t => {
  const incorrect = await runContinuation({id:'codex',output:await directory(t),minContextTokens:128000,configureModel:ctx=>ctx.llm.registerAdapter(['fixture'],new CodingAdapter('wrong-header'))});
  assert.equal(incorrect.status,'task-failed');
  assert.equal(incorrect.taskStatus,'failed');
  assert.equal(incorrect.compactionStatus,'incomplete');
  assert.equal(incorrect.replayStatus,'complete');
  assert.equal(incorrect.acceptance.checks.find(c=>c.name==='header-and-payload').passed,false);
  let boots=0;
  const interrupted = await runContinuation({id:'baseline',output:await directory(t),configureModel:ctx=>{
    if(++boots===2) throw new Error('Replay initialization failed');
    return ctx.llm.registerAdapter(['fixture'],new CodingAdapter());
  }});
  assert.equal(interrupted.status,'runtime-error');
  assert.equal(interrupted.taskStatus,'not-completed');
  assert.equal(interrupted.replayStatus,'incomplete');
  assert.match(interrupted.error,/Replay initialization failed/);
});
