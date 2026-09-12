/**
 * Guard rails for the operator's testnet USDC top-ups on sign-in: each wallet and each signed-in user is topped up at
 * most once, and all top-ups together stay under a rolling 24 hour cap. The ledger is a JSON file kept by the server
 * that holds the operator wallet (`~/.aqua0/onboarding-topups.json` by default).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { formatUnits } from "viem";

export type TopUpRecord = {
  wallet: Lowercase<string>;
  userId?: string;
  /** Raw USDC units. */
  amount: string;
  hash: string;
  at: string;
};

export type TopUpLedger = { version: 1; topUps: TopUpRecord[] };

const DAY_MS = 86_400_000;

export function topUpLedgerPath(file?: string): string {
  return file ?? join(homedir(), ".aqua0", "onboarding-topups.json");
}

/** The ledger, empty when the file does not exist. A malformed ledger throws, so no top-up is sent past it. */
export function readTopUpLedger(file?: string): TopUpLedger {
  const path = topUpLedgerPath(file);
  if (!existsSync(path)) {
    return { version: 1, topUps: [] };
  }
  const ledger = JSON.parse(readFileSync(path, "utf8")) as Partial<TopUpLedger>;
  if (ledger.version !== 1 || !Array.isArray(ledger.topUps)) {
    throw new Error(`Top-up ledger ${path} is not a version 1 ledger; fix or move it before topping up`);
  }
  return ledger as TopUpLedger;
}

export function appendTopUp(record: TopUpRecord, file?: string): void {
  const path = topUpLedgerPath(file);
  const ledger = readTopUpLedger(file);
  ledger.topUps.push(record);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Why a top-up must not be sent, or undefined when it may: once per wallet and per user, within the daily cap. */
export function topUpRefusal(
  ledger: TopUpLedger,
  input: { wallet: string; userId?: string | undefined; amount: bigint; dailyCap: bigint; now: number; decimals: number }
): string | undefined {
  const wallet = input.wallet.toLowerCase();
  const previous = ledger.topUps.find(
    (record) => record.wallet === wallet || (input.userId !== undefined && record.userId === input.userId)
  );
  if (previous) {
    return `this ${previous.wallet === wallet ? "wallet" : "user"} was already topped up (${previous.at}, tx ${previous.hash})`;
  }
  const spent = ledger.topUps
    .filter((record) => Date.parse(record.at) > input.now - DAY_MS)
    .reduce((sum, record) => sum + BigInt(record.amount), 0n);
  if (spent + input.amount > input.dailyCap) {
    return `the daily top-up cap is reached (${formatUnits(spent, input.decimals)} of ${formatUnits(input.dailyCap, input.decimals)} USDC sent in the last 24 hours)`;
  }
  return undefined;
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs top-ups one at a time in this process, so two simultaneous sign-ins cannot both pass the ledger check. */
export function withTopUpLock<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}
