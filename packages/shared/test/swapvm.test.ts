import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  concat,
  encodeAbiParameters,
  encodePacked,
  getAddress,
  hashTypedData,
  keccak256,
  padHex,
  toBytes,
  toHex,
  type Hex
} from "viem";

import { ARC_TESTNET_DEPLOYMENT } from "../src/constants.js";
import {
  executeCreateFxStrategy,
  executeFxDeposit,
  executeFxSwap,
  executeSetFxPrice,
  prepareFxDeposit,
  resolveStrategyOpcode,
  resolveSwapVMVenue,
  resolveToolWriteMode
} from "../src/fx.js";
import {
  FXSWAP,
  assertSupportedChain,
  buildFxSwapProgram,
  buildFxSwapStrategySpec,
  buildPeggedStrategySpec,
  buildShipTypedData,
  buildTakerTraitsAndData,
  decodeFxSwapArgs,
  decodeSwapVMOrder,
  decodeSwapVMProgram,
  encodeFxSwapArgs,
  fxSwapOrientation,
  inferOpcodeFromParams,
  parseDurationSeconds,
  parseFeePpb,
  parseIntegerLike,
  parseTokenAmount,
  resolvePair,
  resolveToken,
  type FxSwapArgs
} from "../src/swapvm.js";

const WAD = 10n ** 18n;
const FX_ADAPTER = "0x8236cfFDD17D7b41F41c820f5E4b7DA6d5F243D5";
const ARS_FEED = "0xc05A3Fb016f973C82b0232EF50336d4C0466E70C";
const BRL_FEED = "0x1AE6542b9da89Ed2AEf00600710Bba75DbFF5e71";
const ADAPTER = "0xbF72D34b804636496c3308796908152b82624Ca5";
const ARS_STRATEGY_ID = "0x5e8668583f2e4a8e23680ebc5bb687c35769d977be9b5e115d13b01ecca3a2e4";
const BRL_STRATEGY_ID = "0xe16591490b549dd816c0d4cd2df92cfedbc0680eb295f4550cb47bd5f6d94be1";
const uint256x5 = [
  { type: "uint256" },
  { type: "uint256" },
  { type: "uint256" },
  { type: "uint256" },
  { type: "uint256" }
] as const;

test("default pegged ARS and BRL strategies reproduce the Arc fork strategyId vectors", () => {
  const ars = buildPeggedStrategySpec(ADAPTER, resolvePair("USDC/ARS"));
  const brl = buildPeggedStrategySpec(ADAPTER, resolvePair("usdc-brl"));
  assert.equal(ars.strategyId, ARS_STRATEGY_ID);
  assert.equal(brl.strategyId, BRL_STRATEGY_ID);
  assert.equal(ars.fxShip, 1_400n * 10n ** 18n);
  assert.equal(brl.fxShip, 55n * 10n ** 17n);
  assert.equal(ars.label, "FXSwap ARS");

  const sloppyButEqual = buildPeggedStrategySpec(ADAPTER, resolvePair("ARS to USDC"), {
    price: "1,400 ARS",
    feeBps: 30,
    usdcAmount: "1 USDC",
    linearWidth: "10e27"
  });
  assert.equal(sloppyButEqual.strategyId, ARS_STRATEGY_ID);
  assert.deepEqual(decodeSwapVMOrder(ars.strategyBytes), ars.order);
});

test("program bytes match ArcFxStrategies.buildProgram for a USDC (6dp) / FX (18dp) pair", () => {
  const spec = buildPeggedStrategySpec(ADAPTER, resolvePair("USDC/BRL"));
  const usdcRate = 550n * 10n ** 10n;
  const expected = encodePacked(
    ["uint8", "uint8", "uint32", "uint8", "uint8", "bytes"],
    [
      21,
      4,
      3_000_000,
      31,
      160,
      encodeAbiParameters(uint256x5, [1_000_000n * usdcRate, 55n * 10n ** 17n, 10n ** 28n, usdcRate, 1n])
    ]
  );
  assert.equal(spec.program, expected);
  assert.equal(spec.order.maker, getAddress(ADAPTER));
  assert.equal(spec.order.traits, (1n << 254n) | (1n << 251n) | (1n << 250n));
});

