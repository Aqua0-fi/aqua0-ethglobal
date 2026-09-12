import { ARC_TESTNET_DEPLOYMENT } from "./constants.js";
import type { FetchLike } from "./graph.js";

/**
 * benchmark_fx_strategy: one standardized query pattern (the Messari DEX AMM schema) sent unchanged to every
 * standardized DEX subgraph on The Graph Network, composed with the Aqua0 subgraph on Subgraph Studio (live forex
 * strategies and their indexed fills on Arc Testnet).
 *
 * The standard is the leverage: Uniswap v3, Curve, SushiSwap and Velodrome on six chains answer the same
 * `liquidityPools` and snapshot queries, so adding a protocol or a chain is one subgraph id, not a new integration.
 * Uniswap-v3-schema subgraphs (Aerodrome on Base, the official Uniswap v3 subgraphs) are a labelled, non-standardized
 * fallback only.
 *
 * This module never prices the forex curve. The Aqua0 side is the strategy's proportional fee inside the flat band,
 * the indexed fills, and an optional live router quote supplied by the caller (quotes always go through the router).
 */

export const GRAPH_GATEWAY_SUBGRAPH_URL = "https://gateway.thegraph.com/api/subgraphs/id";

export const BENCHMARK_CHAINS = ["ethereum", "base", "polygon", "arbitrum", "optimism", "celo"] as const;
export type BenchmarkChain = (typeof BENCHMARK_CHAINS)[number];

export const BENCHMARK_CHAIN_IDS: Record<BenchmarkChain, number> = {
  ethereum: 1,
  base: 8453,
  polygon: 137,
  arbitrum: 42161,
  optimism: 10,
  celo: 42220
};

/**
 * USDC per chain (lowercase), native first, then bridged. Checked on 2026-09-12 with `tokens(where: { id_in })` on the
 * standardized subgraphs, which label each one USDC.
 */
export const BENCHMARK_USDC: Record<BenchmarkChain, readonly string[]> = {
  ethereum: ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
  // USDC and the bridged USDbC.
  base: ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca"],
  // USDC and the bridged USDC (PoS).
  polygon: ["0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", "0x2791bca1f2de4661ed88a30c99a7a9449aa84174"],
  // USDC and the bridged USDC (Arb1).
  arbitrum: ["0xaf88d065e77c8cc2239327c5edb3a432268e5831", "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8"],
  // USDC and the bridged USDC.e.
  optimism: ["0x0b2c639c533813f4aa9d7837caf62653d097ff85", "0x7f5c764cbc14f9669b88837ca1490cca17c31607"],
  // USDC and USDC (Wormhole).
  celo: ["0xceba9300f2b948710d2653dd7b07f33a8b32118c", "0x37f750b7cc259a2f741af45294f6a16572cf5cad"]
};

export type BenchmarkSubgraph = {
  protocol: string;
  chain: BenchmarkChain;
  subgraphId: string;
  schema: "messari-dex-amm" | "uniswap-v3";
  /** Why a non-standardized subgraph is queried. */
  note?: string;
};

/**
 * Messari DEX AMM standardized subgraphs published on The Graph Network (ids from messari/subgraphs
 * deployment/deployment.json, `decentralized-network` query ids) that answered through the gateway on 2026-09-12.
 * Not included: pancakeswap-v3 and curve-finance on Optimism ("no allocations"), balancer-v2 on Ethereum (indexing
 * error), curve-finance on Gnosis (stopped indexing in 2022).
 */
export const MESSARI_DEX_AMM_SUBGRAPHS: readonly BenchmarkSubgraph[] = [
  { protocol: "uniswap-v3", chain: "ethereum", subgraphId: "4cKy6QQMc5tpfdx8yxfYeb9TLZmgLQe44ddW1G7NwkA6", schema: "messari-dex-amm" },
  { protocol: "curve-finance", chain: "ethereum", subgraphId: "3fy93eAT56UJsRCEht8iFhfi6wjHWXtZ9dnnbQmvFopF", schema: "messari-dex-amm" },
  { protocol: "sushiswap", chain: "ethereum", subgraphId: "77jZ9KWeyi3CJ96zkkj5s1CojKPHt6XJKjLFzsDCd8Fd", schema: "messari-dex-amm" },
  { protocol: "uniswap-v3", chain: "base", subgraphId: "FUbEPQw1oMghy39fwWBFY5fE6MXPXZQtjncQy2cXdrNS", schema: "messari-dex-amm" },
  { protocol: "uniswap-v3", chain: "polygon", subgraphId: "BvYimJ6vCLkk63oWZy7WB5cVDTVVMugUAF35RAUZpQXE", schema: "messari-dex-amm" },
  { protocol: "sushiswap", chain: "polygon", subgraphId: "B3Jt84tHJJjanE4W1YijyksTwtm7jqK8KcG5dcoc1ZNF", schema: "messari-dex-amm" },
  { protocol: "uniswap-v3", chain: "arbitrum", subgraphId: "FQ6JYszEKApsBpAmiHesRsd9Ygc6mzmpNRANeVQFYoVX", schema: "messari-dex-amm" },
  { protocol: "sushiswap", chain: "arbitrum", subgraphId: "9tSS5FaePZnjmnXnSKCCqKVLAqA6eGg6jA2oRojsXUbP", schema: "messari-dex-amm" },
  { protocol: "uniswap-v3", chain: "optimism", subgraphId: "EgnS9YE1avupkvCNj9fHnJxppfEmNNywYJtghqiu2pd9", schema: "messari-dex-amm" },
  { protocol: "velodrome-finance-v2", chain: "optimism", subgraphId: "A4Y1A82YhSLTn998BVVELC8eWzhi992k4ZitByvssxqA", schema: "messari-dex-amm" },
  { protocol: "uniswap-v3", chain: "celo", subgraphId: "8cLf29KxAedWLVaEqjV8qKomdwwXQxjptBZFrqWNH5u2", schema: "messari-dex-amm" },
  { protocol: "sushiswap", chain: "celo", subgraphId: "5H97eNhy9fVHcqRXZtCV2UxHG2DbzcFA7yth1TaVZ45x", schema: "messari-dex-amm" }
];

/** Uniswap-v3-schema subgraphs, not standardized. Queried for a chain only as a fallback (see `fallback`). */
export const NON_STANDARDIZED_SUBGRAPHS: readonly BenchmarkSubgraph[] = [
  {
    protocol: "aerodrome",
    chain: "base",
    subgraphId: "GENunSHWLBXm59mBSgPzQ8metBEp9YDfdqwFr91Av1UM",
    schema: "uniswap-v3",
    note: "Aerodrome Base Full; Aerodrome has no Messari standardized subgraph"
  },
  {
    protocol: "uniswap-v3",
    chain: "ethereum",
    subgraphId: "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV",
    schema: "uniswap-v3",
    note: "official Uniswap v3 subgraph"
  },
  {
    protocol: "uniswap-v3",
    chain: "polygon",
    subgraphId: "3hCPRGf4z88VC5rsBKU5AA9FBBq5nF3jbKJG7VZCbhjm",
    schema: "uniswap-v3",
    note: "official Uniswap v3 subgraph"
  }
];

export type BenchmarkCurrency = "EUR" | "BRL" | "MXN" | "ARS" | "SGD" | "CAD";

type TokenPin = { symbol: string; address: string };

type CurrencyDefinition = {
  name: string;
  aliases: readonly string[];
  /** FX stablecoins per chain, shared by every protocol on that chain. */
  tokens: Partial<Record<BenchmarkChain, readonly TokenPin[]>>;
  /** The Aqua0 pair on Arc Testnet, when Aqua0 runs one for this currency. */
  arcPair?: "USDC/ARS" | "USDC/BRL";
  latam: boolean;
};

/**
 * FX stablecoin addresses, resolved per chain on 2026-09-12 with `tokens(where: { symbol_in: [...] })` on the subgraphs
 * above. Where several tokens share a symbol, the issuer's contract or the one holding USDC pools is pinned; look-alike
 * tokens with no pools are left out.
 */
