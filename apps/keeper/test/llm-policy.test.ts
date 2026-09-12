import assert from "node:assert/strict";
import test from "node:test";

import { estimateCostUsd, LlmPolicy, notableReason, parseModelDecision, type ResponsesClient } from "../src/llm-policy.js";
import { BRL, budget, observation, tiltedAfterSwap } from "./fixtures.js";

type Call = { body: Record<string, unknown>; options?: { timeout?: number; maxRetries?: number } };

function mockClient(respond: (call: Call) => Promise<{ output_text?: string; usage?: { input_tokens: number; output_tokens: number } }>) {
  const calls: Call[] = [];
  const client: ResponsesClient = {
    responses: {
      create: (body, options) => {
        const call: Call = { body, ...(options ? { options } : {}) };
        calls.push(call);
        return respond(call);
      }
    }
  };
  return { client, calls };
}

const usage = { input_tokens: 1000, output_tokens: 100 };

test("a valid model decision inside the limits is used, with tokens and cost recorded", async () => {
  const { client, calls } = mockClient(async () => ({
    output_text: JSON.stringify({ action: "rebalance", strategyId: BRL, direction: "fx-in", sizeUsdc: 0.1, which: null, amountUsdc: null, reason: "BRL spread 263.6 bps above 150; sell BRAt worth 0.1 USDC" }),
    usage
  }));
  const policy = new LlmPolicy({ client, capDayUsd: 0.5, now: () => Date.parse("2026-09-12T20:00:00Z") });
  const outcome = await policy.decide(tiltedAfterSwap(), budget(), []);
  assert.equal(outcome.by, "llm:gpt-5-nano");
  assert.equal(outcome.decision.action, "rebalance");
  assert.equal(outcome.llm?.inputTokens, 1000);
  assert.equal(outcome.llm?.outputTokens, 100);
  assert.equal(outcome.llm?.costUsd, 0.00009);
  assert.equal(outcome.llm?.fallback, undefined);
  assert.equal(calls.length, 1);
  const body = calls[0]!.body;
  assert.equal(body.model, "gpt-5-nano");
  assert.deepEqual(body.reasoning, { effort: "minimal" });
  assert.equal((body.text as { format: { type: string; strict: boolean } }).format.type, "json_schema");
  assert.equal(calls[0]!.options?.timeout, 10_000);
  assert.equal(calls[0]!.options?.maxRetries, 0);
  const input = JSON.parse(String(body.input)) as { trigger: string; allowedActions: string[]; strategies: Array<{ spreadBps: number | null }> };
  assert.equal(input.trigger, "swap on USDC/BRL");
  assert.ok(!input.allowedActions.includes("buy_signal"));
  assert.equal(input.strategies[1]?.spreadBps, 263.6);
  assert.equal(policy.spentTodayUsd, 0.00009);
});

test("invalid JSON falls back to the rules policy and says why", async () => {
  const { client } = mockClient(async () => ({ output_text: "rebalance BRL please", usage }));
  const policy = new LlmPolicy({ client, capDayUsd: 0.5 });
  const outcome = await policy.decide(tiltedAfterSwap(), budget(), []);
  assert.equal(outcome.by, "rules (llm fallback)");
  assert.equal(outcome.decision.action, "rebalance");
  assert.match(outcome.llm?.fallback ?? "", /invalid model output: not JSON/);
  assert.equal(outcome.llm?.costUsd, 0.00009, "the failed call still costs");
});

test("an action outside the limits (oversize trade) falls back to the rules", async () => {
  const { client } = mockClient(async () => ({
    output_text: JSON.stringify({ action: "rebalance", strategyId: BRL, direction: "fx-in", sizeUsdc: 3, which: null, amountUsdc: null, reason: "go big" }),
    usage
  }));
  const outcome = await new LlmPolicy({ client, capDayUsd: 0.5 }).decide(tiltedAfterSwap(), budget(), []);
  assert.equal(outcome.by, "rules (llm fallback)");
  assert.match(outcome.llm?.fallback ?? "", /outside the limits: size 3 USDC is above the max trade 0.25/);
  if (outcome.decision.action === "rebalance") {
    assert.ok(outcome.decision.sizeUsdc <= 0.25);
  }
});