test("ship typed-data digest equals the Solidity shipDigest construction", () => {
  const spec = buildPeggedStrategySpec(ADAPTER, resolvePair("USDC/ARS"));
  const typedData = buildShipTypedData({
    chainId: 5042002,
    adapter: ADAPTER,
    classId: 7n,
    strategyId: spec.strategyId,
    tokens: spec.tokens,
    amounts: spec.amounts,
    feePpb: spec.feePpb,
    nonce: 2n,
    deadline: 1_900_000_000n
  });
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [
        keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
        keccak256(toBytes("AquaAdapter")),
        keccak256(toBytes("1")),
        5042002n,
        getAddress(ADAPTER)
      ]
    )
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint32" },
        { type: "uint256" },
        { type: "uint256" }
      ],
      [
        keccak256(
          toBytes(
            "ShipStrategy(uint256 classId,bytes32 strategyId,address[] tokens,uint256[] amounts,uint32 feePpb,uint256 nonce,uint256 deadline)"
          )
        ),
        7n,
        spec.strategyId,
        keccak256(concat(spec.tokens.map((token) => padHex(token, { size: 32 })))),
        keccak256(concat(spec.amounts.map((amount) => toHex(amount, { size: 32 })))),
        3_000_000,
        2n,
        1_900_000_000n
      ]
    )
  );
  assert.equal(hashTypedData(typedData), keccak256(concat(["0x1901", domainSeparator, structHash])));
});

test("taker data is the 22-byte exact-in header, optionally followed by a 32-byte min-out threshold", () => {
  assert.equal(buildTakerTraitsAndData(), `0x${"00".repeat(20)}0041`);
  const withMin = buildTakerTraitsAndData(123n);
  assert.equal((withMin.length - 2) / 2, 54);
  const header = BigInt(`0x${withMin.slice(2, 42)}`);
  for (let slice = 0n; slice < 10n; slice += 1n) {
    assert.equal((header >> (16n * slice)) & 0xffffn, 32n);
  }
  assert.equal(withMin.slice(42, 46), "0041");
  assert.equal(BigInt(`0x${withMin.slice(46)}`), 123n);
});

test("amounts accept human units, raw units and sloppy formatting", () => {
  assert.equal(parseTokenAmount("2", 6), 2_000_000n);
  assert.equal(parseTokenAmount(2.5, 6), 2_500_000n);
  assert.equal(parseTokenAmount("0.1 USDC", 6), 100_000n);
  assert.equal(parseTokenAmount("$3", 6), 3_000_000n);
  assert.equal(parseTokenAmount("1,000.25", 6), 1_000_250_000n);
  assert.equal(parseTokenAmount("2,5", 18), 25n * 10n ** 17n);
  assert.equal(parseTokenAmount(1e-6, 6), 1n);
  assert.equal(parseTokenAmount(".5", 6), 500_000n);
  assert.equal(parseTokenAmount("2000000", 6, { unit: "raw" }), 2_000_000n);
  assert.throws(() => parseTokenAmount("0.0000001", 6), /at most 6/);
  assert.throws(() => parseTokenAmount("2.5", 6, { unit: "raw" }), /whole number/);
  assert.throws(() => parseTokenAmount("-1", 6), /non-negative/);
  assert.throws(() => parseTokenAmount("2k", 6), /shorthand/);
  assert.equal(parseIntegerLike("1e28", "linearWidth"), 10n ** 28n);
  assert.equal(parseIntegerLike(1e28, "linearWidth"), 10n ** 28n);
  assert.equal(parseFeePpb({}), 3_000_000);
  assert.equal(parseFeePpb({ feeBps: "30" }), 3_000_000);
  assert.equal(parseFeePpb({ feePercent: "0.3%" }), 3_000_000);
  assert.throws(() => parseFeePpb({ feeBps: 30, feePpb: 1 }), /only one/);
  assert.throws(() => parseFeePpb({ feePpb: 1_000_000_000 }), /below/);
});

