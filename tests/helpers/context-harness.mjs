/** Real DSH services and deterministic history used by context integration tests. */
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter, ToolCallId, createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import piPlugin from '../../packages/pi/dist/index.js';

const SUMMARY = 'Checkpoint: the requested file edits remain in progress.';
const SYSTEM = 'Keep the project constraints and verify edits before reporting success.';
const TOOLS = [{ name: 'read', description: 'Read a project file.', parameters: { type: 'object' } }];

class SummaryAdapter extends LlmAdapter {
  requests = [];

  constructor(mode = 'success', onStream = () => {}) {
    super();
    this.mode = mode;
    this.onStream = onStream;
  }

  async resolveModel(provider, model) {
    return { provider, id: model, name: model, context: { contextWindow: 20_000 }, defaultMaxTokens: 2_000 };
  }

  async *stream(options) {
    this.requests.push(options);
    await this.onStream(options);
    options.signal?.throwIfAborted();
    if (this.mode === 'error') throw new Error('fixture provider failure');
    const text = this.mode === 'empty' ? '   ' : this.mode === 'xml' ? `<state_snapshot>${SUMMARY}</state_snapshot>` : SUMMARY;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: 400, outputTokens: 12 } };
    yield { type: 'finish', reason: { kind: this.mode === 'truncated' ? 'max-tokens' : 'stop' } };
  }
}

function seedConversation(session, openTurn, firstTurn = 1) {
  for (let turn = firstTurn; turn < firstTurn + 3; turn++) {
    const callId = ToolCallId(`read-${turn}`);
    session.append('turn/start', { turn });
    if (turn === 1) {
      session.append('system/message', { turn, step: 1, message: createSystemMessage(SYSTEM) }, { surfaceOp: 'append' });
    }
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `Request ${turn}: ${'project detail '.repeat(90)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' });
    session.append('step/start', { turn, step: 1 });
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: 'fixture', model: 'routed-model', maxTokens: 1_000 }, tools: TOOLS },
        reason: 'initial',
      });
    }
    session.append('assistant/message', {
      turn,
      step: 1,
      stream: [],
      message: createAssistantMessage({
        content: [
          { type: 'text', text: `Inspecting file ${turn}.` },
          { type: 'tool-call', id: callId, name: 'read', arguments: JSON.stringify({ path: `file-${turn}.ts` }) },
        ],
        source: { provider: 'fixture', model: 'routed-model' },
      }),
    }, { surfaceOp: 'append' });
    session.append('tool/call', { turn, step: 1, callId, name: 'read', arguments: JSON.stringify({ path: `file-${turn}.ts` }) });
    session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: `File ${turn}: ${'recorded file contents '.repeat(turn === firstTurn + 2 ? 8 : 160)}` }],
        isError: false,
      }),
    }, { surfaceOp: 'append' });
    session.append('step/end', { turn, step: 1 });
    session.append('turn/end', { turn, reason: { kind: 'completed' } });
  }
  if (openTurn) session.append('turn/start', { turn: firstTurn + 3 });
}

async function harness(t, { mode, onStream, openTurn = true, config = {}, plugin = piPlugin, seed } = {}) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(TokenMeter);
  const adapter = new SummaryAdapter(mode, onStream);
  ctx.llm.registerAdapter(['fixture', 'summary-fixture'], adapter);
  await ctx.plugin(plugin, {
    auto: false,
    reserveTokens: 0,
    thresholdRatio: 0.01,
    keepRecentTokens: 80,
    maxSummaryTokens: 500,
    ...config,
  });
  const session = ctx.sessions.create(SessionId('integration-session'), seed === undefined ? undefined : { seed });
  if (seed === undefined) seedConversation(session, openTurn);
  const maintenance = { calls: 0, released: 0 };
  const maintenanceSignal = new AbortController().signal;
  const agent = {
    session,
    options: { provider: 'unused-fallback', model: 'unused-model' },
    async runMaintenance(task) {
      maintenance.calls++;
      try {
        return await task(maintenanceSignal);
      } finally {
        maintenance.released++;
      }
    },
  };
  return { ctx, session, agent, adapter, maintenance };
}

function compactionEvents(session) {
  return session.snapshotEvents().filter(event => event.type.startsWith('compaction/'));
}

function assertToolPairs(messages) {
  const pending = new Set();
  for (const message of messages) {
    for (const block of message.content) if (block.type === 'tool-call') pending.add(block.id);
    if (message.role === 'tool') {
      assert.ok(pending.has(message.toolCallId), `Tool result ${message.toolCallId} needs a preceding call.`);
      pending.delete(message.toolCallId);
    }
  }
  assert.equal(pending.size, 0);
}

export { SUMMARY, SYSTEM, TOOLS, SummaryAdapter, seedConversation, harness, compactionEvents, assertToolPairs };
