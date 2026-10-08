import assert from "node:assert/strict";
import test from "node:test";
import { budgetFor, observations, strategies } from "../src/lib/strategies.ts";
import { simulate, type ScenarioId } from "../src/lib/simulation.ts";

test("native Harness headroom is part of the trigger, and small default windows are invalid", () => {
  assert.deepEqual(budgetFor("deepseek", 131072), { trigger: 57344, retain: 19660, valid: true });
  assert.equal(budgetFor("deepseek", 65536).valid, false);
  assert.equal(budgetFor("deepseek", 32768).trigger, 0);
});

test("the comparison distinguishes proportional, reserved, and fallback budgets", () => {
  assert.equal(budgetFor("codex", 131072).trigger, 117964);
  assert.equal(budgetFor("pi", 131072).trigger, 114688);
  assert.equal(budgetFor("opencode", 131072).trigger, 122880);
  assert.equal(budgetFor("opencode", 131072).retain, 15000);
  assert.equal(budgetFor("cline", 131072).trigger, 106168);
  assert.equal(budgetFor("qwen-code", 32768).trigger, Math.floor(32768 * .85));
  assert.equal(budgetFor("kimi-code", 32768).trigger, Math.floor(32768 * .85));
});

test("all teaching traces conserve their displayed totals and preserve the system block", () => {
  for (const strategy of strategies) {
    for (const window of [131072, 262144, 524288, 1048576]) {
      for (const scenario of ["coding", "tools", "requirements"] as ScenarioId[]) {
        const trace = simulate(strategy.id, window, scenario);
        assert.equal(trace.beforeTokens, trace.before.reduce((total, block) => total + block.tokens, 0));
        assert.equal(trace.afterTokens, trace.after.reduce((total, block) => total + block.tokens, 0));
        assert.deepEqual(trace.after[0], trace.before[0]);
        assert.ok(trace.afterTokens < trace.beforeTokens);
        assert.ok(trace.afterTokens < window);
        assert.ok(trace.prunedTokens >= 0 && trace.prunedTokens < trace.beforeTokens);
        assert.ok(trace.after.every(block => block.tokens > 0));
      }
    }
  }
});

test("the selected illustration does not invent pruning or confuse restored user input with a tail", () => {
  assert.equal(simulate("zcode", 131072, "coding").hasPruning, false);
  assert.equal(simulate("pi", 131072, "coding").hasPruning, false);
  for (const id of ["codex", "kimi-code"] as const) {
    const trace = simulate(id, 131072, "coding");
    assert.equal(trace.hasTail, false);
    assert.equal(trace.restored, true);
    assert.ok(trace.after.some(block => block.kind === "restored"));
  }
});

test("every strategy has all five bilingual stages and a source", () => {
  assert.equal(new Set(strategies.map(strategy => strategy.id)).size, 9);
  for (const strategy of strategies) {
    assert.equal(strategy.zh.steps.length, 5);
    assert.equal(strategy.en.steps.length, 5);
    assert.equal(strategy.zh.details.length, 5);
    assert.equal(strategy.en.details.length, 5);
    assert.match(strategy.source, /^https:\/\/github\.com\//);
  }
});

test("observations preserve failures and do not fabricate native Harness measurements", () => {
  assert.equal(observations.length, 8);
  assert.equal(observations.find(result => result.id === "qwen-code")?.fixed, "37/43");
  assert.equal(observations.find(result => result.id === "zcode")?.fixed, null);
  assert.equal(observations.filter(result => result.nativeCompactions === 3).length, 5);
});
