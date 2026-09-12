/**
 * Pure SwapVM / Aqua strategy encoding for the Arc USDC-FX demo, ported 1:1 from
 * `packages/contracts/script/ArcFxStrategies.s.sol`, plus the tolerant input normalisation the
 * MCP tools rely on (pair names, human amounts, prices, fees). No RPC access here.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  concat,
  decodeAbiParameters,
  encodeAbiParameters,
  encodePacked,
  formatUnits,
  getAddress,
  keccak256,
  parseUnits,
  toBytes,
  toHex,
  type Address,
  type Hex
} from "viem";

import { ARC_TESTNET_DEPLOYMENT } from "./constants.js";
import { normalizeAddress } from "./graph.js";

export type AmountUnit = "human" | "raw";
export type AmountValue = string | number;

export type TokenInfo = {
  symbol: string;
  address: Lowercase<string>;
  decimals: number;
  vault: Lowercase<string>;
  fiat: string;
  openMint: boolean;
};

export type FxPair = {
  /** Canonical display name, e.g. `USDC/ARS`. */
  name: string;
  usdc: TokenInfo;
  fx: TokenInfo;
};

export type SwapVMOrder = {
  maker: Address;
  traits: bigint;
  data: Hex;
};

export const SWAPVM = {
  /** AquaSwapVMRouter v1.0.2 `AquaOpcodes` dispatch indices. */
  opcodeFlatFeeIn: 21,
  opcodePeggedSwap: 31,
  /** useAquaInsteadOfSignature | postTransferIn hook | preTransferOut hook: what AquaAdapter accepts. */
  makerTraits: (1n << 254n) | (1n << 251n) | (1n << 250n),
  /** Taker traits flags: isExactIn | useTransferFromAndAquaPush. */
  takerFlagsExactIn: 0x0041,
  feeDenominatorPpb: 1_000_000_000,
  defaultFeePpb: 3_000_000,
  defaultLinearWidth: 10n * 10n ** 27n,
  /** 1 USDC (6 decimals). */
  defaultUsdcShip: 1_000_000n,
  shipDeadlineSeconds: 3_600n,
  adapterDomain: { name: "AquaAdapter", version: "1" }
} as const;

export const OPERATOR_ROLE = keccak256(toBytes("OPERATOR_ROLE"));
export const VENUE_SETTLER_ROLE = keccak256(toBytes("VENUE_SETTLER_ROLE"));

/** Default FX units per 1 USDC, times 100 (1400 ARS -> 140000; 5.50 BRL -> 550). */
export const DEFAULT_PRICE_E2: Readonly<Record<string, bigint>> = {
  ARGt: 140_000n,
  BRAt: 550n
};

export const ARC_TOKENS: readonly TokenInfo[] = Object.values(ARC_TESTNET_DEPLOYMENT.tokens).map(
  (token) => ({
    symbol: token.symbol,
    address: normalizeAddress(token.address),
    decimals: token.decimals,
    vault: normalizeAddress(token.vault),
    fiat: token.fiat,
    openMint: token.openMint
  })
);

const TOKEN_ALIASES: Readonly<Record<string, string>> = {
  usdc: "USDC",
  usd: "USDC",
  dollar: "USDC",
  dollars: "USDC",
  "us dollar": "USDC",
  "us dollars": "USDC",
  argt: "ARGt",
  ars: "ARGt",
  peso: "ARGt",
  pesos: "ARGt",
  "argentine peso": "ARGt",
  "argentine pesos": "ARGt",
  argentina: "ARGt",
  brat: "BRAt",
  brl: "BRAt",
  real: "BRAt",
  reais: "BRAt",
  reals: "BRAt",
  "brazilian real": "BRAt",
  "brazilian reais": "BRAt",
  brazil: "BRAt"
};

const SUPPORTED_TOKENS = "USDC, ARS (ARGt token), BRL (BRAt token)";

/** Resolve a token by symbol, fiat code, common name, token address or vault address. */
export function resolveToken(input: string): TokenInfo {
  const text = input.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(text)) {
    const value = normalizeAddress(text);
    const token = ARC_TOKENS.find((item) => item.address === value || item.vault === value);
    if (token) {
      return token;
    }
    throw new Error(`Unknown token or vault address ${text}. Supported: ${SUPPORTED_TOKENS}`);
  }
  const key = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const symbol = TOKEN_ALIASES[key];
  const token = symbol ? ARC_TOKENS.find((item) => item.symbol === symbol) : undefined;
  if (!token) {
    throw new Error(`Unknown token "${input}". Supported: ${SUPPORTED_TOKENS}`);
  }
  return token;
}

/**
 * Resolve a USDC/FX pair from loose text: `USDC/ARS`, `ars-usdc`, `USDC to BRL`, `usdc brat`, or a
 * lone FX side such as `BRL` / `the argentine peso pool` (USDC is implied).
 */
