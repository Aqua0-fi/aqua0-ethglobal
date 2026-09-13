import assert from "node:assert/strict";
import test from "node:test";

import type { KeeperJournalEntry } from "@aqua0/shared";

import { formatTickLine } from "../src/format.js";

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
