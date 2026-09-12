/**
 * Market signals for the forex strategies, built only from existing reads: the router quote (oracle price, age,
 * freshness, band, effective spread), Aqua's per-strategy book balances, and the shared-backing read.
 *
 * The pure functions below turn those reads into the numbers a keeper decides on; they have no network access and are
 * unit-tested. `readSignalsSnapshot` performs the reads (unpaid, direct RPC). The signals seller serves the same
 * snapshot behind Circle Nanopayments, and the MCP `get_signals` tool returns it for free.
 */
import { formatUnits, getAddress, parseAbi, type Hex } from "viem";

import { ARC_TESTNET, ARC_TESTNET_DEPLOYMENT } from "./constants.js";
import { quoteFxSwap, readSharedBacking, resolveSwapVMVenue } from "./fx.js";
import { aquaAdapterAbi } from "./abis.js";
import { createReadClient, type WriteConfig } from "./write.js";

export type SignalName = "oracle" | "book" | "vault";

export type KeeperStrategyRef = {
  pair: "USDC/ARS" | "USDC/BRL";
  strategyId: Hex;
  fxSymbol: "ARGt" | "BRAt";
};

/** The live forex strategies on Arc Testnet (strategist: the demo Circle wallet), see deployments/arc-testnet-strategies.json. */
export const LIVE_FOREX_STRATEGIES: readonly KeeperStrategyRef[] = [
  { pair: "USDC/ARS", strategyId: "0xc39dd71deb079e2cd3b725f31562a74cea0e5266244170df4974739402f58597", fxSymbol: "ARGt" },
  { pair: "USDC/BRL", strategyId: "0x87e021d4a0a607f009dbb4689b593ce816c6d13fde885282ce385888290f2aa1", fxSymbol: "BRAt" }
];

/** Strategist of the live forex strategies (vault signal default). */
export const LIVE_FOREX_STRATEGIST = "0xb0c0687eb013a5ffde4d23a89398a11bc424d952";

/** Size of the probe quote a book's spread is measured with. */
export const SIGNAL_QUOTE_USDC = "0.1";

export type OracleStatus = "ok" | "stale" | "out-of-band" | "unknown";

export type OracleSignal = {
  source: string;
  price: string;
  /** Whole FX units per 1 USDC, as the curve prices (display and sizing only). */
  fxPerUsdc: number | null;
  ageSeconds: number | null;
  maxStalenessSeconds: number | null;
  fresh: boolean | null;
  inBand: boolean | null;
  status: OracleStatus;
  updatedAt: string | null;
};

export type BookSide = "usdc-heavy" | "fx-heavy" | "balanced";

export type RebalanceDirection = "fx-in" | "usdc-in";

export type BookSignal = {
  quoteUsdc: string;
  /** Effective spread of a 0.1 USDC -> FX quote, bps (fee plus any inventory fee; negative = rebate). */
  usdcInSpreadBps: number | null;
  /** Effective spread of the same value FX -> USDC, bps. */
  fxInSpreadBps: number | null;
  /** The worse of the two: how far the book is tilted for the next trader. */
  spreadBps: number | null;
  usdcBalance: number;
  fxBalance: number;
  fxValueUsdc: number | null;
  /** USDC share of the book's value at the oracle price, 0..1 (0.5 is an even split). */
  usdcShare: number | null;
  side: BookSide;
  /** Half the value gap between the two sides, in USDC: the trade that restores an even split. */
  imbalanceUsdc: number | null;
  rebalance: { direction: RebalanceDirection; sizeUsdc: number; fxAmount: number } | null;
};

export type StrategySignal = {
  pair: string;
  strategyId: Hex;
  live: boolean;
  oracle: OracleSignal | null;
  book: BookSignal | null;
  errors: string[];
};

export type VaultSignal = {
  lp: string;
  usdcPrincipal: string;
  usdcFreePrincipal: string;
  classes: Array<{
    classId: string;
    pair: string | null;
    committedBackingUsdc: string;
    availableForUsdc: string;
    liveStrategies: number;
  }>;
};

export type SignalsSnapshot = {
  source: string;
  chainId: number;
  blockNumber: string;
  at: string;
  strategies: StrategySignal[];
  vault?: VaultSignal | { error: string };
};

