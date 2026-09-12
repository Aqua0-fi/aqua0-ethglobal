import assert from "node:assert/strict";
import test from "node:test";

import { checkDecision } from "../src/guard.js";
import { nextSignalToBuy, rulesDecide } from "../src/policy.js";
import { deriveKeeperState } from "../src/state.js";
import { ARS, BRL, budget, flatBook, limits, observation, oracle, snapshot, tiltedAfterSwap } from "./fixtures.js";

test("a swap wake buys the book first, then the oracle once a book is tilted", () => {
  const woke = tiltedAfterSwap({ bought: {} });
  assert.deepEqual(rulesDecide(woke, budget()), { action: "buy_signal", which: "book", reason: "a swap just moved USDC/BRL: read the book tilt" });
  const withBook = tiltedAfterSwap();
  delete withBook.bought.oracle;
  assert.equal(nextSignalToBuy(withBook)?.which, "oracle");
  // A fresh oracle reading from a previous tick is enough: no second purchase.
  const recent = tiltedAfterSwap({ signalAgeSeconds: { oracle: 30, book: null, vault: null }, lastKnown: [{ pair: "USDC/BRL", strategyId: BRL, spreadBps: 30, side: "balanced", oracleAgeSeconds: 2, oracleStatus: "ok" }] });
  delete recent.bought.oracle;
  assert.equal(nextSignalToBuy(recent), null);
});

test("a tilted book with a fresh oracle is rebalanced in the direction that evens it, sized from the tilt", () => {
  const decision = rulesDecide(tiltedAfterSwap(), budget());
  assert.equal(decision.action, "rebalance");
  if (decision.action !== "rebalance") return;
  assert.equal(decision.strategyId, BRL);
  assert.equal(decision.direction, "fx-in");
  assert.ok(decision.sizeUsdc > 0.09 && decision.sizeUsdc < 0.11, `size ${decision.sizeUsdc}`);
  assert.deepEqual(checkDecision(decision, tiltedAfterSwap(), budget()), { allowed: true });
});

test("the max trade size caps the rebalance", () => {
  const small = { ...limits, maxTradeUsdc: 0.05 };
  const decision = rulesDecide(tiltedAfterSwap({ limits: small }), budget());
  assert.equal(decision.action === "rebalance" && decision.sizeUsdc, 0.05);
});

test("cooldown: the policy waits and the guard blocks a rebalance on the same strategy", () => {
  const cooling = tiltedAfterSwap({ cooldownSeconds: { [BRL]: 42 } });
  const decision = rulesDecide(cooling, budget());
  assert.equal(decision.action, "wait");
  assert.match(decision.reason, /cooldown has 42s left/);
  const forced = { action: "rebalance" as const, strategyId: BRL, pair: "USDC/BRL", direction: "fx-in" as const, sizeUsdc: 0.1, reason: "x" };
  assert.deepEqual(checkDecision(forced, cooling, budget()), { allowed: false, reason: "cooldown: 42s left on USDC/BRL" });
});

test("a stale oracle is never traded on: the keeper recommends docking instead", () => {
  const stale = tiltedAfterSwap();
  stale.bought.oracle!.snapshot = snapshot([
    { pair: "USDC/ARS", strategyId: ARS, oracle: oracle("ok", { fxPerUsdc: 1400 }) },
    { pair: "USDC/BRL", strategyId: BRL, oracle: oracle("stale") }
  ]);
  const decision = rulesDecide(stale, budget());
  assert.equal(decision.action, "recommend_dock");
  assert.match(decision.reason, /7200s old/);
  const forced = { action: "rebalance" as const, strategyId: BRL, pair: "USDC/BRL", direction: "fx-in" as const, sizeUsdc: 0.1, reason: "x" };
  const guard = checkDecision(forced, stale, budget());
  assert.equal(guard.allowed, false);
  // Recommended recently: not repeated, and no trade either.
  const again = rulesDecide({ ...stale, dockRecommendedAgeSeconds: { [BRL]: 60 } }, budget());
  assert.equal(again.action, "wait");
});

test("data budget: no purchase above the remaining hourly budget", () => {
  const decision = rulesDecide(observation(), budget({ dataRemainingUsdc: 0.0001 }));
  assert.equal(decision.action, "wait");
  assert.match(decision.reason, /data budget/);
  const guard = checkDecision({ action: "buy_signal", which: "book", reason: "x" }, observation(), budget({ dataRemainingUsdc: 0.0005 }));
  assert.equal(guard.allowed, false);
});

test("a quiet heartbeat buys only the cheap oracle signal when the book is recent", () => {
  const quiet = observation({ signalAgeSeconds: { oracle: 90, book: 100, vault: 200 } });
  assert.deepEqual(nextSignalToBuy(quiet), { which: "oracle", reason: "heartbeat: check oracle staleness and band" });
  quiet.bought.oracle = {
    at: quiet.now,
    blockNumber: "1",
    spentUsdc: 0.0005,
    snapshot: snapshot([
      { pair: "USDC/ARS", strategyId: ARS, oracle: oracle("ok", { fxPerUsdc: 1400 }) },
      { pair: "USDC/BRL", strategyId: BRL, oracle: oracle("ok") }
    ])
  };
  assert.equal(nextSignalToBuy(quiet), null);
  assert.equal(rulesDecide(quiet, budget()).action, "wait");
});