export const BENCHMARK_CURRENCIES: Record<BenchmarkCurrency, CurrencyDefinition> = {
  EUR: {
    name: "Euro",
    aliases: ["eur", "euro", "euros", "eurc", "euroc", "eurcv", "eurs", "eure", "ageur", "eura", "ceur"],
    tokens: {
      ethereum: [
        // Circle EURC (still labelled EUROC in the subgraphs).
        { symbol: "EURC", address: "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c" },
        { symbol: "EURCV", address: "0x5f7827fdeb7c20b443265fc2f40845b715385ff2" },
        { symbol: "EURS", address: "0xdb25f211ab05b1c97d595516f45794528a807ad8" },
        { symbol: "EURA", address: "0x1a7e4e63778b4f12a199c062f3efdd288afcbce8" },
        { symbol: "EURe", address: "0x3231cb76718cdef2155fc47b5286d82e6eda273f" }
      ],
      base: [{ symbol: "EURC", address: "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42" }],
      polygon: [
        { symbol: "EURC", address: "0x8a037dbca8134ffc72c362e394e35e0cad618f85" },
        { symbol: "EURe", address: "0x18ec0a6e18e5bc3784fdd3a3634b31245ab704f6" },
        { symbol: "EURA", address: "0xe0b52e49357fd4daf2c15e02058dce6bc0057db4" },
        { symbol: "jEUR", address: "0x4e3decbb3645551b8a19f0ea1678079fcb33fb4c" }
      ],
      arbitrum: [
        { symbol: "EURC", address: "0x863708032b5c328e11abcbc0df9d79c71fc52a48" },
        { symbol: "EURe", address: "0x0c06ccf38114ddfc35e07427b9424adcca9f44f8" },
        { symbol: "EURA", address: "0xfa5ed56a203466cbbc2430a43c66b9d8723528e7" }
      ],
      optimism: [
        { symbol: "EURA", address: "0x9485aca5bbbe1667ad97c7fe7c4531a624c8b1ed" },
        { symbol: "jEUR", address: "0x79af5dd14e855823fa3e9ecacdf001d99647d043" }
      ],
      celo: [
        { symbol: "cEUR", address: "0xd8763cba276a3738e6de85b4b3bf5fded6d6ca73" },
        { symbol: "EURC", address: "0xbddc3554269053544be0d6d027a73271225e9859" }
      ]
    },
    latam: false
  },
  BRL: {
    name: "Brazilian real",
    aliases: ["brl", "real", "reais", "reales", "brz", "brla", "jbrl", "creal", "brat"],
    tokens: {
      ethereum: [{ symbol: "BRZ", address: "0x01d33fd36ec67c6ada32cf36b31e88ee190b1839" }],
      base: [{ symbol: "BRZ", address: "0xe9185ee218cae427af7b9764a011bb89fea761b4" }],
      polygon: [
        { symbol: "BRLA", address: "0xe6a537a407488807f0bbeb0038b79004f19dddfb" },
        { symbol: "BRZ", address: "0x4ed141110f6eeeaba9a1df36d8c26f684d2475dc" },
        { symbol: "jBRL", address: "0xf2f77fe7b8e66571e0fca7104c4d670bf1c8d722" }
      ],
      celo: [
        { symbol: "cREAL", address: "0xe8537a3d056da446677b9e9d6c5db704eaab4787" },
        { symbol: "BRLA", address: "0xfecb3f7c54e2caae9dc6ac9060a822d47e053760" }
      ]
    },
    arcPair: "USDC/BRL",
    latam: true
  },
  MXN: {
    name: "Mexican peso",
    aliases: ["mxn", "mxne", "mexican", "mexico"],
    tokens: {
      base: [{ symbol: "MXNe", address: "0x269cae7dc59803e5c596c95756faeebb6030e0af" }],
      polygon: [{ symbol: "MXNe", address: "0x615c2f42919c7fed56a44a5c62d5ef73f748fd0f" }]
    },
    latam: true
  },
  ARS: {
    name: "Argentine peso",
    aliases: ["ars", "peso", "pesos", "argentine", "argentina", "nars", "arst", "argt"],
    tokens: {
      base: [
        { symbol: "nARS", address: "0x5e40f26e89213660514c51fb61b2d357dbf63c85" },
        { symbol: "ARST", address: "0xe29410178928ecbf0f20203ede333aa6058c8767" }
      ],
      polygon: [{ symbol: "nARS", address: "0x65517425ac3ce259a34400bb67ceb39ff3ddc0bd" }]
    },
    arcPair: "USDC/ARS",
    latam: true
  },
  SGD: {
    name: "Singapore dollar",
    aliases: ["sgd", "xsgd", "singapore"],
    tokens: {
      ethereum: [{ symbol: "XSGD", address: "0x70e8de73ce538da2beed35d14187f6959a8eca96" }],
      base: [{ symbol: "XSGD", address: "0x0a4c9cb2778ab3302996a34befcf9a8bc288c33b" }],
      polygon: [
        { symbol: "XSGD", address: "0xdc3326e71d45186f113a2f448984ca0e8d201995" },
        { symbol: "XSGD", address: "0x769434dca303597c8fc4997bf3dab233e961eda2" }
      ],
      arbitrum: [
        { symbol: "XSGD", address: "0xa05245ade25cc1063ee50cf7c083b4524c1c4302" },
        { symbol: "XSGD", address: "0xe333e7754a2dc1e020a162ecab019254b9dab653" }
      ]
    },
    latam: false
  },
  CAD: {
    name: "Canadian dollar",
    aliases: ["cad", "cadc", "canadian", "canada"],
    tokens: {
      ethereum: [{ symbol: "CADC", address: "0xcadc0acd4b445166f12d2c07eac6e2544fbe2eef" }],
      base: [{ symbol: "CADC", address: "0x043eb4b75d0805c43d7c834902e335621983cf03" }],
      polygon: [{ symbol: "CADC", address: "0x5d146d8b1dacb1ebba5cb005ae1059da8a1fbf57" }]
    },
    latam: false
  }
};

/** A listed pool is analysed when its USDC leg or its subgraph TVL clears these; otherwise it is dust. */
export const BENCHMARK_DUST_USDC = 500;
export const BENCHMARK_DUST_TVL_USD = 1_000;
/** A pool at or above both of these makes the pair "liquid". */
export const BENCHMARK_LIQUID_TVL_USD = 1_000_000;
export const BENCHMARK_LIQUID_DAILY_VOLUME_USD = 250_000;
/** A pool at or above either of these makes the pair "thin" rather than "none". */
export const BENCHMARK_MEANINGFUL_TVL_USD = 50_000;
export const BENCHMARK_MEANINGFUL_DAILY_VOLUME_USD = 10_000;

/** A pool's own price is shown only within this share of the market price (FX stablecoins barely move). */
const PRICE_SANITY_SHARE = 0.03;
/** Hourly volume-weighted prices further than this from the 24h median are left out of the range. */
const HOURLY_PRICE_OUTLIER_SHARE = 0.03;

const DAY_SECONDS = 86_400;
const MAX_LOOKBACK_DAYS = 30;
const DEFAULT_TRADE_SIZES_USD = [1_000, 10_000, 100_000];

export type BenchmarkFallbackMode = "auto" | "always" | "never";

export type BenchmarkFxStrategyInput = {
  pair: string;
  feeBps?: number | string | undefined;
  flatBandPercent?: number | string | undefined;
  tradeSizesUsd?: Array<number | string> | undefined;
  lookbackDays?: number | string | undefined;
  chains?: string | string[] | undefined;
  /**
   * Non-standardized (Uniswap-v3-schema) subgraphs. "auto" (default): only on a chain where no standardized
   * subgraph answered or none found a non-dust pool for the pair. "always" or "never" override.
   */
  fallback?: string | undefined;
  /** For USDC/ARS and USDC/BRL: add a live Arc Testnet router quote for 0.1 USDC (default true). */
  includeArcQuote?: boolean | undefined;
};

export type BenchmarkFxStrategyOptions = {
  /** Graph Network gateway API key (GRAPH_GATEWAY_API_KEY). Sent only as a bearer header; redacted from errors. */
  apiKey: string | undefined;
  fetch?: FetchLike | undefined;
  timeoutMs?: number | undefined;
  /** Clock in milliseconds, for tests. */
  now?: (() => number) | undefined;
  /** The Aqua0 subgraph (Subgraph Studio). */
  aqua0Graph?:
    | {
        endpointOrigin: string;
        query: <T>(query: string) => Promise<T>;
      }
    | undefined;
  /** Live Arc Testnet quote through the router, e.g. quoteFxSwap. */
  arcQuote?: ((pair: "USDC/ARS" | "USDC/BRL", amount: string) => Promise<unknown>) | undefined;
};

export class GraphGatewayError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;
  attempts = 1;

  constructor(message: string, options: { status?: number | undefined; retryable: boolean }) {
    super(message);
    this.name = "GraphGatewayError";
    this.status = options.status;
    this.retryable = options.retryable;
  }
}

/** Replaces every occurrence of the secret with <redacted>. */
export function redactSecret(text: string, secret: string | undefined): string {
  if (!secret) {
    return text;
  }
  return text.split(secret).join("<redacted>");
}

export function resolveBenchmarkCurrency(pair: string): BenchmarkCurrency {
  const words = pair
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word.length > 0);
  for (const word of words) {
    for (const [code, definition] of Object.entries(BENCHMARK_CURRENCIES) as Array<[BenchmarkCurrency, CurrencyDefinition]>) {
      if (definition.aliases.includes(word)) {
        return code;
      }
    }
  }
  throw new Error(
    `Unsupported pair "${pair}": use one of ${Object.keys(BENCHMARK_CURRENCIES).join(", ")} (against USDC), e.g. "USDC/EUR" or "BRL"`
  );
}

const CHAIN_ALIASES: Record<string, BenchmarkChain> = {
  ethereum: "ethereum",
  eth: "ethereum",
  mainnet: "ethereum",
  "1": "ethereum",
  base: "base",
  "8453": "base",
  polygon: "polygon",
  matic: "polygon",
  pol: "polygon",
  "137": "polygon",
  arbitrum: "arbitrum",
  arb: "arbitrum",
  "42161": "arbitrum",
  optimism: "optimism",
  op: "optimism",
  "10": "optimism",
  celo: "celo",
  "42220": "celo"
};

/** The chosen chains that have a pinned token for the currency (default: all of them). */
export function resolveBenchmarkChains(chains: string | string[] | undefined, currency: BenchmarkCurrency): BenchmarkChain[] {
  const pinned = BENCHMARK_CHAINS.filter((chain) => (BENCHMARK_CURRENCIES[currency].tokens[chain]?.length ?? 0) > 0);
  const values = (chains === undefined ? [] : Array.isArray(chains) ? chains : [chains])
    .flatMap((value) => value.split(/[\s,]+/))
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  if (values.length === 0) {
    return pinned;
  }
  const resolved: BenchmarkChain[] = [];
  for (const value of values) {
    const chain = CHAIN_ALIASES[value];
    if (!chain) {
      throw new Error(`Unsupported chain "${value}": use ${BENCHMARK_CHAINS.join(", ")}`);
    }
    if (!resolved.includes(chain)) {
      resolved.push(chain);
    }
  }
  return resolved;
}

