import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const names = { baseline: 'Baseline', 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi', 'qwen-code': 'Qwen Code', zcode: 'ZCode', 'kimi-code': 'Kimi Code', cline: 'Cline' };
const cell = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
const table = (headers, rows) => `| ${headers.join(' | ')} |\n| ${headers.map(()=>'---').join(' | ')} |\n${rows.map(row=>`| ${row.map(cell).join(' | ')} |`).join('\n')}`;
export function renderContinuationReport(report, language = 'en') {
  const zh = language === 'zh';
  const t = (en, cn) => zh ? cn : en;
  const status = value => zh ? ({passed:'通过',failed:'失败','not-completed':'未完成','task-failed':'任务失败','runtime-error':'运行异常','compaction-incomplete':'压缩次数不足'}[value] ?? value) : value;
  const score = result => result.acceptance ? `${result.acceptance.passed}/${result.acceptance.total}` : '—';
  const sections = [t('# Coding continuation evaluation', '# 编码续接评测'),
    `Task: \`${report.task}\`; model: \`${report.model}\`; started: ${report.startedAt}.`,
    t('All eight plugins use the same task and scoring. One baseline is shared across budget modes in each repetition. Results below retain every attempted trial.', '八个插件使用相同任务和评分。每轮的不同预算模式共享一个基线，以下保留每次实际运行的结果。'),
    t(`Development stages: ${report.phaseCount}; compaction boundaries: ${report.boundaries.join(', ')}. A complete pass requires correct final code, edits and development tests in every stage, three committed summaries, three disk replays, and a further source change after the third summary.`, `开发阶段：${report.phaseCount}；压缩边界：阶段 ${report.boundaries.join('、')} 后。完整通过需要最终代码验收通过、每阶段修改代码并运行开发测试、提交三次摘要、完成三次磁盘重载，并在第三次摘要后继续修改代码。`),
    t('A protected skip or rejected summary permits continued work, but earns no compaction credit. “—” means the final stage was not reached. Each mode uses a fresh project; the baseline is repeated in each table for comparison.', '保护性跳过或摘要被拒绝后继续任务，但不计作成功压缩。“—”表示未进入最终阶段。每个模式使用新项目，基线在各表中重复展示以便比较。')];
  for (const mode of report.budgetModes) {
    const runs = report.results.filter(r=>r.id==='baseline' || r.budgetMode===mode);
    sections.push(`## ${mode}`,table(t(['Plugin / repeat','Task acceptance','Task status','Summaries','Replays','Complete protocol'],['插件 / 轮次','任务验收','任务状态','成功摘要','磁盘重载','完整协议']), runs.map(r=>[`${names[r.id]} / ${r.repeat}`,score(r),status(r.taskStatus),`${r.successfulCompactions}/${r.requiredCompactions}`,`${r.phases.filter(p=>p.replayed).length}/${report.boundaries.length}`,status(r.status)])));
  }
  sections.push(t('## Skips and errors','## 跳过与异常'));
  const issues = report.results.flatMap(r=>r.compactions.filter(c=>c.outcome!=='committed').map(c=>[`${r.budgetMode} / ${names[r.id]} / ${r.repeat}`,c.afterPhase,c.outcome,c.reason]));
  sections.push(issues.length ? table(t(['Mode / plugin / repeat','After stage','Outcome','Reason'],['模式 / 插件 / 轮次','阶段后','分类','原因']),issues) : t('All attempted compactions committed successfully.','所有尝试的压缩均成功提交。'));
  for (const r of report.results.filter(r=>r.error || r.taskStatus==='failed')) {
    sections.push(`- ${r.budgetMode} / ${names[r.id]} / ${r.repeat}: ${cell(r.error ?? r.acceptance?.checks.filter(c=>!c.passed).map(c=>c.name).join(', ') ?? r.taskStatus)}`);
  }
  sections.push(t('## Usage','## 用量'),table(t(['Mode / plugin / repeat','Task calls','Summary calls','Summary request caps','Input','Cached input','Output','Repeated reads','Time (s)'],['模式 / 插件 / 轮次','任务调用','摘要调用','摘要请求上限','输入','缓存输入','输出','重复读取','耗时（秒）']), report.results.map(r=>[`${r.id==='baseline'?'shared':r.budgetMode} / ${names[r.id]} / ${r.repeat}`,r.calls.filter(c=>c.purpose==='task').length,r.calls.filter(c=>c.purpose==='compaction').length,[...new Set(r.calls.filter(c=>c.purpose==='compaction').map(c=>c.maxTokens))].join(', ')||'—',r.totalUsage.inputTokens,r.totalUsage.cacheReadTokens,r.totalUsage.outputTokens,r.repeatedReads,(r.elapsedMs/1000).toFixed(3)])));
  const responses = Object.fromEntries([...new Set(report.requests.map(r=>r.status??'error'))].map(code=>[code,report.requests.filter(r=>(r.status??'error')===code).length]));
  sections.push(t(`HTTP requests: ${report.requests.length}; responses: ${JSON.stringify(responses)}. Calls without reported usage: ${report.callsWithoutUsage}. Elapsed: ${(report.elapsedMs/1000).toFixed(3)} s. Input is uncached input; summaries and repeated reads are included.`, `HTTP 请求：${report.requests.length}；响应：${JSON.stringify(responses)}。缺失用量的调用数：${report.callsWithoutUsage}。总耗时：${(report.elapsedMs/1000).toFixed(3)} 秒。输入列为未缓存输入；统计包含摘要和重复读取。`));
  sections.push(t('## Configuration and evidence','## 配置与证据'),
    t(`Fixed summary cap: ${report.limits.fixedSummaryTokens}; model route ceiling: ${report.limits.summaryCeiling}; task call cap: 4096; minimum estimated context at a boundary: ${report.limits.minContextTokens}. Fixed mode uses one summary attempt and a 256-token recent tail (0 for Claude/Qwen). Plugin-default mode passes only auto:false and uses the plugin's default retention and retry behavior within the shared model route ceiling. Actual settings and request caps are recorded for every trial.`, `固定摘要上限：${report.limits.fixedSummaryTokens}；模型路由上限：${report.limits.summaryCeiling}；任务调用上限：4096；压缩边界的最低上下文估算：${report.limits.minContextTokens}。固定模式使用一次摘要尝试及 256-token 最近历史预算（Claude/Qwen 为 0）。插件默认模式只传入 auto:false，在统一模型路由上限内使用各插件默认的历史保留和重试行为。每次运行均记录实际设置和请求上限。`),
    t('Manual checkpoints do not measure automatic trigger policies or actual context exhaustion. One trial per mode cannot rank strategies or establish that compaction caused a defect. Task versions and budget modes must be compared separately.', '手动检查点不衡量自动触发策略或真正填满上下文的行为。每个模式单次运行无法给策略排名，也无法证明缺陷由压缩造成。不同任务版本和预算模式应分别比较。'),
    '- [report.json](report.json)\n- [final-sources.json](final-sources.json)',
    t('The JSON report records per-stage checks, compaction reasons and durable failure events, token estimates, actual source hashes, API calls, and replay outcomes. Local run directories retain source and session snapshots. Earlier reports are preserved separately.', 'JSON 报告记录各阶段验收、压缩原因和持久化失败事件、token 估算、源文件哈希、API 调用和重载结果。本地运行目录保留代码和会话快照。早先报告另行保留。'));
  return sections.join('\n\n')+'\n';
}

export async function writeContinuationArtifacts(report, output) {
  const sources = {};
  for (const result of report.results) {
    assert.match(result.artifactDirectory, /^[a-z0-9-]+$/);
    sources[result.artifactDirectory] = {};
    for (const [path, expected] of Object.entries(result.finalFiles)) {
      assert.ok(['src/policy.mjs','src/store.mjs','src/importer.mjs'].includes(path));
      const content = await readFile(join(output,result.artifactDirectory,'project',path),'utf8');
      assert.equal(createHash('sha256').update(content).digest('hex'),expected.sha256);
      sources[result.artifactDirectory][path] = content;
    }
  }
  await writeFile(join(output,'final-sources.json'),JSON.stringify(sources,null,2)+'\n',{mode:0o600});
  for (const language of ['en','zh']) await writeFile(join(output,language==='en'?'report.md':'report.zh-CN.md'),renderContinuationReport(report,language),{mode:0o600});
}
