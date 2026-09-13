import assert from "node:assert/strict";
import test from "node:test";

import type { KeeperJournalEntry } from "@aqua0/shared";

import { formatTickBlock, formatTickLine } from "../src/format.js";

function heartbeat(bookCached: boolean): KeeperJournalEntry {
  return {
    v: 1,
    type: "tick",
    ts: "2026-09-13T04:00:00.000Z",
    tick: 7,
    wake: { kind: "heartbeat" },
    signals: [
      {
        pair: "USDC/BRL",
        strategyId: "0x87e021d4a0a607f009dbb4689b593ce816c6d13fde885282ce385888290f2aa1",
        spreadBps: 29.99,
        side: "balanced",
        oracleAgeSeconds: 40,
        oracleStatus: "ok",
        ...(bookCached ? { bookCached: true } : {})
      }
    ],
    outcome: { action: "wait", reason: "oracles fresh; book not re-read this heartbeat", by: "rules", txs: [] }
  } as KeeperJournalEntry;
}

test("a spread carried over from an earlier tick is labelled cached", () => {
  assert.match(formatTickLine(heartbeat(true)), /BRL \+30\.0bps \(cached\) oracle 40s ok/);
});

test("a spread read this tick has no cached label", () => {
  const line = formatTickLine(heartbeat(false));
  assert.match(line, /BRL \+30\.0bps oracle 40s ok/);
  assert.doesNotMatch(line, /cached/);
});

test("a live tick prints as a labelled block with the rebalance result and links", () => {
  const entry = {
    v: 1,
    type: "tick",
    ts: "2026-09-13T04:01:00.000Z",
    tick: 4,
    wake: { kind: "swap", detail: "swap 0xa1ed7419... usdc-in on USDC/BRL by 0xb0c068..." },
    steps: [{ receipt: { route: "/v1/book", amountUsdc: "0.001", settlement: null, ms: 900 } }],
    signals: [
      { pair: "USDC/ARS", strategyId: "0x1", spreadBps: 30.1, side: "balanced", oracleAgeSeconds: 63974, oracleStatus: "ok", bookCached: true },
      { pair: "USDC/BRL", strategyId: "0x2", spreadBps: 29.99, side: null, oracleAgeSeconds: 0, oracleStatus: "ok" }
    ],
    outcome: {
      action: "rebalance",
      reason: "USDC/BRL spread 265.53 bps above 150",
      by: "llm:gpt-5-nano",
      pair: "USDC/BRL",
      txs: [{ stage: "swap BRAt -> USDC", hash: "0xa3", url: "https://testnet.arcscan.app/tx/0xa3" }],
      spreadBeforeBps: 265.53,
      spreadAfterBps: 29.99
    },
    spend: { tickUsdc: 0.001, hourUsdc: 0.006, totalUsdc: 0.006, budgetHourUsdc: 0.5, llmTickUsd: 0.0001, llmDayUsd: 0.0001, llmTotalUsd: 0.0001, llmCapDayUsd: 0.5 }
  } as unknown as KeeperJournalEntry;

  const plain = formatTickBlock(entry);
  assert.doesNotMatch(plain, /\u001b\[/);
  assert.match(plain, /^04:01:00 #4 swap swap 0xa1ed7419/);
  assert.match(plain, /paid {5}book · 0\.001 USDC \(hour 0\.006\/0\.5\)/);
  assert.match(plain, /ARS \+30\.1 bps \(cached\) oracle 17\.8h ok {3}BRL \+30\.0 bps oracle 0s ok/);
  assert.match(plain, /decision {1}llm:gpt-5-nano rebalance USDC\/BRL · USDC\/BRL spread 265\.53 bps above 150/);
  assert.match(plain, /result {3}265\.53 bps → 29\.99 bps/);
  assert.match(plain, /tx {7}swap BRAt -> USDC https:\/\/testnet\.arcscan\.app\/tx\/0xa3/);

  const colored = formatTickBlock(entry, { color: true });
  assert.match(colored, /\u001b\[1m\u001b\[33mrebalance\u001b\[39m\u001b\[22m/);
  assert.equal(colored.replace(/\u001b\[\d+m/g, ""), plain);
});