test("guard: disallowed actions, oversize trades, flat books and wrong directions are blocked", () => {
  const obs = tiltedAfterSwap();
  const rebalance = { action: "rebalance" as const, strategyId: BRL, pair: "USDC/BRL", direction: "fx-in" as const, sizeUsdc: 0.1, reason: "x" };
  assert.equal(checkDecision(rebalance, { ...obs, limits: { ...limits, allowedActions: ["wait", "buy_signal"] } }, budget()).allowed, false);
  assert.match(String((checkDecision({ ...rebalance, sizeUsdc: 5 }, obs, budget()) as { reason?: string }).reason), /above the max trade/);
  assert.match(String((checkDecision({ ...rebalance, direction: "usdc-in" }, obs, budget()) as { reason?: string }).reason), /tilt the book further/);
  assert.match(String((checkDecision({ ...rebalance, strategyId: ARS, pair: "USDC/ARS" }, obs, budget()) as { reason?: string }).reason), /does not show USDC\/ARS/);
  assert.equal(checkDecision({ ...rebalance, strategyId: "0xdead" }, obs, budget()).allowed, false);
  assert.equal(checkDecision({ action: "top_up_usdc", amountUsdc: 2, reason: "x" }, obs, budget()).allowed, false);
  assert.equal(checkDecision({ action: "top_up_usdc", amountUsdc: 1, reason: "x" }, obs, budget({ topUpsTodayUsdc: 2.5 })).allowed, false);
  assert.equal(checkDecision({ action: "top_up_gateway", amountUsdc: 0.25, reason: "x" }, obs, budget()).allowed, true);
});

test("balance floors come first: Gateway deposit, then a USDC top-up within the daily cap", () => {
  const empty = observation({ keeper: { address: "0x1", usdc: 2, gatewayUsdc: 0.01 } });
  assert.equal(rulesDecide(empty, budget()).action, "top_up_gateway");
  const poor = observation({ keeper: { address: "0x1", usdc: 0.2, gatewayUsdc: 0.4 } });
  const topUp = rulesDecide(poor, budget({ topUpsTodayUsdc: 2.5 }));
  assert.deepEqual({ action: topUp.action, amount: topUp.action === "top_up_usdc" ? topUp.amountUsdc : null }, { action: "top_up_usdc", amount: 0.5 });
  assert.notEqual(rulesDecide(poor, budget({ topUpsTodayUsdc: 3 })).action, "top_up_usdc");
});

test("state derived from the journal gives hourly spend, cooldowns, top-ups and model spend", () => {
  const now = Date.parse("2026-09-12T20:00:00.000Z");
  const state = deriveKeeperState(
    [
      {
        v: 1,
        type: "tick",
        ts: "2026-09-12T18:30:00.000Z",
        steps: [{ decision: { action: "buy_signal", reason: "" }, by: "rules", guard: { allowed: true }, receipt: { route: "/v1/book", amountUsdc: "0.001", settlement: null, ms: 1 } }]
      },
      {
        v: 1,
        type: "tick",
        ts: "2026-09-12T19:59:00.000Z",
        steps: [
          { decision: { action: "buy_signal", reason: "" }, by: "rules", guard: { allowed: true }, receipt: { route: "/v1/oracle", amountUsdc: "0.0005", settlement: null, ms: 1 } },
          { decision: { action: "rebalance", reason: "" }, by: "llm", guard: { allowed: true }, llm: { model: "gpt-5-nano", inputTokens: 1000, outputTokens: 100, costUsd: 0.00009, ms: 1 } }
        ],
        outcome: { action: "rebalance", reason: "", by: "llm", txs: [{ stage: "swap", hash: "0x1", url: "u" }], detail: { strategyId: BRL } },
        signals: [{ pair: "USDC/BRL", strategyId: BRL, spreadBps: 30, side: "balanced", oracleAgeSeconds: 1, oracleStatus: "ok" }]
      },
      {
        v: 1,
        type: "tick",
        ts: "2026-09-12T19:59:30.000Z",
        outcome: { action: "top_up_usdc", reason: "", by: "rules", txs: [{ stage: "send", hash: "0x2", url: "u" }], detail: { amountUsdc: 1 } }
      },
      { v: 1, type: "tick", ts: "2026-09-12T19:59:40.000Z", outcome: { action: "rebalance", reason: "", by: "rules", dryRun: true, txs: [], detail: { strategyId: ARS } } }
    ],
    now
  );
  assert.equal(state.dataSpentHourUsdc, 0.0005);
  assert.equal(state.dataSpentTotalUsdc, 0.0015);
  assert.equal(state.signalBoughtAt.book, Date.parse("2026-09-12T18:30:00.000Z"));
  assert.equal(state.lastRebalanceAt[BRL], Date.parse("2026-09-12T19:59:00.000Z"));
  assert.equal(state.lastRebalanceAt[ARS], undefined, "a dry run starts no cooldown");
  assert.equal(state.topUpsTodayUsdc, 1);
  assert.equal(state.llmDayUsd, 0.00009);
  assert.equal(state.lastSignals[0]?.spreadBps, 30);
  assert.equal(flatBook.side, "balanced");
});