type SourceStatus = "ok" | "partial" | "failed" | "skipped";

export type BenchmarkSource = {
  kind: "standardized" | "non-standardized" | "aqua0";
  protocol: string;
  network: string;
  chainId?: number;
  subgraphId?: string;
  schema: string;
  provider: string;
  endpoint?: string;
  status: SourceStatus;
  meta?: {
    blockNumber: number | null;
    blockTimestamp: number | null;
    hasIndexingErrors: boolean | null;
    deployment: string | null;
    schemaVersion?: string | null;
  };
  latencyMs?: number;
  attempts?: number;
  poolsFound?: number;
  error?: string;
  note?: string;
};

export type BenchmarkPool = {
  id: string;
  protocol: string;
  chain: BenchmarkChain;
  chainId: number;
  standardized: boolean;
  name: string | null;
  pair: string;
  /** Trading fee at the last update, in bps (null when the subgraph does not report one). */
  feeTierBps: number | null;
  /** Fees / volume in USD over the lookback, from the subgraph; null when it does not price the pool in USD. */
  realizedFeeBps: number | null;
  /** TVL as the subgraph reports it (it counts only the legs it can price). */
  tvlUsd: number;
  /** USDC leg plus the FX leg at the deepest market price. */
  tvlUsdEstimate: number;
  usdcLocked: number;
  fxLocked: number;
  /** Pool price in FX per USDC: spot for Uniswap-v3-schema pools, lookback volume-weighted for standardized pools. */
  fxPerUsdc: number | null;
  avgDailyVolumeUsd: number | null;
  volumeUsdLookback: number | null;
  daysWithSwaps: number | null;
  range24hBps: number | null;
  range24hBasis: "hourly high and low" | "hourly volume-weighted prices" | null;
  lastActivityAt: string | null;
  notes?: string[];
};

type TokenRef = { id: string; symbol: string; decimals: number };

type ListedPool = {
  source: BenchmarkSubgraph;
  id: string;
  name: string | null;
  feeTierBps: number | null;
  usdc: TokenRef;
  fx: TokenRef;
  tokenCount: number;
  /** Messari: index of each leg in inputTokens. Uniswap v3 schema: 0 or 1. */
  usdcIndex: number;
  fxIndex: number;
  usdcLocked: number;
  fxLocked: number;
  tvlUsd: number;
  spotFxPerUsdc: number | null;
  negativeBalance: boolean;
};

type DayPoint = { timestamp: number; usdcVolume: number; fxVolume: number; volumeUsd: number; feesUsd: number };
type HourPoint = { timestamp: number; usdcVolume: number; fxVolume: number; high: number | null; low: number | null };

export type PoolSeries = { days: DayPoint[]; hours: HourPoint[]; lastActivity: number | null };

export type BenchmarkWindow = { nowSeconds: number; todayStart: number; dayStart: number; hourStart: number; lookbackDays: number };

type GatewayContext = {
  apiKey: string;
  fetch: FetchLike;
  timeoutMs: number;
};

type SourceRun = {
  source: BenchmarkSubgraph;
  report: BenchmarkSource;
  pools: ListedPool[];
};

export async function benchmarkFxStrategy(input: BenchmarkFxStrategyInput, options: BenchmarkFxStrategyOptions) {
  const currency = resolveBenchmarkCurrency(input.pair);
  const definition = BENCHMARK_CURRENCIES[currency];
  const feeBps = parseBoundedNumber(input.feeBps, "feeBps", 30, (value) => value >= 0 && value <= 10_000, "between 0 and 10000");
  const flatBandPercent = parseBoundedNumber(
    input.flatBandPercent,
    "flatBandPercent",
    15,
    (value) => value > 0 && value < 100,
    "above 0 and below 100"
  );
  const lookbackDays = parseBoundedNumber(
    input.lookbackDays,
    "lookbackDays",
    7,
    (value) => Number.isInteger(value) && value >= 1 && value <= MAX_LOOKBACK_DAYS,
    `a whole number from 1 to ${MAX_LOOKBACK_DAYS}`
  );
  const tradeSizesUsd = parseTradeSizes(input.tradeSizesUsd);
  const chains = resolveBenchmarkChains(input.chains, currency);
  const fallback = parseFallback(input.fallback);

  const apiKey = options.apiKey?.trim();
  if (!apiKey) {
    throw new Error(
      "GRAPH_GATEWAY_API_KEY is required for benchmark_fx_strategy: set a The Graph Network gateway API key in the server environment"
    );
  }
  const gateway: GatewayContext = { apiKey, fetch: options.fetch ?? fetch, timeoutMs: options.timeoutMs ?? 20_000 };
  const nowSeconds = Math.floor((options.now ?? Date.now)() / 1000);
  const todayStart = Math.floor(nowSeconds / DAY_SECONDS) * DAY_SECONDS;
  const window: BenchmarkWindow = {
    nowSeconds,
    todayStart,
    dayStart: todayStart - lookbackDays * DAY_SECONDS,
    hourStart: nowSeconds - DAY_SECONDS,
    lookbackDays
  };

  // Started first: they run while the gateway queries do.
  const arcQuoteTask =
    definition.arcPair && options.arcQuote && input.includeArcQuote !== false
      ? settle(options.arcQuote(definition.arcPair, "0.1"))
      : undefined;
  const aqua0Task = options.aqua0Graph ? readAqua0Forex(options.aqua0Graph) : undefined;

  const pinnedChains = chains.filter((chain) => (definition.tokens[chain]?.length ?? 0) > 0);
  const skippedChains = chains.filter((chain) => !pinnedChains.includes(chain));

  // Stage 1, standardized: the same liquidityPools query goes to every Messari DEX AMM subgraph on the chosen chains.
  const standardized = await Promise.all(
    MESSARI_DEX_AMM_SUBGRAPHS.filter((source) => pinnedChains.includes(source.chain)).map((source) =>
      listPools(gateway, source, definition, apiKey)
    )
  );

  // Non-standardized fallback, per chain.
  const fallbackChains = pinnedChains.filter((chain) => {
    if (!NON_STANDARDIZED_SUBGRAPHS.some((source) => source.chain === chain)) {
      return false;
    }
    if (fallback === "never") {
      return false;
    }
    if (fallback === "always") {
      return true;
    }
    const onChain = standardized.filter((run) => run.source.chain === chain);
    const answered = onChain.filter((run) => run.report.status === "ok");
    return answered.length === 0 || !onChain.some((run) => run.pools.some((pool) => !isDust(pool)));
  });
  const fallbackRuns = await Promise.all(
    NON_STANDARDIZED_SUBGRAPHS.filter((source) => fallbackChains.includes(source.chain)).map((source) =>
      listPools(gateway, source, definition, apiKey)
    )
  );
  const runs = [...standardized, ...fallbackRuns];

  // Stage 2: daily and hourly series for the pools that are not dust (again one query shape per schema).
  const dustPools: Array<{ id: string; protocol: string; chain: BenchmarkChain; pair: string; usdcLocked: number; tvlUsd: number }> = [];
  const detailed = await Promise.all(
    runs.map(async (run) => {
      const kept = run.pools.filter((pool) => {
        if (!isDust(pool)) {
          return true;
        }
        dustPools.push({
          id: pool.id,
          protocol: pool.source.protocol,
          chain: pool.source.chain,
          pair: `${pool.fx.symbol}/${pool.usdc.symbol}`,
          usdcLocked: round(Math.max(pool.usdcLocked, 0), 2),
          tvlUsd: round(Math.max(pool.tvlUsd, 0), 2)
        });
        return false;
      });
      if (kept.length === 0 || run.report.status !== "ok") {
        return { run, kept, series: new Map<string, PoolSeries>() };
      }
      try {
        const series = await readSeries(gateway, run.source, kept, window, run.report);
        return { run, kept, series };
      } catch (error) {
        const failed = failedReport(run.report, error, apiKey);
        run.report = { ...failed, status: "partial", error: `pool snapshots failed: ${failed.error ?? ""}` };
        return { run, kept, series: new Map<string, PoolSeries>() };
      }
    })
  );

  // The market price: volume-weighted price of the pool with the most USDC volume, else the deepest spot price.
  const priced = detailed.flatMap(({ kept, series }) =>
    kept.map((pool) => ({ pool, metrics: series.has(pool.id) ? computePoolMetrics(series.get(pool.id) as PoolSeries, window) : undefined }))
  );
  const byVolume = priced
    .filter((entry) => entry.metrics?.vwapFxPerUsdc !== null && entry.metrics?.vwapFxPerUsdc !== undefined)
    .sort((a, b) => (b.metrics?.volumeUsd ?? 0) - (a.metrics?.volumeUsd ?? 0))[0];
  const bySpot = priced
    .filter((entry) => entry.pool.spotFxPerUsdc !== null)
    .sort((a, b) => b.pool.usdcLocked - a.pool.usdcLocked)[0];
  const marketFxPerUsdc = byVolume?.metrics?.vwapFxPerUsdc ?? bySpot?.pool.spotFxPerUsdc ?? null;

  const pools = priced
    .map(({ pool, metrics }) => buildPoolReport(pool, metrics, window, marketFxPerUsdc))
    .sort((a, b) => b.tvlUsdEstimate - a.tvlUsdEstimate);
  for (const run of runs) {
    run.report.poolsFound = pools.filter((pool) => pool.chain === run.source.chain && pool.protocol === run.source.protocol && pool.standardized === (run.source.schema === "messari-dex-amm")).length;
  }

  const sources: BenchmarkSource[] = [
    ...runs.map((run) => run.report),
    ...skippedChains.map(
      (chain): BenchmarkSource => ({
        kind: "standardized",
        protocol: "all",
        network: chain,
        chainId: BENCHMARK_CHAIN_IDS[chain],
        schema: "Messari DEX AMM",
        provider: "The Graph Network gateway",
        status: "skipped",
        note: `No ${currency} stablecoin is pinned on ${chain}`
      })
    )
  ];

  const standardizedRuns = runs.filter((run) => run.source.schema === "messari-dex-amm");
  const answeredStandardized = standardizedRuns.filter((run) => run.report.status !== "failed");
  const aqua0 = await buildAqua0Section({
    currency,
    definition,
    feeBps,
    flatBandPercent,
    tradeSizesUsd,
    pools,
    aqua0Task,
    arcQuoteTask,
    includeArcQuote: input.includeArcQuote !== false,
    sources,
    endpointOrigin: options.aqua0Graph?.endpointOrigin,
    apiKey,
    marketFxPerUsdc
  });

  return {
    pair: `${currency}/USDC`,
    currency,
    currencyName: definition.name,
    generatedAt: new Date(nowSeconds * 1000).toISOString(),
    query: { feeBps, flatBandPercent, tradeSizesUsd, lookbackDays, chains, fallback },
    standardized: {
      schema: "Messari DEX AMM standardized subgraph schema",
      pattern:
        "One liquidityPools query (pools holding USDC and a pinned FX token) and one snapshots query (dailySnapshots, hourlySnapshots) go unchanged to every standardized subgraph; only the subgraph id and the chain's token addresses change.",
      subgraphsQueried: standardizedRuns.length,
      subgraphsAnswered: answeredStandardized.length,
      protocols: [...new Set(answeredStandardized.map((run) => run.source.protocol))],
      chains: [...new Set(answeredStandardized.map((run) => run.source.chain))],
      poolsAnalysed: pools.filter((pool) => pool.standardized).length,
      nonStandardizedFallbackChains: fallbackChains
    },
    market: {
      fxPerUsdc: marketFxPerUsdc === null ? null : significant(marketFxPerUsdc, 6),
      basis: byVolume
        ? `volume-weighted over ${lookbackDays} days on ${byVolume.pool.source.protocol} ${byVolume.pool.source.chain} ${byVolume.pool.fx.symbol}/${byVolume.pool.usdc.symbol}`
        : bySpot
          ? `spot price of ${bySpot.pool.source.protocol} ${bySpot.pool.source.chain} ${bySpot.pool.fx.symbol}/${bySpot.pool.usdc.symbol}`
          : "no priced pool"
    },
    sources,
    pools,
    ignoredDustPools: dustPools.sort((a, b) => b.usdcLocked - a.usdcLocked).slice(0, 25),
    ignoredDustPoolCount: dustPools.length,
    aqua0,
    verdict: buildVerdict({ currency, definition, feeBps, tradeSizesUsd, pools, sources, lookbackDays }),
    notes: [
      "USD volume is the USDC leg of each pool (USDC taken as $1), because subgraphs cannot price every FX token and may report volumeUSD or TVL as 0.",
      "realizedFeeBps is fees / volume in USD from the subgraph (dailyTotalRevenueUSD for standardized pools, feesUSD for Uniswap-v3-schema pools); it books the fee tier, so dynamic fees may not be reflected.",
      "Price impact per trade size is not computed: in-range liquidity only covers the current tick, and a robust estimate needs a tick-by-tick swap simulation.",
      `Pools with under ${BENCHMARK_DUST_USDC} USDC and under $${BENCHMARK_DUST_TVL_USD.toLocaleString("en-US")} subgraph TVL are counted in ignoredDustPoolCount and not analysed.`
    ]
  };
}

