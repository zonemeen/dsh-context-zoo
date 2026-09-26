import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence';
import piPlugin from '../packages/pi/dist/index.js';
import { SummaryAdapter, assertToolPairs } from './helpers/context-harness.mjs';
import { seedQualityConversation, recallPrompt, scoreRecall } from './helpers/deepseek-quality-fixture.mjs';

const recalledFacts = {
  ttl_hours: 48,
  idempotency_header: 'Idempotency-Key',
  retry_statuses: [429, 502, 503, 504],
  max_attempts: 3,
  backoff_ms: [250, 500],
  unique_key: ['tenant_id', 'external_invoice_id'],
  migration_file: 'migrations/20260926_invoice_import.sql',
  test_command: 'pnpm test -- invoice-import',
  test_counts: { passed: 17, skipped: 1 },
  next_step: 'Add a tenant isolation regression test',
  production_contact_allowed: false,
  migration_apply_allowed: false,
};

test('recall scoring accepts fenced JSON and preserves observed values for inspection', () => {
  const answer = { ...recalledFacts, retry_statuses: [504, 503, 429, 502], note: 'A brace in a quoted value: }.' };
  const result = scoreRecall(`Recorded answer:\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``);
  assert.equal(result.passed, 10);
  assert.equal(result.total, 10);
  assert.deepEqual(result.checks.find(check => check.name === 'retry statuses').actual, answer.retry_statuses);
});

test('recall scoring rejects stale decisions, invented checks, unsafe permissions, and missing JSON', () => {
  for (const changed of [
    { ttl_hours: 24 },
    { idempotency_header: 'X-Request-Id' },
    { retry_statuses: [429, 500, 502, 503, 504] },
    { max_attempts: 4 },
    { backoff_ms: [500, 250] },
    { unique_key: ['external_invoice_id'] },
    { migration_file: 'migrations/latest.sql' },
    { test_counts: { passed: 18, skipped: 0 } },
    { test_command: 'pnpm test' },
    { next_step: 'Already completed the tenant isolation regression test' },
    { production_contact_allowed: true },
    { migration_apply_allowed: true },
  ]) {
    const result = scoreRecall(JSON.stringify({ ...recalledFacts, ...changed }));
    assert.equal(result.passed, 9, JSON.stringify(changed));
  }
  assert.equal(scoreRecall('I cannot determine the previous task.').passed, 0);
  assert.equal(scoreRecall('{"ttl_hours":').passed, 0);
  assert.doesNotMatch(recallPrompt, /20260926|48 hours|\b429\b|\b250\b|\b17\b/);
});

test('the synthetic history stays bounded, restores valid events, and gives Pi one summary call', async t => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, TokenMeter]) await ctx.plugin(plugin);
  const adapter = new SummaryAdapter();
  ctx.llm.registerAdapter(['fixture'], adapter);
  await ctx.plugin(piPlugin, { auto: false, keepRecentTokens: 256, maxSummaryTokens: 2048, maxSummaryAttempts: 1 });
  const session = ctx.sessions.create(SessionId('quality-fixture'));
  seedQualityConversation(session, { provider: 'fixture', model: 'fixture' });
  const before = ctx.tokenMeter.measure(session).totalTokens;
  assert.ok(before >= 4000 && before <= 6000, `Expected 4–6k estimated tokens, got ${before}.`);
  const messages = session.deriveMessages();
  const lastUser = messages.at(-1);
  assert.equal(lastUser.role, 'user');
  assert.ok(Math.ceil(lastUser.content[0].text.length / 4) > 256);
  for (const message of [messages[0], lastUser]) {
    assert.doesNotMatch(message.content[0].text, /48|24|429|502|503|504|Idempotency-Key|tenant_id|external_invoice_id|20260926|17 passed|production/);
  }
  assertToolPairs(messages);
  validateStoredEvents(session.header, structuredClone(session.snapshotEvents()));
  const agent = { session, options: { provider: 'fixture', model: 'fixture' }, runMaintenance: task => task(new AbortController().signal) };
  assert.ok(await ctx.compaction.compactNow(agent, new AbortController().signal));
  assert.equal(adapter.requests.length, 1, 'The final user message keeps the Pi cut outside a split assistant turn.');
  assert.deepEqual(session.deriveMessages().at(-1), lastUser);
  assert.ok(ctx.tokenMeter.measure(session).totalTokens < before);
  validateStoredEvents(session.header, structuredClone(session.snapshotEvents()));
});