export function resolvePair(input: string): FxPair {
  const parts = input
    .replace(/\b(?:to|for|into|and|vs|versus|pair|pool|strategy|market|the|a|an|my|new)\b/gi, " ")
    .replace(/[/\\\-:,>|+→]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let lastError: Error | undefined;
  if (parts.length > 0) {
    try {
      const only = resolveToken(parts.join(" "));
      if (only.symbol !== "USDC") {
        return { name: `USDC/${only.fiat}`, usdc: resolveToken("USDC"), fx: only };
      }
    } catch {
      // Not a single token; try splitting into two sides below.
    }
  }
  for (let split = 1; split < parts.length; split += 1) {
    try {
      const first = resolveToken(parts.slice(0, split).join(" "));
      const second = resolveToken(parts.slice(split).join(" "));
      const usdc = [first, second].find((token) => token.symbol === "USDC");
      const fx = [first, second].find((token) => token.symbol !== "USDC");
      if (!usdc || !fx) {
        throw new Error(`Pair "${input}" must be USDC against ARS or BRL`);
      }
      return { name: `USDC/${fx.fiat}`, usdc, fx };
    } catch (error) {
      lastError = error instanceof Error ? error : lastError;
    }
  }
  throw new Error(
    `Could not read pair "${input}". Use USDC/ARS or USDC/BRL${
      lastError && parts.length === 2 ? ` (${lastError.message})` : ""
    }`
  );
}

/** Accepts `arc-testnet`, `Arc Testnet`, `arc`, `5042002`; rejects everything else. */
export function assertSupportedChain(chain: string | number | undefined, chainId: number): void {
  if (chain === undefined || String(chain).trim() === "") {
    return;
  }
  const text = String(chain).trim().toLowerCase().replace(/[\s_]+/g, "-");
  const isArc =
    text === String(ARC_TESTNET_DEPLOYMENT.chainId) || /^arc(-?test(-?net)?)?$/.test(text);
  if (!isArc) {
    throw new Error(
      `Unsupported chain "${chain}". These tools target arc-testnet (chain id ${ARC_TESTNET_DEPLOYMENT.chainId})`
    );
  }
  if (chainId !== ARC_TESTNET_DEPLOYMENT.chainId) {
    throw new Error(`chain "${chain}" was requested but WRITE_CHAIN_ID is ${chainId}`);
  }
}

/**
 * Parse an amount into base units. `unit: "human"` (default) takes decimal token units ("2", "2.5",
 * "0.1 USDC", "1,000.5", "2,5"); `unit: "raw"` takes whole base units ("2000000").
 */
export function parseTokenAmount(
  value: AmountValue,
  decimals: number,
  options: { unit?: AmountUnit | undefined; field?: string | undefined } = {}
): bigint {
  const field = options.field ?? "amount";
  const unit = options.unit ?? "human";
  if (unit === "raw" && typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error(`${field} ${value} is not a safe integer; pass large raw amounts as strings`);
  }
  const text = normalizeNumericText(value, field);
  if (unit === "raw") {
    if (!/^\d+$/.test(text)) {
      throw new Error(
        `${field} "${value}" must be a whole number of base units when unit is "raw"; use unit "human" for decimal amounts like 2.5`
      );
    }
    return BigInt(text);
  }
  const fraction = text.split(".")[1] ?? "";
  if (fraction.length > decimals) {
    throw new Error(
      `${field} "${value}" has ${fraction.length} decimal places; at most ${decimals} are allowed`
    );
  }
  return parseUnits(text.startsWith(".") ? `0${text}` : text, decimals);
}

/** Parse an integer that may be written in scientific notation (`1e28`, `10e27`). */
export function parseIntegerLike(value: AmountValue, field: string): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  const text = (typeof value === "number" ? numberToPlainString(value, field) : String(value))
    .trim()
    .replace(/[_,\s]/g, "");
  if (/^\d+$/.test(text)) {
    return BigInt(text);
  }
  const scientific = /^(\d+)(?:\.(\d+))?e\+?(\d+)$/i.exec(text);
  if (scientific) {
    const fraction = scientific[2] ?? "";
    const exponent = Number(scientific[3]);
    if (fraction.length <= exponent) {
      return BigInt(`${scientific[1]}${fraction}`) * 10n ** BigInt(exponent - fraction.length);
    }
  }
  throw new Error(`${field} "${value}" must be a non-negative integer (1e28 style is accepted)`);
}

export function parsePriceE2(
  input: { price?: AmountValue | undefined; priceE2?: AmountValue | undefined },
  fx: TokenInfo
): bigint {
  if (input.price !== undefined && input.priceE2 !== undefined) {
    throw new Error("Pass either price or priceE2, not both");
  }
  let priceE2: bigint;
  if (input.priceE2 !== undefined) {
    priceE2 = parseIntegerLike(input.priceE2, "priceE2");
  } else if (input.price !== undefined) {
    priceE2 = parseTokenAmount(input.price, 2, { field: `price (${fx.fiat} per 1 USDC)` });
  } else {
    const fallback = DEFAULT_PRICE_E2[fx.symbol];
    if (fallback === undefined) {
      throw new Error(`No default price for ${fx.symbol}; pass price`);
    }
    priceE2 = fallback;
  }
  if (priceE2 <= 0n) {
    throw new Error("price must be greater than zero");
  }
  return priceE2;
}

/** feePpb (parts per billion), feeBps (30 = 0.30%) or feePercent (0.3 / "0.3%"). Default 3,000,000 ppb. */
export function parseFeePpb(input: {
  feePpb?: AmountValue | undefined;
  feeBps?: AmountValue | undefined;
  feePercent?: AmountValue | undefined;
}): number {
  const provided = [input.feePpb, input.feeBps, input.feePercent].filter(
    (value) => value !== undefined
  );
  if (provided.length > 1) {
    throw new Error("Pass only one of feePpb, feeBps or feePercent");
  }
  let feePpb: bigint;
  if (input.feePpb !== undefined) {
    feePpb = parseIntegerLike(input.feePpb, "feePpb");
  } else if (input.feeBps !== undefined) {
    feePpb = parseTokenAmount(input.feeBps, 5, { field: "feeBps" });
  } else if (input.feePercent !== undefined) {
    feePpb = parseTokenAmount(input.feePercent, 7, { field: "feePercent" });
  } else {
    feePpb = BigInt(SWAPVM.defaultFeePpb);
  }
  if (feePpb >= BigInt(SWAPVM.feeDenominatorPpb)) {
    throw new Error(`fee of ${feePpb} ppb must be below 1,000,000,000 ppb (100%)`);
  }
  return Number(feePpb);
}

/** FX-token amount worth `usdcAmount` at `priceE2` FX units per USDC (decimal gap handled). */
export function fxAmountFor(usdcAmount: bigint, priceE2: bigint, pair: FxPair): bigint {
  return (usdcAmount * decimalScale(pair) * priceE2) / 100n;
}

/**
 * `[FlatFeeAmountIn(feePpb)][PeggedSwap(x0, y0, linearWidth, rateLt, rateGt)]` for a USDC/FX pair.
 * USDC's rate multiplier carries both the decimal gap and the FX price, so the curve's balanced
 * point sits at `priceE2 / 100` FX units per USDC.
 */
export function buildPeggedProgram(input: {
  pair: FxPair;
  usdcReserve: bigint;
  fxReserve: bigint;
  priceE2: bigint;
  feePpb: number;
  linearWidth: bigint;
}): Hex {
  const scaledPrice = input.priceE2 * decimalScale(input.pair);
  if (scaledPrice % 100n !== 0n) {
    throw new Error("priceE2 x 10^(fx decimals - USDC decimals) must be divisible by 100");
  }
  const usdcRate = scaledPrice / 100n;
  const fxRate = 1n;
  const usdcIsLower = BigInt(input.pair.usdc.address) < BigInt(input.pair.fx.address);
  const [x0, y0, rateLt, rateGt] = usdcIsLower
    ? [input.usdcReserve * usdcRate, input.fxReserve * fxRate, usdcRate, fxRate]
    : [input.fxReserve * fxRate, input.usdcReserve * usdcRate, fxRate, usdcRate];
  const peggedArgs = encodeAbiParameters(
    [
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" }
    ],
    [x0, y0, input.linearWidth, rateLt, rateGt]
  );
  return encodePacked(
    ["uint8", "uint8", "uint32", "uint8", "uint8", "bytes"],
    [SWAPVM.opcodeFlatFeeIn, 4, input.feePpb, SWAPVM.opcodePeggedSwap, 160, peggedArgs]
  );
}