export type BenchmarkFxStrategyResult = Awaited<ReturnType<typeof benchmarkFxStrategy>>;

// ---------------------------------------------------------------------------------------------
// stage 1: list pools

type MessariMeta = {
  block?: { number?: number | string; timestamp?: number | string | null };
  hasIndexingErrors?: boolean;
  deployment?: string;
};

type MessariPoolEntity = {
  id: string;
  name: string | null;
  fees: Array<{ feePercentage: string | null; feeType: string }>;
  inputTokens: Array<{ id: string; symbol: string; decimals: number | string }>;
  inputTokenBalances: string[];
  totalValueLockedUSD: string;
};

type UniswapPoolEntity = {
  id: string;
  feeTier: string;
  token0: { id: string; symbol: string; decimals: string };
  token1: { id: string; symbol: string; decimals: string };
  token0Price: string;
  token1Price: string;
  totalValueLockedUSD: string;
  totalValueLockedToken0: string;
  totalValueLockedToken1: string;
};

async function listPools(
  gateway: GatewayContext,
  source: BenchmarkSubgraph,
  definition: CurrencyDefinition,
  apiKey: string
): Promise<SourceRun> {
  const standardized = source.schema === "messari-dex-amm";
  const fx = (definition.tokens[source.chain] ?? []).map((token) => token.address);
  const usdc = BENCHMARK_USDC[source.chain];
  const report: BenchmarkSource = {
    kind: standardized ? "standardized" : "non-standardized",
    protocol: source.protocol,
    network: source.chain,
    chainId: BENCHMARK_CHAIN_IDS[source.chain],
    subgraphId: source.subgraphId,
    schema: standardized ? "Messari DEX AMM" : "Uniswap v3 style (not standardized)",
    provider: "The Graph Network gateway",
    status: "ok",
    ...(source.note ? { note: source.note } : {})
  };
  try {
    if (standardized) {
      const result = await gatewayQuery<{
        _meta?: MessariMeta;
        dexAmmProtocols?: Array<{ schemaVersion?: string }>;
        liquidityPools: MessariPoolEntity[];
      }>(gateway, source.subgraphId, standardizedPoolListQuery(usdc, fx));
      report.meta = { ...readMeta(result.data._meta), schemaVersion: result.data.dexAmmProtocols?.[0]?.schemaVersion ?? null };
      report.latencyMs = result.latencyMs;
      report.attempts = result.attempts;
      return { source, report, pools: result.data.liquidityPools.flatMap((pool) => normalizeMessariPool(source, pool, usdc, fx)) };
    }
    const result = await gatewayQuery<{ _meta?: MessariMeta; pools: UniswapPoolEntity[] }>(
      gateway,
      source.subgraphId,
      uniswapPoolListQuery(usdc, fx)
    );
    report.meta = readMeta(result.data._meta);
    report.latencyMs = result.latencyMs;
    report.attempts = result.attempts;
    return { source, report, pools: result.data.pools.flatMap((pool) => normalizeUniswapPool(source, pool, usdc)) };
  } catch (error) {
    return { source, report: failedReport(report, error, apiKey), pools: [] };
  }
}

function normalizeMessariPool(
  source: BenchmarkSubgraph,
  pool: MessariPoolEntity,
  usdc: readonly string[],
  fx: readonly string[]
): ListedPool[] {
  const tokens = pool.inputTokens.map((token) => ({ ...token, id: token.id.toLowerCase(), decimals: toNumber(token.decimals) }));
  const usdcIndex = tokens.findIndex((token) => usdc.includes(token.id));
  const fxIndex = tokens.findIndex((token) => fx.includes(token.id));
  const usdcToken = tokens[usdcIndex];
  const fxToken = tokens[fxIndex];
  if (!usdcToken || !fxToken) {
    return [];
  }
  const usdcLocked = unitsToNumber(pool.inputTokenBalances[usdcIndex], usdcToken.decimals);
  const fxLocked = unitsToNumber(pool.inputTokenBalances[fxIndex], fxToken.decimals);
  const tradingFee = pool.fees.find((fee) => fee.feeType === "FIXED_TRADING_FEE" || fee.feeType === "DYNAMIC_TRADING_FEE");
  const lpAndProtocol = pool.fees.filter((fee) => fee.feeType === "FIXED_LP_FEE" || fee.feeType === "FIXED_PROTOCOL_FEE");
  const feePercent =
    tradingFee?.feePercentage !== null && tradingFee?.feePercentage !== undefined
      ? toNumber(tradingFee.feePercentage)
      : lpAndProtocol.length > 0
        ? lpAndProtocol.reduce((sum, fee) => sum + toNumber(fee.feePercentage), 0)
        : null;
  return [
    {
      source,
      id: pool.id.toLowerCase(),
      name: pool.name,
      feeTierBps: feePercent === null ? null : round(feePercent * 100, 2),
      usdc: usdcToken,
      fx: fxToken,
      tokenCount: tokens.length,
      usdcIndex,
      fxIndex,
      usdcLocked,
      fxLocked,
      tvlUsd: toNumber(pool.totalValueLockedUSD),
      spotFxPerUsdc: null,
      negativeBalance: usdcLocked < 0 || fxLocked < 0
    }
  ];
}

