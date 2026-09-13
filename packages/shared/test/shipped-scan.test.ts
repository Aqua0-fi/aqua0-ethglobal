import assert from "node:assert/strict";
import test from "node:test";
import { keccak256 } from "viem";

import { scanShippedStrategies } from "../src/fx.js";
import { encodeSwapVMOrder } from "../src/swapvm.js";

const venue = { aqua: "0x490d2eceD9aCF99e1db6090f820775bFa70020D4", aquaStartBlock: 0n } as never;

function shippedLog(maker: string, data: `0x${string}`) {
  const strategy = encodeSwapVMOrder({ maker: maker as `0x${string}`, traits: 0n, data });
  return { strategyHash: keccak256(strategy), args: { maker, strategyHash: keccak256(strategy), strategy } };
}

test("a page rejected by the RPC is retried with half the window, and the found order is then served from memory", async () => {
  const maker = "0xc9cD056FCF2EF46116259fb094BD897c7E7C0EfB";
  const log = shippedLog(maker, "0x1234");
  const windows: bigint[] = [];
  let blockReads = 0;
  const client = {
    getBlockNumber: async () => {
      blockReads += 1;
      return 20_000n;
    },
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      windows.push(toBlock - fromBlock + 1n);
      if (windows.length === 1) {
        throw new Error("Request exceeds defined limit.");
      }
      return [log];
    }
  } as never;

  const found = await scanShippedStrategies(client, venue, [maker], undefined, { retryDelayMs: 1 });
  assert.equal(found.error, undefined);
  assert.equal(found.strategies.length, 1);
  assert.equal(found.strategies[0]!.strategyId, log.strategyHash.toLowerCase());
  assert.deepEqual(windows.slice(0, 2), [10_000n, 5_000n]);

  const logReads = windows.length;
  const cached = await scanShippedStrategies(client, venue, [maker], log.strategyHash, { retryDelayMs: 1 });
  assert.equal(cached.strategies[0]!.strategyId, log.strategyHash.toLowerCase());
  assert.equal(windows.length, logReads, "a known strategy id needs no log read");
  assert.equal(blockReads, 1, "a known strategy id needs no block read");
});

test("a scan that keeps failing returns the RPC error instead of throwing", async () => {
  let reads = 0;
  const client = {
    getBlockNumber: async () => 20_000n,
    getLogs: async () => {
      reads += 1;
      throw new Error("Request exceeds defined limit.");
    }
  } as never;

  const found = await scanShippedStrategies(client, venue, ["0x0000000000000000000000000000000000000001"], undefined, {
    retryDelayMs: 1
  });
  assert.equal(found.strategies.length, 0);
  assert.match(found.error ?? "", /exceeds defined limit/);
  assert.equal(reads, 5, "one read plus four retries");
});