const ORDER_PARAMETERS = [
  {
    type: "tuple",
    components: [
      { name: "maker", type: "address" },
      { name: "traits", type: "uint256" },
      { name: "data", type: "bytes" }
    ]
  }
] as const;

export function buildAquaOrder(adapter: string, program: Hex): SwapVMOrder {
  return { maker: getAddress(adapter), traits: SWAPVM.makerTraits, data: program };
}

/** `abi.encode(ISwapVM.Order)`; its keccak256 is the Aqua strategy hash / AquaAdapter strategyId. */
export function encodeSwapVMOrder(order: SwapVMOrder): Hex {
  return encodeAbiParameters(ORDER_PARAMETERS, [order]);
}

export function decodeSwapVMOrder(strategyBytes: Hex): SwapVMOrder {
  const [order] = decodeAbiParameters(ORDER_PARAMETERS, strategyBytes);
  return { maker: order.maker, traits: order.traits, data: order.data };
}

export type StrategyParamsInput = {
  /** Pegged only: FX units per 1 USDC, up to 2 decimals: 1400 (ARS), 5.5 (BRL). */
  price?: AmountValue | undefined;
  /** Pegged only: price x 100 as an integer. */
  priceE2?: AmountValue | undefined;
  /** Pegged: the flat input fee. FXSwap: the mid fee (fee at balance). */
  feePpb?: AmountValue | undefined;
  feeBps?: AmountValue | undefined;
  feePercent?: AmountValue | undefined;
  /** USDC shipped into the strategy (default 1 USDC). */
  usdcAmount?: AmountValue | undefined;
  /** FX tokens shipped (default: usdcAmount x price; FXSwap uses the live oracle price). */
  fxAmount?: AmountValue | undefined;
  amountUnit?: AmountUnit | undefined;
  /** Pegged only: PeggedSwap flat-zone width. */
  linearWidth?: AmountValue | undefined;
  /** FXSwap: CryptoSwap amplification A in whitepaper units (default 100). */
  a?: AmountValue | undefined;
  /** FXSwap: CryptoSwap gamma as a decimal (default 0.1). */
  gamma?: AmountValue | undefined;
  /** FXSwap: fee far from balance (default 1%, never below the mid fee). */
  outFeeBps?: AmountValue | undefined;
  outFeePercent?: AmountValue | undefined;
  outFeePpb?: AmountValue | undefined;
  /** FXSwap: fee transition width as a decimal (default 0.03). */
  feeGamma?: AmountValue | undefined;
  /** FXSwap: optional FlatFeeAmountIn input fee in front of the curve (default none). */
  flatFeeBps?: AmountValue | undefined;
  flatFeePercent?: AmountValue | undefined;
  flatFeePpb?: AmountValue | undefined;
  /** FXSwap: accepted feed band as +/- percent around the live oracle price at creation. */
  bandPercent?: AmountValue | undefined;
  /** FXSwap: lowest accepted feed answer, FX units per 1 USD (default 0.5x the reference price). */
  minPrice?: AmountValue | undefined;
  /** FXSwap: highest accepted feed answer, FX units per 1 USD (default 2x the reference price). */
  maxPrice?: AmountValue | undefined;
  /** FXSwap: max feed age, seconds or "24h" / "7d" / "30m" (default 7d). */
  maxStaleness?: AmountValue | undefined;
  /** FXSwap: feed decimals pinned in the program; 0 (default) reads decimals() on every swap. */
  oracleDecimals?: AmountValue | undefined;
  /** Strategy class label (default `FXSwap ARS` for pegged, `FXSwap oracle ARS` for FXSwap). */
  label?: string | undefined;
};

export type PeggedStrategySpec = {
  opcode: "pegged";
  pair: FxPair;
  label: string;
  priceE2: bigint;
  feePpb: number;
  usdcShip: bigint;
  fxShip: bigint;
  linearWidth: bigint;
  program: Hex;
  order: SwapVMOrder;
  strategyBytes: Hex;
  strategyId: Hex;
  tokens: [Address, Address];
  amounts: [bigint, bigint];
};

export function buildPeggedStrategySpec(
  adapter: string,
  pair: FxPair,
  params: StrategyParamsInput = {}
): PeggedStrategySpec {
  assertParamsFor("pegged", params);
  const priceE2 = parsePriceE2(params, pair.fx);
  const feePpb = parseFeePpb(params);
  const unit = params.amountUnit ?? "human";
  const usdcShip =
    params.usdcAmount === undefined
      ? SWAPVM.defaultUsdcShip
      : parseTokenAmount(params.usdcAmount, pair.usdc.decimals, { unit, field: "usdcAmount" });
  if (usdcShip <= 0n) {
    throw new Error("usdcAmount must be greater than zero");
  }
  const fxShip =
    params.fxAmount === undefined
      ? fxAmountFor(usdcShip, priceE2, pair)
      : parseTokenAmount(params.fxAmount, pair.fx.decimals, { unit, field: "fxAmount" });
  if (fxShip <= 0n) {
    throw new Error("fxAmount must be greater than zero");
  }
  const linearWidth =
    params.linearWidth === undefined
      ? SWAPVM.defaultLinearWidth
      : parseIntegerLike(params.linearWidth, "linearWidth");
  if (linearWidth <= 0n) {
    throw new Error("linearWidth must be greater than zero");
  }
  const label = (params.label ?? `FXSwap ${pair.fx.fiat}`).trim();
  if (label.length === 0) {
    throw new Error("label must not be empty");
  }
  const program = buildPeggedProgram({
    pair,
    usdcReserve: usdcShip,
    fxReserve: fxShip,
    priceE2,
    feePpb,
    linearWidth
  });
  const order = buildAquaOrder(adapter, program);
  const strategyBytes = encodeSwapVMOrder(order);
  return {
    opcode: "pegged",
    pair,
    label,
    priceE2,
    feePpb,
    usdcShip,
    fxShip,
    linearWidth,
    program,
    order,
    strategyBytes,
    strategyId: keccak256(strategyBytes),
    tokens: [getAddress(pair.usdc.address), getAddress(pair.fx.address)],
    amounts: [usdcShip, fxShip]
  };
}

// ---------------------------------------------------------------------------------------------
// FXSwap: oracle-anchored CryptoSwap instruction, AquaFXSwapVMRouter opcode 34.
// Mirrors packages/contracts/src/instructions/FXSwap.sol (FXSwapArgsBuilder); byte-equality is pinned by
// test/fixtures/fxswap-args-vectors.json, generated from the Solidity builder.