test("pairs, tokens and chains resolve from loose phrasing", () => {
  assert.equal(resolvePair("USDC/ARS").fx.symbol, "ARGt");
  assert.equal(resolvePair("brl to usdc").name, "USDC/BRL");
  assert.equal(resolvePair("USDC ARGt").name, "USDC/ARS");
  assert.equal(resolvePair("usdc / argentine pesos").name, "USDC/ARS");
  assert.equal(resolvePair("BRL").name, "USDC/BRL");
  assert.equal(resolvePair("the argentine peso pool").name, "USDC/ARS");
  assert.throws(() => resolvePair("USDC"), /Could not read pair/);
  assert.equal(resolveToken("0x8a3d6188C58d7877499592E179DfE3bd80c4F460").symbol, "ARGt");
  assert.throws(() => resolvePair("ARS/BRL"), /USDC/);
  assert.throws(() => resolveToken("EUR"), /Unknown token/);
  assert.doesNotThrow(() => assertSupportedChain("Arc Testnet", 5042002));
  assert.doesNotThrow(() => assertSupportedChain(5042002, 5042002));
  assert.throws(() => assertSupportedChain("base", 5042002), /Unsupported chain/);
});

test("opcode resolution: fxswap is the default once its venue is configured, pegged stays available", () => {
  const unconfigured = { fxswapRouterAddress: "", fxswapAquaAdapterAddress: "" };
  assert.equal(resolveStrategyOpcode(undefined, {}), "fxswap");
  assert.equal(resolveStrategyOpcode("", {}), "fxswap");
  assert.equal(resolveStrategyOpcode("Pegged Swap", {}), "pegged");
  assert.equal(resolveStrategyOpcode("oracle", {}), "fxswap");
  assert.equal(resolveStrategyOpcode(undefined, {}, { price: 1400 }), "pegged");
  assert.equal(resolveStrategyOpcode(undefined, {}, { bandPercent: 20 }), "fxswap");
  assert.equal(resolveStrategyOpcode(undefined, {}, { feeBps: 10 }), "fxswap");
  assert.equal(resolveStrategyOpcode(undefined, unconfigured), "pegged");
  assert.throws(() => resolveStrategyOpcode("fxswap", unconfigured), /FXSwap venue not configured/);
  assert.throws(() => resolveStrategyOpcode("xyc", {}), /Unknown opcode/);
  assert.throws(() => inferOpcodeFromParams({ price: 1400, gamma: 0.01 }), /mix pegged-only/);
});

test("Arc deployment constants stay in sync with deployments/arc-testnet.json (FX venue keys optional)", () => {
  const file = JSON.parse(
    readFileSync(new URL("../../../deployments/arc-testnet.json", import.meta.url), "utf8")
  ) as {
    chainId: number;
    contracts: Record<string, unknown> & {
      fxswapRouter?: string | null;
      fxAquaAdapter?: string | null;
      fxOracles?: { arsUsd?: string | null; brlUsd?: string | null; owner?: string | null } | null;
      redstone?: { multiFeedAdapter?: string | null; feeds?: { BRL?: string | null; MXNe?: string | null } } | null;
    };
    assets: Record<string, string>;
    vaults: Record<string, string>;
  };
  const deployment = ARC_TESTNET_DEPLOYMENT;
  assert.equal(file.chainId, deployment.chainId);
  for (const [name, address] of Object.entries(deployment.contracts)) {
    assert.equal(String(file.contracts[name]).toLowerCase(), address.toLowerCase(), name);
  }
  const tokens = { usdc: deployment.tokens.USDC, argt: deployment.tokens.ARGt, brat: deployment.tokens.BRAt };
  for (const [name, token] of Object.entries(tokens)) {
    assert.equal(file.assets[name]?.toLowerCase(), token.address.toLowerCase(), name);
    assert.equal(file.vaults[name]?.toLowerCase(), token.vault.toLowerCase(), name);
  }
  const fx = deployment.fxVenue;
  const pairs: Array<[string, string | null | undefined, string | null]> = [
    ["fxswapRouter", file.contracts.fxswapRouter, fx.fxswapRouter],
    ["fxAquaAdapter", file.contracts.fxAquaAdapter, fx.fxAquaAdapter],
    ["fxOracles.arsUsd", file.contracts.fxOracles?.arsUsd, fx.fxOracles.arsUsd],
    ["fxOracles.brlUsd", file.contracts.fxOracles?.brlUsd, fx.fxOracles.brlUsd],
    ["fxOracles.owner", file.contracts.fxOracles?.owner, fx.fxOracles.owner],
    ["redstone.multiFeedAdapter", file.contracts.redstone?.multiFeedAdapter, fx.redstone.multiFeedAdapter],
    ["redstone.feeds.BRL", file.contracts.redstone?.feeds?.BRL, fx.redstone.feeds.BRL],
    ["redstone.feeds.MXNe", file.contracts.redstone?.feeds?.MXNe, fx.redstone.feeds.MXNe]
  ];
  for (const [name, inFile, inConstants] of pairs) {
    assert.equal(inConstants?.toLowerCase() ?? null, inFile?.toLowerCase() ?? null, name);
  }
});

