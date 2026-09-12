/**
 * RedStone pull prices for the forex curve on Arc Testnet.
 *
 * The forex curve reads a Chainlink-style feed (`latestRoundData`). On Arc that feed is an AquaRedStonePriceFeed over an
 * AquaRedStoneMultiFeedAdapter holding RedStone `redstone-primary-prod` values. Nobody runs a keeper: before a swap
 * the client fetches a signed payload from RedStone's public gateways (no API key) and sends
 * `updateDataFeedsValuesPartial(feedIds)` with the payload appended to the calldata. The adapter stores a value only
 * when 3 of the 5 primary-prod signers agree and the data timestamp is newer than the stored one and at most
 * 3 minutes old.
 *
 * Quotes need no transaction: the payload is decoded here exactly as the adapter would aggregate it (median per
 * feed), and `eth_call` runs with a state override that places those values in the adapter's storage.
 */
import { requestRedstonePayload } from "@redstone-finance/sdk";
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hexToBytes,
  keccak256,
  stringToHex,
  toHex,
  type Address,
  type Hex,
  type StateOverride
} from "viem";

export const REDSTONE_DATA_SERVICE_ID = "redstone-primary-prod";
export const REDSTONE_UNIQUE_SIGNERS = 3;
export const REDSTONE_FEED_DECIMALS = 8;

/** Signers `MultiFeedAdapterWithoutRoundsPrimaryProd` authorises on-chain; the SDK checks packages against them too. */
export const REDSTONE_PRIMARY_PROD_SIGNERS = [
  "0x8BB8F32Df04c8b654987DAaeD53D6B6091e3B774",
  "0xdEB22f54738d54976C4c0fe5ce6d408E40d88499",
  "0x51Ce04Be4b3E32572C4Ec9135221d0691Ba7d202",
  "0xDD682daEC5A90dD295d14DA4b0bec9281017b5bE",
  "0x9c5AE89C4Af6aA32cE58588DBaF90d18a855B6de"
] as const;

/** `keccak256("RedStone.MultiFeedAdapterWithoutRounds.dataFeeds")`: base of the adapter's feed mapping. */
export const REDSTONE_DATA_FEEDS_STORAGE_LOCATION =
  "0x5e9fb4cb0eb3c2583734d3394f30bb14b241acb9b3a034f7e7ba1a62db4370f1" as const;

const REDSTONE_MARKER = "0x000002ed57011e0000";
const UINT48_MAX = (1n << 48n) - 1n;
const UINT152_MAX = (1n << 152n) - 1n;

export const redstoneMultiFeedAdapterAbi = [
  {
    type: "function",
    name: "updateDataFeedsValuesPartial",
    stateMutability: "nonpayable",
    inputs: [{ name: "dataFeedsIds", type: "bytes32[]" }],
    outputs: []
  },
  {
    type: "function",
    name: "getLastUpdateDetailsUnsafe",
    stateMutability: "view",
    inputs: [{ name: "dataFeedId", type: "bytes32" }],
    outputs: [
      { name: "lastDataTimestamp", type: "uint256" },
      { name: "lastBlockTimestamp", type: "uint256" },
      { name: "lastValue", type: "uint256" }
    ]
  }
] as const;

export type RedstoneDataPackage = {
  /** Data timestamp in milliseconds, as signed. */
  timestampMs: bigint;
  points: { feed: string; value: bigint }[];
};

export type RedstonePrice = {
  feed: string;
  /** Median of the signed values, 8 decimals: the value the adapter would store. */
  value: bigint;
  dataTimestampMs: bigint;
  signerValues: bigint[];
};

export type RedstoneUpdate = {
  feeds: string[];
  payload: Hex;
  /** `updateDataFeedsValuesPartial(feeds)` calldata with the payload appended. Valid for about 3 minutes. */
  calldata: Hex;
  prices: RedstonePrice[];
};

/** RedStone feed ids are the ASCII symbol right-padded to bytes32, e.g. `BRL`, `MXNe`. */
export function redstoneDataFeedId(feed: string): Hex {
  return stringToHex(feed, { size: 32 });
}

/** Fetches a signed `redstone-primary-prod` payload for `feeds` (hex, 0x-prefixed). */
export async function fetchRedstonePayload(feeds: readonly string[]): Promise<Hex> {
  const payload = await requestRedstonePayload({
    dataServiceId: REDSTONE_DATA_SERVICE_ID,
    dataPackagesIds: [...feeds],
    uniqueSignersCount: REDSTONE_UNIQUE_SIGNERS,
    authorizedSigners: [...REDSTONE_PRIMARY_PROD_SIGNERS]
  });
  return `0x${payload.replace(/^0x/, "")}`;
}

