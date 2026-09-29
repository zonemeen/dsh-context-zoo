/** Interpret durable evidence without turning a skipped compaction into a pass. */
export function compactionOutcome({ committed, commandResult, events, calls, thrown, surfaceChanged }) {
  const failures = events.filter(event => event.type === 'compaction/end' && event.data.error);
  const reason = failures.at(-1)?.data.error ?? thrown?.message ?? commandResult?.text ?? 'No compaction result';
  const evidence = { reason, failures };
  if (committed && commandResult?.kind === 'success' && !thrown) return { outcome: 'committed', ...evidence };
  if (committed || /flush|persist|busy|cancelled/i.test(commandResult?.text ?? '')) return { outcome: 'runtime-error', ...evidence };
  if (/would increase history tokens|not smaller than the selected history/.test(reason)) return { outcome: 'skipped-no-benefit', ...evidence };
  if (/output limit|truncat/i.test(reason) || calls.some(call => call.finish === 'max-tokens')) return { outcome: 'summary-truncated', ...evidence };
  if (calls.some(call => call.error || call.failure || ['error', 'aborted'].includes(call.finish))) return { outcome: 'provider-error', ...evidence };
  if (/empty.*summary|summary.*empty|non-text|must contain text|attempted to call a tool|unsupported response|no summary text|did not contain usable continuation text/i.test(reason)) return { outcome: 'summary-invalid', ...evidence };
  if (commandResult?.kind === 'success' && /No compactable history/.test(commandResult.text)) return { outcome: surfaceChanged ? 'pruned-only' : 'skipped-no-eligible-history', ...evidence };
  return { outcome: 'runtime-error', ...evidence };
}

export function scoreContinuation(result, task) {
  const completed = result.phases.length === task.phases.length && !!result.phases.at(-1)?.acceptance;
  result.acceptance = completed ? result.phases.at(-1).acceptance : undefined;
  result.taskStatus = completed ? result.acceptance.passed === result.acceptance.total
    && result.phases.every(phase => phase.changedFiles?.length > 0 && phase.testsAfterLastWrite) ? 'passed' : 'failed' : 'not-completed';
  const committed = result.compactions.filter(item => item.outcome === 'committed');
  result.successfulCompactions = committed.length;
  result.requiredCompactions = result.id === 'baseline' ? 0 : task.compactAfter.length;
  result.compactionStatus = result.id === 'baseline' ? 'not-applicable' : committed.length === result.requiredCompactions ? 'complete' : 'incomplete';
  result.replayStatus = result.phases.filter(phase => phase.replayed).length === task.compactAfter.length ? 'complete' : 'incomplete';
  result.continuedAfterLastCompaction = committed.length > 0 && result.phases.some((phase, i) => i + 1 > committed.at(-1).afterPhase && phase.changedFiles?.length > 0);
  result.continuedAfterThirdCompaction = committed.length >= 3 && result.phases.some((phase, i) => i + 1 > committed[2].afterPhase && phase.changedFiles?.length > 0);
  if (result.error) result.status = 'runtime-error';
  else if (result.taskStatus !== 'passed') result.status = 'task-failed';
  else if (result.compactionStatus === 'incomplete' || result.replayStatus !== 'complete' || result.id !== 'baseline' && !result.continuedAfterThirdCompaction) result.status = 'compaction-incomplete';
  else result.status = 'passed';
}