type ArgsVector = {
  oracleKind: number;
  flags: number;
  oracle: string;
  oracleDecimals: number;
  maxStaleness: number;
  minPrice: string;
  maxPrice: string;
  a: string;
  gamma: string;
  midFee: string;
  outFee: string;
  feeGamma: string;
  rateLt: string;
  rateGt: string;
  flatFeePpb: number;
  withFlatFee: boolean;
  args: Hex;
  program: Hex;
};
type OrientationVector = {
  base: string;
  baseDecimals: number;
  quote: string;
  quoteDecimals: number;
  invertPrice: boolean;
  rateLt: string;
  rateGt: string;
};
const FXSWAP_VECTORS = JSON.parse(
  readFileSync(new URL("./fixtures/fxswap-args-vectors.json", import.meta.url), "utf8")
) as Record<string, ArgsVector> & { orientation: Record<string, OrientationVector> };
const ARGS_VECTOR_NAMES = ["usdc-ars-defaults", "usdc-brl-flat-fee", "inverted-extremes"] as const;

function vectorArgs(vector: ArgsVector): FxSwapArgs {
  return {
    oracleKind: vector.oracleKind,
    flags: vector.flags,
    oracle: vector.oracle,
    oracleDecimals: vector.oracleDecimals,
    maxStaleness: vector.maxStaleness,
    minPrice: BigInt(vector.minPrice),
    maxPrice: BigInt(vector.maxPrice),
    a: BigInt(vector.a),
    gamma: BigInt(vector.gamma),
    midFee: BigInt(vector.midFee),
    outFee: BigInt(vector.outFee),
    feeGamma: BigInt(vector.feeGamma),
    rateLt: BigInt(vector.rateLt),
    rateGt: BigInt(vector.rateGt)
  };
}

test("FXSwap args, program and orientation are byte-identical to the Solidity FXSwapArgsBuilder vectors", () => {
  for (const name of ARGS_VECTOR_NAMES) {
    const vector = FXSWAP_VECTORS[name];
    assert.ok(vector, name);
    const args = vectorArgs(vector);
    const encoded = encodeFxSwapArgs(args);
    assert.equal(encoded, vector.args.toLowerCase(), `${name} args`);
    assert.equal((encoded.length - 2) / 2, FXSWAP.argsLength, `${name} length`);
    assert.equal(
      buildFxSwapProgram({ args, flatFeePpb: vector.withFlatFee ? vector.flatFeePpb : 0 }),
      vector.program.toLowerCase(),
      `${name} program`
    );
    assert.deepEqual(decodeFxSwapArgs(vector.args), { ...args, oracle: getAddress(vector.oracle) }, `${name} decode`);
  }
  for (const [name, vector] of Object.entries(FXSWAP_VECTORS.orientation)) {
    assert.deepEqual(
      fxSwapOrientation(vector.base, vector.baseDecimals, vector.quote, vector.quoteDecimals),
      { invertPrice: vector.invertPrice, rateLt: BigInt(vector.rateLt), rateGt: BigInt(vector.rateGt) },
      name
    );
  }
  assert.throws(() => fxSwapOrientation(ARS_FEED, 18, ARS_FEED, 6), /FXSwapInvalidPair/);
  assert.throws(() => fxSwapOrientation(ARS_FEED, 19, BRL_FEED, 6), /FXSwapUnsupportedDecimals/);
});

