import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { decodeFunctionData, encodeAbiParameters, keccak256, stringToHex, type Hex } from "viem";

import {
  REDSTONE_DATA_FEEDS_STORAGE_LOCATION,
  aggregateRedstonePrices,
  decodeRedstonePayload,
  redstoneDataFeedId,
  redstoneFeedStorageSlot,
  redstoneMultiFeedAdapterAbi,
  redstoneStateOverride
} from "../src/redstone.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/redstone-arc-update.json", import.meta.url), "utf8")
) as { adapter: string; calldata: Hex; dataTimestampMs: string; stored: { BRL: string; MXNe: string } };

test("decodes the RedStone update sent on Arc to exactly the values the adapter stored", () => {
  const { args } = decodeFunctionData({ abi: redstoneMultiFeedAdapterAbi, data: fixture.calldata });
  assert.deepEqual(args, [[redstoneDataFeedId("BRL"), redstoneDataFeedId("MXNe")]]);

  const packages = decodeRedstonePayload(fixture.calldata);
  assert.equal(packages.length, 6);
  assert.ok(packages.every((pkg) => pkg.timestampMs === BigInt(fixture.dataTimestampMs)));

  const [brl, mxn] = aggregateRedstonePrices(packages, ["BRL", "MXNe"]);
  assert.equal(brl?.value, BigInt(fixture.stored.BRL));
  assert.equal(mxn?.value, BigInt(fixture.stored.MXNe));
  assert.equal(brl?.signerValues.length, 3);
  assert.throws(() => aggregateRedstonePrices(packages, ["ARS"]), /0 signed values for ARS/);
});

test("median follows NumericArrayLib and malformed payloads are rejected", () => {
  const pkg = (value: bigint) => ({ timestampMs: 1n, points: [{ feed: "BRL", value }] });
  assert.equal(aggregateRedstonePrices([pkg(3n), pkg(1n), pkg(2n)], ["BRL"])[0]?.value, 2n);
  assert.equal(aggregateRedstonePrices([pkg(4n), pkg(1n), pkg(2n), pkg(9n)], ["BRL"])[0]?.value, 3n);
  assert.throws(() => decodeRedstonePayload("0x1234"), /marker is missing/);
});

test("state override packs the adapter's DataFeedDetails slot", () => {
  const slot = redstoneFeedStorageSlot("BRL");
  assert.equal(
    slot,
    keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }],
        [stringToHex("BRL", { size: 32 }), REDSTONE_DATA_FEEDS_STORAGE_LOCATION]
      )
    )
  );
  const [override] = redstoneStateOverride(
    fixture.adapter,
    [{ feed: "BRL", value: 19_402_073n, dataTimestampMs: 1_789_221_660_000n, signerValues: [] }],
    1_789_221_672n
  );
  const word = BigInt(override?.stateDiff?.[0]?.value ?? "0x0");
  assert.equal(word & ((1n << 48n) - 1n), 1_789_221_660_000n);
  assert.equal((word >> 48n) & ((1n << 48n) - 1n), 1_789_221_672n);
  assert.equal((word >> 96n) & ((1n << 152n) - 1n), 19_402_073n);
  assert.equal(word >> 248n, 0n);
  assert.throws(
    () => redstoneStateOverride(fixture.adapter, [{ feed: "BRL", value: 0n, dataTimestampMs: 1n, signerValues: [] }], 1n),
    /does not fit/
  );
});