export const FXSWAP = {
  opcode: 34,
  argsLength: 115,
  oracleKindChainlink: 0,
  flagInvertPrice: 0x01,
  wad: 10n ** 18n,
  /** A is encoded as whitepaper A x 1e4. */
  aPrecision: 10_000n,
  maxA: 1_000_000n * 10_000n,
  minGamma: 10n ** 10n,
  maxGamma: 10n ** 18n,
  /** 50% in WAD. */
  maxFee: 5n * 10n ** 17n,
  routerDomain: { name: "AquaSwapVMRouter", version: "1.0.2-fx" }
} as const;

/**
 * Demo defaults for FXSwap strategies:
 * - A = 100 (the FXSwap test suite's value), gamma = 0.1. The test suite's gamma 0.01 was tuned on a 100k USD pool
 *   with 0.1% trades. At demo depth (1 USDC shipped, 0.1 USDC trades, i.e. 10% of a side) gamma 0.01 leaves the
 *   near-flat zone after a single trade: FXSwapPricing gives a 415 bps spread on the second 0.1 USDC trade and a +5%
 *   oracle move lifts that quote only +2.5%. gamma 0.1 keeps the curve flat around the oracle over those imbalances
 *   (95 bps, +4.8%), while the dynamic fee below still widens as inventory drains.
 * - midFee 10 bps at balance, outFee 1% far from balance, feeGamma 0.03: a tight quote for a balanced pool that
 *   widens as one side is drained, which is what protects the LP when the feed lags the market.
 * - maxStaleness 7 days: the demo feeds are ManualFxOracle answers set by hand (no heartbeat), so a short window
 *   would brick quotes between updates. A Chainlink FX feed (24h heartbeat) should use ~25h instead.
 * - oracleDecimals 0: read decimals() from the feed on every swap, so the program stays correct for any feed.
 * - Price band 0.5x to 2x of a per-pair reference price (700..2800 ARS, 2.75..11 BRL per USD): a circuit
 *   breaker against a broken or mis-scaled feed, not a trading limit, and deterministic so the default strategy id
 *   can be recomputed from the pair alone. `bandPercent` tightens it around the live price at creation.
 */
export const FXSWAP_DEFAULTS = {
  a: 1_000_000n,
  gamma: 10n ** 17n,
  midFee: 10n ** 15n,
  outFee: 10n ** 16n,
  feeGamma: 3n * 10n ** 16n,
  maxStaleness: 604_800,
  oracleDecimals: 0
} as const;

/** What an FX feed answer means: FX units per 1 USD, or USD per 1 FX unit. */
export type FxFeedQuote = "fxPerUsd" | "usdPerFx";

/** FX units per 1 USD (WAD) the default price band is built around. */
export const FXSWAP_REFERENCE_PRICE_WAD: Readonly<Record<string, bigint>> = {
  ARGt: 1_400n * 10n ** 18n,
  BRAt: 55n * 10n ** 17n
};

/** FXSwapArgsBuilder.Args. Prices are feed answers scaled to WAD in the feed's orientation. */
export type FxSwapArgs = {
  oracleKind: number;
  flags: number;
  oracle: string;
  oracleDecimals: number;
  maxStaleness: number;
  minPrice: bigint;
  maxPrice: bigint;
  a: bigint;
  gamma: bigint;
  midFee: bigint;
  outFee: bigint;
  feeGamma: bigint;
  rateLt: bigint;
  rateGt: bigint;
};

const UINT32_MAX = 4_294_967_295;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT128_MAX = (1n << 128n) - 1n;

/** Same checks, in the same order, as FXSwapArgsBuilder.validate, plus field-width checks. */
export function validateFxSwapArgs(args: FxSwapArgs): void {
  assertIntInRange(args.oracleKind, 255, "oracleKind");
  assertIntInRange(args.flags, 255, "flags");
  assertIntInRange(args.oracleDecimals, 255, "oracleDecimals");
  assertIntInRange(args.maxStaleness, UINT32_MAX, "maxStaleness");
  const wide: Array<[string, bigint, bigint]> = [
    ["minPrice", args.minPrice, UINT128_MAX],
    ["maxPrice", args.maxPrice, UINT128_MAX],
    ["a", args.a, UINT64_MAX],
    ["gamma", args.gamma, UINT64_MAX],
    ["midFee", args.midFee, UINT64_MAX],
    ["outFee", args.outFee, UINT64_MAX],
    ["feeGamma", args.feeGamma, UINT64_MAX],
    ["rateLt", args.rateLt, UINT64_MAX],
    ["rateGt", args.rateGt, UINT64_MAX]
  ];
  for (const [name, value, max] of wide) {
    if (value < 0n || value > max) {
      throw new Error(`FXSwap ${name} ${value} does not fit its ${max === UINT128_MAX ? "uint128" : "uint64"} field`);
    }
  }
  if (args.oracleKind !== FXSWAP.oracleKindChainlink) {
    throw new Error(
      `FXSwapUnsupportedOracleKind(${args.oracleKind}): only oracleKind 0 (Chainlink-style latestRoundData) is supported; 1 (Pyth) is reserved`
    );
  }
  if ((args.flags & ~FXSWAP.flagInvertPrice) !== 0) {
    throw new Error(`FXSwapInvalidFlags(${args.flags}): only bit 0 (invert price) may be set`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(args.oracle) || BigInt(args.oracle) === 0n) {
    throw new Error(`FXSwapInvalidOracle(): oracle "${args.oracle}" must be a non-zero address`);
  }
  if (args.maxStaleness === 0) {
    throw new Error("FXSwapInvalidMaxStaleness(): maxStaleness must be greater than zero seconds");
  }
  if (args.minPrice === 0n || args.minPrice > args.maxPrice) {
    throw new Error(
      `FXSwapInvalidPriceBand(${args.minPrice}, ${args.maxPrice}): need 0 < minPrice <= maxPrice`
    );
  }
  if (args.a > FXSWAP.maxA || args.gamma < FXSWAP.minGamma || args.gamma > FXSWAP.maxGamma) {
    throw new Error(
      `FXSwapInvalidCurve(${args.a}, ${args.gamma}): need A <= 1,000,000 and 1e-8 <= gamma <= 1`
    );
  }
  if (
    !(
      args.midFee <= args.outFee &&
      args.outFee <= FXSWAP.maxFee &&
      args.feeGamma <= FXSWAP.wad &&
      (args.feeGamma !== 0n || args.midFee === args.outFee)
    )
  ) {
    throw new Error(
      `FXSwapInvalidFees(${args.midFee}, ${args.outFee}, ${args.feeGamma}): need midFee <= outFee <= 50%, feeGamma <= 1, and feeGamma > 0 unless midFee == outFee`
    );
  }
  if (args.rateLt === 0n || args.rateGt === 0n) {
    throw new Error(`FXSwapInvalidRates(${args.rateLt}, ${args.rateGt}): rates must be non-zero`);
  }
}

/** FXSwapArgsBuilder.build: validate, then pack the 115-byte big-endian layout. */
export function encodeFxSwapArgs(args: FxSwapArgs): Hex {
  validateFxSwapArgs(args);
  return encodePacked(
    [
      "uint8",
      "uint8",
      "address",
      "uint8",
      "uint32",
      "uint128",
      "uint128",
      "uint64",
      "uint64",
      "uint64",
      "uint64",
      "uint64",
      "uint64",
      "uint64"
    ],
    [
      args.oracleKind,
      args.flags,
      getAddress(args.oracle),
      args.oracleDecimals,
      args.maxStaleness,
      args.minPrice,
      args.maxPrice,
      args.a,
      args.gamma,
      args.midFee,
      args.outFee,
      args.feeGamma,
      args.rateLt,
      args.rateGt
    ]
  );
}

/** FXSwapArgsBuilder.parse: decode the 115-byte layout, then validate. */
export function decodeFxSwapArgs(data: Hex): FxSwapArgs {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error("FXSwap args must be hex bytes");
  }
  if (hex.length / 2 !== FXSWAP.argsLength) {
    throw new Error(`FXSwapInvalidArgsLength(${hex.length / 2}): FXSwap args are ${FXSWAP.argsLength} bytes`);
  }
  const field = (offset: number, size: number) => BigInt(`0x${hex.slice(offset * 2, (offset + size) * 2)}`);
  const args: FxSwapArgs = {
    oracleKind: Number(field(0, 1)),
    flags: Number(field(1, 1)),
    oracle: getAddress(`0x${hex.slice(4, 44)}`),
    oracleDecimals: Number(field(22, 1)),
    maxStaleness: Number(field(23, 4)),
    minPrice: field(27, 16),
    maxPrice: field(43, 16),
    a: field(59, 8),
    gamma: field(67, 8),
    midFee: field(75, 8),
    outFee: field(83, 8),
    feeGamma: field(91, 8),
    rateLt: field(99, 8),
    rateGt: field(107, 8)
  };
  validateFxSwapArgs(args);
  return args;
}