function normalizeUniswapPool(source: BenchmarkSubgraph, pool: UniswapPoolEntity, usdc: readonly string[]): ListedPool[] {
  const usdcIsToken0 = usdc.includes(pool.token0.id.toLowerCase());
  const [usdcRaw, fxRaw] = usdcIsToken0 ? [pool.token0, pool.token1] : [pool.token1, pool.token0];
  // token0Price is token0 per token1.
  const spot = toNumber(usdcIsToken0 ? pool.token1Price : pool.token0Price);
  const usdcLocked = toNumber(usdcIsToken0 ? pool.totalValueLockedToken0 : pool.totalValueLockedToken1);
  const fxLocked = toNumber(usdcIsToken0 ? pool.totalValueLockedToken1 : pool.totalValueLockedToken0);
  return [
    {
      source,
      id: pool.id.toLowerCase(),
      name: null,
      // Uniswap v3 fee tiers are in hundredths of a basis point: 500 = 5 bps.
      feeTierBps: toNumber(pool.feeTier) / 100,
      usdc: { id: usdcRaw.id.toLowerCase(), symbol: usdcRaw.symbol, decimals: toNumber(usdcRaw.decimals) },
      fx: { id: fxRaw.id.toLowerCase(), symbol: fxRaw.symbol, decimals: toNumber(fxRaw.decimals) },
      tokenCount: 2,
      usdcIndex: usdcIsToken0 ? 0 : 1,
      fxIndex: usdcIsToken0 ? 1 : 0,
      usdcLocked,
      fxLocked,
      tvlUsd: toNumber(pool.totalValueLockedUSD),
      spotFxPerUsdc: spot > 0 ? spot : null,
      negativeBalance: usdcLocked < 0 || fxLocked < 0
    }
  ];
}

function isDust(pool: ListedPool): boolean {
  return pool.usdcLocked < BENCHMARK_DUST_USDC && pool.tvlUsd < BENCHMARK_DUST_TVL_USD;
}

// ---------------------------------------------------------------------------------------------
// stage 2: daily and hourly series

type MessariSeriesEntity = {
  id: string;
  dailySnapshots: Array<{ timestamp: string; dailyVolumeUSD: string; dailyVolumeByTokenAmount: string[]; dailyTotalRevenueUSD: string }>;
  hourlySnapshots: Array<{ timestamp: string; hourlyVolumeByTokenAmount: string[] }>;
};

type UniswapSeriesEntity = {
  id: string;
  poolDayData: Array<{ date: number | string; volumeUSD: string; volumeToken0: string; volumeToken1: string; feesUSD: string }>;
  poolHourData: Array<{ periodStartUnix: number | string; high: string; low: string }>;
  swaps: Array<{ timestamp: string }>;
};

async function readSeries(
  gateway: GatewayContext,
  source: BenchmarkSubgraph,
  pools: ListedPool[],
  window: BenchmarkWindow,
  report: BenchmarkSource
): Promise<Map<string, PoolSeries>> {
  const ids = pools.map((pool) => pool.id);
  const byId = new Map(pools.map((pool) => [pool.id, pool]));
  const series = new Map<string, PoolSeries>();
  if (source.schema === "messari-dex-amm") {
    const result = await gatewayQuery<{ liquidityPools: MessariSeriesEntity[] }>(
      gateway,
      source.subgraphId,
      standardizedSnapshotsQuery(ids, window)
    );
    addTiming(report, result);
    for (const entity of result.data.liquidityPools) {
      const pool = byId.get(entity.id.toLowerCase());
      if (pool) {
        series.set(pool.id, messariSeries(pool, entity));
      }
    }
    return series;
  }
  const result = await gatewayQuery<{ pools: UniswapSeriesEntity[] }>(gateway, source.subgraphId, uniswapSeriesQuery(ids, window));
  addTiming(report, result);
  for (const entity of result.data.pools) {
    const pool = byId.get(entity.id.toLowerCase());
    if (pool) {
      series.set(pool.id, uniswapSeries(pool, entity));
    }
  }
  return series;
}

function messariSeries(pool: ListedPool, entity: MessariSeriesEntity): PoolSeries {
  const days = entity.dailySnapshots.map((day) => ({
    timestamp: toNumber(day.timestamp),
    usdcVolume: unitsToNumber(day.dailyVolumeByTokenAmount[pool.usdcIndex], pool.usdc.decimals),
    fxVolume: unitsToNumber(day.dailyVolumeByTokenAmount[pool.fxIndex], pool.fx.decimals),
    volumeUsd: toNumber(day.dailyVolumeUSD),
    feesUsd: toNumber(day.dailyTotalRevenueUSD)
  }));
  const hours = entity.hourlySnapshots.map((hour) => ({
    timestamp: toNumber(hour.timestamp),
    usdcVolume: unitsToNumber(hour.hourlyVolumeByTokenAmount[pool.usdcIndex], pool.usdc.decimals),
    fxVolume: unitsToNumber(hour.hourlyVolumeByTokenAmount[pool.fxIndex], pool.fx.decimals),
    high: null,
    low: null
  }));
  const timestamps = [...days, ...hours].map((point) => point.timestamp);
  return { days, hours, lastActivity: timestamps.length > 0 ? Math.max(...timestamps) : null };
}

function uniswapSeries(pool: ListedPool, entity: UniswapSeriesEntity): PoolSeries {
  const usdcIsToken0 = pool.usdcIndex === 0;
  return {
    days: entity.poolDayData.map((day) => ({
      timestamp: toNumber(day.date),
      usdcVolume: toNumber(usdcIsToken0 ? day.volumeToken0 : day.volumeToken1),
      fxVolume: toNumber(usdcIsToken0 ? day.volumeToken1 : day.volumeToken0),
      volumeUsd: toNumber(day.volumeUSD),
      feesUsd: toNumber(day.feesUSD)
    })),
    hours: entity.poolHourData.map((hour) => {
      // high and low follow token0Price (token0 per token1); flip them into FX per USDC when USDC is token0.
      const high = toNumber(hour.high);
      const low = toNumber(hour.low);
      const valid = high > 0 && low > 0;
      return {
        timestamp: toNumber(hour.periodStartUnix),
        usdcVolume: 0,
        fxVolume: 0,
        high: valid ? (usdcIsToken0 ? 1 / low : high) : null,
        low: valid ? (usdcIsToken0 ? 1 / high : low) : null
      };
    }),
    lastActivity: entity.swaps[0] ? toNumber(entity.swaps[0].timestamp) : null
  };
}

/** Lookback totals over complete UTC days, the 24h price range, and the last activity. */
export function computePoolMetrics(series: PoolSeries, window: BenchmarkWindow) {
  let volumeUsd = 0;
  let fxVolume = 0;
  let subgraphVolumeUsd = 0;
  let feesUsd = 0;
  const activeDays = new Set<number>();
  for (const day of series.days) {
    const dayStart = Math.floor(day.timestamp / DAY_SECONDS) * DAY_SECONDS;
    if (dayStart < window.dayStart || dayStart >= window.todayStart) {
      continue;
    }
    volumeUsd += Math.max(day.usdcVolume, 0);
    fxVolume += Math.max(day.fxVolume, 0);
    subgraphVolumeUsd += Math.max(day.volumeUsd, 0);
    feesUsd += Math.max(day.feesUsd, 0);
    if (day.usdcVolume > 0) {
      activeDays.add(dayStart);
    }
  }

  const prices: Array<{ high: number; low: number }> = [];
  let basis: BenchmarkPool["range24hBasis"] = null;
  const hourlyVwaps: number[] = [];
  for (const hour of series.hours) {
    if (hour.timestamp < window.hourStart) {
      continue;
    }
    if (hour.high !== null && hour.low !== null) {
      prices.push({ high: hour.high, low: hour.low });
      basis = "hourly high and low";
    } else if (hour.usdcVolume > 0 && hour.fxVolume > 0) {
      hourlyVwaps.push(hour.fxVolume / hour.usdcVolume);
    }
  }
  // Snapshot volumes per token are noisy (one odd swap skews an hour), so hourly prices far from the 24h median are
  // left out of the range and counted.
  let hoursExcluded = 0;
  if (hourlyVwaps.length > 0) {
    const sorted = [...hourlyVwaps].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
    for (const price of hourlyVwaps) {
      if (Math.abs(price / median - 1) > HOURLY_PRICE_OUTLIER_SHARE) {
        hoursExcluded += 1;
        continue;
      }
      prices.push({ high: price, low: price });
      basis = basis ?? "hourly volume-weighted prices";
    }
  }
  const high = prices.length > 0 ? Math.max(...prices.map((price) => price.high)) : 0;
  const low = prices.length > 0 ? Math.min(...prices.map((price) => price.low)) : 0;
  const mid = (high + low) / 2;

  return {
    volumeUsd,
    subgraphVolumeUsd,
    feesUsd,
    realizedFeeBps: subgraphVolumeUsd > 0 ? (feesUsd / subgraphVolumeUsd) * 10_000 : null,
    vwapFxPerUsdc: volumeUsd > 0 && fxVolume > 0 ? fxVolume / volumeUsd : null,
    daysWithSwaps: activeDays.size,
    range24hBps: prices.length > 0 && mid > 0 ? ((high - low) / mid) * 10_000 : null,
    range24hBasis: prices.length > 0 ? basis : null,
    hoursWithSwaps: prices.length,
    hoursExcluded,
    lastActivity: series.lastActivity
  };
}

