import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyOracle,
  computeBook,
  describeStrategySignal,
  parseLeadingNumber,
  parseSignedBps
} from "../src/signals.js";

test("spread and price text from the quote response parse to numbers", () => {
  assert.equal(parseSignedBps("+263.99"), 263.99);
  assert.equal(parseSignedBps("-4.10"), -4.1);
  assert.equal(parseSignedBps("+30.00"), 30);
  assert.equal(parseSignedBps(undefined), null);
  assert.equal(parseSignedBps("n/a"), null);
  assert.equal(parseLeadingNumber("1400 ARGt per USDC"), 1400);
  assert.equal(parseLeadingNumber("5.15153 BRAt per USDC"), 5.15153);
  assert.equal(parseLeadingNumber(null), null);
});

test("a balanced book (the live ARS strategy) needs no rebalance", () => {
  const book = computeBook({ usdcBalance: 1.0006, fxBalance: 1400, fxPerUsdc: 1400, usdcInSpreadBps: 29.99, fxInSpreadBps: 30 });
  assert.equal(book.side, "balanced");
  assert.equal(book.rebalance, null);
  assert.equal(book.spreadBps, 30);
  assert.equal(book.usdcShare, 0.50015);
});

test("after a 0.1 USDC -> ARGt swap the book is usdc-heavy and an FX-in trade of half the gap restores it", () => {
  // 1.0006 + 0.1 USDC in, 139.58 ARGt out.
  const book = computeBook({ usdcBalance: 1.1006, fxBalance: 1260.42, fxPerUsdc: 1400, usdcInSpreadBps: 263.99, fxInSpreadBps: -12.5 });
  assert.equal(book.side, "usdc-heavy");
  assert.equal(book.spreadBps, 263.99);
  assert.ok(book.rebalance);
  assert.equal(book.rebalance.direction, "fx-in");
  assert.ok(Math.abs(book.rebalance.sizeUsdc - 0.0998) < 1e-3, `size ${book.rebalance.sizeUsdc}`);
  assert.ok(Math.abs(book.rebalance.fxAmount - book.rebalance.sizeUsdc * 1400) < 1e-3);
});

test("an FX-heavy book rebalances with USDC in", () => {
  const book = computeBook({ usdcBalance: 0.9, fxBalance: 5.67, fxPerUsdc: 5.15, usdcInSpreadBps: -10, fxInSpreadBps: 255 });
  assert.equal(book.side, "fx-heavy");
  assert.equal(book.rebalance?.direction, "usdc-in");
  assert.ok((book.rebalance?.sizeUsdc ?? 0) > 0.09);
});

test("without an oracle price the book cannot be sized", () => {
  const book = computeBook({ usdcBalance: 1, fxBalance: 5, fxPerUsdc: null, usdcInSpreadBps: null, fxInSpreadBps: null });
  assert.equal(book.rebalance, null);
  assert.equal(book.spreadBps, null);
  assert.equal(book.usdcShare, null);
});

test("oracle status: out of band wins over stale, stale by flag or by age", () => {
  assert.equal(classifyOracle({ ageSeconds: 10, maxStalenessSeconds: 3600, fresh: true, inBand: true }), "ok");
  assert.equal(classifyOracle({ ageSeconds: 7200, maxStalenessSeconds: 3600, fresh: false, inBand: true }), "stale");
  assert.equal(classifyOracle({ ageSeconds: 7200, maxStalenessSeconds: 3600, fresh: null, inBand: null }), "stale");
  assert.equal(classifyOracle({ ageSeconds: 7200, maxStalenessSeconds: 3600, fresh: false, inBand: false }), "out-of-band");
  assert.equal(classifyOracle({ ageSeconds: null, maxStalenessSeconds: null, fresh: null, inBand: null }), "unknown");
});

test("signal line is compact and readable", () => {
  const line = describeStrategySignal({
    pair: "USDC/BRL",
    strategyId: "0x87e021d4a0a607f009dbb4689b593ce816c6d13fde885282ce385888290f2aa1",
    live: true,
    oracle: { source: "RedStone", price: "0.19 USD per 1 BRL", fxPerUsdc: 5.15, ageSeconds: 3, maxStalenessSeconds: 3600, fresh: true, inBand: true, status: "ok", updatedAt: null },
    book: computeBook({ usdcBalance: 1.1, fxBalance: 4.64, fxPerUsdc: 5.15, usdcInSpreadBps: 263.6, fxInSpreadBps: -10 }),
    errors: []
  });
  assert.equal(line, "BRL +263.60bps usdc-heavy oracle 3s ok");
});