/**
 * FXSwapArgsBuilder.orientation for a feed quoting `quote` units per 1 `base`: whether the invert flag is needed
 * and the decimals multipliers (10^(18 - decimals)) of the lower- and greater-address tokens.
 */
export function fxSwapOrientation(
  base: string,
  baseDecimals: number,
  quote: string,
  quoteDecimals: number
): { invertPrice: boolean; rateLt: bigint; rateGt: bigint } {
  if (normalizeAddress(base) === normalizeAddress(quote)) {
    throw new Error("FXSwapInvalidPair(): base and quote must differ");
  }
  for (const decimals of [baseDecimals, quoteDecimals]) {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
      throw new Error(`FXSwapUnsupportedDecimals(${decimals}): token decimals must be 0..18`);
    }
  }
  const baseRate = 10n ** BigInt(18 - baseDecimals);
  const quoteRate = 10n ** BigInt(18 - quoteDecimals);
  return BigInt(base) < BigInt(quote)
    ? { invertPrice: false, rateLt: baseRate, rateGt: quoteRate }
    : { invertPrice: true, rateLt: quoteRate, rateGt: baseRate };
}

/** `[FlatFeeAmountIn(flatFeePpb)]` (only when flatFeePpb > 0) followed by `[FXSwap(args)]`. */
export function buildFxSwapProgram(input: { args: FxSwapArgs; flatFeePpb?: number | undefined }): Hex {
  const fxSwap = encodePacked(
    ["uint8", "uint8", "bytes"],
    [FXSWAP.opcode, FXSWAP.argsLength, encodeFxSwapArgs(input.args)]
  );
  const flatFeePpb = input.flatFeePpb ?? 0;
  if (!Number.isInteger(flatFeePpb) || flatFeePpb < 0 || flatFeePpb >= SWAPVM.feeDenominatorPpb) {
    throw new Error(`flat fee of ${flatFeePpb} ppb must be an integer below 1,000,000,000 ppb (100%)`);
  }
  if (flatFeePpb === 0) {
    return fxSwap;
  }
  return concat([
    encodePacked(["uint8", "uint8", "uint32"], [SWAPVM.opcodeFlatFeeIn, 4, flatFeePpb]),
    fxSwap
  ]);
}

export type DecodedInstruction =
  | { opcode: 21; name: "FlatFeeAmountIn"; feePpb: number }
  | {
      opcode: 31;
      name: "PeggedSwap";
      x0: bigint;
      y0: bigint;
      linearWidth: bigint;
      rateLt: bigint;
      rateGt: bigint;
    }
  | { opcode: 34; name: "FXSwap"; args: FxSwapArgs }
  | { opcode: number; name: "unknown"; args: Hex };

/** Split a SwapVM program into `[opcode][length][args]` instructions and decode the ones Aqua0 ships. */
export function decodeSwapVMProgram(program: Hex): DecodedInstruction[] {
  const hex = program.startsWith("0x") ? program.slice(2) : program;
  const instructions: DecodedInstruction[] = [];
  let cursor = 0;
  while (cursor < hex.length) {
    if (cursor + 4 > hex.length) {
      throw new Error("SwapVM program is truncated inside an instruction header");
    }
    const opcode = Number.parseInt(hex.slice(cursor, cursor + 2), 16);
    const length = Number.parseInt(hex.slice(cursor + 2, cursor + 4), 16);
    const body = hex.slice(cursor + 4, cursor + 4 + length * 2);
    if (body.length !== length * 2) {
      throw new Error(`SwapVM program is truncated inside opcode ${opcode}'s ${length}-byte args`);
    }
    cursor += 4 + length * 2;
    const args = `0x${body}` as Hex;
    if (opcode === SWAPVM.opcodeFlatFeeIn && length === 4) {
      instructions.push({ opcode, name: "FlatFeeAmountIn", feePpb: Number(BigInt(args)) });
    } else if (opcode === SWAPVM.opcodePeggedSwap && length === 160) {
      const [x0, y0, linearWidth, rateLt, rateGt] = decodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
        args
      );
      instructions.push({ opcode, name: "PeggedSwap", x0, y0, linearWidth, rateLt, rateGt });
    } else if (opcode === FXSWAP.opcode && length === FXSWAP.argsLength) {
      instructions.push({ opcode, name: "FXSwap", args: decodeFxSwapArgs(args) });
    } else {
      instructions.push({ opcode, name: "unknown", args });
    }
  }
  return instructions;
}

