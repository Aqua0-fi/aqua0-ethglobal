import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendTopUp, readTopUpLedger, topUpRefusal, withTopUpLock } from "../src/onboarding.js";

const USDC = 10n ** 6n;
const NOW = Date.parse("2026-09-12T18:00:00.000Z");
const WALLET = "0x34f90ed31798a8017f558e37e26c62f58731450f";

test("a top-up is refused for a wallet or user already topped up, and past the rolling daily cap", () => {
  const ledger = {
    version: 1 as const,
    topUps: [
      { wallet: WALLET, userId: "did:privy:a", amount: String(5n * USDC), hash: "0x01", at: "2026-09-12T15:00:00.000Z" },
      { wallet: "0x00000000000000000000000000000000000000b2" as const, amount: String(40n * USDC), hash: "0x02", at: "2026-09-11T19:00:00.000Z" },
      { wallet: "0x00000000000000000000000000000000000000c3" as const, amount: String(40n * USDC), hash: "0x03", at: "2026-09-10T12:00:00.000Z" }
    ]
  };
  const base = { amount: 5n * USDC, dailyCap: 50n * USDC, now: NOW, decimals: 6 };

  assert.match(topUpRefusal(ledger, { ...base, wallet: WALLET.toUpperCase().replace("0X", "0x") }) ?? "", /wallet was already topped up/);
  assert.match(topUpRefusal(ledger, { ...base, wallet: "0x00000000000000000000000000000000000000d4", userId: "did:privy:a" }) ?? "", /user was already topped up/);
  // 45 USDC went out in the last 24 hours (the 40 USDC from two days ago has rolled off): 5 more fits, 6 does not.
  assert.equal(topUpRefusal(ledger, { ...base, wallet: "0x00000000000000000000000000000000000000d4", userId: "did:privy:b" }), undefined);
  assert.match(
    topUpRefusal(ledger, { ...base, amount: 6n * USDC, wallet: "0x00000000000000000000000000000000000000d4" }) ?? "",
    /daily top-up cap is reached \(45 of 50 USDC/
  );
});

test("the ledger file is created owner-only, appended atomically, and a malformed ledger blocks top-ups", () => {
  const dir = mkdtempSync(join(tmpdir(), "aqua0-topups-"));
  const file = join(dir, "nested", "topups.json");
  assert.deepEqual(readTopUpLedger(file), { version: 1, topUps: [] });
  appendTopUp({ wallet: WALLET, userId: "did:privy:a", amount: "5000000", hash: "0x01", at: "2026-09-12T15:00:00.000Z" }, file);
  appendTopUp({ wallet: "0x00000000000000000000000000000000000000b2", amount: "5000000", hash: "0x02", at: "2026-09-12T16:00:00.000Z" }, file);
  assert.equal(readTopUpLedger(file).topUps.length, 2);
  assert.equal(statSync(file).mode & 0o777, 0o600);

  const broken = join(dir, "broken.json");
  writeFileSync(broken, JSON.stringify({ topUps: "nope" }));
  assert.throws(() => readTopUpLedger(broken), /not a version 1 ledger/);
});

test("top-ups run one at a time, even when one fails", async () => {
  const order: string[] = [];
  const slow = withTopUpLock(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push("first");
    throw new Error("send failed");
  });
  const fast = withTopUpLock(async () => {
    order.push("second");
    return "ok";
  });
  await assert.rejects(slow, /send failed/);
  assert.equal(await fast, "ok");
  assert.deepEqual(order, ["first", "second"]);
});
