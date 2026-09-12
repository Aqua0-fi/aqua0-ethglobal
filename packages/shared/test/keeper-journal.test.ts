import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendKeeperJournal,
  keeperJournalPath,
  readKeeperJournal,
  summarizeKeeperStatus,
  txRef,
  type KeeperJournalEntry
} from "../src/keeper-journal.js";

function tempJournal(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "aqua0-keeper-"));
  return { file: join(dir, "journal.jsonl"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const HASH = "0xdc6809a9ae165d849250cac93ec49c9918513fc0d7aaab25595e7dba6f02ec6f";

function tick(ts: string, overrides: Partial<KeeperJournalEntry> = {}): KeeperJournalEntry {
  return {
    v: 1,
    type: "tick",
    ts,
    tick: 1,
    mode: "live",
    policy: "rules",
    model: null,
    wake: { kind: "heartbeat" },
    signals: [{ pair: "USDC/BRL", strategyId: "0x87", spreadBps: 30, side: "balanced", oracleAgeSeconds: 2, oracleStatus: "ok" }],
    steps: [
      {
        decision: { action: "buy_signal", which: "book", reason: "heartbeat" },
        by: "rules",
        guard: { allowed: true },
        spendUsdc: 0.001,
        receipt: { route: "/v1/book", amountUsdc: "0.001", settlement: "id-1", ms: 900 }
      }
    ],
    outcome: { action: "wait", reason: "books flat", by: "rules", txs: [] },
    spend: { tickUsdc: 0.001, hourUsdc: 0.001, totalUsdc: 0.001, budgetHourUsdc: 0.5, llmTickUsd: 0, llmDayUsd: 0, llmTotalUsd: 0, llmCapDayUsd: 0.5 },
    ...overrides
  };
}

test("journal path: explicit file, then AQUA0_KEEPER_JOURNAL, then ~/.aqua0/keeper/journal.jsonl", () => {
  assert.equal(keeperJournalPath("/tmp/x.jsonl", {}), "/tmp/x.jsonl");
  assert.equal(keeperJournalPath(undefined, { AQUA0_KEEPER_JOURNAL: "/tmp/y.jsonl" }), "/tmp/y.jsonl");
  assert.ok(keeperJournalPath(undefined, {}).endsWith(join(".aqua0", "keeper", "journal.jsonl")));
});

test("append then read returns entries in order and skips a torn last line", () => {
  const { file, cleanup } = tempJournal();
  try {
    appendKeeperJournal(tick("2026-09-12T19:00:00.000Z"), file);
    appendKeeperJournal(tick("2026-09-12T19:00:20.000Z", { tick: 2 }), file);
    writeFileSync(file, '{"v":1,"type":"tick","ts":"2026', { flag: "a" });
    const entries = readKeeperJournal({ file });
    assert.equal(entries.length, 2);
    assert.equal(entries[1]?.tick, 2);
    assert.equal(readKeeperJournal({ file, last: 1 }).length, 1);
    assert.deepEqual(readKeeperJournal({ file: join(file, "..", "missing.jsonl") }), []);
  } finally {
    cleanup();
  }
});

test("status answers 'did the keeper rebalance?' with spreads, tx links and spend", () => {
  const now = Date.parse("2026-09-12T19:02:00.000Z");
  const entries: KeeperJournalEntry[] = [
    { v: 1, type: "start", ts: "2026-09-12T19:00:00.000Z", mode: "live", policy: "llm", model: "gpt-5-nano", keeper: { address: "0x5214" } },
    tick("2026-09-12T19:00:20.000Z"),
    tick("2026-09-12T19:01:40.000Z", {
      tick: 2,
      policy: "llm",
      model: "gpt-5-nano",
      wake: { kind: "swap", detail: "0xe28f... on USDC/BRL" },
      steps: [
        {
          decision: { action: "buy_signal", which: "book", reason: "a swap moved USDC/BRL" },
          by: "rules",
          guard: { allowed: true },
          spendUsdc: 0.001,
          receipt: { route: "/v1/book", amountUsdc: "0.001", settlement: "id-2", ms: 800 }
        },
        {
          decision: { action: "rebalance", pair: "USDC/BRL", direction: "fx-in", sizeUsdc: 0.1, reason: "spread 263.6 bps above 150" },
          by: "llm",
          llm: { model: "gpt-5-nano", inputTokens: 900, outputTokens: 80, costUsd: 0.000077, ms: 1200 },
          guard: { allowed: true }
        }
      ],
      outcome: {
        action: "rebalance",
        pair: "USDC/BRL",
        reason: "spread 263.6 bps above 150",
        by: "llm",
        txs: [txRef("swap BRAt -> USDC", HASH)],
        spreadBeforeBps: 263.6,
        spreadAfterBps: 30
      },
      spend: { tickUsdc: 0.001, hourUsdc: 0.002, totalUsdc: 0.002, budgetHourUsdc: 0.5, llmTickUsd: 0.000077, llmDayUsd: 0.000077, llmTotalUsd: 0.000077, llmCapDayUsd: 0.5 }
    })
  ];
  const status = summarizeKeeperStatus(entries, { now, journal: "/tmp/j.jsonl" });
  assert.equal(status.running, true);
  assert.equal(status.model, "gpt-5-nano");
  assert.equal(status.lastRebalance?.pair, "USDC/BRL");
  assert.equal(status.lastRebalance?.txs[0]?.url, `https://testnet.arcscan.app/tx/${HASH}`);
  assert.equal(status.spend.signalsBought, 2);
  assert.equal(status.spend.nanopaymentsUsdcTotal, 0.002);
  assert.equal(status.spend.llmUsdTotal, 0.000077);
  assert.match(status.summary, /Last rebalance: USDC\/BRL/);
  assert.match(status.summary, /263\.60 bps -> 30\.00 bps/);
  assert.equal(status.recentTicks.at(-1)?.wake, "swap: 0xe28f... on USDC/BRL");
  assert.deepEqual(status.recentTicks.at(-1)?.txs, [`https://testnet.arcscan.app/tx/${HASH}`]);
});

test("a stopped or silent keeper is reported as not running", () => {
  const stopped = summarizeKeeperStatus(
    [tick("2026-09-12T19:00:20.000Z"), { v: 1, type: "stop", ts: "2026-09-12T19:00:30.000Z" }],
    { now: Date.parse("2026-09-12T19:00:40.000Z") }
  );
  assert.equal(stopped.running, false);
  assert.match(stopped.runningNote, /Stopped/);
  const silent = summarizeKeeperStatus([tick("2026-09-12T18:00:00.000Z")], { now: Date.parse("2026-09-12T19:00:00.000Z") });
  assert.equal(silent.running, false);
  assert.equal(summarizeKeeperStatus([]).summary.startsWith("No journal entries"), true);
});