export type StrategyOpcode = "pegged" | "fxswap";

const PEGGED_ONLY_PARAMS = ["price", "priceE2", "linearWidth"] as const;
const FXSWAP_ONLY_PARAMS = [
  "a",
  "gamma",
  "outFeeBps",
  "outFeePercent",
  "outFeePpb",
  "feeGamma",
  "flatFeeBps",
  "flatFeePercent",
  "flatFeePpb",
  "bandPercent",
  "minPrice",
  "maxPrice",
  "maxStaleness",
  "oracleDecimals"
] as const;

/** Opcode implied by opcode-specific params, or undefined when only shared params (or none) are set. */
export function inferOpcodeFromParams(params: StrategyParamsInput = {}): StrategyOpcode | undefined {
  const pegged = PEGGED_ONLY_PARAMS.filter((key) => params[key] !== undefined);
  const fxswap = FXSWAP_ONLY_PARAMS.filter((key) => params[key] !== undefined);
  if (pegged.length > 0 && fxswap.length > 0) {
    throw new Error(
      `params mix pegged-only fields (${pegged.join(", ")}) with FXSwap-only fields (${fxswap.join(", ")}); pick one opcode`
    );
  }
  return pegged.length > 0 ? "pegged" : fxswap.length > 0 ? "fxswap" : undefined;
}

function assertParamsFor(opcode: StrategyOpcode, params: StrategyParamsInput): void {
  const foreign = (opcode === "pegged" ? FXSWAP_ONLY_PARAMS : PEGGED_ONLY_PARAMS).filter(
    (key) => params[key] !== undefined
  );
  if (foreign.length === 0) {
    return;
  }
  throw new Error(
    opcode === "pegged"
      ? `${foreign.join(", ")} only apply to opcode "fxswap" (oracle-anchored FXSwap); the pegged strategy takes price, fee, amounts and linearWidth`
      : `${foreign.join(", ")} only apply to opcode "pegged" (fixed price). FXSwap prices every swap from the oracle: move the feed with set_fx_price, bound it with minPrice/maxPrice or bandPercent`
  );
}

/** Parse seconds, or a duration like "24h", "7d", "30m", "90 seconds". */
export function parseDurationSeconds(value: AmountValue, field = "maxStaleness"): number {
  const text = String(value).trim().toLowerCase();
  const match =
    /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?)?$/.exec(text);
  if (!match) {
    throw new Error(`${field} "${value}" must be seconds or a duration like 3600, "24h", "7d"`);
  }
  const unit = match[2] ?? "s";
  const multiplier = unit.startsWith("w")
    ? 604_800
    : unit.startsWith("d")
      ? 86_400
      : unit.startsWith("h")
        ? 3_600
        : unit.startsWith("m")
          ? 60
          : 1;
  const seconds = Number(match[1]) * multiplier;
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > UINT32_MAX) {
    throw new Error(`${field} "${value}" must be a whole number of seconds between 1 and ${UINT32_MAX}`);
  }
  return seconds;
}

export type FxSwapStrategySpec = {
  opcode: "fxswap";
  pair: FxPair;
  label: string;
  oracle: Lowercase<string>;
  /** What the feed answer means; `minPrice`/`maxPrice` are in this orientation. */
  feedQuote: FxFeedQuote;
  args: FxSwapArgs;
  band: { source: "default" | "explicit" | "bandPercent"; minPrice: bigint; maxPrice: bigint };
  flatFeePpb: number;
  /**
   * Rate declared to AquaAdapter.shipStrategyWithFee: the flat fee composed with the FXSwap mid fee. The adapter
   * does not read opcodes, so this is a declaration; the mid fee is the minimum the curve charges (at balance),
   * so the declared rate never overstates what the program takes.
   */
  feePpb: number;
  usdcShip: bigint;
  fxShip: bigint;
  program: Hex;
  order: SwapVMOrder;
  strategyBytes: Hex;
  strategyId: Hex;
  tokens: [Address, Address];
  amounts: [bigint, bigint];
};

export type StrategySpec = PeggedStrategySpec | FxSwapStrategySpec;

/**
 * `[FlatFeeAmountIn]?[FXSwap]` for a USDC/FX pair. `context.feedQuote` says what the feed answer means: FX units per
 * 1 USD (`fxPerUsd`, the default: the manual feeds, RedStone MXNe) or USD per 1 FX unit (`usdPerFx`: RedStone BRL).
 * `oraclePriceWad` (the live feed answer in WAD, in the feed's orientation) is needed for `bandPercent` and for the
 * default `fxAmount` (value-balanced ship).
 */