// ---------------------------------------------------------------------------------------------
// pure

/** "+263.99" -> 263.99, "-4.10" -> -4.1; anything unparsable -> null. */
export function parseSignedBps(text: string | null | undefined): number | null {
  if (typeof text !== "string") {
    return null;
  }
  const match = /^\s*([+-]?\d+(?:\.\d+)?)/.exec(text);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** "1400 ARGt per USDC" -> 1400; "0.194117 USD per 1 BRL" -> 0.194117. */
export function parseLeadingNumber(text: string | null | undefined): number | null {
  if (typeof text !== "string") {
    return null;
  }
  const match = /^\s*(\d+(?:\.\d+)?)/.exec(text);
  return match?.[1] === undefined ? null : Number(match[1]);
}

export function classifyOracle(input: {
  ageSeconds: number | null;
  maxStalenessSeconds: number | null;
  fresh: boolean | null;
  inBand: boolean | null;
}): OracleStatus {
  if (input.inBand === false) {
    return "out-of-band";
  }
  if (input.fresh === false) {
    return "stale";
  }
  if (
    input.fresh === null &&
    input.ageSeconds !== null &&
    input.maxStalenessSeconds !== null &&
    input.ageSeconds > input.maxStalenessSeconds
  ) {
    return "stale";
  }
  if (input.fresh === null && input.inBand === null) {
    return "unknown";
  }
  return "ok";
}

/**
 * Book tilt from live balances at the oracle price. A book holding more USDC value than FX value is "usdc-heavy": the
 * next USDC -> FX trade pays the inventory fee, and an FX -> USDC trade of half the gap restores an even split.
 */
export function computeBook(input: {
  usdcBalance: number;
  fxBalance: number;
  fxPerUsdc: number | null;
  usdcInSpreadBps: number | null;
  fxInSpreadBps: number | null;
  /** Below this imbalance (USDC) the book counts as balanced. Default 0.005. */
  balancedEpsilonUsdc?: number;
}): BookSignal {
  const spreads = [input.usdcInSpreadBps, input.fxInSpreadBps].filter((value): value is number => value !== null);
  const spreadBps = spreads.length > 0 ? Math.max(...spreads) : null;
  const base = {
    quoteUsdc: SIGNAL_QUOTE_USDC,
    usdcInSpreadBps: input.usdcInSpreadBps,
    fxInSpreadBps: input.fxInSpreadBps,
    spreadBps,
    usdcBalance: input.usdcBalance,
    fxBalance: input.fxBalance
  };
  if (!input.fxPerUsdc || input.fxPerUsdc <= 0) {
    return { ...base, fxValueUsdc: null, usdcShare: null, side: "balanced", imbalanceUsdc: null, rebalance: null };
  }
  const fxValueUsdc = input.fxBalance / input.fxPerUsdc;
  const total = input.usdcBalance + fxValueUsdc;
  const usdcShare = total > 0 ? input.usdcBalance / total : null;
  const imbalanceUsdc = (input.usdcBalance - fxValueUsdc) / 2;
  const epsilon = input.balancedEpsilonUsdc ?? 0.005;
  const side: BookSide = Math.abs(imbalanceUsdc) < epsilon ? "balanced" : imbalanceUsdc > 0 ? "usdc-heavy" : "fx-heavy";
  const sizeUsdc = round6(Math.abs(imbalanceUsdc));
  return {
    ...base,
    fxValueUsdc: round6(fxValueUsdc),
    usdcShare: usdcShare === null ? null : round6(usdcShare),
    side,
    imbalanceUsdc: round6(imbalanceUsdc),
    rebalance:
      side === "balanced"
        ? null
        : {
            direction: side === "usdc-heavy" ? "fx-in" : "usdc-in",
            sizeUsdc,
            fxAmount: round6(sizeUsdc * input.fxPerUsdc)
          }
  };
}

/** One compact line per strategy, e.g. "USDC/BRL +263.60bps usdc-heavy oracle 3s ok". */
export function describeStrategySignal(signal: StrategySignal): string {
  const name = signal.pair.replace("USDC/", "");
  if (!signal.live) {
    return signal.errors.some((error) => error.startsWith("read failed")) ? `${name} read failed` : `${name} not live`;
  }
  const spread = signal.book?.spreadBps;
  const spreadText = spread === null || spread === undefined ? "spread n/a" : `${spread >= 0 ? "+" : ""}${spread.toFixed(2)}bps`;
  const side = signal.book && signal.book.side !== "balanced" ? ` ${signal.book.side}` : "";
  const oracle = signal.oracle
    ? ` oracle ${signal.oracle.ageSeconds ?? "?"}s ${signal.oracle.status}`
    : "";
  return `${name} ${spreadText}${side}${oracle}`;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------------------------
// reads

const aquaBalancesAbi = parseAbi([
  "function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248 balance, uint8 tokensCount)"
]);

/** Arc Testnet RPC and chain id when the caller configured none (reads only). */
export function withArcReadDefaults<T extends WriteConfig>(config: T): T {
  return {
    ...config,
    writeRpcUrl: config.writeRpcUrl ?? ARC_TESTNET.rpcUrl,
    writeChainId: config.writeChainId ?? ARC_TESTNET.chainId
  };
}

/** Oracle and book signals for one strategy: two probe quotes (both directions) and its Aqua balances. */
export async function readStrategySignal(config: WriteConfig, ref: KeeperStrategyRef): Promise<StrategySignal> {
  const cfg = withArcReadDefaults(config);
  const client = createReadClient(cfg);
  const venue = resolveSwapVMVenue(cfg);
  const adapter = getAddress(venue.forex?.adapter ?? ARC_TESTNET_DEPLOYMENT.fxVenue.forexAquaAdapter ?? "");
  const router = getAddress(venue.forex?.router ?? ARC_TESTNET_DEPLOYMENT.fxVenue.forexRouter ?? "");
  const errors: string[] = [];
  const hash = await client.readContract({
    address: adapter,
    abi: aquaAdapterAbi,
    functionName: "currentAquaHash",
    args: [ref.strategyId]
  });
  if (BigInt(hash) === 0n) {
    return { pair: ref.pair, strategyId: ref.strategyId, live: false, oracle: null, book: null, errors: ["strategy is not shipped (docked)"] };
  }
  const usdc = ARC_TESTNET_DEPLOYMENT.tokens.USDC;
  const fx = ARC_TESTNET_DEPLOYMENT.tokens[ref.fxSymbol];
  const [usdcIn, balances] = await Promise.all([
    quoteFxSwap(cfg, { strategyId: ref.strategyId, amount: SIGNAL_QUOTE_USDC }).catch((error: unknown) => {
      errors.push(`USDC-in quote: ${errorText(error)}`);
      return undefined;
    }),
    Promise.all(
      [usdc, fx].map((token) =>
        client.readContract({
          address: getAddress(ARC_TESTNET_DEPLOYMENT.contracts.aqua),
          abi: aquaBalancesAbi,
          functionName: "rawBalances",
          args: [adapter, router, hash, getAddress(token.address)]
        })
      )
    )
  ]);
  const pricing = usdcIn?.pricing as { oraclePrice?: string; effectiveSpreadBps?: string } | undefined;
  const fxPerUsdc = parseLeadingNumber(pricing?.oraclePrice);
  let fxIn: Awaited<ReturnType<typeof quoteFxSwap>> | undefined;
  if (fxPerUsdc) {
    fxIn = await quoteFxSwap(cfg, {
      strategyId: ref.strategyId,
      tokenIn: ref.fxSymbol,
      amount: (Number(SIGNAL_QUOTE_USDC) * fxPerUsdc).toFixed(6)
    }).catch((error: unknown) => {
      errors.push(`FX-in quote: ${errorText(error)}`);
      return undefined;
    });
  }
  const rawOracle = (usdcIn?.oracle ?? fxIn?.oracle) as
    | {
        source?: string;
        price?: string;
        ageSeconds?: string;
        updatedAt?: string;
        strategyMaxStalenessSeconds?: number;
        fresh?: boolean;
        strategyBand?: { inBand?: boolean };
      }
    | undefined;
  const oracle: OracleSignal | null = rawOracle
    ? (() => {
        const ageSeconds = rawOracle.ageSeconds === undefined ? null : Number(rawOracle.ageSeconds);
        const maxStalenessSeconds = rawOracle.strategyMaxStalenessSeconds ?? null;
        const fresh = rawOracle.fresh ?? null;
        const inBand = rawOracle.strategyBand?.inBand ?? null;
        return {
          source: rawOracle.source ?? "unknown",
          price: rawOracle.price ?? "unknown",
          fxPerUsdc,
          ageSeconds,
          maxStalenessSeconds,
          fresh,
          inBand,
          status: classifyOracle({ ageSeconds, maxStalenessSeconds, fresh, inBand }),
          updatedAt: rawOracle.updatedAt ?? null
        };
      })()
    : null;
  const [usdcRaw, fxRaw] = balances;
  const book = computeBook({
    usdcBalance: Number(formatUnits(usdcRaw?.[0] ?? 0n, usdc.decimals)),
    fxBalance: Number(formatUnits(fxRaw?.[0] ?? 0n, fx.decimals)),
    fxPerUsdc,
    usdcInSpreadBps: parseSignedBps(pricing?.effectiveSpreadBps),
    fxInSpreadBps: parseSignedBps((fxIn?.pricing as { effectiveSpreadBps?: string } | undefined)?.effectiveSpreadBps)
  });
  return { pair: ref.pair, strategyId: ref.strategyId, live: true, oracle, book, errors };
}

export async function readVaultSignal(config: WriteConfig, address: string = LIVE_FOREX_STRATEGIST): Promise<VaultSignal> {
  const backing = await readSharedBacking(withArcReadDefaults(config), { address, maxClassScan: 16 });
  return {
    lp: backing.lp,
    usdcPrincipal: backing.usdc.principal.formatted,
    usdcFreePrincipal: backing.usdc.freePrincipal.formatted,
    classes: backing.classes
      .filter((item) => item.lpCommittedUsdc)
      .map((item) => ({
        classId: item.classId,
        pair: item.pair,
        committedBackingUsdc: item.usdcVault.classCommittedBacking.formatted,
        availableForUsdc: item.usdcVault.classAvailableFor.formatted,
        liveStrategies: item.strategies.filter((strategy) => strategy.live).length
      }))
  };
}

/** Signals for every live forex strategy, plus the strategist's vault position when `vault` is requested. */
export async function readSignalsSnapshot(
  config: WriteConfig,
  options: { strategies?: readonly KeeperStrategyRef[]; include?: readonly SignalName[]; vaultAddress?: string } = {}
): Promise<SignalsSnapshot> {
  const cfg = withArcReadDefaults(config);
  const client = createReadClient(cfg);
  const include = new Set(options.include ?? ["oracle", "book"]);
  const strategies = options.strategies ?? LIVE_FOREX_STRATEGIES;
  const [blockNumber, strategySignals, vault] = await Promise.all([
    client.getBlockNumber(),
    include.has("oracle") || include.has("book")
      ? (async () => {
          // One strategy at a time: the public Arc RPC rate-limits bursts of parallel eth_calls.
          const rows: StrategySignal[] = [];
          for (const ref of strategies) {
            rows.push(
              await readStrategySignal(cfg, ref).catch(
                (error: unknown): StrategySignal => ({
                  pair: ref.pair,
                  strategyId: ref.strategyId,
                  live: false,
                  oracle: null,
                  book: null,
                  errors: [`read failed: ${errorText(error)}`]
                })
              )
            );
          }
          return rows;
        })()
      : Promise.resolve([] as StrategySignal[]),
    include.has("vault")
      ? readVaultSignal(cfg, options.vaultAddress).catch((error: unknown) => ({ error: errorText(error) }))
      : Promise.resolve(undefined)
  ]);
  return {
    source: "rpc: forex router quotes (both directions, 0.1 USDC), Aqua rawBalances, shared-backing reads",
    chainId: cfg.writeChainId ?? ARC_TESTNET.chainId,
    blockNumber: blockNumber.toString(),
    at: new Date().toISOString(),
    strategies: strategySignals,
    ...(vault ? { vault } : {})
  };
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}...` : message;
}
