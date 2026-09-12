import assert from "node:assert/strict";
import test from "node:test";

import { LIVE_FOREX_STRATEGIES, type KeeperJournalEntry } from "@aqua0/shared";

import { formatTickLine } from "../src/format.js";
import { swapsFromLogs } from "../src/watcher.js";
import { BRL } from "./fixtures.js";

const KEEPER = "0x5214daeb80b07340bac9060559d660e905564d87";

test("Swapped logs on watched strategies become swap wakes; other orders and the keeper's own swaps are ignored", () => {
  const logs = [
    {
      args: { orderHash: BRL, taker: "0xB0C0687EB013a5FFdE4D23A89398A11bC424d952", tokenIn: "0x3600000000000000000000000000000000000000", tokenOut: "0xa9482a878A3784663512f0Bf8d0be17aD6DEA38E", amountIn: 100000n, amountOut: 513597612703509834n },
      transactionHash: "0xe28f401465a86dd8557ddd8de548366b0ad5e1fe20db74f71e56cd4a6bcc172a",
      blockNumber: 61773897n
    },
    {
      args: { orderHash: BRL, taker: KEEPER, tokenIn: "0xa9482a878A3784663512f0Bf8d0be17aD6DEA38E", tokenOut: "0x3600000000000000000000000000000000000000", amountIn: 1n, amountOut: 1n },
      transactionHash: "0x01",
      blockNumber: 61773900n
    },
    { args: { orderHash: "0x1234", taker: "0x1", tokenIn: "0x2", amountIn: 1n, amountOut: 1n }, transactionHash: "0x02", blockNumber: 61773901n }
  ];
  const swaps = swapsFromLogs(logs, LIVE_FOREX_STRATEGIES, KEEPER);
  assert.equal(swaps.length, 1);
  assert.deepEqual(swaps[0], {
    pair: "USDC/BRL",
    strategyId: BRL,
    txHash: "0xe28f401465a86dd8557ddd8de548366b0ad5e1fe20db74f71e56cd4a6bcc172a",
    blockNumber: "61773897",
    taker: "0xb0c0687eb013a5ffde4d23a89398a11bc424d952",
    direction: "usdc-in",
    amountIn: "100000",
    amountOut: "513597612703509834"
  });
});

test("the tick line shows what woke the keeper, spend, spreads, the decision and tx links", () => {
  const entry: KeeperJournalEntry = {
    v: 1,
    type: "tick",
    ts: "2026-09-12T20:00:05.000Z",
    tick: 7,
    wake: { kind: "swap", detail: "swap 0xe28f4014... usdc-in on USDC/BRL by 0xb0c068..." },
    signals: [
      { pair: "USDC/ARS", strategyId: "a", spreadBps: 29.99, side: "balanced", oracleAgeSeconds: 27561, oracleStatus: "ok" },
      { pair: "USDC/BRL", strategyId: BRL, spreadBps: 263.6, side: "usdc-heavy", oracleAgeSeconds: 2, oracleStatus: "ok" }
    ],
    steps: [
      { decision: { action: "buy_signal", reason: "" }, by: "rules", guard: { allowed: true }, receipt: { route: "/v1/book", amountUsdc: "0.001", settlement: "s", ms: 1 } },
      { decision: { action: "rebalance", reason: "" }, by: "llm:gpt-5-nano", guard: { allowed: true }, llm: { model: "gpt-5-nano", inputTokens: 930, outputTokens: 74, costUsd: 0.000076, ms: 900 } }
    ],
    outcome: {
      action: "rebalance",
      pair: "USDC/BRL",
      reason: "BRL spread 263.6 bps above 150",
      by: "llm:gpt-5-nano",
      txs: [{ stage: "swap", hash: "0xabc", url: "https://testnet.arcscan.app/tx/0xabc" }],
      spreadBeforeBps: 263.6,
      spreadAfterBps: 30
    },
    spend: { tickUsdc: 0.001, hourUsdc: 0.0125, totalUsdc: 0.05, budgetHourUsdc: 0.5, llmTickUsd: 0.000076, llmDayUsd: 0.0003, llmTotalUsd: 0.0003, llmCapDayUsd: 0.5 }
  };
  const line = formatTickLine(entry);
  assert.match(line, /^20:00:05 #7 wake=swap swap 0xe28f4014/);
  assert.match(line, /bought book 0\.001 USDC \(hour 0\.0125\/0\.5\)/);
  assert.match(line, /ARS \+30\.0bps oracle 27561s ok, BRL \+263\.6bps oracle 2s ok/);
  assert.match(line, /llm:gpt-5-nano: rebalance USDC\/BRL - BRL spread 263\.6 bps above 150/);
  assert.match(line, /model gpt-5-nano 930\/74 tok \$0\.000076/);
  assert.match(line, /spread 263\.6 -> 30 bps/);
  assert.match(line, /https:\/\/testnet\.arcscan\.app\/tx\/0xabc$/);
});
