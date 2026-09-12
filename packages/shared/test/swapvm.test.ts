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
  toHex
} from "viem";

import { ARC_TESTNET_DEPLOYMENT } from "../src/constants.js";
import {
  executeCreateFxStrategy,
  executeFxDeposit,
  executeFxSwap,
  prepareFxDeposit,
  resolveStrategyOpcode,
  resolveSwapVMVenue,
  resolveToolWriteMode
} from "../src/fx.js";
import {
  assertSupportedChain,
  buildPeggedStrategySpec,
  buildShipTypedData,
  buildTakerTraitsAndData,
  decodeSwapVMOrder,
  parseFeePpb,
  parseIntegerLike,
  parseTokenAmount,
  resolvePair,
  resolveToken
} from "../src/swapvm.js";

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

test("fxswap is refused until its router exists; pegged is the default opcode", () => {
  assert.equal(resolveStrategyOpcode(undefined, {}), "pegged");
  assert.equal(resolveStrategyOpcode("Pegged Swap", {}), "pegged");
  assert.throws(() => resolveStrategyOpcode("fxswap", {}), /FXSwap router not configured yet/);
  assert.throws(
    () => resolveStrategyOpcode("FXSwap", { fxswapRouterAddress: `0x${"12".repeat(20)}` }),
    /not available in this build/
  );
  assert.throws(() => resolveStrategyOpcode("xyc", {}), /Unknown opcode/);
});

test("Arc deployment constants stay in sync with deployments/arc-testnet.json", () => {
  const file = JSON.parse(
    readFileSync(new URL("../../../deployments/arc-testnet.json", import.meta.url), "utf8")
  ) as {
    chainId: number;
    contracts: Record<string, string>;
    assets: Record<string, string>;
    vaults: Record<string, string>;
  };
  const deployment = ARC_TESTNET_DEPLOYMENT;
  assert.equal(file.chainId, deployment.chainId);
  for (const [name, address] of Object.entries(deployment.contracts)) {
    assert.equal(file.contracts[name]?.toLowerCase(), address.toLowerCase(), name);
  }
  const tokens = { usdc: deployment.tokens.USDC, argt: deployment.tokens.ARGt, brat: deployment.tokens.BRAt };
  for (const [name, token] of Object.entries(tokens)) {
    assert.equal(file.assets[name]?.toLowerCase(), token.address.toLowerCase(), name);
    assert.equal(file.vaults[name]?.toLowerCase(), token.vault.toLowerCase(), name);
  }
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