test("default FXSwap USDC/ARS strategy and human-unit params encode the Solidity vectors", () => {
  const ars = buildFxSwapStrategySpec(FX_ADAPTER, resolvePair("USDC/ARS"), ARS_FEED, {}, { oraclePriceWad: 1_400n * WAD });
  assert.equal(ars.program, FXSWAP_VECTORS["usdc-ars-defaults"]?.program.toLowerCase());
  assert.equal(ars.label, "FXSwap oracle ARS");
  assert.equal(ars.band.source, "default");
  assert.equal(ars.fxShip, 1_400n * WAD);
  assert.equal(ars.usdcShip, 1_000_000n);
  assert.equal(ars.feePpb, 1_000_000);
  assert.equal(ars.order.maker, getAddress(FX_ADAPTER));
  assert.equal(ars.strategyId, keccak256(ars.strategyBytes));
  // The strategy id only depends on the program: amounts and the live price do not move it.
  assert.equal(
    buildFxSwapStrategySpec(FX_ADAPTER, resolvePair("pesos"), ARS_FEED, { usdcAmount: "0.5" }, { oraclePriceWad: 1_470n * WAD })
      .strategyId,
    ars.strategyId
  );

  const brl = buildFxSwapStrategySpec(
    FX_ADAPTER,
    resolvePair("usdc to brl"),
    BRL_FEED,
    {
      a: "250.5",
      gamma: "0.00000001",
      feeBps: "5 bps",
      outFeePercent: "0.05%",
      feeGamma: 0,
      flatFeeBps: 30,
      minPrice: "2.75",
      maxPrice: 11,
      maxStaleness: "24h",
      oracleDecimals: 8,
      fxAmount: "5.5"
    }
  );
  assert.equal(brl.program, FXSWAP_VECTORS["usdc-brl-flat-fee"]?.program.toLowerCase());
  assert.equal(brl.band.source, "explicit");
  assert.equal(brl.flatFeePpb, 3_000_000);
  assert.equal(brl.feePpb, 3_000_000 + 500_000 - 1_500);
  assert.deepEqual(
    decodeSwapVMProgram(brl.program).map((instruction) => instruction.name),
    ["FlatFeeAmountIn", "FXSwap"]
  );

  const banded = buildFxSwapStrategySpec(FX_ADAPTER, resolvePair("ARS"), ARS_FEED, { bandPercent: "20%" }, {
    oraclePriceWad: 1_470n * WAD
  });
  assert.equal(banded.band.minPrice, 1_176n * WAD);
  assert.equal(banded.band.maxPrice, 1_764n * WAD);
  assert.equal(banded.fxShip, 1_470n * WAD);
  assert.notEqual(banded.strategyId, ars.strategyId);

  assert.equal(parseDurationSeconds("7d"), 604_800);
  assert.equal(parseDurationSeconds(3600), 3_600);
  assert.equal(parseDurationSeconds("1.5 hours"), 5_400);
  assert.throws(() => parseDurationSeconds("0"), /whole number of seconds/);
  assert.throws(() => parseDurationSeconds("soon"), /duration/);
});