export function buildFxSwapStrategySpec(
  adapter: string,
  pair: FxPair,
  oracle: string,
  params: StrategyParamsInput = {},
  context: { oraclePriceWad?: bigint | undefined; feedQuote?: FxFeedQuote | undefined } = {}
): FxSwapStrategySpec {
  assertParamsFor("fxswap", params);
  const feedQuote = context.feedQuote ?? "fxPerUsd";
  const orientation =
    feedQuote === "usdPerFx"
      ? fxSwapOrientation(pair.fx.address, pair.fx.decimals, pair.usdc.address, pair.usdc.decimals)
      : fxSwapOrientation(pair.usdc.address, pair.usdc.decimals, pair.fx.address, pair.fx.decimals);
  const a =
    params.a === undefined ? FXSWAP_DEFAULTS.a : parseTokenAmount(params.a, 4, { field: "a (amplification A)" });
  const gamma =
    params.gamma === undefined ? FXSWAP_DEFAULTS.gamma : parseTokenAmount(params.gamma, 18, { field: "gamma" });
  const midFee =
    parseOptionalRateWad(
      { ppb: params.feePpb, bps: params.feeBps, percent: params.feePercent },
      ["feePpb", "feeBps", "feePercent"]
    ) ?? FXSWAP_DEFAULTS.midFee;
  const outFee =
    parseOptionalRateWad(
      { ppb: params.outFeePpb, bps: params.outFeeBps, percent: params.outFeePercent },
      ["outFeePpb", "outFeeBps", "outFeePercent"]
    ) ?? (midFee > FXSWAP_DEFAULTS.outFee ? midFee : FXSWAP_DEFAULTS.outFee);
  const feeGamma =
    params.feeGamma === undefined
      ? FXSWAP_DEFAULTS.feeGamma
      : parseTokenAmount(params.feeGamma, 18, { field: "feeGamma" });
  const flatFeeWad = parseOptionalRateWad(
    { ppb: params.flatFeePpb, bps: params.flatFeeBps, percent: params.flatFeePercent },
    ["flatFeePpb", "flatFeeBps", "flatFeePercent"]
  );
  if (flatFeeWad !== undefined && flatFeeWad % 10n ** 9n !== 0n) {
    throw new Error("flat fee is finer than 1 ppb (0.0000001%)");
  }
  const flatFeePpb = flatFeeWad === undefined ? 0 : Number(flatFeeWad / 10n ** 9n);
  const band = resolveFxSwapBand(pair, params, context.oraclePriceWad, feedQuote);
  const maxStaleness =
    params.maxStaleness === undefined
      ? FXSWAP_DEFAULTS.maxStaleness
      : parseDurationSeconds(params.maxStaleness);
  const oracleDecimals =
    params.oracleDecimals === undefined
      ? FXSWAP_DEFAULTS.oracleDecimals
      : Number(parseIntegerLike(params.oracleDecimals, "oracleDecimals"));

  const args: FxSwapArgs = {
    oracleKind: FXSWAP.oracleKindChainlink,
    flags: orientation.invertPrice ? FXSWAP.flagInvertPrice : 0,
    oracle: getAddress(oracle),
    oracleDecimals,
    maxStaleness,
    minPrice: band.minPrice,
    maxPrice: band.maxPrice,
    a,
    gamma,
    midFee,
    outFee,
    feeGamma,
    rateLt: orientation.rateLt,
    rateGt: orientation.rateGt
  };
  const program = buildFxSwapProgram({ args, flatFeePpb });

  const unit = params.amountUnit ?? "human";
  const usdcShip =
    params.usdcAmount === undefined
      ? SWAPVM.defaultUsdcShip
      : parseTokenAmount(params.usdcAmount, pair.usdc.decimals, { unit, field: "usdcAmount" });
  if (usdcShip <= 0n) {
    throw new Error("usdcAmount must be greater than zero");
  }
  let fxShip: bigint;
  if (params.fxAmount !== undefined) {
    fxShip = parseTokenAmount(params.fxAmount, pair.fx.decimals, { unit, field: "fxAmount" });
  } else if (context.oraclePriceWad !== undefined && context.oraclePriceWad > 0n) {
    const fxPerUsdWad =
      feedQuote === "usdPerFx" ? (FXSWAP.wad * FXSWAP.wad) / context.oraclePriceWad : context.oraclePriceWad;
    fxShip = (usdcShip * decimalScale(pair) * fxPerUsdWad) / FXSWAP.wad;
  } else {
    throw new Error("fxAmount defaults to usdcAmount x the live oracle price; read the feed first or pass fxAmount");
  }
  if (fxShip <= 0n) {
    throw new Error("fxAmount must be greater than zero");
  }
  const label = (params.label ?? `FXSwap oracle ${pair.fx.fiat}`).trim();
  if (label.length === 0) {
    throw new Error("label must not be empty");
  }
  const order = buildAquaOrder(adapter, program);
  const strategyBytes = encodeSwapVMOrder(order);
  return {
    opcode: "fxswap",
    pair,
    label,
    oracle: normalizeAddress(oracle),
    feedQuote,
    args,
    band,
    flatFeePpb,
    feePpb: composeFeePpb(flatFeePpb, Number(midFee / 10n ** 9n)),
    usdcShip,
    fxShip,
    program,
    order,
    strategyBytes,
    strategyId: keccak256(strategyBytes),
    tokens: [getAddress(pair.usdc.address), getAddress(pair.fx.address)],
    amounts: [usdcShip, fxShip]
  };
}

function resolveFxSwapBand(
  pair: FxPair,
  params: StrategyParamsInput,
  oraclePriceWad: bigint | undefined,
  feedQuote: FxFeedQuote
): FxSwapStrategySpec["band"] {
  const explicit = params.minPrice !== undefined || params.maxPrice !== undefined;
  if (params.bandPercent !== undefined) {
    if (explicit) {
      throw new Error("Pass bandPercent or minPrice/maxPrice, not both");
    }
    if (oraclePriceWad === undefined) {
      throw new Error("bandPercent is measured around the live oracle price; read the feed first");
    }
    const fraction = parseTokenAmount(params.bandPercent, 16, { field: "bandPercent" });
    if (fraction <= 0n || fraction >= FXSWAP.wad) {
      throw new Error("bandPercent must be above 0 and below 100");
    }
    return {
      source: "bandPercent",
      minPrice: (oraclePriceWad * (FXSWAP.wad - fraction)) / FXSWAP.wad,
      maxPrice: (oraclePriceWad * (FXSWAP.wad + fraction)) / FXSWAP.wad
    };
  }
  const usdPerFx = feedQuote === "usdPerFx";
  // The default band is half to double the reference price, expressed in the feed's orientation.
  const fxPerUsdReference = FXSWAP_REFERENCE_PRICE_WAD[pair.fx.symbol];
  const reference =
    fxPerUsdReference === undefined || !usdPerFx ? fxPerUsdReference : (FXSWAP.wad * FXSWAP.wad) / fxPerUsdReference;
  const unitLabel = usdPerFx ? `USD per ${pair.fx.fiat}` : `${pair.fx.fiat} per USD`;
  const field = usdPerFx ? `(USD per 1 ${pair.fx.fiat})` : `(${pair.fx.fiat} per 1 USD)`;
  const minPrice =
    params.minPrice !== undefined
      ? parseTokenAmount(params.minPrice, 18, { field: `minPrice ${field}` })
      : reference === undefined
        ? undefined
        : reference / 2n;
  const maxPrice =
    params.maxPrice !== undefined
      ? parseTokenAmount(params.maxPrice, 18, { field: `maxPrice ${field}` })
      : reference === undefined
        ? undefined
        : reference * 2n;
  if (minPrice === undefined || maxPrice === undefined) {
    throw new Error(`No default price band for ${pair.fx.symbol}; pass minPrice and maxPrice or bandPercent`);
  }
  if (minPrice === 0n || minPrice > maxPrice) {
    throw new Error(
      `price band ${formatUnits(minPrice, 18)}..${formatUnits(maxPrice, 18)} ${unitLabel} is invalid: need 0 < minPrice <= maxPrice`
    );
  }
  return { source: explicit ? "explicit" : "default", minPrice, maxPrice };
}

/** One of ppb / bps / percent as a WAD fraction (1e18 = 100%), or undefined when none is given. */
function parseOptionalRateWad(
  input: { ppb?: AmountValue | undefined; bps?: AmountValue | undefined; percent?: AmountValue | undefined },
  names: [string, string, string]
): bigint | undefined {
  const provided = [input.ppb, input.bps, input.percent].filter((value) => value !== undefined);
  if (provided.length > 1) {
    throw new Error(`Pass only one of ${names.join(", ")}`);
  }
  if (input.ppb !== undefined) {
    return parseIntegerLike(input.ppb, names[0]) * 10n ** 9n;
  }
  if (input.bps !== undefined) {
    return parseTokenAmount(input.bps, 14, { field: names[1] });
  }
  if (input.percent !== undefined) {
    return parseTokenAmount(input.percent, 16, { field: names[2] });
  }
  return undefined;
}