function buildPoolReport(
  pool: ListedPool,
  metrics: ReturnType<typeof computePoolMetrics> | undefined,
  window: BenchmarkWindow,
  marketFxPerUsdc: number | null
): BenchmarkPool {
  const notes: string[] = [];
  const standardized = pool.source.schema === "messari-dex-amm";
  const ownPrice = standardized ? (metrics?.vwapFxPerUsdc ?? null) : pool.spotFxPerUsdc;
  const priceIsSane =
    ownPrice !== null &&
    marketFxPerUsdc !== null &&
    ownPrice > 0 &&
    Math.abs(ownPrice / marketFxPerUsdc - 1) <= PRICE_SANITY_SHARE;
  if (ownPrice !== null && !priceIsSane) {
    notes.push(
      `Pool price is more than ${PRICE_SANITY_SHARE * 100}% away from the market price (stale range, noisy snapshot volumes or a different token); not shown.`
    );
  }
  if (pool.negativeBalance) {
    notes.push("The subgraph reports a negative token balance for this pool; it is counted as 0.");
  }
  if (pool.tokenCount > 2) {
    notes.push(`Pool holds ${pool.tokenCount} tokens; volumes are its USDC and ${pool.fx.symbol} legs.`);
  }
  const usdcLocked = Math.max(pool.usdcLocked, 0);
  const fxLocked = Math.max(pool.fxLocked, 0);
  const tvlUsdEstimate = usdcLocked + (marketFxPerUsdc && marketFxPerUsdc > 0 ? fxLocked / marketFxPerUsdc : 0);
  const base: BenchmarkPool = {
    id: pool.id,
    protocol: pool.source.protocol,
    chain: pool.source.chain,
    chainId: BENCHMARK_CHAIN_IDS[pool.source.chain],
    standardized,
    name: pool.name,
    pair: `${pool.fx.symbol}/${pool.usdc.symbol}`,
    feeTierBps: pool.feeTierBps,
    realizedFeeBps: null,
    tvlUsd: round(Math.max(pool.tvlUsd, 0), 2),
    tvlUsdEstimate: round(tvlUsdEstimate, 2),
    usdcLocked: round(usdcLocked, 2),
    fxLocked: round(fxLocked, 2),
    fxPerUsdc: priceIsSane && ownPrice !== null ? significant(ownPrice, 6) : null,
    avgDailyVolumeUsd: null,
    volumeUsdLookback: null,
    daysWithSwaps: null,
    range24hBps: null,
    range24hBasis: null,
    lastActivityAt: null
  };
  if (!metrics) {
    notes.push("Daily and hourly data unavailable for this pool.");
    return { ...base, notes };
  }
  if (metrics.realizedFeeBps === null && metrics.volumeUsd > 0) {
    notes.push("The subgraph does not price this pool's volume in USD, so the realized fee rate is unknown; the fee tier applies.");
  }
  if (metrics.hoursExcluded > 0) {
    notes.push(
      `${metrics.hoursExcluded} hourly price${metrics.hoursExcluded === 1 ? "" : "s"} more than ${HOURLY_PRICE_OUTLIER_SHARE * 100}% from the 24h median left out of the range.`
    );
  }
  return {
    ...base,
    realizedFeeBps: metrics.realizedFeeBps === null ? null : round(metrics.realizedFeeBps, 2),
    avgDailyVolumeUsd: round(metrics.volumeUsd / window.lookbackDays, 2),
    volumeUsdLookback: round(metrics.volumeUsd, 2),
    daysWithSwaps: metrics.daysWithSwaps,
    range24hBps: metrics.range24hBps === null ? null : round(metrics.range24hBps, 2),
    range24hBasis: metrics.range24hBasis,
    lastActivityAt: metrics.lastActivity === null ? null : new Date(metrics.lastActivity * 1000).toISOString(),
    ...(notes.length > 0 ? { notes } : {})
  };
}

// ---------------------------------------------------------------------------------------------
// queries

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

function addressList(addresses: readonly string[]): string {
  for (const address of addresses) {
    if (!ADDRESS_PATTERN.test(address)) {
      throw new Error(`Invalid address ${address}`);
    }
  }
  return JSON.stringify(addresses);
}

/** Standardized stage 1: every Messari DEX AMM subgraph gets this same query. */
export function standardizedPoolListQuery(usdcTokens: readonly string[], fxTokens: readonly string[]): string {
  addressList(usdcTokens);
  addressList(fxTokens);
  const branches = usdcTokens.flatMap((usdc) => fxTokens.map((fx) => `{ inputTokens_contains: ["${usdc}", "${fx}"] }`));
  return `query Aqua0BenchmarkStandardPools {
  _meta { block { number timestamp } hasIndexingErrors deployment }
  dexAmmProtocols(first: 1) { name slug schemaVersion network }
  liquidityPools(first: 100, where: { or: [${branches.join(", ")}] }) {
    id name fees { feePercentage feeType } inputTokens { id symbol decimals } inputTokenBalances totalValueLockedUSD
  }
}`;
}

/** Standardized stage 2: daily and hourly snapshots for the pools stage 1 found. */
export function standardizedSnapshotsQuery(poolIds: readonly string[], window: BenchmarkWindow): string {
  return `query Aqua0BenchmarkStandardSnapshots {
  liquidityPools(first: ${poolIds.length}, where: { id_in: ${addressList(poolIds)} }) {
    id
    dailySnapshots(first: ${window.lookbackDays + 2}, orderBy: timestamp, orderDirection: desc, where: { timestamp_gte: ${window.dayStart} }) {
      timestamp dailyVolumeUSD dailyVolumeByTokenAmount dailyTotalRevenueUSD
    }
    hourlySnapshots(first: 25, orderBy: timestamp, orderDirection: desc, where: { timestamp_gte: ${window.hourStart} }) {
      timestamp hourlyVolumeByTokenAmount
    }
  }
}`;
}

function uniswapPoolListQuery(usdcTokens: readonly string[], fxTokens: readonly string[]): string {
  const fx = addressList(fxTokens);
  const usdc = addressList(usdcTokens);
  return `query Aqua0BenchmarkUniswapPools {
  _meta { block { number timestamp } hasIndexingErrors deployment }
  pools(first: 100, where: { or: [{ token0_in: ${fx}, token1_in: ${usdc} }, { token0_in: ${usdc}, token1_in: ${fx} }] }) {
    id feeTier token0 { id symbol decimals } token1 { id symbol decimals } token0Price token1Price
    totalValueLockedUSD totalValueLockedToken0 totalValueLockedToken1
  }
}`;
}

function uniswapSeriesQuery(poolIds: readonly string[], window: BenchmarkWindow): string {
  return `query Aqua0BenchmarkUniswapSeries {
  pools(first: ${poolIds.length}, where: { id_in: ${addressList(poolIds)} }) {
    id
    poolDayData(first: ${window.lookbackDays + 1}, orderBy: date, orderDirection: desc, where: { date_gte: ${window.dayStart} }) {
      date volumeUSD volumeToken0 volumeToken1 feesUSD
    }
    poolHourData(first: 25, orderBy: periodStartUnix, orderDirection: desc, where: { periodStartUnix_gte: ${window.hourStart} }) {
      periodStartUnix high low
    }
    swaps(first: 1, orderBy: timestamp, orderDirection: desc) { timestamp }
  }
}`;
}

// ---------------------------------------------------------------------------------------------
// gateway client

async function gatewayQuery<T>(
  context: GatewayContext,
  subgraphId: string,
  query: string
): Promise<{ data: T; latencyMs: number; attempts: number }> {
  const started = performance.now();
  let lastError: GraphGatewayError | undefined;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const data = await gatewayOnce<T>(context, subgraphId, query);
      return { data, latencyMs: Math.round(performance.now() - started), attempts: attempt };
    } catch (error) {
      lastError =
        error instanceof GraphGatewayError
          ? error
          : new GraphGatewayError(error instanceof Error ? error.message : String(error), { retryable: true });
      lastError.attempts = attempt;
      if (!lastError.retryable) {
        break;
      }
    }
  }
  throw lastError ?? new GraphGatewayError("gateway request failed", { retryable: false });
}

async function gatewayOnce<T>(context: GatewayContext, subgraphId: string, query: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), context.timeoutMs);
  try {
    let response: Response;
    try {
      response = await context.fetch(`${GRAPH_GATEWAY_SUBGRAPH_URL}/${subgraphId}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          // The key travels only in this header, never in the URL.
          authorization: `Bearer ${context.apiKey}`
        },
        body: JSON.stringify({ query }),
        signal: controller.signal
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new GraphGatewayError(`timed out after ${context.timeoutMs}ms`, { retryable: true });
      }
      throw new GraphGatewayError(`request failed: ${error instanceof Error ? error.message : String(error)}`, { retryable: true });
    }
    const text = await response.text();
    let body: { data?: T; errors?: unknown[] } | undefined;
    try {
      body = text.length > 0 ? (JSON.parse(text) as { data?: T; errors?: unknown[] }) : undefined;
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      const detail = body?.errors ? graphErrorsText(body.errors) : text.slice(0, 200);
      throw new GraphGatewayError(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`, {
        status: response.status,
        retryable: response.status >= 500 || response.status === 429
      });
    }
    if (!body) {
      throw new GraphGatewayError("gateway returned a non-JSON response", { status: response.status, retryable: true });
    }
    if (body.errors && body.errors.length > 0) {
      const message = graphErrorsText(body.errors);
      // "bad indexers: {...}" means no healthy indexer answered this time; a retry often reaches another one.
      throw new GraphGatewayError(message, { status: response.status, retryable: /indexer|timeout|timed out|unavailable/i.test(message) });
    }
    if (body.data === undefined || body.data === null) {
      throw new GraphGatewayError("gateway response had no data", { status: response.status, retryable: true });
    }
    return body.data;
  } finally {
    clearTimeout(timer);
  }
}

function graphErrorsText(errors: unknown[]): string {
  return errors
    .map((error) =>
      error && typeof error === "object" && "message" in error ? String((error as { message: unknown }).message) : JSON.stringify(error)
    )
    .join("; ");
}

function addTiming(report: BenchmarkSource, result: { latencyMs: number; attempts: number }) {
  report.latencyMs = (report.latencyMs ?? 0) + result.latencyMs;
  report.attempts = (report.attempts ?? 0) + result.attempts;
}

function failedReport(report: BenchmarkSource, error: unknown, apiKey: string): BenchmarkSource {
  const message = error instanceof Error ? error.message : String(error);
  const attempts = error instanceof GraphGatewayError ? error.attempts : 1;
  return {
    ...report,
    status: "failed",
    attempts: (report.attempts ?? 0) + attempts,
    error: truncate(redactSecret(message, apiKey), 300)
  };
}