/** Fetches a payload for `feeds` and returns the update calldata plus the prices it will store. */
export async function fetchRedstoneUpdate(feeds: readonly string[]): Promise<RedstoneUpdate> {
  const payload = await fetchRedstonePayload(feeds);
  const call = encodeFunctionData({
    abi: redstoneMultiFeedAdapterAbi,
    functionName: "updateDataFeedsValuesPartial",
    args: [feeds.map(redstoneDataFeedId)]
  });
  return {
    feeds: [...feeds],
    payload,
    calldata: `${call}${payload.slice(2)}`,
    prices: aggregateRedstonePrices(decodeRedstonePayload(payload), feeds)
  };
}

/**
 * Decodes a RedStone payload read from its end, like the on-chain CalldataExtractor:
 * `[packages][packages count 2][unsigned metadata][metadata size 3][marker 9]`, each package being
 * `[points: feedId 32, value N][timestamp 6][value size 4][points count 3][signature 65]`. Signatures are not checked
 * here; the adapter checks them on-chain.
 */
export function decodeRedstonePayload(payload: Hex): RedstoneDataPackage[] {
  const bytes = hexToBytes(payload);
  const readUint = (start: number, size: number) => {
    if (start < 0) {
      throw new Error("RedStone payload is truncated");
    }
    let value = 0n;
    for (let index = start; index < start + size; index += 1) {
      value = (value << 8n) | BigInt(bytes[index] ?? 0);
    }
    return value;
  };
  let end = bytes.length - 9;
  if (end < 0 || toHex(bytes.slice(end)) !== REDSTONE_MARKER) {
    throw new Error("Not a RedStone payload: the 0x000002ed57011e0000 marker is missing");
  }
  const metadataSize = Number(readUint(end - 3, 3));
  end -= 3 + metadataSize;
  const packageCount = Number(readUint(end - 2, 2));
  end -= 2;
  const packages: RedstoneDataPackage[] = [];
  for (let pkg = 0; pkg < packageCount; pkg += 1) {
    end -= 65;
    const pointCount = Number(readUint(end - 3, 3));
    end -= 3;
    const valueSize = Number(readUint(end - 4, 4));
    end -= 4;
    const timestampMs = readUint(end - 6, 6);
    end -= 6;
    const points: RedstoneDataPackage["points"] = [];
    for (let point = 0; point < pointCount; point += 1) {
      end -= valueSize;
      const value = readUint(end, valueSize);
      end -= 32;
      const id = bytes.slice(end, end + 32);
      const length = id.findIndex((byte) => byte === 0);
      points.unshift({ feed: new TextDecoder().decode(length === -1 ? id : id.slice(0, length)), value });
    }
    packages.unshift({ timestampMs, points });
  }
  return packages;
}

/** Median per feed across packages, matching `NumericArrayLib.pickMedian` (mean of the middle two when even). */
export function aggregateRedstonePrices(
  packages: readonly RedstoneDataPackage[],
  feeds: readonly string[]
): RedstonePrice[] {
  return feeds.map((feed) => {
    const found = packages.flatMap((pkg) =>
      pkg.points.filter((point) => point.feed === feed).map((point) => ({ value: point.value, ts: pkg.timestampMs }))
    );
    if (found.length < REDSTONE_UNIQUE_SIGNERS) {
      throw new Error(`RedStone payload has ${found.length} signed values for ${feed}; the adapter needs ${REDSTONE_UNIQUE_SIGNERS}`);
    }
    const sorted = found.map((entry) => entry.value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const middle = Math.floor(sorted.length / 2);
    const value = sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2n : sorted[middle]!;
    return { feed, value, dataTimestampMs: found[0]!.ts, signerValues: found.map((entry) => entry.value) };
  });
}

/** Storage slot of `feed` in the adapter's `DataFeedDetails` mapping. */
export function redstoneFeedStorageSlot(feed: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }],
      [redstoneDataFeedId(feed), REDSTONE_DATA_FEEDS_STORAGE_LOCATION]
    )
  );
}

/**
 * `eth_call` state override that makes `adapter` hold `prices` as if they had been pushed in a block at
 * `blockTimestamp`. The packed slot is `dataTimestamp uint48 | blockTimestamp uint48 | value uint152 | isValueBigger`.
 */
export function redstoneStateOverride(
  adapter: string,
  prices: readonly RedstonePrice[],
  blockTimestamp: bigint
): StateOverride {
  return [
    {
      address: getAddress(adapter) as Address,
      stateDiff: prices.map((price) => {
        if (price.value <= 0n || price.value > UINT152_MAX || price.dataTimestampMs > UINT48_MAX || blockTimestamp > UINT48_MAX) {
          throw new Error(`RedStone ${price.feed} value or timestamp does not fit the adapter's packed slot`);
        }
        return {
          slot: redstoneFeedStorageSlot(price.feed),
          value: toHex(price.dataTimestampMs | (blockTimestamp << 48n) | (price.value << 96n), { size: 32 })
        };
      })
    }
  ];
}

/** Calldata for `updateDataFeedsValuesPartial(feeds)` with a fresh signed payload appended. */
export async function buildRedstoneUpdateCalldata(feeds: readonly string[]): Promise<Hex> {
  return (await fetchRedstoneUpdate(feeds)).calldata;
}
