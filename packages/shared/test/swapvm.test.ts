import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
  FOREX,
  FOREX_DEFAULTS,
  FXSWAP,
  assertSupportedChain,
  buildForexProgram,
  buildForexStrategySpec,
  buildFxSwapProgram,
  buildFxSwapStrategySpec,
  buildPeggedStrategySpec,
  buildShipTypedData,
  buildTakerTraitsAndData,
  decodeForexArgs,
  forexMaxFeeLimit,
  decodeFxSwapArgs,
  decodeSwapVMOrder,
  decodeSwapVMProgram,
  encodeForexArgs,
  encodeFxSwapArgs,
  forexFlags,
  forexFxPerUsdcWad,
  forexOrientation,
  forexPairFields,
  fxSwapOrientation,
  inferOpcodeFromParams,
  parseDurationSeconds,
  parseFeePpb,
  parseIntegerLike,
  parseTokenAmount,
  resolvePair,
  resolveToken,
  buildSaltInstruction,
  strategySalt,
  type ForexArgs,
  type FxPair,
  type FxSwapArgs,
  type StrategyParamsInput
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

test("opcode resolution: forex is the default once its venue is configured, pegged stays available", () => {
  const unconfigured = { fxswapRouterAddress: "", fxswapAquaAdapterAddress: "" };
  assert.equal(resolveStrategyOpcode(undefined, {}), "forex");
  assert.equal(resolveStrategyOpcode("", {}), "forex");
  assert.equal(resolveStrategyOpcode("Pegged Swap", {}), "pegged");
  for (const alias of ["forex", "fxswap", "fx", "oracle", "fx curve", "DFX", "shell", "Shell v1", "forex-curve"]) {
    assert.equal(resolveStrategyOpcode(alias, {}), "forex", alias);
  }
  assert.equal(resolveStrategyOpcode(undefined, {}, { price: 1400 }), "pegged");
  assert.equal(resolveStrategyOpcode(undefined, {}, { bandPercent: 20 }), "forex");
  assert.equal(resolveStrategyOpcode(undefined, {}, { beta: 0.1 }), "forex");
  assert.equal(resolveStrategyOpcode(undefined, {}, { feeBps: 10 }), "forex");
  assert.equal(resolveStrategyOpcode(undefined, unconfigured), "pegged");
  assert.throws(() => resolveStrategyOpcode("forex", unconfigured), /Forex venue not configured/);
  assert.throws(() => resolveStrategyOpcode("xyc", {}), /Unknown opcode/);
  assert.throws(() => inferOpcodeFromParams({ price: 1400, lambda: 0.5 }), /mix pegged-only/);
  // FXSwap-only params arrive untyped from MCP JSON or old scripts; every opcode rejects them by name.
  const legacy = { gamma: 0.01, a: 200 } as StrategyParamsInput;
  assert.throws(() => inferOpcodeFromParams(legacy), /a, gamma belong to the CryptoSwap-style FXSwap curve/);
  assert.throws(() => resolveStrategyOpcode(undefined, {}, { flatFeeBps: 30 } as StrategyParamsInput), /no SwapVM flat fee/);
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

test("a per-strategist Salt keeps two users' identical strategies on separate ids", () => {
  const pair = resolvePair("USDC/BRL");
  const saltA = strategySalt(keccak256(toBytes("strategist A class")));
  const saltB = strategySalt(keccak256(toBytes("strategist B class")));
  assert.equal(saltA.length, 18);

  const plain = buildPeggedStrategySpec(ADAPTER, pair, {});
  const a = buildPeggedStrategySpec(ADAPTER, pair, {}, { salt: saltA });
  const b = buildPeggedStrategySpec(ADAPTER, pair, {}, { salt: saltB });
  assert.notEqual(a.strategyId, b.strategyId);
  assert.notEqual(a.strategyId, plain.strategyId);
  assert.equal(a.program, `${buildSaltInstruction(saltA)}${plain.program.slice(2)}`);
  assert.deepEqual(
    decodeSwapVMProgram(a.program).map((instruction) => instruction.name),
    ["Salt", "FlatFeeAmountIn", "PeggedSwap"]
  );
  assert.equal(a.amounts[0], plain.amounts[0]);

  const fx = buildFxSwapStrategySpec(FX_ADAPTER, pair, BRL_FEED, { flatFeeBps: 30 }, { oraclePriceWad: 55n * 10n ** 17n, salt: saltA });
  assert.deepEqual(
    decodeSwapVMProgram(fx.program).map((instruction) => instruction.name),
    ["Salt", "FlatFeeAmountIn", "FXSwap"]
  );
  assert.equal(fx.salt, saltA);

  const forexPlain = buildForexStrategySpec(FX_ADAPTER, pair, BRL_FEED, {}, { oraclePriceWad: 55n * 10n ** 17n });
  const forexA = buildForexStrategySpec(FX_ADAPTER, pair, BRL_FEED, {}, { oraclePriceWad: 55n * 10n ** 17n, salt: saltA });
  const forexB = buildForexStrategySpec(FX_ADAPTER, pair, BRL_FEED, {}, { oraclePriceWad: 55n * 10n ** 17n, salt: saltB });
  assert.deepEqual(
    decodeSwapVMProgram(forexA.program).map((instruction) => instruction.name),
    ["Salt", "ForexCurve"]
  );
  assert.equal(forexA.program, `${buildSaltInstruction(saltA)}${forexPlain.program.slice(2)}`);
  assert.notEqual(forexA.strategyId, forexB.strategyId);
  assert.equal(forexA.salt, saltA);
  assert.equal(forexPlain.salt, undefined);
  assert.throws(() => buildSaltInstruction("0x"), /1 to 255 bytes/);
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
  assert.throws(() => buildPeggedStrategySpec(ADAPTER, pair, { beta: 0.1 }), /only apply to opcode "forex"/);
  assert.throws(() => buildFxSwapStrategySpec(FX_ADAPTER, pair, ARS_FEED, { lambda: 0.5 }, price), /only apply to the forex curve/);
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

// ---------------------------------------------------------------------------------------------
// ForexCurve, the forex curve (Shell v1 / DFX): 123-byte args. Expected bytes are written out field by field here;
// the Solidity cross-check below runs once test/fixtures/forex-args-vectors.json exists.

const ARS_FOREX_DEFAULT_ARGS = `0x${[
  "00", // oracleKind: Chainlink-style latestRoundData
  "01", // flags: FLAG_INVERT_PRICE (the ARS feed quotes ARS per USD); USDC 0x3600.. is the lower address
  "c05a3fb016f973c82b0232ef50336d4c0466e70c", // oracle
  "00", // oracleDecimals: read decimals() on every swap
  "00093a80", // maxStaleness 604800 s
  "0000000000000025f273933db5700000", // minPrice 700e18 ARS per USD
  "0000000000000097c9ce4cf6d5c00000", // maxPrice 2800e18
  "06f05b59d3b20000", // alpha 0.5
  "0214e8348c4f0000", // beta 0.15
  "06f05b59d3b20000", // delta 0.5
  "03782dace9d90000", // maxFee 0.25
  "0429d069189e0000", // lambda 0.3
  "000aa87bee538000", // epsilon 0.003 (30 bps)
  "000000e8d4a51000", // rateLt 1e12: USDC, 6 decimals
  "0000000000000001" // rateGt 1: ARGt, 18 decimals
].join("")}` as Hex;

test("forex USDC/ARS defaults encode the hand-computed 123-byte ForexCurve args, with no flat fee in front", () => {
  assert.equal((ARS_FOREX_DEFAULT_ARGS.length - 2) / 2, FOREX.argsLength);
  const ars = buildForexStrategySpec(FX_ADAPTER, resolvePair("USDC/ARS"), ARS_FEED, {}, { oraclePriceWad: 1_400n * WAD });
  // [ForexCurve]: opcode 34 (0x22), 123 bytes (0x7b), args.
  assert.equal(ars.program, `0x227b${ARS_FOREX_DEFAULT_ARGS.slice(2)}`);
  assert.deepEqual(
    decodeSwapVMProgram(ars.program).map((instruction) => instruction.name),
    ["ForexCurve"]
  );
  assert.equal(ars.opcode, "forex");
  assert.equal(ars.label, "Forex ARS");
  assert.equal(ars.feedQuote, "fxPerUsd");
  assert.equal(ars.band.source, "default");
  assert.equal(ars.feePpb, 3_000_000);
  assert.equal(ars.usdcShip, 1_000_000n);
  assert.equal(ars.fxShip, 1_400n * WAD);
  assert.equal(ars.order.maker, getAddress(FX_ADAPTER));
  assert.equal(ars.strategyId, keccak256(ars.strategyBytes));
  assert.deepEqual(ars.args, {
    oracleKind: 0,
    flags: FOREX.flagInvertPrice,
    oracle: getAddress(ARS_FEED),
    oracleDecimals: 0,
    maxStaleness: 604_800,
    minPrice: 700n * WAD,
    maxPrice: 2_800n * WAD,
    alpha: FOREX_DEFAULTS.alpha,
    beta: FOREX_DEFAULTS.beta,
    delta: FOREX_DEFAULTS.delta,
    maxFee: FOREX_DEFAULTS.maxFee,
    lambda: FOREX_DEFAULTS.lambda,
    epsilon: FOREX_DEFAULTS.epsilon,
    rateLt: 10n ** 12n,
    rateGt: 1n
  });
  // The strategy id only depends on the program: amounts and the live price do not move it.
  assert.equal(
    buildForexStrategySpec(FX_ADAPTER, resolvePair("pesos"), ARS_FEED, { usdcAmount: "0.5" }, { oraclePriceWad: 1_470n * WAD })
      .strategyId,
    ars.strategyId
  );

  const decoded = decodeForexArgs(ARS_FOREX_DEFAULT_ARGS);
  assert.deepEqual(decoded, ars.args);
  assert.equal(encodeForexArgs(decoded), ARS_FOREX_DEFAULT_ARGS);
  assert.equal(buildForexProgram({ args: decoded }), ars.program);
  assert.deepEqual(decodeSwapVMProgram(ars.program)[0], { opcode: 34, name: "ForexCurve", args: decoded });

  // Opcode 34 with 115 bytes of args is still FXSwap.
  const fxVector = FXSWAP_VECTORS["usdc-ars-defaults"];
  assert.ok(fxVector);
  assert.deepEqual(
    decodeSwapVMProgram(fxVector.program).map((instruction) => instruction.name),
    ["FXSwap"]
  );
  assert.throws(() => decodeForexArgs(fxVector.args), /ForexCurveInvalidArgsLength\(115\)/);
});

test("forex flags: p is USDC per FX unit, inverted only for FX-per-USD feeds; FLAG_QUOTE_IS_GT follows address order", () => {
  const pair = resolvePair("USDC/BRL");
  const usdPerBrl = 194n * 10n ** 15n;
  const brlPerUsd = (WAD * WAD) / usdPerBrl;
  const redstone = buildForexStrategySpec(FX_ADAPTER, pair, BRL_FEED, {}, { oraclePriceWad: usdPerBrl, feedQuote: "usdPerFx" });
  const manual = buildForexStrategySpec(FX_ADAPTER, pair, BRL_FEED, {}, { oraclePriceWad: brlPerUsd });
  // RedStone BRL quotes USD per BRL, which is already the curve's price: no flag. USDC is below BRAt: no quoteIsGt.
  assert.equal(redstone.args.flags, 0x00);
  assert.equal(manual.args.flags, FOREX.flagInvertPrice);
  // Flags are args byte 1, right after the 2-byte instruction header and oracleKind.
  assert.equal(redstone.program.slice(8, 10), "00");
  assert.equal(manual.program.slice(8, 10), "01");
  assert.equal(redstone.fxShip, manual.fxShip);
  assert.notEqual(redstone.strategyId, manual.strategyId);
  // Default band: half to double the 5.50 BRL per USD reference, in the feed's orientation.
  const reference = (WAD * WAD) / (55n * 10n ** 17n);
  assert.equal(redstone.band.minPrice, reference / 2n);
  assert.equal(redstone.band.maxPrice, reference * 2n);

  // Both feed orientations give the same FX per USDC.
  assert.equal(forexFxPerUsdcWad(redstone.args, usdPerBrl, pair), brlPerUsd);
  assert.equal(forexFxPerUsdcWad(manual.args, brlPerUsd, pair), brlPerUsd);
  const ars = resolvePair("USDC/ARS");
  assert.equal(forexFxPerUsdcWad({ flags: FOREX.flagInvertPrice }, 1_400n * WAD, ars), 1_400n * WAD);
  assert.equal(forexFxPerUsdcWad({ flags: 0 }, 5n * 10n ** 14n, ars), 2_000n * WAD);
  // A program quoting in the FX token instead (quoteIsGt set while USDC is the lower address): p is FX per USDC.
  assert.equal(forexFxPerUsdcWad({ flags: FOREX.flagQuoteIsGt }, 1_400n * WAD, ars), 1_400n * WAD);
  assert.equal(
    forexFxPerUsdcWad({ flags: FOREX.flagQuoteIsGt | FOREX.flagInvertPrice }, 5n * 10n ** 14n, ars),
    2_000n * WAD
  );
  assert.equal(forexFxPerUsdcWad({ flags: 0 }, 0n, ars), 0n);

  // An FX token below USDC's address makes USDC the greater token: FLAG_QUOTE_IS_GT and swapped rates.
  const lowPair: FxPair = {
    name: "USDC/LOW",
    usdc: pair.usdc,
    fx: { ...pair.fx, symbol: "LOWt", address: "0x1000000000000000000000000000000000000001", fiat: "LOW" }
  };
  assert.deepEqual(forexOrientation(lowPair.usdc.address, 6, lowPair.fx.address, 18), {
    quoteIsGt: true,
    rateLt: 1n,
    rateGt: 10n ** 12n
  });
  assert.deepEqual(forexOrientation(pair.usdc.address, 6, pair.fx.address, 18), {
    quoteIsGt: false,
    rateLt: 10n ** 12n,
    rateGt: 1n
  });
  assert.equal(forexFlags("fxPerUsd", true), 0x03);
  assert.equal(forexFlags("usdPerFx", true), 0x02);
  assert.equal(forexFlags("usdPerFx", false), 0x00);
  // forexPairFields mirrors ForexCurveArgsBuilder.pairFields, including its USDC/BRAt and USDC/ARGt doc examples.
  assert.deepEqual(forexPairFields(pair.usdc.address, 6, pair.fx.address, 18, false), {
    flags: 0x00,
    rateLt: 10n ** 12n,
    rateGt: 1n
  });
  assert.deepEqual(forexPairFields(ars.usdc.address, 6, ars.fx.address, 18, true), {
    flags: FOREX.flagInvertPrice,
    rateLt: 10n ** 12n,
    rateGt: 1n
  });
  assert.deepEqual(forexPairFields(lowPair.usdc.address, 6, lowPair.fx.address, 18, true), {
    flags: FOREX.flagInvertPrice | FOREX.flagQuoteIsGt,
    rateLt: 1n,
    rateGt: 10n ** 12n
  });
  const low = buildForexStrategySpec(FX_ADAPTER, lowPair, BRL_FEED, { minPrice: 1, maxPrice: 10 }, { oraclePriceWad: 5n * WAD });
  assert.equal(low.args.flags, FOREX.flagInvertPrice | FOREX.flagQuoteIsGt);
  assert.equal(low.program.slice(8, 10), "03");
  assert.equal(low.program.slice(-32), "0000000000000001000000e8d4a51000");
  assert.equal(forexFxPerUsdcWad(low.args, 5n * WAD, lowPair), 5n * WAD);
  assert.equal(low.fxShip, 5n * WAD);
  assert.throws(() => forexOrientation(ARS_FEED, 6, ARS_FEED, 18), /ForexCurveInvalidPair/);
  assert.throws(() => forexOrientation(ARS_FEED, 6, BRL_FEED, 19), /ForexCurveUnsupportedDecimals\(19\)/);
});

test("forex params: curve params as decimals or percent, epsilon via the fee fields, FXSwap params rejected", () => {
  const pair = resolvePair("USDC/BRL");
  const price = { oraclePriceWad: 55n * 10n ** 17n };
  const build = (params: StrategyParamsInput) => buildForexStrategySpec(FX_ADAPTER, pair, BRL_FEED, params, price);

  const custom = build({ alpha: "40%", beta: 0.1, delta: "1", maxFeePercent: 5, lambda: "0.5", feePercent: "0.15%" });
  assert.equal(custom.args.alpha, 4n * 10n ** 17n);
  assert.equal(custom.args.beta, 10n ** 17n);
  assert.equal(custom.args.delta, WAD);
  assert.equal(custom.args.maxFee, 5n * 10n ** 16n);
  assert.equal(custom.args.lambda, 5n * 10n ** 17n);
  assert.equal(custom.args.epsilon, 15n * 10n ** 14n);
  assert.equal(custom.feePpb, 1_500_000);
  assert.equal(build({ maxFee: "5%" }).args.maxFee, 5n * 10n ** 16n);
  assert.equal(build({ maxFee: 0.05 }).args.maxFee, 5n * 10n ** 16n);
  assert.equal(build({ feeBps: 5 }).feePpb, 500_000);
  assert.equal(build({ feePpb: 1_000_000 }).args.epsilon, 10n ** 15n);
  assert.equal(build({ beta: 0 }).args.beta, 0n);

  const explicit = buildForexStrategySpec(
    FX_ADAPTER,
    pair,
    BRL_FEED,
    { minPrice: "0.09", maxPrice: 0.37, maxStaleness: "1h", oracleDecimals: 8, fxAmount: "5.5", label: " tight BRL " },
    { feedQuote: "usdPerFx" }
  );
  assert.equal(explicit.band.source, "explicit");
  assert.equal(explicit.args.minPrice, 9n * 10n ** 16n);
  assert.equal(explicit.args.maxStaleness, 3_600);
  assert.equal(explicit.args.oracleDecimals, 8);
  assert.equal(explicit.fxShip, 55n * 10n ** 17n);
  assert.equal(explicit.label, "tight BRL");
  const banded = buildForexStrategySpec(FX_ADAPTER, resolvePair("ARS"), ARS_FEED, { bandPercent: "20%" }, {
    oraclePriceWad: 1_470n * WAD
  });
  assert.equal(banded.band.minPrice, 1_176n * WAD);
  assert.equal(banded.band.maxPrice, 1_764n * WAD);
  assert.equal(banded.fxShip, 1_470n * WAD);

  assert.throws(() => build({ flatFeeBps: 30 } as StrategyParamsInput), /flatFeeBps is not accepted: the forex curve \(Shell v1 \/ DFX\) charges its own proportional fee epsilon/);
  assert.throws(
    () => build({ outFeeBps: 200, feeGamma: 0.03 } as StrategyParamsInput),
    /outFeeBps, feeGamma belong to the CryptoSwap-style FXSwap curve/
  );
  assert.throws(() => build({ price: 1400 }), /only apply to opcode "pegged"/);
  assert.throws(() => build({ maxFee: 0.05, maxFeePercent: 5 }), /only one of maxFee or maxFeePercent/);
  assert.throws(() => build({ feeBps: 10, feePercent: 0.1 }), /only one/);
  assert.throws(() => build({ beta: 0.6 }), /ForexCurveInvalidCurve\(.*\): beta \(flat band\) must be below alpha/);
  assert.throws(() => build({ alpha: 1 }), /ForexCurveInvalidCurve\(.*\): alpha \(halt band\) must be above 0 and below 1/);
  assert.throws(() => build({ lambda: "150%" }), /ForexCurveInvalidFees\(.*\): lambda \(rebate share\)/);
  assert.throws(() => build({ feeBps: 1000 }), /ForexCurveInvalidFees\(.*\): epsilon \(proportional fee\)/);
  assert.throws(() => build({ feeBps: "0.000001" }), /finer than 1 ppb/);
  assert.throws(() => build({ delta: 20 }), /ForexCurve delta \d+ does not fit its uint64 field/);
  assert.throws(() => buildForexStrategySpec(FX_ADAPTER, pair, BRL_FEED, { bandPercent: 10 }), /live oracle price/);
  assert.throws(() => buildForexStrategySpec(FX_ADAPTER, pair, BRL_FEED, {}), /fxAmount defaults/);
});

test("forex args validation covers flags, oracle, band and every curve range", () => {
  const base = decodeForexArgs(ARS_FOREX_DEFAULT_ARGS);
  const encode = (patch: Partial<ForexArgs>) => encodeForexArgs({ ...base, ...patch });
  assert.throws(() => encode({ oracleKind: 1 }), /ForexCurveUnsupportedOracleKind\(1\)/);
  assert.throws(() => encode({ flags: 4 }), /ForexCurveInvalidFlags\(4\)/);
  assert.doesNotThrow(() => encode({ flags: 3 }));
  assert.throws(() => encode({ oracle: `0x${"00".repeat(20)}` }), /ForexCurveInvalidOracle/);
  assert.throws(() => encode({ maxStaleness: 0 }), /ForexCurveInvalidMaxStaleness/);
  assert.throws(() => encode({ minPrice: 3_000n * WAD }), /ForexCurveInvalidPriceBand/);
  assert.throws(() => encode({ minPrice: 0n }), /ForexCurveInvalidPriceBand/);
  assert.throws(() => encode({ alpha: 0n }), /ForexCurveInvalidCurve\(0, \d+, \d+\): alpha \(halt band\)/);
  assert.throws(() => encode({ alpha: WAD }), /ForexCurveInvalidCurve\(.*\): alpha \(halt band\)/);
  assert.throws(() => encode({ beta: base.alpha }), /ForexCurveInvalidCurve\(.*\): beta \(flat band\)/);
  assert.doesNotThrow(() => encode({ beta: 0n, delta: 0n, maxFee: 0n, lambda: 0n, epsilon: 0n }));
  // delta's uint64 field tops out near 18.45; there is no other cap.
  assert.doesNotThrow(() => encode({ delta: 18n * WAD }));
  assert.throws(() => encode({ delta: 1n << 64n }), /uint64/);
  // maxFee < min(1/2, (1 - alpha) / (2 alpha)): just under 0.5 at alpha 0.5, lower as alpha nears 1.
  assert.equal(base.alpha, WAD / 2n);
  assert.doesNotThrow(() => encode({ maxFee: WAD / 2n - 1n, lambda: WAD }));
  assert.throws(() => encode({ maxFee: WAD / 2n }), /ForexCurveInvalidFees\(500000000000000000, .*\): maxFee/);
  const alpha09 = (9n * WAD) / 10n;
  assert.doesNotThrow(() => encode({ alpha: alpha09, maxFee: forexMaxFeeLimit(alpha09) }));
  assert.throws(() => encode({ alpha: alpha09, maxFee: forexMaxFeeLimit(alpha09) + 1n }), /ForexCurveInvalidFees/);
  assert.throws(() => encode({ lambda: WAD + 1n }), /ForexCurveInvalidFees\(.*\): lambda \(rebate share\)/);
  assert.doesNotThrow(() => encode({ epsilon: 10n ** 17n - 1n }));
  assert.throws(() => encode({ epsilon: 10n ** 17n }), /ForexCurveInvalidFees\(.*\): epsilon \(proportional fee\)/);
  assert.throws(() => encode({ rateGt: 0n }), /ForexCurveInvalidRates/);
  // Rates are 10^(18 - decimals): 1 (18 decimals) up to 1e18 (0 decimals).
  assert.doesNotThrow(() => encode({ rateLt: WAD, rateGt: 1n }));
  assert.throws(() => encode({ rateLt: WAD + 1n }), /ForexCurveInvalidRates\(1000000000000000001, 1\): rates are 10\^\(18 - token decimals\)/);
  assert.throws(() => encode({ maxPrice: 1n << 128n }), /uint128/);
  assert.throws(() => encode({ maxStaleness: 2 ** 32 }), /ForexCurve maxStaleness/);
  assert.throws(() => decodeForexArgs(`0x${"00".repeat(122)}`), /ForexCurveInvalidArgsLength\(122\)/);
  assert.throws(() => decodeForexArgs("0xzz"), /hex bytes/);
});

type ForexArgsVector = {
  oracleKind: number;
  flags: number;
  oracle: string;
  oracleDecimals: number;
  maxStaleness: number;
  minPrice: string;
  maxPrice: string;
  alpha: string;
  beta: string;
  delta: string;
  maxFee: string;
  lambda: string;
  epsilon: string;
  rateLt: string;
  rateGt: string;
  args: Hex;
  program?: Hex;
  salt?: Hex;
  withSalt?: boolean;
};
const FOREX_VECTORS_URL = new URL("./fixtures/forex-args-vectors.json", import.meta.url);

test(
  "forex args and programs are byte-identical to the Solidity ForexCurve args builder vectors",
  {
    skip: existsSync(FOREX_VECTORS_URL)
      ? false
      : "test/fixtures/forex-args-vectors.json does not exist yet; it is generated from the Solidity ForexCurve args builder"
  },
  () => {
    const vectors = JSON.parse(readFileSync(FOREX_VECTORS_URL, "utf8")) as Record<string, unknown>;
    const limits = vectors.maxFeeLimit as Record<string, string> | undefined;
    assert.ok(limits && Object.keys(limits).length > 0, "forex-args-vectors.json has no maxFeeLimit table");
    for (const [alpha, limit] of Object.entries(limits)) {
      assert.equal(forexMaxFeeLimit(BigInt(alpha)), BigInt(limit), `maxFeeLimit(${alpha}) matches ForexCurveArgsBuilder`);
    }
    const entries = Object.entries(vectors).filter(
      (entry): entry is [string, ForexArgsVector] => typeof (entry[1] as { args?: unknown }).args === "string"
    );
    assert.ok(entries.length > 0, "forex-args-vectors.json has no entries with args");
    for (const [name, vector] of entries) {
      const args: ForexArgs = {
        oracleKind: vector.oracleKind,
        flags: vector.flags,
        oracle: vector.oracle,
        oracleDecimals: vector.oracleDecimals,
        maxStaleness: vector.maxStaleness,
        minPrice: BigInt(vector.minPrice),
        maxPrice: BigInt(vector.maxPrice),
        alpha: BigInt(vector.alpha),
        beta: BigInt(vector.beta),
        delta: BigInt(vector.delta),
        maxFee: BigInt(vector.maxFee),
        lambda: BigInt(vector.lambda),
        epsilon: BigInt(vector.epsilon),
        rateLt: BigInt(vector.rateLt),
        rateGt: BigInt(vector.rateGt)
      };
      assert.equal(encodeForexArgs(args), vector.args.toLowerCase(), `${name} args`);
      assert.deepEqual(decodeForexArgs(vector.args), { ...args, oracle: getAddress(vector.oracle) }, `${name} decode`);
      if (vector.program) {
        assert.equal(
          buildForexProgram({ args, salt: vector.withSalt ? vector.salt : undefined }),
          vector.program.toLowerCase(),
          `${name} program`
        );
      }
    }
  }
);

test("venues: forex venue addresses default to the Arc deployment and can be overridden", async () => {
  const venue = resolveSwapVMVenue({ writeChainId: 5042002 });
  assert.equal(venue.forex?.opcode, "forex");
  assert.equal(venue.forex?.name, "forex venue (AquaForexSwapVMRouter)");
  assert.equal(venue.forex?.router, ARC_TESTNET_DEPLOYMENT.fxVenue.fxswapRouter?.toLowerCase());
  assert.equal(venue.forex?.adapter, ARC_TESTNET_DEPLOYMENT.fxVenue.fxAquaAdapter?.toLowerCase());
  assert.equal(venue.forex?.oracles.ARGt, ARS_FEED.toLowerCase());
  // USDC/BRL reads RedStone's BRL feed (USD per 1 BRL) unless FX_ORACLE_BRL_USD overrides it with a BRL-per-USD feed.
  assert.equal(venue.forex?.oracles.BRAt, ARC_TESTNET_DEPLOYMENT.fxVenue.redstone.feeds.BRL?.toLowerCase());
  assert.deepEqual(venue.forex?.feeds.BRAt, {
    address: ARC_TESTNET_DEPLOYMENT.fxVenue.redstone.feeds.BRL?.toLowerCase(),
    source: "redstone",
    quote: "usdPerFx",
    redstone: { feedId: "BRL", adapter: ARC_TESTNET_DEPLOYMENT.fxVenue.redstone.multiFeedAdapter?.toLowerCase() }
  });
  assert.equal(venue.forex?.feeds.ARGt?.source, "manual");
  const manualBrl = resolveSwapVMVenue({ writeChainId: 5042002, fxOracleBrlUsdAddress: BRL_FEED }).forex?.feeds.BRAt;
  assert.deepEqual(manualBrl, { address: BRL_FEED.toLowerCase(), source: "manual", quote: "fxPerUsd" });
  assert.equal(venue.pegged.adapter, ADAPTER.toLowerCase());
  const override = `0x${"ab".repeat(20)}`;
  assert.equal(resolveSwapVMVenue({ writeChainId: 5042002, fxOracleArsUsdAddress: override }).forex?.oracles.ARGt, override);
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