test("FXSwap on a USD-per-FX feed (RedStone BRL) flips the price flag and states the band in the feed's orientation", () => {
  const pair = resolvePair("USDC/BRL");
  const usdPerBrl = 194n * 10n ** 15n;
  const brlPerUsd = (WAD * WAD) / usdPerBrl;
  const redstone = buildFxSwapStrategySpec(FX_ADAPTER, pair, BRL_FEED, {}, { oraclePriceWad: usdPerBrl, feedQuote: "usdPerFx" });
  const manual = buildFxSwapStrategySpec(FX_ADAPTER, pair, BRL_FEED, {}, { oraclePriceWad: brlPerUsd });
  assert.equal(redstone.feedQuote, "usdPerFx");
  assert.equal(manual.feedQuote, "fxPerUsd");
  assert.equal(redstone.args.flags, manual.args.flags ^ FXSWAP.flagInvertPrice);
  assert.equal(redstone.args.rateLt, manual.args.rateLt);
  assert.equal(redstone.args.rateGt, manual.args.rateGt);
  // Default band: half to double the 5.50 BRL per USD reference, as USD per BRL.
  const reference = (WAD * WAD) / (55n * 10n ** 17n);
  assert.equal(redstone.band.minPrice, reference / 2n);
  assert.equal(redstone.band.maxPrice, reference * 2n);
  // Same value-balanced ship whichever way the feed quotes.
  assert.equal(redstone.fxShip, manual.fxShip);
  assert.notEqual(redstone.strategyId, manual.strategyId);

  const banded = buildFxSwapStrategySpec(FX_ADAPTER, pair, BRL_FEED, { bandPercent: 10 }, {
    oraclePriceWad: usdPerBrl,
    feedQuote: "usdPerFx"
  });
  assert.equal(banded.band.minPrice, (usdPerBrl * 9n) / 10n);
  assert.equal(banded.band.maxPrice, (usdPerBrl * 11n) / 10n);
  assert.throws(
    () => buildFxSwapStrategySpec(FX_ADAPTER, pair, BRL_FEED, { minPrice: 1, maxPrice: 0.5, fxAmount: 1 }, { feedQuote: "usdPerFx" }),
    /USD per BRL is invalid/
  );
});

test("FXSwap validation mirrors FXSwapArgsBuilder.validate, and params are checked per opcode", () => {
  const vector = FXSWAP_VECTORS["usdc-ars-defaults"];
  assert.ok(vector);
  const base = vectorArgs(vector);
  assert.throws(() => encodeFxSwapArgs({ ...base, oracleKind: 1 }), /FXSwapUnsupportedOracleKind\(1\)/);
  assert.throws(() => encodeFxSwapArgs({ ...base, flags: 2 }), /FXSwapInvalidFlags\(2\)/);
  assert.throws(() => encodeFxSwapArgs({ ...base, oracle: `0x${"00".repeat(20)}` }), /FXSwapInvalidOracle/);
  assert.throws(() => encodeFxSwapArgs({ ...base, maxStaleness: 0 }), /FXSwapInvalidMaxStaleness/);
  assert.throws(() => encodeFxSwapArgs({ ...base, minPrice: 3_000n * WAD }), /FXSwapInvalidPriceBand/);
  assert.throws(() => encodeFxSwapArgs({ ...base, gamma: 1n }), /FXSwapInvalidCurve/);
  assert.throws(() => encodeFxSwapArgs({ ...base, a: FXSWAP.maxA + 1n }), /FXSwapInvalidCurve/);
  assert.throws(() => encodeFxSwapArgs({ ...base, midFee: 2n * 10n ** 16n }), /FXSwapInvalidFees/);
  assert.throws(() => encodeFxSwapArgs({ ...base, feeGamma: 0n }), /FXSwapInvalidFees/);
  assert.throws(() => encodeFxSwapArgs({ ...base, rateGt: 0n }), /FXSwapInvalidRates/);
  assert.throws(() => encodeFxSwapArgs({ ...base, a: 1n << 64n }), /uint64/);
  assert.throws(() => decodeFxSwapArgs(`0x${"00".repeat(114)}`), /FXSwapInvalidArgsLength\(114\)/);

  const pair = resolvePair("USDC/ARS");
  const price = { oraclePriceWad: 1_400n * WAD };
  assert.throws(() => buildFxSwapStrategySpec(FX_ADAPTER, pair, ARS_FEED, { price: 1400 }, price), /only apply to opcode "pegged"/);
  assert.throws(() => buildPeggedStrategySpec(ADAPTER, pair, { gamma: 0.01 }), /only apply to opcode "fxswap"/);
  assert.throws(() => buildFxSwapStrategySpec(FX_ADAPTER, pair, ARS_FEED, { bandPercent: 10 }), /live oracle price/);
  assert.throws(() => buildFxSwapStrategySpec(FX_ADAPTER, pair, ARS_FEED, {}), /fxAmount defaults/);
  assert.throws(
    () => buildFxSwapStrategySpec(FX_ADAPTER, pair, ARS_FEED, { bandPercent: 10, minPrice: 1000 }, price),
    /not both/
  );
  assert.throws(() => buildFxSwapStrategySpec(FX_ADAPTER, pair, ARS_FEED, { feeBps: 10, feePercent: 0.1 }, price), /only one/);
  // A mid fee above the default out fee lifts the out fee with it instead of failing validation.
  assert.equal(
    buildFxSwapStrategySpec(FX_ADAPTER, pair, ARS_FEED, { feeBps: 150 }, price).args.outFee,
    15n * 10n ** 15n
  );
});