// ---------------------------------------------------------------------------------------------
// Aqua0 side (Subgraph Studio)

type Aqua0StrategyEntity = { strategyId: string; tokens: string[]; feePpb: string | null; fillCount: string; shippedAtTimestamp: string };
type Aqua0FillEntity = {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  feesCredited: string;
  timestamp: string;
  aquaStrategyId: string | null;
};

export const AQUA0_FOREX_QUERY = `query Aqua0BenchmarkForex {
  _meta { block { number timestamp } hasIndexingErrors deployment }
  aquaStrategies(first: 100, where: { venue: "fxswap", status: "LIVE" }, orderBy: shippedAtTimestamp, orderDirection: desc) {
    strategyId tokens feePpb fillCount shippedAtTimestamp
  }
  aquaFills(first: 200, where: { venue: "fxswap" }, orderBy: timestamp, orderDirection: desc) {
    tokenIn tokenOut amountIn amountOut feesCredited timestamp aquaStrategyId
  }
}`;

async function readAqua0Forex(graph: NonNullable<BenchmarkFxStrategyOptions["aqua0Graph"]>) {
  const started = performance.now();
  try {
    const data = await graph.query<{ _meta?: MessariMeta; aquaStrategies: Aqua0StrategyEntity[]; aquaFills: Aqua0FillEntity[] }>(
      AQUA0_FOREX_QUERY
    );
    return { ok: true as const, data, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error), latencyMs: Math.round(performance.now() - started) };
  }
}

const ARC_USDC = ARC_TESTNET_DEPLOYMENT.tokens.USDC;
const ARC_FX_TOKENS: Record<string, { pair: "USDC/ARS" | "USDC/BRL"; symbol: string; decimals: number }> = {
  [ARC_TESTNET_DEPLOYMENT.tokens.ARGt.address.toLowerCase()]: { pair: "USDC/ARS", symbol: "ARGt", decimals: 18 },
  [ARC_TESTNET_DEPLOYMENT.tokens.BRAt.address.toLowerCase()]: { pair: "USDC/BRL", symbol: "BRAt", decimals: 18 }
};

async function buildAqua0Section(args: {
  currency: BenchmarkCurrency;
  definition: CurrencyDefinition;
  feeBps: number;
  flatBandPercent: number;
  tradeSizesUsd: number[];
  pools: BenchmarkPool[];
  aqua0Task: ReturnType<typeof readAqua0Forex> | undefined;
  arcQuoteTask: Promise<{ ok: true; value: unknown } | { ok: false; error: string }> | undefined;
  includeArcQuote: boolean;
  sources: BenchmarkSource[];
  endpointOrigin: string | undefined;
  apiKey: string;
  marketFxPerUsdc: number | null;
}) {
  const { currency, definition, feeBps, flatBandPercent, tradeSizesUsd, pools } = args;
  const costAtTradeSizes = tradeSizesUsd.map((tradeSizeUsd) => {
    const deepEnough = pools.filter(
      (pool) => pool.feeTierBps !== null && pool.tvlUsdEstimate >= tradeSizeUsd * 10 && (pool.avgDailyVolumeUsd ?? 0) > 0
    );
    return {
      tradeSizeUsd,
      aqua0FeeBps: feeBps,
      aqua0FeeUsd: round((tradeSizeUsd * feeBps) / 10_000, 2),
      lowestPoolFeeTierBps: deepEnough.length > 0 ? Math.min(...deepEnough.map((pool) => pool.feeTierBps as number)) : null,
      poolsWithTvlAtLeast10xTrade: deepEnough.length
    };
  });

  let indexed: Record<string, unknown> | undefined;
  if (args.aqua0Task) {
    const result = await args.aqua0Task;
    const source: BenchmarkSource = {
      kind: "aqua0",
      protocol: "aqua0",
      network: "arc-testnet",
      chainId: ARC_TESTNET_DEPLOYMENT.chainId,
      schema: "Aqua0 subgraph (AquaStrategy, AquaFill)",
      provider: "Subgraph Studio",
      ...(args.endpointOrigin ? { endpoint: args.endpointOrigin } : {}),
      status: result.ok ? "ok" : "failed",
      latencyMs: result.latencyMs,
      ...(result.ok ? { meta: readMeta(result.data._meta) } : { error: truncate(redactSecret(result.error, args.apiKey), 300) })
    };
    args.sources.push(source);
    indexed = result.ok
      ? summarizeAqua0(result.data.aquaStrategies, result.data.aquaFills, definition, args.marketFxPerUsdc)
      : { error: `Aqua0 subgraph query failed: ${source.error ?? ""}` };
  }

  let quote: Record<string, unknown> | undefined;
  if (definition.arcPair && args.includeArcQuote) {
    const settled = args.arcQuoteTask ? await args.arcQuoteTask : undefined;
    quote = settled
      ? settled.ok
        ? { size: "0.1 USDC", ...pickQuoteFields(settled.value) }
        : { size: "0.1 USDC", error: truncate(redactSecret(settled.error, args.apiKey), 300) }
      : { size: "0.1 USDC", error: "no quote path configured" };
  }

  return {
    venue: "Aqua0 forex curve (Shell v1 / DFX), opcode 34 on AquaForexSwapVMRouter",
    feeBps,
    flatBandPercent,
    costAtTradeSizes,
    costNote: `While a trade keeps the book within the flat band (beta = ${flatBandPercent}% of an even split), the strategy trades at the oracle price and its cost is the proportional fee, ${feeBps} bps. Past the band an inventory fee applies (slope delta, capped at maxFee), part of which is paid back to trades that rebalance. This tool does not evaluate the curve; get an exact figure from the router with quote_swap. lowestPoolFeeTierBps is the fee tier alone, before price impact.`,
    arcTestnet: {
      label: `Arc Testnet (chain ${ARC_TESTNET_DEPLOYMENT.chainId}): ARGt and BRAt are open-mint demo tokens, not real money, so these fills show the strategy working, not market volume`,
      ...(definition.arcPair ? { pair: definition.arcPair } : { note: `Aqua0 runs USDC/ARS and USDC/BRL on Arc Testnet; there is no ${currency} strategy` }),
      ...(indexed ? { indexed } : {}),
      ...(quote ? { liveQuote: quote } : {})
    }
  };
}

export function summarizeAqua0(
  strategies: Aqua0StrategyEntity[],
  fills: Aqua0FillEntity[],
  definition: Pick<CurrencyDefinition, "arcPair">,
  marketFxPerUsdc: number | null
) {
  const livePairs = [
    ...new Set(
      strategies.flatMap((strategy) =>
        strategy.tokens.map((token) => ARC_FX_TOKENS[token.toLowerCase()]?.pair).filter((pair) => pair !== undefined)
      )
    )
  ].sort();
  if (!definition.arcPair) {
    return { source: "Aqua0 subgraph on Subgraph Studio", livePairs };
  }
  const fxToken = Object.entries(ARC_FX_TOKENS).find(([, token]) => token.pair === definition.arcPair);
  const fxAddress = fxToken?.[0];
  const fxInfo = fxToken?.[1];
  const usdcAddress = ARC_USDC.address.toLowerCase();
  const pairStrategies = strategies.filter((strategy) => fxAddress !== undefined && strategy.tokens.some((token) => token.toLowerCase() === fxAddress));
  const pairFills = fills.filter((fill) => {
    const tokens = [fill.tokenIn.toLowerCase(), fill.tokenOut.toLowerCase()];
    return fxAddress !== undefined && tokens.includes(fxAddress) && tokens.includes(usdcAddress);
  });
  let usdcVolume = 0;
  const feesCredited: Record<string, number> = {};
  const recentFills = pairFills.slice(0, 10).map((fill) => {
    const usdcIn = fill.tokenIn.toLowerCase() === usdcAddress;
    const usdc = unitsToNumber(usdcIn ? fill.amountIn : fill.amountOut, ARC_USDC.decimals);
    const fx = unitsToNumber(usdcIn ? fill.amountOut : fill.amountIn, fxInfo?.decimals ?? 18);
    const feeSymbol = usdcIn ? ARC_USDC.symbol : (fxInfo?.symbol ?? "FX");
    const feeDecimals = usdcIn ? ARC_USDC.decimals : (fxInfo?.decimals ?? 18);
    return {
      at: new Date(toNumber(fill.timestamp) * 1000).toISOString(),
      direction: usdcIn ? `USDC -> ${fxInfo?.symbol ?? "FX"}` : `${fxInfo?.symbol ?? "FX"} -> USDC`,
      usdc,
      fx: significant(fx, 8),
      fxPerUsdc: usdc > 0 ? significant(fx / usdc, 6) : null,
      feesCredited: { raw: fill.feesCredited, amount: unitsToNumber(fill.feesCredited, feeDecimals), token: feeSymbol }
    };
  });
  for (const fill of pairFills) {
    const usdcIn = fill.tokenIn.toLowerCase() === usdcAddress;
    usdcVolume += unitsToNumber(usdcIn ? fill.amountIn : fill.amountOut, ARC_USDC.decimals);
    const symbol = usdcIn ? ARC_USDC.symbol : (fxInfo?.symbol ?? "FX");
    feesCredited[symbol] = (feesCredited[symbol] ?? 0) + unitsToNumber(fill.feesCredited, usdcIn ? ARC_USDC.decimals : (fxInfo?.decimals ?? 18));
  }
  return {
    source: "Aqua0 subgraph on Subgraph Studio (AquaStrategy, AquaFill with venue fxswap)",
    livePairs,
    runsThisPair: pairStrategies.length > 0,
    liveForexStrategies: pairStrategies.map((strategy) => ({
      strategyId: strategy.strategyId,
      feeBps: strategy.feePpb === null ? null : toNumber(strategy.feePpb) / 100_000,
      fillCount: toNumber(strategy.fillCount),
      shippedAt: new Date(toNumber(strategy.shippedAtTimestamp) * 1000).toISOString()
    })),
    fills: {
      count: pairFills.length,
      usdcVolume: round(usdcVolume, 6),
      feesCredited,
      recent: recentFills
    },
    marketNote:
      marketFxPerUsdc === null
        ? "No onchain market price for this currency to compare the fills with."
        : `Onchain market price from the pools above: ${significant(marketFxPerUsdc, 6)} per USDC. Arc fills settle demo tokens against Aqua0's own feed, so the two prices are not the same asset.`
  };
}