/** Combined rate of an input fee followed by an output fee, in ppb. */
function composeFeePpb(firstPpb: number, secondPpb: number): number {
  const denominator = BigInt(SWAPVM.feeDenominatorPpb);
  const first = BigInt(firstPpb);
  const second = BigInt(secondPpb);
  const combined = first + second - (first * second) / denominator;
  return Number(combined > denominator ? denominator : combined);
}

function assertIntInRange(value: number, max: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`FXSwap ${field} ${value} must be an integer between 0 and ${max}`);
  }
}

export const SHIP_STRATEGY_TYPES = {
  ShipStrategy: [
    { name: "classId", type: "uint256" },
    { name: "strategyId", type: "bytes32" },
    { name: "tokens", type: "address[]" },
    { name: "amounts", type: "uint256[]" },
    { name: "feePpb", type: "uint32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }
  ]
} as const;

/** EIP-712 payload the strategist signs for `AquaAdapter.shipStrategyWithFee`. */
export function buildShipTypedData(input: {
  chainId: number;
  adapter: string;
  classId: bigint;
  strategyId: Hex;
  tokens: readonly string[];
  amounts: readonly bigint[];
  feePpb: number;
  nonce: bigint;
  deadline: bigint;
}) {
  return {
    domain: {
      name: SWAPVM.adapterDomain.name,
      version: SWAPVM.adapterDomain.version,
      chainId: input.chainId,
      verifyingContract: getAddress(input.adapter)
    },
    types: SHIP_STRATEGY_TYPES,
    primaryType: "ShipStrategy" as const,
    message: {
      classId: input.classId,
      strategyId: input.strategyId,
      tokens: input.tokens.map((token) => getAddress(token)),
      amounts: [...input.amounts],
      feePpb: input.feePpb,
      nonce: input.nonce,
      deadline: input.deadline
    }
  };
}

/**
 * Taker traits for an exact-in swap: 20-byte slice-index header, 2-byte flags, optional 32-byte
 * minimum-output threshold (all later slices empty).
 */
export function buildTakerTraitsAndData(minAmountOut?: bigint): Hex {
  const flags = toHex(SWAPVM.takerFlagsExactIn, { size: 2 });
  if (minAmountOut === undefined) {
    return concat([toHex(0n, { size: 20 }), flags]);
  }
  let sliceIndexes = 0n;
  for (let slice = 0n; slice < 10n; slice += 1n) {
    sliceIndexes |= 32n << (16n * slice);
  }
  return concat([toHex(sliceIndexes, { size: 20 }), flags, toHex(minAmountOut, { size: 32 })]);
}

export function formatTokenAmount(raw: bigint, token: TokenInfo) {
  return { raw: raw.toString(), formatted: formatUnits(raw, token.decimals), symbol: token.symbol };
}

/** `amountOut / amountIn` in human units, 8 decimals, e.g. `1392.48479 ARGt per USDC`. */
export function formatRate(
  amountIn: bigint,
  tokenIn: TokenInfo,
  amountOut: bigint,
  tokenOut: TokenInfo
): string {
  if (amountIn === 0n) {
    return `0 ${tokenOut.symbol} per ${tokenIn.symbol}`;
  }
  const scaled =
    (amountOut * 10n ** BigInt(tokenIn.decimals) * 10n ** 8n) /
    (amountIn * 10n ** BigInt(tokenOut.decimals));
  return `${formatUnits(scaled, 8)} ${tokenOut.symbol} per ${tokenIn.symbol}`;
}

/** Decoded custom-error name + args for a viem contract error, or its short message. */
export function describeContractError(error: unknown): string {
  if (error instanceof BaseError) {
    const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      if (reverted.data?.errorName) {
        const args = (reverted.data.args ?? []).map(formatErrorArgument).join(", ");
        return `${reverted.data.errorName}(${args})`;
      }
      return reverted.reason ?? reverted.signature ?? reverted.shortMessage;
    }
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Recursively convert bigint values to decimal strings so results can be JSON-serialised. */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(toJsonSafe);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toJsonSafe(item)])
    );
  }
  return value;
}

function formatErrorArgument(value: unknown): string {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return `[${value.map(formatErrorArgument).join(", ")}]`;
  }
  return String(value);
}

function decimalScale(pair: FxPair): bigint {
  const gap = pair.fx.decimals - pair.usdc.decimals;
  if (gap < 0) {
    throw new Error(`${pair.fx.symbol} has fewer decimals than USDC; unsupported pair`);
  }
  return 10n ** BigInt(gap);
}

const SHORTHAND_SUFFIXES = new Set(["k", "m", "mm", "b", "bn", "thousand", "million", "billion"]);

function normalizeNumericText(value: AmountValue, field: string): string {
  let text = typeof value === "number" ? numberToPlainString(value, field) : String(value);
  text = text.trim().replace(/^(?:r\$|us\$|\$)\s*/i, "");
  const suffix = /\s*([a-z%][a-z%.\s]*)$/i.exec(text);
  if (suffix?.[1] && SHORTHAND_SUFFIXES.has(suffix[1].trim().toLowerCase())) {
    throw new Error(`${field} "${value}": shorthand like 2k is not supported; write the full number`);
  }
  text = text.replace(/\s*[a-z%][a-z%.\s]*$/i, "").replace(/[_\s]/g, "");
  if (text.includes(",")) {
    if (text.includes(".") || /^\d{1,3}(,\d{3})+$/.test(text)) {
      text = text.replace(/,/g, "");
    } else if (/^\d*,\d+$/.test(text)) {
      text = text.replace(",", ".");
    }
  }
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) {
    throw new Error(`${field} "${value}" is not a non-negative number`);
  }
  return text.endsWith(".") ? text.slice(0, -1) : text;
}

function numberToPlainString(value: number, field: string): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative number`);
  }
  const text = String(value);
  const match = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(text);
  if (!match) {
    return text;
  }
  const fraction = match[2] ?? "";
  const digits = `${match[1]}${fraction}`;
  const exponent = Number(match[3]) - fraction.length;
  if (exponent >= 0) {
    return `${digits}${"0".repeat(exponent)}`;
  }
  const padded = digits.padStart(-exponent + 1, "0");
  return `${padded.slice(0, exponent)}.${padded.slice(exponent)}`;
}