test("a timeout falls back to the rules", async () => {
  const { client } = mockClient(async () => {
    throw new Error("Request timed out.");
  });
  const outcome = await new LlmPolicy({ client, capDayUsd: 0.5 }).decide(tiltedAfterSwap(), budget(), []);
  assert.equal(outcome.by, "rules (llm fallback)");
  assert.match(outcome.llm?.fallback ?? "", /model timeout/);
  assert.equal(outcome.decision.action, "rebalance");
});

test("API errors never leak the key", async () => {
  const secret = "sk-test-0123456789abcdef";
  const { client } = mockClient(async () => {
    throw new Error(`401 Incorrect API key provided: ${secret}`);
  });
  const outcome = await new LlmPolicy({ client, capDayUsd: 0.5, secret }).decide(tiltedAfterSwap(), budget(), []);
  assert.ok(!(outcome.llm?.fallback ?? "").includes(secret));
  assert.match(outcome.llm?.fallback ?? "", /\[redacted\]/);
});

test("quiet heartbeats and signal purchases never call the model", async () => {
  const { client, calls } = mockClient(async () => ({ output_text: "{}", usage }));
  const policy = new LlmPolicy({ client, capDayUsd: 0.5 });
  const buy = await policy.decide(tiltedAfterSwap({ bought: {} }), budget(), []);
  assert.equal(buy.decision.action, "buy_signal");
  assert.equal(notableReason(observation()), null);
  const quiet = await policy.decide(observation({ signalAgeSeconds: { oracle: 10, book: 10, vault: 10 }, bought: { oracle: { at: "", blockNumber: "1", spentUsdc: 0, snapshot: { source: "", chainId: 1, blockNumber: "1", at: "", strategies: [] } } } }), budget(), []);
  assert.equal(quiet.decision.action, "wait");
  assert.equal(calls.length, 0);
  assert.equal(buy.llm, undefined);
});

test("cost accounting accumulates per call and the daily cap stops model calls", async () => {
  const { client, calls } = mockClient(async () => ({
    output_text: JSON.stringify({ action: "wait", strategyId: null, direction: null, sizeUsdc: null, which: null, amountUsdc: null, reason: "watching" }),
    usage: { input_tokens: 2_000_000, output_tokens: 500_000 }
  }));
  let now = Date.parse("2026-09-12T20:00:00Z");
  const policy = new LlmPolicy({ client, capDayUsd: 0.25, now: () => now });
  const first = await policy.decide(tiltedAfterSwap(), budget(), []);
  assert.equal(first.llm?.costUsd, 0.3);
  assert.equal(policy.spentTodayUsd, 0.3);
  const second = await policy.decide(tiltedAfterSwap(), budget(), []);
  assert.equal(calls.length, 1, "no call once the cap is reached");
  assert.match(second.llm?.fallback ?? "", /daily model spend cap \$0.25 reached/);
  now = Date.parse("2026-09-13T00:00:01Z");
  await policy.decide(tiltedAfterSwap(), budget(), []);
  assert.equal(calls.length, 2, "the cap resets on a new UTC day");
  assert.equal(policy.totalUsd, 0.6);
  assert.equal(estimateCostUsd("gpt-5-nano-2025-08-07", 1_000_000, 1_000_000), 0.45);
  assert.equal(estimateCostUsd("unknown-model", 1_000_000, 0), 1.25);
});

test("model output shape checks", () => {
  const obs = tiltedAfterSwap();
  assert.deepEqual(parseModelDecision("", obs), { error: "empty response" });
  assert.match(JSON.stringify(parseModelDecision(JSON.stringify({ action: "sell_everything", reason: "x" }), obs)), /unknown action/);
  assert.match(JSON.stringify(parseModelDecision(JSON.stringify({ action: "rebalance", strategyId: "0xabc", direction: "fx-in", sizeUsdc: 0.1, reason: "x" }), obs)), /unknown strategyId/);
  assert.match(JSON.stringify(parseModelDecision(JSON.stringify({ action: "wait", reason: "" }), obs)), /missing reason/);
  const ok = parseModelDecision(JSON.stringify({ action: "recommend_dock", strategyId: BRL.toUpperCase().replace("0X", "0x"), reason: "stale" }), obs);
  assert.ok("decision" in ok && ok.decision.action === "recommend_dock" && ok.decision.pair === "USDC/BRL");
});