function pickQuoteFields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const record = value as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of ["pair", "opcode", "strategyId", "blockNumber", "amountIn", "amountOut", "rate", "pricing", "warnings"]) {
    if (record[key] !== undefined) {
      picked[key] = record[key];
    }
  }
  return picked;
}

// ---------------------------------------------------------------------------------------------
// verdict

export function buildVerdict(args: {
  currency: BenchmarkCurrency;
  definition: Pick<CurrencyDefinition, "latam">;
  feeBps: number;
  tradeSizesUsd: number[];
  pools: BenchmarkPool[];
  sources: BenchmarkSource[];
  lookbackDays: number;
}): { level: "liquid" | "thin" | "none" | "unknown"; summary: string } {
  const { currency, feeBps, pools, lookbackDays } = args;
  const markets = args.sources.filter((source) => source.kind !== "aqua0");
  const failed = markets.filter((source) => source.status === "failed" || source.status === "partial");
  const answered = markets.filter((source) => source.status === "ok" || source.status === "partial");
  const failureNote =
    failed.length > 0
      ? ` Not fully checked: ${failed.map((source) => `${source.protocol} on ${source.network} (${truncate(source.error ?? source.status, 80)})`).join("; ")}.`
      : "";

  if (answered.length === 0) {
    const tried = markets.filter((source) => source.status !== "skipped");
    return {
      level: "unknown",
      summary: tried.length === 0 ? `No verdict: no ${currency} stablecoin is pinned on the chosen chains.` : `No verdict: every source failed.${failureNote}`
    };
  }

  const measured = pools.filter((pool) => pool.avgDailyVolumeUsd !== null);
  const deepest = [...pools].sort((a, b) => b.tvlUsdEstimate - a.tvlUsdEstimate)[0];
  const busiest = [...measured].sort((a, b) => (b.avgDailyVolumeUsd ?? 0) - (a.avgDailyVolumeUsd ?? 0))[0];
  const period = `over ${lookbackDays} day${lookbackDays === 1 ? "" : "s"}`;

  const liquid = measured.filter(
    (pool) => pool.tvlUsdEstimate >= BENCHMARK_LIQUID_TVL_USD && (pool.avgDailyVolumeUsd ?? 0) >= BENCHMARK_LIQUID_DAILY_VOLUME_USD
  );
  const busiestLiquid = [...liquid].sort((a, b) => (b.avgDailyVolumeUsd ?? 0) - (a.avgDailyVolumeUsd ?? 0))[0];
  if (busiestLiquid) {
    const fees = liquid.map((pool) => pool.feeTierBps).filter((fee): fee is number => fee !== null);
    const minFee = fees.length > 0 ? Math.min(...fees) : null;
    const maxFee = fees.length > 0 ? Math.max(...fees) : null;
    const feeRange = minFee === null ? "unknown fees" : minFee === maxFee ? `${formatBps(minFee)} bps` : `${formatBps(minFee)}-${formatBps(maxFee ?? minFee)} bps`;
    const competitiveness =
      minFee === null
        ? ""
        : feeBps > minFee
          ? ` A ${formatBps(feeBps)} bps Aqua0 strategy is not competitive on price here: takers already pay ${feeRange} in these pools.`
          : ` A ${formatBps(feeBps)} bps Aqua0 strategy matches or beats the ${formatBps(minFee)} bps pool fee.`;
    return {
      level: "liquid",
      summary: `Liquid: ${liquid.length} ${currency}/USDC pool${liquid.length === 1 ? "" : "s"} with $1M+ TVL and $250k+ daily volume ${period} (${[...new Set(liquid.map((pool) => pool.protocol))].join(", ")}), charging ${feeRange}. Busiest: ${describePool(busiestLiquid, lookbackDays)}.${competitiveness}${failureNote}`
    };
  }

  const meaningful = measured.filter(
    (pool) => pool.tvlUsdEstimate >= BENCHMARK_MEANINGFUL_TVL_USD || (pool.avgDailyVolumeUsd ?? 0) >= BENCHMARK_MEANINGFUL_DAILY_VOLUME_USD
  );
  if (meaningful.length > 0 && deepest) {
    const largestTrade = Math.max(...args.tradeSizesUsd);
    const share = deepest.tvlUsdEstimate > 0 ? (largestTrade / deepest.tvlUsdEstimate) * 100 : undefined;
    const busiestText = busiest && busiest.id !== deepest.id ? ` Busiest: ${describePool(busiest, lookbackDays)}.` : "";
    const feeText =
      deepest.feeTierBps === null
        ? ""
        : ` At ${formatBps(feeBps)} bps the Aqua0 strategy charges ${feeBps > deepest.feeTierBps ? "more than" : "no more than"} that pool's ${formatBps(deepest.feeTierBps)} bps fee tier, and inside its flat band it quotes the oracle price rather than moving along a shallow pool.`;
    return {
      level: "thin",
      summary: `Thin: no ${currency}/USDC pool has both $1M TVL and $250k daily volume. Deepest: ${describePool(deepest, lookbackDays)}.${busiestText}${
        share === undefined ? "" : ` A $${formatUsd(largestTrade)} trade is ${round(share, 1)}% of that pool's TVL.`
      }${feeText}${args.definition.latam ? " Thin LatAm FX liquidity is the gap Aqua0's FX strategies target." : ""}${failureNote}`
    };
  }

  const found = deepest
    ? `the deepest ${currency}/USDC pool is ${describePool(deepest, lookbackDays)}`
    : `no ${currency}/USDC pool above dust was found for the pinned tokens`;
  return {
    level: "none",
    summary: `No meaningful onchain liquidity: ${found}.${args.definition.latam ? " This is the gap Aqua0's LatAm FX strategies target." : ""}${failureNote}`
  };
}

function describePool(pool: BenchmarkPool, lookbackDays: number): string {
  // From the unrounded lookback total, so small volumes keep their cents.
  const daily = pool.volumeUsdLookback === null ? null : pool.volumeUsdLookback / lookbackDays;
  const volume = daily === null ? "volume unknown" : `$${formatUsd(daily * 7)}/week ($${formatUsd(daily)}/day)`;
  const fee = pool.feeTierBps === null ? "" : ` ${formatBps(pool.feeTierBps)} bps`;
  return `${pool.protocol} on ${pool.chain}, ${pool.pair}${fee}, $${formatUsd(pool.tvlUsdEstimate)} TVL, ${volume}`;
}

// ---------------------------------------------------------------------------------------------
// helpers

async function settle(promise: Promise<unknown>): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function readMeta(meta: MessariMeta | undefined) {
  const number = meta?.block?.number;
  const timestamp = meta?.block?.timestamp;
  return {
    blockNumber: number === undefined ? null : Number(number),
    blockTimestamp: timestamp === undefined || timestamp === null ? null : Number(timestamp),
    hasIndexingErrors: meta?.hasIndexingErrors ?? null,
    deployment: meta?.deployment ?? null
  };
}

function toNumber(value: string | number | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Integer token units (possibly negative) to a decimal number. */
function unitsToNumber(raw: string | undefined, decimals: number): number {
  if (raw === undefined || !/^-?\d+$/.test(raw)) {
    return 0;
  }
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals > 0 ? digits.slice(digits.length - decimals) : "";
  const value = Number(`${whole}.${fraction || "0"}`);
  return negative ? -value : value;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function significant(value: number, digits: number): number {
  return Number(value.toPrecision(digits));
}

function formatUsd(value: number): string {
  return value >= 100 ? Math.round(value).toLocaleString("en-US") : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatBps(value: number): string {
  return Number.isInteger(value) ? String(value) : String(round(value, 2));
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function parseFallback(value: string | undefined): BenchmarkFallbackMode {
  if (value === undefined || value === "") {
    return "auto";
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto" || normalized === "always" || normalized === "never") {
    return normalized;
  }
  throw new Error('fallback must be "auto", "always" or "never"');
}

function parseBoundedNumber(
  value: number | string | undefined,
  field: string,
  fallback: number,
  valid: (value: number) => boolean,
  rule: string
): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = typeof value === "number" ? value : Number(String(value).trim().replace(/%$/, ""));
  if (!Number.isFinite(parsed) || !valid(parsed)) {
    throw new Error(`${field} must be ${rule}`);
  }
  return parsed;
}

function parseTradeSizes(values: Array<number | string> | undefined): number[] {
  if (values === undefined || values.length === 0) {
    return [...DEFAULT_TRADE_SIZES_USD];
  }
  if (values.length > 10) {
    throw new Error("tradeSizesUsd takes at most 10 sizes");
  }
  return values.map((value) =>
    parseBoundedNumber(
      typeof value === "string" ? value.replace(/[$,_\s]/g, "") : value,
      "tradeSizesUsd",
      0,
      (size) => size > 0 && size <= 1_000_000_000,
      "positive USD amounts up to 1e9"
    )
  );
}