test("venues: FXSwap addresses default to the Arc deployment and can be overridden", async () => {
  const venue = resolveSwapVMVenue({ writeChainId: 5042002 });
  assert.equal(venue.fxswap?.router, ARC_TESTNET_DEPLOYMENT.fxVenue.fxswapRouter?.toLowerCase());
  assert.equal(venue.fxswap?.adapter, FX_ADAPTER.toLowerCase());
  assert.equal(venue.fxswap?.oracles.ARGt, ARS_FEED.toLowerCase());
  assert.equal(venue.fxswap?.oracles.BRAt, BRL_FEED.toLowerCase());
  assert.equal(venue.pegged.adapter, ADAPTER.toLowerCase());
  const override = `0x${"ab".repeat(20)}`;
  assert.equal(resolveSwapVMVenue({ writeChainId: 5042002, fxOracleArsUsdAddress: override }).fxswap?.oracles.ARGt, override);
  assert.throws(
    () => resolveSwapVMVenue({ writeChainId: 5042002, fxswapAquaAdapterAddress: ADAPTER }),
    /is the pegged AquaAdapter/
  );

  const key = `0x${"11".repeat(32)}`;
  await assert.rejects(
    executeSetFxPrice(
      { mcpWriteMode: "execute", writeRpcUrl: "https://mainnet.base.org", writeChainId: 8453, writePrivateKey: key },
      { pair: "BRL", price: "5.6" }
    ),
    /mainnet\/Base writes are not allowed/
  );
  await assert.rejects(
    executeSetFxPrice({ mcpWriteMode: "prepare" }, { pair: "ARS", changePercent: 5 }),
    /MCP_WRITE_MODE must be execute/
  );
});

test("write tools default to prepare, and execution stays behind the guard", async () => {
  assert.equal(resolveToolWriteMode({}), "prepare");
  assert.equal(resolveToolWriteMode({ mcpWriteMode: "execute" }, true), "prepare");
  assert.equal(resolveToolWriteMode({ mcpWriteMode: "execute" }), "execute");

  const receiver = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
  const prepared = await prepareFxDeposit({ writeChainId: 5042002 }, { token: "usdc", amount: "2", receiver });
  assert.equal(prepared.mode, "prepare");
  assert.equal(prepared.transactions.length, 2);
  assert.deepEqual(prepared.transactions[1]?.args, ["2000000", getAddress(receiver)]);

  const key = `0x${"11".repeat(32)}`;
  const base = { mcpWriteMode: "execute" as const, writeRpcUrl: "https://mainnet.base.org", writeChainId: 8453, writePrivateKey: key };
  await assert.rejects(executeFxDeposit(base, { token: "USDC", amount: "2" }), /mainnet\/Base writes are not allowed/);
  await assert.rejects(
    executeCreateFxStrategy({ ...base, writeChainId: 1 }, { pair: "USDC/ARS" }),
    /mainnet\/Base writes are not allowed/
  );
  await assert.rejects(
    executeFxSwap({ ...base, mcpWriteMode: "prepare" }, { pair: "USDC/ARS", amount: "0.1" }),
    /MCP_WRITE_MODE must be execute/
  );
  await assert.rejects(
    executeFxSwap(
      { ...base, writeChainId: 31337, writeRpcUrl: "https://rpc.example.org" },
      { pair: "USDC/ARS", amount: "0.1" }
    ),
    /not Arc Testnet/
  );
  assert.throws(() => resolveSwapVMVenue({ writeChainId: 8453 }), /target Arc Testnet/);
});
