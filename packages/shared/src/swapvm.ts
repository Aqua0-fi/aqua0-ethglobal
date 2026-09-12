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
  /** FX units per 1 USDC, up to 2 decimals: 1400 (ARS), 5.5 (BRL). */
  price?: AmountValue | undefined;
  priceE2?: AmountValue | undefined;
  feePpb?: AmountValue | undefined;
  feeBps?: AmountValue | undefined;
  feePercent?: AmountValue | undefined;
  /** USDC shipped into the strategy (default 1 USDC). */
  usdcAmount?: AmountValue | undefined;
  /** FX tokens shipped (default: usdcAmount x price). */
  fxAmount?: AmountValue | undefined;
  amountUnit?: AmountUnit | undefined;
  linearWidth?: AmountValue | undefined;
  /** Strategy class label (default `FXSwap ARS` / `FXSwap BRL`). */
  label?: string | undefined;
};

export type PeggedStrategySpec = {
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
