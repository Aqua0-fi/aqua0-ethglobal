/**
 * On-chain flows for the Arc USDC-FX demo through Aqua0 AquaAdapters and 1inch SwapVM routers.
 *
 * Two venues share the Aqua0 vaults and the 1inch Aqua instance, because an AquaAdapter binds one router
 * immutably:
 * - fxswap (default when configured): AquaFXSwapVMRouter, `[FlatFeeAmountIn]?[FXSwap]`, priced from an FX
 *   oracle on every swap;
 * - pegged (fallback): stock AquaSwapVMRouter, `[FlatFeeAmountIn][PeggedSwap]` at a fixed FX price.
 *
 * Flows: create a strategy (class -> vault legs -> backing -> commitments -> ship), deposit with human units,
 * quote/swap against a live strategy with oracle/execution price and spread, read how one USDC deposit backs
 * classes on both venues, and read or (owner only) move the FX feeds.
 *
 * Every write has a prepare path (calldata / EIP-712 typed data, nothing sent) and an execute path that only
 * runs behind `assertExecutionAllowed` (MCP_WRITE_MODE=execute, key set, Arc or local RPC).
 */
import {
  encodeFunctionData,
  formatUnits,
  getAddress,
  hashTypedData,
  keccak256,
  toBytes,
  toHex,
  type Hex
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import {
  aquaAdapterAbi,
  aquaShippedEvent,
  aquaSwapVMRouterAbi,
  assetVaultAbi,
  manualFxOracleAbi,
  mintableErc20Abi,
  vaultRegistryAbi
} from "./abis.js";
import { ARC_TESTNET_DEPLOYMENT } from "./constants.js";
import { normalizeAddress, normalizeBytes32 } from "./graph.js";
import {
  ARC_TOKENS,
  FXSWAP,
  FXSWAP_REFERENCE_PRICE_WAD,
  OPERATOR_ROLE,
  SWAPVM,
  VENUE_SETTLER_ROLE,
  assertSupportedChain,
  buildFxSwapStrategySpec,
  buildPeggedStrategySpec,
  buildShipTypedData,
  buildTakerTraitsAndData,
  decodeSwapVMOrder,
  decodeSwapVMProgram,
  describeContractError,
  formatRate,
  formatTokenAmount,
  inferOpcodeFromParams,
  parseTokenAmount,
  resolvePair,
  resolveToken,
  toJsonSafe,
  type AmountUnit,
  type AmountValue,
  type DecodedInstruction,
  type FxPair,
  type FxSwapArgs,
  type StrategyOpcode,
  type StrategyParamsInput,
  type StrategySpec,
  type SwapVMOrder,
  type TokenInfo
} from "./swapvm.js";
import {
  assertExecutionAllowed,
  assertReceiptSuccess,
  createExecutionClients,
  createReadClient,
  deriveStrategyKey,
  normalizePrivateKey,
  requireWriteChainId,
  type WriteConfig,
  type WriteMode
} from "./write.js";

type ReadClient = ReturnType<typeof createReadClient>;
type ExecutionClients = Awaited<ReturnType<typeof createExecutionClients>>;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const WAD = 10n ** 18n;

const FEED_ENV: Readonly<Record<string, string>> = {
  ARGt: "FX_ORACLE_ARS_USD",
  BRAt: "FX_ORACLE_BRL_USD"
};

export const FX_FEED_RISK =
  "The Arc demo feeds are ManualFxOracle contracts: only the feed owner can set the price, by hand. Every FXSwap strategy on a feed prices swaps from it, bounded only by that strategy's price band and staleness window. Treat it as a demo oracle, not a market feed.";

// ---------------------------------------------------------------------------------------------
// venues

export type AquaVenue = {
  opcode: StrategyOpcode;
  name: string;
  adapter: Lowercase<string>;
  router: Lowercase<string>;
};

export type FxSwapVenue = AquaVenue & {
  opcode: "fxswap";
  /** Feed per FX token symbol (ARGt, BRAt). Aqua0 feeds quote FX units per 1 USD. */
  oracles: Partial<Record<string, Lowercase<string>>>;
};

export type SwapVMVenue = {
  chainId: number;
  registry: Lowercase<string>;
  aqua: Lowercase<string>;
  aquaStartBlock: bigint;
  /** Pegged venue adapter and router, kept at the top level for existing callers. */
  adapter: Lowercase<string>;
  router: Lowercase<string>;
  pegged: AquaVenue;
  fxswap?: FxSwapVenue;
};

/** Venue addresses: env overrides first, Arc Testnet deployment defaults otherwise. */
export function resolveSwapVMVenue(config: WriteConfig): SwapVMVenue {
  const chainId = requireWriteChainId(config);
  if (chainId !== ARC_TESTNET_DEPLOYMENT.chainId) {
    throw new Error(
      `SwapVM FX strategies target Arc Testnet: WRITE_CHAIN_ID must be ${ARC_TESTNET_DEPLOYMENT.chainId} (a local Anvil fork of Arc keeps that id); got ${chainId}`
    );
  }
  const contracts = ARC_TESTNET_DEPLOYMENT.contracts;
  const pegged: AquaVenue = {
    opcode: "pegged",
    name: "pegged venue (AquaSwapVMRouter)",
    adapter: normalizeAddress(config.aquaAdapterAddress ?? contracts.aquaAdapter),
    router: normalizeAddress(config.aquaSwapVMRouterAddress ?? contracts.aquaSwapVMRouter)
  };
  const fxswap = resolveFxSwapVenue(config);
  if (fxswap && fxswap.adapter === pegged.adapter) {
    throw new Error(
      `The FXSwap venue adapter ${fxswap.adapter} is the pegged AquaAdapter; FXSWAP_AQUA_ADAPTER_ADDRESS must be the adapter bound to the FXSwap router`
    );
  }
  return {
    chainId,
    registry: normalizeAddress(config.vaultRegistryAddress ?? contracts.vaultRegistry),
    aqua: normalizeAddress(contracts.aqua),
    aquaStartBlock: BigInt(ARC_TESTNET_DEPLOYMENT.startBlocks.aqua),
    adapter: pegged.adapter,
    router: pegged.router,
    pegged,
    ...(fxswap ? { fxswap } : {})
  };
}

/** FXSwap venue from env overrides, then the Arc deployment; undefined until both router and adapter are known. */
export function resolveFxSwapVenue(config: WriteConfig): FxSwapVenue | undefined {
  const deployed = ARC_TESTNET_DEPLOYMENT.fxVenue;
  const router = config.fxswapRouterAddress ?? deployed.fxswapRouter;
  const adapter = config.fxswapAquaAdapterAddress ?? deployed.fxAquaAdapter;
  if (!router || !adapter) {
    return undefined;
  }
  const ars = config.fxOracleArsUsdAddress ?? deployed.fxOracles.arsUsd;
  const brl = config.fxOracleBrlUsdAddress ?? deployed.fxOracles.brlUsd;
  return {
    opcode: "fxswap",
    name: "FXSwap venue (AquaFXSwapVMRouter)",
    adapter: normalizeAddress(adapter),
    router: normalizeAddress(router),
    oracles: {
      ...(ars ? { ARGt: normalizeAddress(ars) } : {}),
      ...(brl ? { BRAt: normalizeAddress(brl) } : {})
    }
  };
}

/** Address of the configured signer (never the key itself), or undefined when none is configured. */
export function configuredSignerAddress(config: WriteConfig): Lowercase<string> | undefined {
  if (!config.writePrivateKey || !/^0x[0-9a-fA-F]{64}$/.test(config.writePrivateKey)) {
    return undefined;
  }
  return normalizeAddress(privateKeyToAccount(config.writePrivateKey as Hex).address);
}

/** Tools execute only when MCP_WRITE_MODE=execute and the caller did not ask for a dry run. */
export function resolveToolWriteMode(config: WriteConfig, dryRun?: boolean): WriteMode {
  return !dryRun && config.mcpWriteMode === "execute" ? "execute" : "prepare";
}

/** Parse an opcode name; undefined when omitted or empty. */
export function parseStrategyOpcode(opcode: string | undefined): StrategyOpcode | undefined {
  if (opcode === undefined) {
    return undefined;
  }
  const value = opcode.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (value === "") {
    return undefined;
  }
  if (["pegged", "peg", "peggedswap", "stable", "stableswap", "fixed", "fixedrate", "fixedprice"].includes(value)) {
    return "pegged";
  }
  if (["fxswap", "fx", "oracle", "oraclefx", "dynamic", "dynamicfx", "floating", "floatingfx"].includes(value)) {
    return "fxswap";
  }
  throw new Error(
    `Unknown opcode "${opcode}". Supported: "fxswap" (oracle-anchored FXSwap, the default when its venue is configured) and "pegged" (fixed-price PeggedSwap fallback)`
  );
}

/**
 * Opcode before on-chain checks: explicit opcode, else what opcode-specific params imply, else "fxswap" when
 * the FXSwap venue is configured, else "pegged". Throws when "fxswap" is requested but not configured.
 */
export function resolveStrategyOpcode(
  opcode: string | undefined,
  config: WriteConfig,
  params?: StrategyParamsInput
): StrategyOpcode {
  const requested = parseStrategyOpcode(opcode) ?? inferOpcodeFromParams(params);
  const fxConfigured = resolveFxSwapVenue(config) !== undefined;
  if (requested === "fxswap" && !fxConfigured) {
    throw new Error(
      'FXSwap venue not configured: set FXSWAP_ROUTER_ADDRESS and FXSWAP_AQUA_ADAPTER_ADDRESS (and FX_ORACLE_ARS_USD / FX_ORACLE_BRL_USD). Meanwhile use opcode "pegged".'
    );
  }
  return requested ?? (fxConfigured ? "fxswap" : "pegged");
}

type OpcodeChoice = {
  opcode: StrategyOpcode;
  source: "explicit" | "params" | "default" | "fallback";
  note?: string;
};

export type StrategyStep = {
  stage: string;
  status: "sent" | "skipped";
  to?: Lowercase<string>;
  hash?: Hex;
  blockNumber?: string;
  note?: string;
};

export type PreparedStep = {
  stage: string;
  to: Lowercase<string>;
  value: "0";
  data: Hex;
  functionName: string;
  args: unknown[];
  note?: string;
};

// ---------------------------------------------------------------------------------------------
// create strategy

export type CreateFxStrategyInput = {
  pair: string;
  chain?: string | number | undefined;
  opcode?: string | undefined;
  params?: StrategyParamsInput | undefined;
  strategist?: string | undefined;
  /** Mint (open-mint demo token), deposit and commit the FX leg if its backing is short. Default true. */
  fundFxLeg?: boolean | undefined;
};

type StrategyIdentity = ReturnType<typeof strategyIdentity>;

export type ExecutedFxStrategy = StrategyIdentity & {
  mode: "execute";
  steps: StrategyStep[];
  backing: {
    usdc: ReturnType<typeof positionSummary>;
    fx: ReturnType<typeof positionSummary>;
  };
};

export type PreparedFxStrategy = StrategyIdentity & {
  mode: "prepare";
  stage: "registerStrategyClass" | "configureAndShip" | "alreadyLive";
  explanation: string;
  transactions: PreparedStep[];
  shipSignature?: { signer: Lowercase<string>; digest: Hex; typedData: unknown };
  shipCall?: { to: Lowercase<string>; functionName: string; args: unknown; caller: string };
  warnings: string[];
};

export async function executeCreateFxStrategy(
  config: WriteConfig,
  input: CreateFxStrategyInput
): Promise<ExecutedFxStrategy> {
  assertExecutionAllowed(config);
  parseStrategyOpcode(input.opcode);
  const venue = resolveSwapVMVenue(config);
  assertSupportedChain(input.chain, venue.chainId);
  const pair = resolvePair(input.pair);
  const ctx = await createExecContext(config);
  const client = ctx.publicClient;
  if (input.strategist && normalizeAddress(input.strategist) !== ctx.signer) {
    throw new Error(
      `In execute mode the strategist is the configured signer ${ctx.signer}; got ${input.strategist}. Omit strategist, or use dryRun to prepare for another address.`
    );
  }
  const choice = await chooseCreateOpcode(client, venue, input, pair, ctx.signer);
  const { spec, aquaVenue, oracle } = await buildStrategySpec(client, venue, choice.opcode, pair, input.params ?? {});
  const strategyKey = deriveStrategyKey({
    strategist: ctx.signer,
    chainId: venue.chainId,
    token0: pair.usdc.address,
    token1: pair.fx.address,
    label: spec.label
  }).strategyKey;
  const alreadyLive = await isStrategyLive(client, aquaVenue.adapter, spec.strategyId);
  if (!alreadyLive) {
    // Check wiring, router binding and operator role before sending anything.
    const readiness = await readVenueReadiness(client, venueTarget(venue, aquaVenue), [pair.usdc, pair.fx], ctx.signer);
    const problem = readiness.hint ?? readiness.operatorHint;
    if (problem) {
      throw new Error(`Cannot ship on the ${aquaVenue.name}: ${problem} Nothing was sent.`);
    }
  }

  // 1. Strategy class (permissionless).
  let classId = await readClassId(client, venue, strategyKey);
  if (classId === 0n) {
    await sendTransaction(ctx, "registerStrategyClass", venue.registry, () =>
      client.simulateContract({
        account: ctx.account,
        address: getAddress(venue.registry),
        abi: vaultRegistryAbi,
        functionName: "registerStrategyClass",
        args: [strategyKey]
      })
    );
    classId = await readClassId(client, venue, strategyKey);
    if (classId === 0n) {
      throw new Error("classForStrategy still returned 0 after registerStrategyClass mined");
    }
  } else {
    skipStep(ctx, "registerStrategyClass", `class ${classId} already exists for this strategist, pair and label`);
  }
  const registeredClassId = classId;

  // 2. Vault legs (permissionless first registration).
  for (const token of [pair.usdc, pair.fx]) {
    const stage = `registerStrategy (${token.symbol} vault)`;
    const current = await readLegStrategist(client, token.vault, registeredClassId);
    if (current === ZERO_ADDRESS) {
      await sendTransaction(ctx, stage, token.vault, () =>
        client.simulateContract({
          account: ctx.account,
          address: getAddress(token.vault),
          abi: assetVaultAbi,
          functionName: "registerStrategy",
          args: [registeredClassId, getAddress(ctx.signer)]
        })
      );
    } else if (current !== ctx.signer) {
      throw new Error(
        `Class ${registeredClassId} on the ${token.symbol} vault already belongs to strategist ${current}`
      );
    } else {
      skipStep(ctx, stage, "leg already registered to this strategist");
    }
  }

  // 3. FX leg backing. The Arc demo FX tokens have an open mint, so the tool can fund them itself.
  if (alreadyLive) {
    skipStep(ctx, `fund ${pair.fx.symbol} leg`, "strategy already live");
  } else {
    await ensureFxBacking(ctx, spec, registeredClassId, input.fundFxLeg ?? true);
  }

  // 4. Commitments: the same USDC principal can be committed to any number of classes.
  for (const token of [pair.usdc, pair.fx]) {
    const stage = `setCommitment (${token.symbol} vault)`;
    const position = await readVaultPosition(client, token, ctx.signer, registeredClassId);
    if (position.committed) {
      skipStep(ctx, stage, "already committed");
    } else if (position.principal === 0n) {
      skipStep(ctx, stage, `no ${token.symbol} principal to commit; deposit ${token.symbol} first`);
    } else {
      await sendTransaction(ctx, stage, token.vault, () =>
        client.simulateContract({
          account: ctx.account,
          address: getAddress(token.vault),
          abi: assetVaultAbi,
          functionName: "setCommitment",
          args: [registeredClassId, true]
        })
      );
    }
  }

  // 5. Ship the SwapVM program through the venue's adapter.
  if (alreadyLive) {
    skipStep(ctx, "shipStrategyWithFee", `strategy already live on the ${aquaVenue.name} AquaAdapter`);
  } else {
    await shipStrategy(ctx, venue, aquaVenue, spec, registeredClassId);
  }

  const [usdcPosition, fxPosition] = await Promise.all([
    readVaultPosition(client, pair.usdc, ctx.signer, registeredClassId),
    readVaultPosition(client, pair.fx, ctx.signer, registeredClassId)
  ]);
  return {
    mode: "execute",
    ...strategyIdentity(venue.chainId, spec, aquaVenue, choice, ctx.signer, strategyKey, registeredClassId, true, oracle),
    steps: ctx.steps,
    backing: {
      usdc: positionSummary(pair.usdc, usdcPosition),
      fx: positionSummary(pair.fx, fxPosition)
    }
  };
}

export async function prepareCreateFxStrategy(
  config: WriteConfig,
  input: CreateFxStrategyInput
): Promise<PreparedFxStrategy> {
  parseStrategyOpcode(input.opcode);
  const venue = resolveSwapVMVenue(config);
  assertSupportedChain(input.chain, venue.chainId);
  const pair = resolvePair(input.pair);
  const strategist = input.strategist
    ? normalizeAddress(input.strategist)
    : configuredSignerAddress(config);
  if (!strategist) {
    throw new Error(
      "strategist is required in prepare mode (no WRITE_PRIVATE_KEY signer is configured to default to)"
    );
  }
  const client = createReadClient(config);
  const choice = await chooseCreateOpcode(client, venue, input, pair, undefined);
  const { spec, aquaVenue, oracle } = await buildStrategySpec(client, venue, choice.opcode, pair, input.params ?? {});
  const strategyKey = deriveStrategyKey({
    strategist,
    chainId: venue.chainId,
    token0: pair.usdc.address,
    token1: pair.fx.address,
    label: spec.label
  }).strategyKey;
  const [classId, live] = await Promise.all([
    readClassId(client, venue, strategyKey),
    isStrategyLive(client, aquaVenue.adapter, spec.strategyId)
  ]);
  const identity = strategyIdentity(venue.chainId, spec, aquaVenue, choice, strategist, strategyKey, classId, live, oracle);
  const warnings: string[] = choice.note ? [choice.note] : [];

  if (classId === 0n) {
    return {
      mode: "prepare",
      ...identity,
      stage: "registerStrategyClass",
      explanation:
        "No strategy class exists for this strategist, pair and label yet. Send registerStrategyClass (permissionless), wait for it to mine, then call create_strategy again: the class id it assigns is needed to encode the vault-leg, commitment and ship payloads. Nothing was executed.",
      transactions: [
        prepareStep("registerStrategyClass", venue.registry, vaultRegistryAbi, "registerStrategyClass", [
          strategyKey
        ])
      ],
      warnings
    };
  }

  const transactions: PreparedStep[] = [];
  for (const token of [pair.usdc, pair.fx]) {
    const current = await readLegStrategist(client, token.vault, classId);
    if (current === ZERO_ADDRESS) {
      transactions.push(
        prepareStep(`registerStrategy (${token.symbol} vault)`, token.vault, assetVaultAbi, "registerStrategy", [
          classId,
          getAddress(strategist)
        ])
      );
    } else if (current !== strategist) {
      throw new Error(`Class ${classId} on the ${token.symbol} vault already belongs to strategist ${current}`);
    }
  }

  const [usdcPosition, fxPosition] = await Promise.all([
    readVaultPosition(client, pair.usdc, strategist, classId),
    readVaultPosition(client, pair.fx, strategist, classId)
  ]);

  let fxFunding = 0n;
  if (!live) {
    const fxBacking = effectiveBacking(fxPosition);
    if (fxBacking < spec.fxShip) {
      const shortfall = spec.fxShip - fxBacking;
      if (!(input.fundFxLeg ?? true) || !pair.fx.openMint) {
        warnings.push(
          `${pair.fx.symbol} backing for class ${classId} is short by ${formatUnits(shortfall, pair.fx.decimals)}; deposit and commit it before shipping`
        );
      } else {
        fxFunding = shortfall;
        const balance = await readTokenBalance(client, pair.fx, strategist);
        if (balance < shortfall) {
          transactions.push(
            prepareStep(
              `mint ${pair.fx.symbol} (open-mint demo token)`,
              pair.fx.address,
              mintableErc20Abi,
              "mint",
              [getAddress(strategist), shortfall - balance]
            )
          );
        }
        transactions.push(
          prepareStep(`approve ${pair.fx.symbol}`, pair.fx.address, mintableErc20Abi, "approve", [
            getAddress(pair.fx.vault),
            shortfall
          ]),
          prepareStep(`deposit ${pair.fx.symbol}`, pair.fx.vault, assetVaultAbi, "deposit", [
            shortfall,
            getAddress(strategist)
          ])
        );
      }
    }
  }

  const legs: Array<[TokenInfo, VaultPosition, boolean]> = [
    [pair.usdc, usdcPosition, false],
    [pair.fx, fxPosition, fxFunding > 0n]
  ];
  for (const [token, position, funded] of legs) {
    if (position.committed) {
      continue;
    }
    if (position.principal === 0n && !funded) {
      warnings.push(
        `${strategist} has no ${token.symbol} principal in ${token.vault}; deposit ${token.symbol} (deposit tool) before committing to class ${classId}`
      );
      continue;
    }
    transactions.push(
      prepareStep(`setCommitment (${token.symbol} vault)`, token.vault, assetVaultAbi, "setCommitment", [
        classId,
        true
      ])
    );
  }

  if (live) {
    return {
      mode: "prepare",
      ...identity,
      stage: "alreadyLive",
      explanation: `The strategy is already live on the ${aquaVenue.name} AquaAdapter; only missing registrations/commitments (if any) are listed. Nothing was executed.`,
      transactions,
      warnings
    };
  }

  if (effectiveBacking(usdcPosition) < spec.usdcShip) {
    warnings.push(
      `USDC backing for class ${classId} is ${formatUnits(effectiveBacking(usdcPosition), pair.usdc.decimals)} USDC, below the ${formatUnits(spec.usdcShip, pair.usdc.decimals)} USDC this strategy ships; deposit USDC first`
    );
  }
  const [nonce, block, readiness] = await Promise.all([
    client.readContract({
      address: getAddress(aquaVenue.adapter),
      abi: aquaAdapterAbi,
      functionName: "strategistNonces",
      args: [getAddress(strategist)]
    }),
    client.getBlock(),
    readVenueReadiness(client, venueTarget(venue, aquaVenue), [pair.usdc, pair.fx])
  ]);
  if (readiness.hint) {
    warnings.push(readiness.hint);
  }
  const strategistCode = await client.getCode({ address: getAddress(strategist) });
  if (strategistCode && strategistCode !== "0x") {
    warnings.push(
      `Strategist ${strategist} has contract code (e.g. an EIP-7702 delegation), so the AquaAdapter verifies the ship signature with ERC-1271 instead of ECDSA; a plain EIP-712 signature from its key will be rejected (NotStrategist).`
    );
  }
  const deadline = block.timestamp + SWAPVM.shipDeadlineSeconds;
  const typedData = buildShipTypedData({
    chainId: venue.chainId,
    adapter: aquaVenue.adapter,
    classId,
    strategyId: spec.strategyId,
    tokens: spec.tokens,
    amounts: spec.amounts,
    feePpb: spec.feePpb,
    nonce,
    deadline
  });

  return {
    mode: "prepare",
    ...identity,
    stage: "configureAndShip",
    explanation:
      "Send the transactions in order. Then the strategist signs shipSignature.typedData (EIP-712, expires in 1 hour) and an operator sends shipCall with that signature in place of the placeholder. Nothing was executed.",
    transactions,
    shipSignature: { signer: strategist, digest: hashTypedData(typedData), typedData: toJsonSafe(typedData) },
    shipCall: {
      to: aquaVenue.adapter,
      functionName: "shipStrategyWithFee",
      args: toJsonSafe([
        classId,
        spec.strategyBytes,
        spec.tokens,
        spec.amounts,
        spec.feePpb,
        nonce,
        deadline,
        "<strategist signature over shipSignature.typedData>"
      ]),
      caller: `must hold OPERATOR_ROLE on the ${aquaVenue.name} AquaAdapter ${aquaVenue.adapter} and be an EOA`
    },
    warnings
  };
}

// ---------------------------------------------------------------------------------------------
// deposit

export type FxDepositInput = {
  token?: string | undefined;
  vault?: string | undefined;
  amount: AmountValue;
  unit?: AmountUnit | undefined;
  receiver?: string | undefined;
};

export async function prepareFxDeposit(config: WriteConfig, input: FxDepositInput) {
  const token = resolveDepositToken(input);
  const amount = requirePositive(
    parseTokenAmount(input.amount, token.decimals, { unit: input.unit, field: "amount" }),
    "amount"
  );
  const receiver = input.receiver ? normalizeAddress(input.receiver) : configuredSignerAddress(config);
  if (!receiver) {
    throw new Error("receiver is required in prepare mode (no WRITE_PRIVATE_KEY signer is configured)");
  }
  return {
    mode: "prepare" as const,
    token: token.symbol,
    vault: token.vault,
    receiver,
    amount: formatTokenAmount(amount, token),
    explanation: `Send from ${receiver}: approve, then deposit. Skip the approve if the vault allowance already covers the amount. Nothing was executed.`,
    transactions: [
      prepareStep(`approve ${token.symbol}`, token.address, mintableErc20Abi, "approve", [
        getAddress(token.vault),
        amount
      ]),
      prepareStep(`deposit ${token.symbol}`, token.vault, assetVaultAbi, "deposit", [
        amount,
        getAddress(receiver)
      ])
    ]
  };
}

export async function executeFxDeposit(config: WriteConfig, input: FxDepositInput) {
  assertExecutionAllowed(config);
  const token = resolveDepositToken(input);
  const amount = requirePositive(
    parseTokenAmount(input.amount, token.decimals, { unit: input.unit, field: "amount" }),
    "amount"
  );
  resolveSwapVMVenue(config);
  const ctx = await createExecContext(config);
  const client = ctx.publicClient;
  const receiver = input.receiver ? normalizeAddress(input.receiver) : ctx.signer;
  const balance = await readTokenBalance(client, token, ctx.signer);
  if (balance < amount) {
    throw new Error(
      `Signer ${ctx.signer} holds ${formatUnits(balance, token.decimals)} ${token.symbol}; depositing ${formatUnits(amount, token.decimals)} needs more`
    );
  }
  await approveIfNeeded(ctx, token, token.vault, amount);
  await sendTransaction(ctx, `deposit ${token.symbol}`, token.vault, () =>
    client.simulateContract({
      account: ctx.account,
      address: getAddress(token.vault),
      abi: assetVaultAbi,
      functionName: "deposit",
      args: [amount, getAddress(receiver)]
    })
  );
  const [principal, freePrincipal] = await Promise.all([
    client.readContract({
      address: getAddress(token.vault),
      abi: assetVaultAbi,
      functionName: "principal",
      args: [getAddress(receiver)]
    }),
    client.readContract({
      address: getAddress(token.vault),
      abi: assetVaultAbi,
      functionName: "freePrincipal",
      args: [getAddress(receiver)]
    })
  ]);
  return {
    mode: "execute" as const,
    chainId: ctx.chainId,
    token: token.symbol,
    vault: token.vault,
    receiver,
    amount: formatTokenAmount(amount, token),
    steps: ctx.steps,
    position: {
      principal: formatTokenAmount(principal, token),
      freePrincipal: formatTokenAmount(freePrincipal, token)
    }
  };
}

// ---------------------------------------------------------------------------------------------
// quote / swap

export type FxSwapInput = {
  pair?: string | undefined;
  strategyId?: string | undefined;
  /** "fxswap" or "pegged" to pick the venue; default tries FXSwap first when configured, then pegged. */
  opcode?: string | undefined;
  /** Same params used at creation; defaults reproduce the default strategy. */
  params?: StrategyParamsInput | undefined;
  /** Token you pay; defaults to USDC. */
  tokenIn?: string | undefined;
  amount: AmountValue;
  unit?: AmountUnit | undefined;
  taker?: string | undefined;
  minAmountOut?: AmountValue | undefined;
  slippageBps?: number | undefined;
};

type LiveStrategy = {
  pair: FxPair;
  strategyId: Hex;
  order: SwapVMOrder;
  classId: bigint;
  feePpb: number;
  resolvedBy: "pair-params" | "aqua-shipped-event";
  venue: AquaVenue;
  instructions: DecodedInstruction[];
};

export async function quoteFxSwap(config: WriteConfig, input: FxSwapInput) {
  const venue = resolveSwapVMVenue(config);
  const client = createReadClient(config);
  const taker = input.taker ? normalizeAddress(input.taker) : configuredSignerAddress(config);
  const strategy = await resolveLiveStrategy(client, venue, input, taker);
  const { tokenIn, tokenOut } = resolveSwapDirection(strategy.pair, input.tokenIn);
  const amountIn = requirePositive(
    parseTokenAmount(input.amount, tokenIn.decimals, { unit: input.unit, field: "amount" }),
    "amount"
  );
  const blockNumber = await client.getBlockNumber();
  const reference = await readReferencePrice(client, strategy, blockNumber);
  let amountOut: bigint;
  try {
    amountOut = await quoteOnRouter(client, strategy, tokenIn, tokenOut, amountIn, taker, blockNumber);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(reference?.warning ? `${message}. ${reference.warning}` : message);
  }
  return {
    source: `${routerContractName(strategy.venue)}.quote via eth_call at block ${blockNumber} (read-only; nothing is sent)`,
    chainId: venue.chainId,
    blockNumber: blockNumber.toString(),
    router: strategy.venue.router,
    ...strategyReference(strategy),
    amountIn: formatTokenAmount(amountIn, tokenIn),
    amountOut: formatTokenAmount(amountOut, tokenOut),
    rate: formatRate(amountIn, tokenIn, amountOut, tokenOut),
    pricing: pricingSummary(strategy.pair, tokenIn, amountIn, tokenOut, amountOut, reference),
    ...(reference?.oracle ? { oracle: reference.oracle } : {}),
    ...(reference?.warning ? { warnings: [reference.warning] } : {})
  };
}

export async function prepareFxSwap(config: WriteConfig, input: FxSwapInput) {
  const venue = resolveSwapVMVenue(config);
  const client = createReadClient(config);
  const taker = input.taker ? normalizeAddress(input.taker) : configuredSignerAddress(config);
  if (!taker) {
    throw new Error("taker is required in prepare mode (no WRITE_PRIVATE_KEY signer is configured)");
  }
  const strategy = await resolveLiveStrategy(client, venue, input, taker);
  const { tokenIn, tokenOut } = resolveSwapDirection(strategy.pair, input.tokenIn);
  const amountIn = requirePositive(
    parseTokenAmount(input.amount, tokenIn.decimals, { unit: input.unit, field: "amount" }),
    "amount"
  );
  const warnings: string[] = [];
  const blockNumber = await client.getBlockNumber();
  const reference = await readReferencePrice(client, strategy, blockNumber).catch((error: unknown) => {
    warnings.push(error instanceof Error ? error.message : String(error));
    return undefined;
  });
  if (reference?.warning) {
    warnings.push(reference.warning);
  }
  let quoted: bigint | undefined;
  try {
    quoted = await quoteOnRouter(client, strategy, tokenIn, tokenOut, amountIn, taker, blockNumber);
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }
  const minAmountOut = resolveMinAmountOut(input, tokenOut, quoted);
  if (minAmountOut === undefined) {
    warnings.push("No quote was available, so the prepared swap has no minimum-output protection");
  }
  return {
    mode: "prepare" as const,
    chainId: venue.chainId,
    router: strategy.venue.router,
    ...strategyReference(strategy),
    taker,
    amountIn: formatTokenAmount(amountIn, tokenIn),
    quotedAmountOut: quoted === undefined ? null : formatTokenAmount(quoted, tokenOut),
    minAmountOut: minAmountOut === undefined ? null : formatTokenAmount(minAmountOut, tokenOut),
    ...(quoted === undefined
      ? {}
      : { pricing: pricingSummary(strategy.pair, tokenIn, amountIn, tokenOut, quoted, reference) }),
    ...(reference?.oracle ? { oracle: reference.oracle } : {}),
    explanation: `Send from ${taker}: approve the ${routerContractName(strategy.venue)}, then swap. Skip the approve if the router allowance already covers the amount. Nothing was executed.`,
    transactions: [
      prepareStep(`approve ${tokenIn.symbol}`, tokenIn.address, mintableErc20Abi, "approve", [
        getAddress(strategy.venue.router),
        amountIn
      ]),
      prepareStep(
        `swap ${tokenIn.symbol} -> ${tokenOut.symbol}`,
        strategy.venue.router,
        aquaSwapVMRouterAbi,
        "swap",
        [
          strategy.order,
          getAddress(tokenIn.address),
          getAddress(tokenOut.address),
          amountIn,
          buildTakerTraitsAndData(minAmountOut)
        ]
      )
    ],
    warnings
  };
}

export async function executeFxSwap(config: WriteConfig, input: FxSwapInput) {
  assertExecutionAllowed(config);
  const venue = resolveSwapVMVenue(config);
  const ctx = await createExecContext(config);
  const client = ctx.publicClient;
  if (input.taker && normalizeAddress(input.taker) !== ctx.signer) {
    throw new Error(`In execute mode the taker is the configured signer ${ctx.signer}; got ${input.taker}`);
  }
  const strategy = await resolveLiveStrategy(client, venue, input, ctx.signer);
  const { tokenIn, tokenOut } = resolveSwapDirection(strategy.pair, input.tokenIn);
  const amountIn = requirePositive(
    parseTokenAmount(input.amount, tokenIn.decimals, { unit: input.unit, field: "amount" }),
    "amount"
  );
  const balance = await readTokenBalance(client, tokenIn, ctx.signer);
  if (balance < amountIn) {
    throw new Error(
      `Signer ${ctx.signer} holds ${formatUnits(balance, tokenIn.decimals)} ${tokenIn.symbol}; swapping ${formatUnits(amountIn, tokenIn.decimals)} needs more`
    );
  }
  const blockNumber = await client.getBlockNumber();
  const reference = await readReferencePrice(client, strategy, blockNumber);
  let quoted: bigint;
  try {
    quoted = await quoteOnRouter(client, strategy, tokenIn, tokenOut, amountIn, ctx.signer, blockNumber);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(reference?.warning ? `${message}. ${reference.warning}` : message);
  }
  const minAmountOut = resolveMinAmountOut(input, tokenOut, quoted) ?? 0n;
  await approveIfNeeded(ctx, tokenIn, strategy.venue.router, amountIn);
  const before = await readTokenBalance(client, tokenOut, ctx.signer);
  await sendTransaction(
    ctx,
    `swap ${tokenIn.symbol} -> ${tokenOut.symbol}`,
    strategy.venue.router,
    () =>
      client.simulateContract({
        account: ctx.account,
        address: getAddress(strategy.venue.router),
        abi: aquaSwapVMRouterAbi,
        functionName: "swap",
        args: [
          strategy.order,
          getAddress(tokenIn.address),
          getAddress(tokenOut.address),
          amountIn,
          buildTakerTraitsAndData(minAmountOut)
        ]
      }),
    async () =>
      (await readVenueReadiness(client, venueTarget(venue, strategy.venue), [strategy.pair.usdc, strategy.pair.fx]))
        .hint
  );
  const received = (await readTokenBalance(client, tokenOut, ctx.signer)) - before;
  return {
    mode: "execute" as const,
    chainId: ctx.chainId,
    router: strategy.venue.router,
    ...strategyReference(strategy),
    taker: ctx.signer,
    amountIn: formatTokenAmount(amountIn, tokenIn),
    quotedAmountOut: formatTokenAmount(quoted, tokenOut),
    minAmountOut: formatTokenAmount(minAmountOut, tokenOut),
    received: formatTokenAmount(received, tokenOut),
    rate: formatRate(amountIn, tokenIn, received, tokenOut),
    pricing: pricingSummary(strategy.pair, tokenIn, amountIn, tokenOut, received, reference),
    ...(reference?.oracle ? { oracle: reference.oracle } : {}),
    steps: ctx.steps
  };
}

// ---------------------------------------------------------------------------------------------
// shared backing read

export type SharedBackingInput = {
  address?: string | undefined;
  /** Params of non-default strategies to recognise (Aqua Shipped events find the rest). */
  params?: StrategyParamsInput | undefined;
  /** How many of the newest class ids to scan (default 256). */
  maxClassScan?: number | undefined;
};

export async function readSharedBacking(config: WriteConfig, input: SharedBackingInput = {}) {
  const venue = resolveSwapVMVenue(config);
  const client = createReadClient(config);
  const lp = input.address ? normalizeAddress(input.address) : configuredSignerAddress(config);
  if (!lp) {
    throw new Error("address is required (no WRITE_PRIVATE_KEY signer is configured to default to)");
  }
  const aquaVenues = listVenues(venue);
  const usdc = resolveToken("USDC");
  const fxTokens = ARC_TOKENS.filter((token) => token.symbol !== "USDC");
  const vaultTokens = [usdc, ...fxTokens];
  const [blockNumber, lastClassId, usdcPrincipal, usdcFreePrincipal] = await Promise.all([
    client.getBlockNumber(),
    client.readContract({
      address: getAddress(venue.registry),
      abi: vaultRegistryAbi,
      functionName: "lastClassId"
    }),
    client.readContract({
      address: getAddress(usdc.vault),
      abi: assetVaultAbi,
      functionName: "principal",
      args: [getAddress(lp)]
    }),
    client.readContract({
      address: getAddress(usdc.vault),
      abi: assetVaultAbi,
      functionName: "freePrincipal",
      args: [getAddress(lp)]
    })
  ]);

  const scanLimit = BigInt(Math.max(1, Math.min(Math.trunc(input.maxClassScan ?? 256), 2_000)));
  const classIds: bigint[] = [];
  for (let id = lastClassId > scanLimit ? lastClassId - scanLimit + 1n : 1n; id <= lastClassId; id += 1n) {
    classIds.push(id);
  }
  const commitmentRows = await mapInChunks(classIds, 16, async (classId) => ({
    classId,
    committed: await Promise.all(
      vaultTokens.map((token) =>
        client.readContract({
          address: getAddress(token.vault),
          abi: assetVaultAbi,
          functionName: "committed",
          args: [getAddress(lp), classId]
        })
      )
    )
  }));
  const relevant = commitmentRows.filter((row) => row.committed.some(Boolean));

  const shipped =
    relevant.length > 0
      ? await scanShippedStrategies(client, venue, aquaVenues.map((item) => item.adapter))
      : { strategies: [] };
  const shippedClassIds = await mapInChunks(shipped.strategies, 16, async (strategy) => {
    const aquaVenue = aquaVenues.find((item) => item.adapter === strategy.maker);
    return {
      ...strategy,
      venue: aquaVenue,
      classId: aquaVenue
        ? await client.readContract({
            address: getAddress(aquaVenue.adapter),
            abi: aquaAdapterAbi,
            functionName: "strategyClassId",
            args: [strategy.strategyId]
          })
        : 0n
    };
  });

  const classes = await mapInChunks(relevant, 4, async ({ classId, committed }) => {
    const [usdcStrategist, usdcBacking, usdcAvailable] = await Promise.all([
      readLegStrategist(client, usdc.vault, classId),
      readVaultUint(client, usdc.vault, "committedBacking", classId),
      readVaultUint(client, usdc.vault, "availableFor", classId)
    ]);
    const fxLegs = await Promise.all(
      fxTokens.map(async (token, index) => ({
        token,
        strategist: await readLegStrategist(client, token.vault, classId),
        lpCommitted: committed[index + 1] ?? false
      }))
    );
    const fxLeg = fxLegs.find((leg) => leg.strategist !== ZERO_ADDRESS || leg.lpCommitted);
    const pair: FxPair | undefined = fxLeg
      ? { name: `USDC/${fxLeg.token.fiat}`, usdc, fx: fxLeg.token }
      : undefined;
    const fxVault = fxLeg
      ? await (async () => {
          const [backing, available, principal] = await Promise.all([
            readVaultUint(client, fxLeg.token.vault, "committedBacking", classId),
            readVaultUint(client, fxLeg.token.vault, "availableFor", classId),
            client.readContract({
              address: getAddress(fxLeg.token.vault),
              abi: assetVaultAbi,
              functionName: "principal",
              args: [getAddress(lp)]
            })
          ]);
          return {
            token: fxLeg.token.symbol,
            vault: fxLeg.token.vault,
            lpCommitted: fxLeg.lpCommitted,
            lpPrincipal: formatTokenAmount(principal, fxLeg.token),
            classCommittedBacking: formatTokenAmount(backing, fxLeg.token),
            classAvailableFor: formatTokenAmount(available, fxLeg.token)
          };
        })()
      : null;

    const candidates = new Map<Hex, { venue: AquaVenue; order?: SwapVMOrder }>();
    for (const row of shippedClassIds) {
      if (row.venue && row.classId === classId) {
        candidates.set(row.strategyId, { venue: row.venue, order: row.order });
      }
    }
    if (pair) {
      for (const aquaVenue of aquaVenues) {
        const spec = specForRecognition(venue, aquaVenue, pair, input.params ?? {});
        if (spec && !candidates.has(spec.strategyId)) {
          candidates.set(spec.strategyId, { venue: aquaVenue, order: spec.order });
        }
      }
    }
    const strategies = (
      await Promise.all(
        [...candidates].map(async ([strategyId, candidate]) => {
          const adapter = getAddress(candidate.venue.adapter);
          const [strategyClassId, aquaHash, feePpb] = await Promise.all([
            client.readContract({ address: adapter, abi: aquaAdapterAbi, functionName: "strategyClassId", args: [strategyId] }),
            client.readContract({ address: adapter, abi: aquaAdapterAbi, functionName: "currentAquaHash", args: [strategyId] }),
            client.readContract({ address: adapter, abi: aquaAdapterAbi, functionName: "strategyFeePpb", args: [strategyId] })
          ]);
          if (strategyClassId !== classId) {
            return undefined;
          }
          const amounts = pair
            ? await Promise.all(
                [pair.usdc, pair.fx].map((token) =>
                  client.readContract({
                    address: adapter,
                    abi: aquaAdapterAbi,
                    functionName: "strategyAmount",
                    args: [strategyId, getAddress(token.address)]
                  })
                )
              )
            : undefined;
          return {
            strategyId,
            opcode: candidate.venue.opcode,
            venue: candidate.venue.name,
            adapter: candidate.venue.adapter,
            router: candidate.venue.router,
            live: BigInt(aquaHash) !== 0n,
            feePpb,
            ...(candidate.order ? { instructions: summarizeProgram(candidate.order.data) } : {}),
            ...(pair && amounts
              ? {
                  strategyAmounts: {
                    usdc: formatTokenAmount(amounts[0] ?? 0n, pair.usdc),
                    fx: formatTokenAmount(amounts[1] ?? 0n, pair.fx)
                  }
                }
              : {})
          };
        })
      )
    ).filter((strategy) => strategy !== undefined);

    return {
      classId: classId.toString(),
      pair: pair?.name ?? null,
      strategist: usdcStrategist !== ZERO_ADDRESS ? usdcStrategist : (fxLeg?.strategist ?? null),
      lpCommittedUsdc: committed[0] ?? false,
      usdcVault: {
        classCommittedBacking: formatTokenAmount(usdcBacking, usdc),
        classAvailableFor: formatTokenAmount(usdcAvailable, usdc)
      },
      fxVault,
      strategies
    };
  });

  const backed = classes.filter((item) => item.lpCommittedUsdc);
  const principalText = `${formatUnits(usdcPrincipal, usdc.decimals)} USDC`;
  const describeClass = (item: (typeof backed)[number]) => {
    const opcodes = [...new Set(item.strategies.filter((strategy) => strategy.live).map((strategy) => strategy.opcode))];
    return `class ${item.classId} ${item.pair ?? "unknown pair"}${opcodes.length > 0 ? ` (${opcodes.join("+")})` : ""}`;
  };
  return {
    source: "rpc",
    sourceNote: `Direct on-chain reads (VaultRegistry, AssetVault, the ${aquaVenues.map((item) => item.name).join(" and ")} AquaAdapters, Aqua Shipped events). Graph indexing for the Aqua adapters is being added separately.`,
    chainId: venue.chainId,
    blockNumber: blockNumber.toString(),
    lp,
    venues: aquaVenues.map((item) => ({ opcode: item.opcode, name: item.name, adapter: item.adapter, router: item.router })),
    usdc: {
      vault: usdc.vault,
      principal: formatTokenAmount(usdcPrincipal, usdc),
      freePrincipal: formatTokenAmount(usdcFreePrincipal, usdc)
    },
    classes,
    summary: {
      usdcPrincipalCountedOnce: formatTokenAmount(usdcPrincipal, usdc),
      classesBackedByThatUsdc: backed.map((item) => ({
        classId: item.classId,
        pair: item.pair,
        classCommittedBacking: item.usdcVault.classCommittedBacking.formatted,
        liveStrategies: item.strategies.filter((strategy) => strategy.live).length,
        liveOpcodes: [
          ...new Set(item.strategies.filter((strategy) => strategy.live).map((strategy) => strategy.opcode))
        ]
      })),
      sharedBacking: backed.length >= 2,
      explanation:
        backed.length >= 2
          ? `The same ${principalText} principal is committed to ${backed.length} strategy classes at once (${backed
              .map(describeClass)
              .join(", ")}). Each class counts it as committed backing: the deposit is shared, not split.`
          : backed.length === 1
            ? `${principalText} principal is committed to one strategy class (${backed[0] ? describeClass(backed[0]) : "unknown"}).`
            : "This address has no USDC committed to any strategy class yet."
    },
    ...(shipped.error ? { warnings: [`Aqua Shipped event scan incomplete: ${shipped.error}`] } : {})
  };
}

// ---------------------------------------------------------------------------------------------
// FX feeds: read and (owner only) set

export type FxPricesInput = { pair?: string | undefined };

export async function readFxPrices(config: WriteConfig, input: FxPricesInput = {}) {
  const venue = resolveSwapVMVenue(config);
  const client = createReadClient(config);
  const pairs = input.pair
    ? [resolvePair(input.pair)]
    : ARC_TOKENS.filter((token) => token.symbol !== "USDC").map((token) => resolvePair(token.symbol));
  const block = await client.getBlock();
  const feeds = await Promise.all(
    pairs.map(async (pair) => {
      const feed = venue.fxswap?.oracles[pair.fx.symbol];
      if (!feed) {
        return {
          pair: pair.name,
          configured: false,
          note: `No ${pair.fx.fiat}/USD feed configured; set ${FEED_ENV[pair.fx.symbol] ?? "the feed env var"}`
        };
      }
      const reading = await readFxOracle(client, feed, pair, block.number);
      const reference = FXSWAP_REFERENCE_PRICE_WAD[pair.fx.symbol];
      return {
        configured: true,
        ...describeOracle(reading),
        ...(reference === undefined
          ? {}
          : {
              defaultStrategyBand: {
                min: `${formatWad(reference / 2n)} ${pair.fx.fiat} per 1 USD`,
                max: `${formatWad(reference * 2n)} ${pair.fx.fiat} per 1 USD`,
                inBand: reading.feedPriceWad >= reference / 2n && reading.feedPriceWad <= reference * 2n
              }
            }),
        whoCanSet: reading.owner
          ? `only the feed owner ${reading.owner} (set_fx_price)`
          : "unknown (the feed has no owner())"
      };
    })
  );
  return {
    source: "rpc",
    chainId: venue.chainId,
    blockNumber: block.number.toString(),
    blockTimestamp: block.timestamp.toString(),
    fxswapVenue: venue.fxswap
      ? { router: venue.fxswap.router, adapter: venue.fxswap.adapter }
      : null,
    feeds,
    risk: FX_FEED_RISK
  };
}

export type SetFxPriceInput = {
  pair?: string | undefined;
  /** Feed address; must be one of the configured FXSwap feeds. Alternative to pair. */
  feed?: string | undefined;
  /** New absolute price, FX units per 1 USD (e.g. 5.6 for BRL). */
  price?: AmountValue | undefined;
  /** Relative move in percent, e.g. 5 (up 5%) or "-2.5". */
  changePercent?: AmountValue | undefined;
};

export async function prepareSetFxPrice(config: WriteConfig, input: SetFxPriceInput) {
  const venue = resolveSwapVMVenue(config);
  const client = createReadClient(config);
  const { pair, feed } = resolveFeedTarget(venue, input);
  const reading = await readFxOracle(client, feed, pair);
  const newAnswer = computeNewAnswer(reading, input);
  const signer = configuredSignerAddress(config);
  const warnings = feedMoveWarnings(pair, reading, newAnswer);
  if (reading.owner && signer && signer !== reading.owner) {
    warnings.push(`The configured signer ${signer} is not the feed owner ${reading.owner}; only the owner can send this.`);
  }
  return {
    mode: "prepare" as const,
    chainId: venue.chainId,
    pair: pair.name,
    feed,
    owner: reading.owner,
    current: describeOracle(reading),
    newPrice: `${formatUnits(newAnswer, reading.decimals)} ${pair.fx.fiat} per 1 USD`,
    newAnswer: newAnswer.toString(),
    change: formatChange(reading.answer, newAnswer),
    explanation: `Send from the feed owner ${reading.owner ?? "(unknown)"}: ManualFxOracle.setAnswer. Nothing was executed.`,
    transactions: [prepareStep("setAnswer", feed, manualFxOracleAbi, "setAnswer", [newAnswer])],
    warnings,
    risk: FX_FEED_RISK
  };
}

export async function executeSetFxPrice(config: WriteConfig, input: SetFxPriceInput) {
  assertExecutionAllowed(config);
  const venue = resolveSwapVMVenue(config);
  const { pair, feed } = resolveFeedTarget(venue, input);
  const ctx = await createExecContext(config);
  const client = ctx.publicClient;
  const before = await readFxOracle(client, feed, pair);
  const newAnswer = computeNewAnswer(before, input);
  if (!before.owner) {
    throw new Error(`The ${pair.fx.fiat}/USD feed ${feed} has no owner(); it is not a settable ManualFxOracle. Nothing was sent.`);
  }
  if (before.owner !== ctx.signer) {
    throw new Error(
      `Signer ${ctx.signer} is not the owner of the ${pair.fx.fiat}/USD feed ${feed}: only ${before.owner} can set its price. Nothing was sent.`
    );
  }
  const warnings = feedMoveWarnings(pair, before, newAnswer);
  await sendTransaction(ctx, `setAnswer (${pair.fx.fiat}/USD feed)`, feed, () =>
    client.simulateContract({
      account: ctx.account,
      address: getAddress(feed),
      abi: manualFxOracleAbi,
      functionName: "setAnswer",
      args: [newAnswer]
    })
  );
  const after = await readFxOracle(client, feed, pair);
  return {
    mode: "execute" as const,
    chainId: ctx.chainId,
    pair: pair.name,
    feed,
    owner: before.owner,
    before: describeOracle(before),
    after: describeOracle(after),
    change: formatChange(before.answer, after.answer),
    steps: ctx.steps,
    next: `FXSwap strategies reading this feed now price ${pair.name} at ${formatWad(after.feedPriceWad)} ${pair.fx.fiat} per USD on their next quote or swap; pegged strategies do not move.`,
    ...(warnings.length > 0 ? { warnings } : {}),
    risk: FX_FEED_RISK
  };
}

// ---------------------------------------------------------------------------------------------
// venue readiness

export type VenueReadiness = {
  ready: boolean;
  adapterAllowed: boolean;
  vaultsMissingVenueSettlerRole: Lowercase<string>[];
  /** Whether adapter.aquaSwapVMRouter() is the router this venue quotes and swaps on (when a router is given). */
  routerMatches?: boolean;
  operator?: { address: Lowercase<string>; hasOperatorRole: boolean };
  hint?: string;
  operatorHint?: string;
};

export async function readVenueReadiness(
  client: ReadClient,
  venue: { registry: string; adapter: string; router?: string | undefined },
  tokens: readonly TokenInfo[],
  operator?: string
): Promise<VenueReadiness> {
  const adapter = normalizeAddress(venue.adapter);
  const [adapterAllowed, roles, boundRouter, operatorRole] = await Promise.all([
    client.readContract({
      address: getAddress(venue.registry),
      abi: vaultRegistryAbi,
      functionName: "isAllowedAdapter",
      args: [getAddress(adapter)]
    }),
    Promise.all(
      tokens.map((token) =>
        client.readContract({
          address: getAddress(token.vault),
          abi: assetVaultAbi,
          functionName: "hasRole",
          args: [VENUE_SETTLER_ROLE, getAddress(adapter)]
        })
      )
    ),
    venue.router
      ? client
          .readContract({ address: getAddress(adapter), abi: aquaAdapterAbi, functionName: "aquaSwapVMRouter" })
          .then((value) => normalizeAddress(value))
          .catch(() => undefined)
      : Promise.resolve(undefined),
    operator
      ? client.readContract({
          address: getAddress(adapter),
          abi: aquaAdapterAbi,
          functionName: "hasRole",
          args: [OPERATOR_ROLE, getAddress(operator)]
        })
      : Promise.resolve(undefined)
  ]);
  const missing = tokens.filter((_, index) => !roles[index]).map((token) => token.vault);
  const routerMatches =
    venue.router && boundRouter !== undefined ? boundRouter === normalizeAddress(venue.router) : undefined;
  const ready = adapterAllowed && missing.length === 0 && routerMatches !== false;
  const result: VenueReadiness = {
    ready,
    adapterAllowed,
    vaultsMissingVenueSettlerRole: missing,
    ...(routerMatches === undefined ? {} : { routerMatches }),
    ...(operator && operatorRole !== undefined
      ? { operator: { address: normalizeAddress(operator), hasOperatorRole: operatorRole } }
      : {})
  };
  if (operator && operatorRole === false) {
    result.operatorHint = `Signer ${normalizeAddress(operator)} lacks OPERATOR_ROLE on AquaAdapter ${adapter}; the adapter admin must grantRole(${OPERATOR_ROLE}, ${normalizeAddress(operator)}).`;
  }
  if (ready) {
    return result;
  }
  if (routerMatches === false) {
    result.hint = `AquaAdapter ${adapter} is bound to router ${boundRouter}, not ${normalizeAddress(venue.router ?? "")}; the adapter and router env vars point at different venues.`;
    return result;
  }
  const actions = [
    ...(adapterAllowed ? [] : [`VaultRegistry.setAdapterAllowed(${adapter}, true)`]),
    ...(missing.length > 0
      ? [`grantRole(VENUE_SETTLER_ROLE, ${adapter}) on vault(s) ${missing.join(", ")}`]
      : [])
  ];
  result.hint = `AquaAdapter ${adapter} is not wired into Aqua0 core yet: the core admin must send ${actions.join(" and ")}. Ships and swaps revert until then.`;
  return result;
}

// ---------------------------------------------------------------------------------------------
// internals

type ExecContext = {
  chainId: number;
  publicClient: ExecutionClients["publicClient"];
  wallet: ExecutionClients["wallet"];
  account: PrivateKeyAccount;
  signer: Lowercase<string>;
  steps: StrategyStep[];
};

type VaultPosition = {
  principal: bigint;
  committed: boolean;
  availableFor: bigint;
  committedBacking: bigint;
};

type FxOracleReading = {
  feed: Lowercase<string>;
  pair: FxPair;
  description: string | null;
  decimals: number;
  roundId: bigint;
  answer: bigint;
  /** Feed answer scaled to 18 decimals, in the feed's orientation (FX units per 1 USD for Aqua0 feeds). */
  feedPriceWad: bigint;
  updatedAt: bigint;
  blockNumber: bigint;
  blockTimestamp: bigint;
  owner: Lowercase<string> | null;
};

type ReferencePrice = {
  source: "oracle" | "pegged-program";
  /** Whole FX units per 1 whole USDC, WAD. */
  fxPerUsdcWad: bigint;
  oracle?: ReturnType<typeof describeOracle>;
  warning?: string;
};

async function createExecContext(config: WriteConfig): Promise<ExecContext> {
  assertExecutionAllowed(config);
  const { publicClient, wallet } = await createExecutionClients(config);
  const account = privateKeyToAccount(normalizePrivateKey(config.writePrivateKey));
  return {
    chainId: requireWriteChainId(config),
    publicClient,
    wallet,
    account,
    signer: normalizeAddress(account.address),
    steps: []
  };
}

/** Simulate first (decoded custom-error messages), then send and wait for a successful receipt. */
async function sendTransaction(
  ctx: ExecContext,
  stage: string,
  to: string,
  simulate: () => Promise<{ request: unknown }>,
  hint?: () => Promise<string | undefined>
): Promise<Hex> {
  let request: unknown;
  try {
    ({ request } = await simulate());
  } catch (error) {
    const extra = hint ? await hint().catch(() => undefined) : undefined;
    throw new Error(`${stage} would revert: ${describeContractError(error)}${extra ? `. ${extra}` : ""}`);
  }
  const hash = await ctx.wallet.writeContract(request as never);
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  assertReceiptSuccess(receipt, stage, hash);
  ctx.steps.push({
    stage,
    status: "sent",
    to: normalizeAddress(to),
    hash,
    blockNumber: receipt.blockNumber.toString()
  });
  return hash;
}

function skipStep(ctx: ExecContext, stage: string, note: string): void {
  ctx.steps.push({ stage, status: "skipped", note });
}

function prepareStep(
  stage: string,
  to: string,
  abi: unknown,
  functionName: string,
  args: readonly unknown[]
): PreparedStep {
  return {
    stage,
    to: normalizeAddress(to),
    value: "0",
    functionName,
    args: toJsonSafe(args) as unknown[],
    data: encodeFunctionData({ abi, functionName, args } as never)
  };
}

function listVenues(venue: SwapVMVenue): AquaVenue[] {
  return venue.fxswap ? [venue.fxswap, venue.pegged] : [venue.pegged];
}

function venueTarget(venue: SwapVMVenue, aquaVenue: AquaVenue) {
  return { registry: venue.registry, adapter: aquaVenue.adapter, router: aquaVenue.router };
}

function routerContractName(aquaVenue: AquaVenue): string {
  return aquaVenue.opcode === "fxswap" ? "AquaFXSwapVMRouter" : "AquaSwapVMRouter";
}

function requireFxSwapFeed(venue: SwapVMVenue, pair: FxPair): { fxVenue: FxSwapVenue; feed: Lowercase<string> } {
  if (!venue.fxswap) {
    throw new Error(
      'FXSwap venue not configured: set FXSWAP_ROUTER_ADDRESS and FXSWAP_AQUA_ADAPTER_ADDRESS. Meanwhile use opcode "pegged".'
    );
  }
  const feed = venue.fxswap.oracles[pair.fx.symbol];
  if (!feed) {
    throw new Error(
      `No ${pair.fx.fiat}/USD feed configured for FXSwap ${pair.name}: set ${FEED_ENV[pair.fx.symbol] ?? "its feed env var"}`
    );
  }
  return { fxVenue: venue.fxswap, feed };
}

/**
 * Explicit opcode, then opcode-specific params, then the default: FXSwap when its venue is configured, has a feed
 * for the pair, is wired into Aqua0 core and (in execute mode) the signer may ship on it; otherwise the pegged
 * venue, with a note saying why.
 */
async function chooseCreateOpcode(
  client: ReadClient,
  venue: SwapVMVenue,
  input: Pick<CreateFxStrategyInput, "opcode" | "params">,
  pair: FxPair,
  signer: Lowercase<string> | undefined
): Promise<OpcodeChoice> {
  const explicit = parseStrategyOpcode(input.opcode);
  if (explicit) {
    if (explicit === "fxswap") {
      requireFxSwapFeed(venue, pair);
    }
    return { opcode: explicit, source: "explicit" };
  }
  const inferred = inferOpcodeFromParams(input.params);
  if (inferred) {
    if (inferred === "fxswap") {
      requireFxSwapFeed(venue, pair);
    }
    return { opcode: inferred, source: "params" };
  }
  if (!venue.fxswap) {
    return { opcode: "pegged", source: "default", note: "FXSwap venue not configured; used the pegged (fixed-price) venue." };
  }
  const fallback = (reason: string): OpcodeChoice => ({
    opcode: "pegged",
    source: "fallback",
    note: `FXSwap is the default opcode, but ${reason} So this used the pegged (fixed-price) venue; pass opcode "fxswap" to insist once that is fixed.`
  });
  if (!venue.fxswap.oracles[pair.fx.symbol]) {
    return fallback(`no ${pair.fx.fiat}/USD feed is configured (${FEED_ENV[pair.fx.symbol] ?? "feed env var"}).`);
  }
  const readiness = await readVenueReadiness(client, venueTarget(venue, venue.fxswap), [pair.usdc, pair.fx], signer);
  if (readiness.hint) {
    return fallback(readiness.hint);
  }
  if (readiness.operatorHint) {
    return fallback(readiness.operatorHint);
  }
  return { opcode: "fxswap", source: "default" };
}

async function buildStrategySpec(
  client: ReadClient,
  venue: SwapVMVenue,
  opcode: StrategyOpcode,
  pair: FxPair,
  params: StrategyParamsInput
): Promise<{ spec: StrategySpec; aquaVenue: AquaVenue; oracle?: FxOracleReading }> {
  if (opcode === "pegged") {
    return { spec: buildPeggedStrategySpec(venue.pegged.adapter, pair, params), aquaVenue: venue.pegged };
  }
  const { fxVenue, feed } = requireFxSwapFeed(venue, pair);
  const oracle = await readFxOracle(client, feed, pair);
  if (oracle.answer <= 0n) {
    throw new Error(`The ${pair.fx.fiat}/USD feed ${feed} reports a non-positive answer (${oracle.answer})`);
  }
  const spec = buildFxSwapStrategySpec(fxVenue.adapter, pair, feed, params, { oraclePriceWad: oracle.feedPriceWad });
  if (oracle.feedPriceWad < spec.band.minPrice || oracle.feedPriceWad > spec.band.maxPrice) {
    throw new Error(
      `The ${pair.fx.fiat}/USD feed is at ${formatWad(oracle.feedPriceWad)}, outside this strategy's price band ${formatWad(spec.band.minPrice)}..${formatWad(spec.band.maxPrice)}: every swap would revert (FXSwapOraclePriceOutOfBand). Adjust minPrice/maxPrice or use bandPercent.`
    );
  }
  return { spec, aquaVenue: fxVenue, oracle };
}

/** Best-effort spec used to recognise a strategy from params (no RPC; FXSwap amounts use the reference price). */
function specForRecognition(
  venue: SwapVMVenue,
  aquaVenue: AquaVenue,
  pair: FxPair,
  params: StrategyParamsInput
): StrategySpec | undefined {
  try {
    if (aquaVenue.opcode === "pegged") {
      return buildPeggedStrategySpec(aquaVenue.adapter, pair, params);
    }
    const feed = venue.fxswap?.oracles[pair.fx.symbol];
    if (!feed || params.bandPercent !== undefined) {
      return undefined;
    }
    return buildFxSwapStrategySpec(aquaVenue.adapter, pair, feed, params, {
      oraclePriceWad: FXSWAP_REFERENCE_PRICE_WAD[pair.fx.symbol] ?? WAD
    });
  } catch {
    return undefined;
  }
}

/** Params that do not change the program bytes, so a strategy may be found by event scan instead. */
function paramsPinProgram(opcode: StrategyOpcode, params: StrategyParamsInput | undefined): boolean {
  const free =
    opcode === "fxswap"
      ? ["label", "amountUnit", "usdcAmount", "fxAmount", "bandPercent"]
      : ["label", "amountUnit"];
  return Object.entries(params ?? {}).some(([key, value]) => value !== undefined && !free.includes(key));
}

async function ensureFxBacking(
  ctx: ExecContext,
  spec: StrategySpec,
  classId: bigint,
  fund: boolean
): Promise<void> {
  const client = ctx.publicClient;
  const fx = spec.pair.fx;
  const stage = `fund ${fx.symbol} leg`;
  const position = await readVaultPosition(client, fx, ctx.signer, classId);
  const backing = effectiveBacking(position);
  if (backing >= spec.fxShip) {
    skipStep(ctx, stage, `${formatUnits(backing, fx.decimals)} ${fx.symbol} backing already available to class ${classId}`);
    return;
  }
  const shortfall = spec.fxShip - backing;
  if (!fund || !fx.openMint) {
    throw new Error(
      `${fx.symbol} backing for class ${classId} is ${formatUnits(backing, fx.decimals)} but the strategy ships ${formatUnits(spec.fxShip, fx.decimals)}; deposit and commit ${formatUnits(shortfall, fx.decimals)} ${fx.symbol} into ${fx.vault} first`
    );
  }
  const balance = await readTokenBalance(client, fx, ctx.signer);
  if (balance < shortfall) {
    await sendTransaction(ctx, `mint ${fx.symbol} (open-mint demo token)`, fx.address, () =>
      client.simulateContract({
        account: ctx.account,
        address: getAddress(fx.address),
        abi: mintableErc20Abi,
        functionName: "mint",
        args: [getAddress(ctx.signer), shortfall - balance]
      })
    );
  }
  await approveIfNeeded(ctx, fx, fx.vault, shortfall);
  await sendTransaction(ctx, `deposit ${fx.symbol}`, fx.vault, () =>
    client.simulateContract({
      account: ctx.account,
      address: getAddress(fx.vault),
      abi: assetVaultAbi,
      functionName: "deposit",
      args: [shortfall, getAddress(ctx.signer)]
    })
  );
}

async function shipStrategy(
  ctx: ExecContext,
  venue: SwapVMVenue,
  aquaVenue: AquaVenue,
  spec: StrategySpec,
  classId: bigint
): Promise<void> {
  const client = ctx.publicClient;
  const { pair } = spec;
  const adapter = getAddress(aquaVenue.adapter);
  const [usdcAvailable, fxAvailable, isOperator, domainVersionHash, nonce, block] = await Promise.all([
    readVaultUint(client, pair.usdc.vault, "availableFor", classId),
    readVaultUint(client, pair.fx.vault, "availableFor", classId),
    client.readContract({
      address: adapter,
      abi: aquaAdapterAbi,
      functionName: "hasRole",
      args: [OPERATOR_ROLE, getAddress(ctx.signer)]
    }),
    client.readContract({ address: adapter, abi: aquaAdapterAbi, functionName: "DOMAIN_VERSION_HASH" }),
    client.readContract({
      address: adapter,
      abi: aquaAdapterAbi,
      functionName: "strategistNonces",
      args: [getAddress(ctx.signer)]
    }),
    client.getBlock()
  ]);
  if (usdcAvailable < spec.usdcShip) {
    throw new Error(
      `USDC backing available to class ${classId} is ${formatUnits(usdcAvailable, pair.usdc.decimals)} USDC but this strategy ships ${formatUnits(spec.usdcShip, pair.usdc.decimals)} USDC. Deposit USDC first (e.g. "deposit 2 USDC"), then run create_strategy again, or lower params.usdcAmount.`
    );
  }
  if (fxAvailable < spec.fxShip) {
    throw new Error(
      `${pair.fx.symbol} backing available to class ${classId} is ${formatUnits(fxAvailable, pair.fx.decimals)} but this strategy ships ${formatUnits(spec.fxShip, pair.fx.decimals)}`
    );
  }
  if (!isOperator) {
    throw new Error(
      `Signer ${ctx.signer} lacks OPERATOR_ROLE on AquaAdapter ${aquaVenue.adapter}; the adapter admin must grantRole(${OPERATOR_ROLE}, ${ctx.signer})`
    );
  }
  if (domainVersionHash.toLowerCase() !== keccak256(toBytes(SWAPVM.adapterDomain.version))) {
    throw new Error(`AquaAdapter EIP-712 domain version is not "${SWAPVM.adapterDomain.version}"; refusing to sign`);
  }
  const signerCode = await client.getCode({ address: getAddress(ctx.signer) });
  if (signerCode && signerCode !== "0x") {
    throw new Error(
      `Strategist ${ctx.signer} has contract code (${signerCode.slice(0, 48)}, e.g. an EIP-7702 delegation). The AquaAdapter verifies ship signatures with SignatureChecker, which uses ERC-1271 for addresses with code, so this key's EIP-712 signature would be rejected (NotStrategist). Use a strategist key whose address has no code.`
    );
  }
  const deadline = block.timestamp + SWAPVM.shipDeadlineSeconds;
  const signature = await ctx.account.signTypedData(
    buildShipTypedData({
      chainId: ctx.chainId,
      adapter: aquaVenue.adapter,
      classId,
      strategyId: spec.strategyId,
      tokens: spec.tokens,
      amounts: spec.amounts,
      feePpb: spec.feePpb,
      nonce,
      deadline
    })
  );
  await sendTransaction(
    ctx,
    "shipStrategyWithFee",
    aquaVenue.adapter,
    () =>
      client.simulateContract({
        account: ctx.account,
        address: adapter,
        abi: aquaAdapterAbi,
        functionName: "shipStrategyWithFee",
        args: [classId, spec.strategyBytes, spec.tokens, spec.amounts, spec.feePpb, nonce, deadline, signature]
      }),
    async () => (await readVenueReadiness(client, venueTarget(venue, aquaVenue), [pair.usdc, pair.fx])).hint
  );
  if (!(await isStrategyLive(client, aquaVenue.adapter, spec.strategyId))) {
    throw new Error(`shipStrategyWithFee mined but strategy ${spec.strategyId} is not live`);
  }
}

async function approveIfNeeded(
  ctx: ExecContext,
  token: TokenInfo,
  spender: string,
  amount: bigint
): Promise<void> {
  const allowance = await ctx.publicClient.readContract({
    address: getAddress(token.address),
    abi: mintableErc20Abi,
    functionName: "allowance",
    args: [getAddress(ctx.signer), getAddress(spender)]
  });
  if (allowance >= amount) {
    return;
  }
  await sendTransaction(ctx, `approve ${token.symbol}`, token.address, () =>
    ctx.publicClient.simulateContract({
      account: ctx.account,
      address: getAddress(token.address),
      abi: mintableErc20Abi,
      functionName: "approve",
      args: [getAddress(spender), amount]
    })
  );
}

/**
 * Find the live strategy a quote/swap targets. Venues are tried in order (the requested opcode only, or FXSwap
 * then pegged): first the strategy id rebuilt from pair + params, then, when the params do not pin the program
 * bytes (e.g. none were given, or bandPercent), the newest live strategy for the pair in Aqua Shipped events,
 * preferring one whose class belongs to `preferStrategist`.
 */
async function resolveLiveStrategy(
  client: ReadClient,
  venue: SwapVMVenue,
  input: Pick<FxSwapInput, "pair" | "strategyId" | "params" | "opcode">,
  preferStrategist: string | undefined
): Promise<LiveStrategy> {
  const requested = parseStrategyOpcode(input.opcode) ?? inferOpcodeFromParams(input.params);
  let ordered: AquaVenue[];
  if (requested === "fxswap") {
    if (!venue.fxswap) {
      throw new Error('FXSwap venue not configured: set FXSWAP_ROUTER_ADDRESS and FXSWAP_AQUA_ADAPTER_ADDRESS, or use opcode "pegged"');
    }
    ordered = [venue.fxswap];
  } else if (requested === "pegged") {
    ordered = [venue.pegged];
  } else {
    ordered = listVenues(venue);
  }
  const pair = input.pair ? resolvePair(input.pair) : undefined;
  const params = input.params ?? {};

  if (input.strategyId) {
    const wanted = normalizeBytes32(input.strategyId) as Hex;
    for (const aquaVenue of ordered) {
      if (!(await isStrategyLive(client, aquaVenue.adapter, wanted))) {
        continue;
      }
      const fromParams = pair ? specForRecognition(venue, aquaVenue, pair, params) : undefined;
      if (fromParams && fromParams.strategyId === wanted) {
        return finalizeLiveStrategy(client, aquaVenue, pair ?? fromParams.pair, wanted, fromParams.order, "pair-params");
      }
      const found = await scanShippedStrategies(client, venue, [aquaVenue.adapter], wanted);
      const match = found.strategies[0];
      if (!match) {
        throw new Error(
          `strategyId ${wanted} is live on the ${aquaVenue.name} but its order was not found in Aqua Shipped events${
            found.error ? ` (event scan failed: ${found.error})` : ""
          }. Pass the pair plus the same params used when the strategy was created.`
        );
      }
      const livePair = pair ?? (await pairForStrategy(client, aquaVenue.adapter, wanted));
      return finalizeLiveStrategy(client, aquaVenue, livePair, wanted, match.order, "aqua-shipped-event");
    }
    throw new Error(
      `strategyId ${wanted} is not live on ${ordered.map((item) => `the ${item.name} adapter ${item.adapter}`).join(" or ")}`
    );
  }

  if (!pair) {
    throw new Error('Pass pair (e.g. "USDC/ARS") or strategyId to choose the strategy');
  }
  const tried: string[] = [];
  for (const aquaVenue of ordered) {
    let spec: StrategySpec | undefined;
    let specError: string | undefined;
    try {
      spec =
        aquaVenue.opcode === "pegged"
          ? buildPeggedStrategySpec(aquaVenue.adapter, pair, params)
          : buildFxSwapStrategySpec(aquaVenue.adapter, pair, requireFxSwapFeed(venue, pair).feed, params, {
              oraclePriceWad:
                params.bandPercent === undefined
                  ? (FXSWAP_REFERENCE_PRICE_WAD[pair.fx.symbol] ?? WAD)
                  : (await readFxOracle(client, requireFxSwapFeed(venue, pair).feed, pair)).feedPriceWad
            });
    } catch (error) {
      specError = error instanceof Error ? error.message : String(error);
    }
    if (spec && (await isStrategyLive(client, aquaVenue.adapter, spec.strategyId))) {
      return finalizeLiveStrategy(client, aquaVenue, pair, spec.strategyId, spec.order, "pair-params");
    }
    if (specError === undefined && !paramsPinProgram(aquaVenue.opcode, params)) {
      const found = await findLiveStrategyForPair(client, venue, aquaVenue, pair, preferStrategist);
      if (found.strategy) {
        return finalizeLiveStrategy(
          client,
          aquaVenue,
          pair,
          found.strategy.strategyId,
          found.strategy.order,
          "aqua-shipped-event"
        );
      }
      tried.push(
        `${aquaVenue.name}: no live ${pair.name} strategy (default id ${spec?.strategyId ?? "n/a"} is not live and none was found in Aqua Shipped events${found.error ? `; scan error: ${found.error}` : ""})`
      );
    } else {
      tried.push(
        specError
          ? `${aquaVenue.name}: params do not apply (${specError})`
          : `${aquaVenue.name}: strategy ${spec?.strategyId ?? "n/a"} for these params is not live`
      );
    }
  }
  throw new Error(
    `No live ${pair.name} strategy found. ${tried.join("; ")}. Create one with create_strategy (same params), or pass the strategyId it returned.`
  );
}

async function finalizeLiveStrategy(
  client: ReadClient,
  aquaVenue: AquaVenue,
  pair: FxPair,
  strategyId: Hex,
  order: SwapVMOrder,
  resolvedBy: LiveStrategy["resolvedBy"]
): Promise<LiveStrategy> {
  const [classId, feePpb] = await Promise.all([
    client.readContract({
      address: getAddress(aquaVenue.adapter),
      abi: aquaAdapterAbi,
      functionName: "strategyClassId",
      args: [strategyId]
    }),
    client.readContract({
      address: getAddress(aquaVenue.adapter),
      abi: aquaAdapterAbi,
      functionName: "strategyFeePpb",
      args: [strategyId]
    })
  ]);
  return {
    pair,
    strategyId,
    order,
    classId,
    feePpb,
    resolvedBy,
    venue: aquaVenue,
    instructions: safeDecodeProgram(order.data)
  };
}

async function findLiveStrategyForPair(
  client: ReadClient,
  venue: SwapVMVenue,
  aquaVenue: AquaVenue,
  pair: FxPair,
  preferStrategist: string | undefined
): Promise<{ strategy?: { strategyId: Hex; order: SwapVMOrder }; error?: string }> {
  const scan = await scanShippedStrategies(client, venue, [aquaVenue.adapter]);
  const wantedInstruction = aquaVenue.opcode === "fxswap" ? "FXSwap" : "PeggedSwap";
  const wantedTokens = [pair.usdc.address, pair.fx.address].sort().join();
  let first: { strategyId: Hex; order: SwapVMOrder } | undefined;
  const preferred = preferStrategist ? normalizeAddress(preferStrategist) : undefined;
  for (const candidate of scan.strategies.slice(0, 50)) {
    if (!safeDecodeProgram(candidate.order.data).some((item) => item.name === wantedInstruction)) {
      continue;
    }
    if (!(await isStrategyLive(client, aquaVenue.adapter, candidate.strategyId))) {
      continue;
    }
    const tokens = await client.readContract({
      address: getAddress(aquaVenue.adapter),
      abi: aquaAdapterAbi,
      functionName: "getStrategyTokens",
      args: [candidate.strategyId]
    });
    if (tokens.map((token) => normalizeAddress(token)).sort().join() !== wantedTokens) {
      continue;
    }
    first ??= candidate;
    if (!preferred) {
      break;
    }
    const classId = await client.readContract({
      address: getAddress(aquaVenue.adapter),
      abi: aquaAdapterAbi,
      functionName: "strategyClassId",
      args: [candidate.strategyId]
    });
    if ((await readLegStrategist(client, pair.usdc.vault, classId)) === preferred) {
      return { strategy: candidate };
    }
  }
  return { ...(first ? { strategy: first } : {}), ...(scan.error ? { error: scan.error } : {}) };
}

async function pairForStrategy(client: ReadClient, adapter: string, strategyId: Hex): Promise<FxPair> {
  const tokens = await client.readContract({
    address: getAddress(adapter),
    abi: aquaAdapterAbi,
    functionName: "getStrategyTokens",
    args: [strategyId]
  });
  if (tokens.length !== 2) {
    throw new Error(`Strategy ${strategyId} has ${tokens.length} tokens; expected a USDC/FX pair`);
  }
  return resolvePair(tokens.join("/"));
}

/** Aqua `Shipped` events made by the given adapters, newest first, in 10k-block windows. Best effort. */
async function scanShippedStrategies(
  client: ReadClient,
  venue: SwapVMVenue,
  makers: readonly string[],
  wanted?: Hex
): Promise<{
  strategies: Array<{ strategyId: Hex; order: SwapVMOrder; maker: Lowercase<string> }>;
  error?: string;
}> {
  const strategies: Array<{ strategyId: Hex; order: SwapVMOrder; maker: Lowercase<string> }> = [];
  const makerSet = new Set(makers.map((maker) => normalizeAddress(maker)));
  const window = 10_000n;
  try {
    let toBlock = await client.getBlockNumber();
    for (let page = 0; page < 500 && toBlock >= venue.aquaStartBlock; page += 1) {
      const fromBlock = toBlock - window + 1n > venue.aquaStartBlock ? toBlock - window + 1n : venue.aquaStartBlock;
      const logs = await client.getLogs({
        address: getAddress(venue.aqua),
        event: aquaShippedEvent,
        fromBlock,
        toBlock
      });
      for (const log of logs.reverse()) {
        const { maker, strategyHash, strategy } = log.args;
        if (!maker || !strategyHash || !strategy || !makerSet.has(normalizeAddress(maker))) {
          continue;
        }
        const strategyId = strategyHash.toLowerCase() as Hex;
        if ((wanted && strategyId !== wanted) || strategies.some((item) => item.strategyId === strategyId)) {
          continue;
        }
        try {
          strategies.push({ strategyId, order: decodeSwapVMOrder(strategy), maker: normalizeAddress(maker) });
        } catch {
          continue;
        }
        if (wanted) {
          return { strategies };
        }
      }
      toBlock = fromBlock - 1n;
    }
    return { strategies };
  } catch (error) {
    return { strategies, error: describeContractError(error) };
  }
}

async function quoteOnRouter(
  client: ReadClient,
  strategy: LiveStrategy,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: bigint,
  taker: string | undefined,
  blockNumber?: bigint
): Promise<bigint> {
  try {
    const { result } = await client.simulateContract({
      address: getAddress(strategy.venue.router),
      abi: aquaSwapVMRouterAbi,
      functionName: "quote",
      args: [
        strategy.order,
        getAddress(tokenIn.address),
        getAddress(tokenOut.address),
        amountIn,
        buildTakerTraitsAndData()
      ],
      ...(taker ? { account: getAddress(taker) } : {}),
      ...(blockNumber === undefined ? {} : { blockNumber })
    });
    return result[1];
  } catch (error) {
    throw new Error(`quote reverted: ${describeContractError(error)}`);
  }
}

async function readFxOracle(
  client: ReadClient,
  feed: string,
  pair: FxPair,
  blockNumber?: bigint
): Promise<FxOracleReading> {
  const address = getAddress(feed);
  const block = blockNumber === undefined ? await client.getBlock() : await client.getBlock({ blockNumber });
  let round: readonly [bigint, bigint, bigint, bigint, bigint];
  let decimals: number;
  try {
    [round, decimals] = await Promise.all([
      client.readContract({ address, abi: manualFxOracleAbi, functionName: "latestRoundData", blockNumber: block.number }),
      client.readContract({ address, abi: manualFxOracleAbi, functionName: "decimals", blockNumber: block.number })
    ]);
  } catch (error) {
    throw new Error(`Could not read the ${pair.fx.fiat}/USD feed ${feed}: ${describeContractError(error)}`);
  }
  const [description, owner] = await Promise.all([
    client
      .readContract({ address, abi: manualFxOracleAbi, functionName: "description", blockNumber: block.number })
      .catch(() => null),
    client
      .readContract({ address, abi: manualFxOracleAbi, functionName: "owner", blockNumber: block.number })
      .then((value) => normalizeAddress(value))
      .catch(() => null)
  ]);
  const answer = round[1];
  return {
    feed: normalizeAddress(feed),
    pair,
    description,
    decimals,
    roundId: round[0],
    answer,
    feedPriceWad: answer > 0n ? scaleToWad(answer, decimals) : 0n,
    updatedAt: round[3],
    blockNumber: block.number,
    blockTimestamp: block.timestamp,
    owner
  };
}

function describeOracle(
  reading: FxOracleReading,
  strategy?: { maxStaleness: number; minPrice: bigint; maxPrice: bigint }
) {
  const fiat = reading.pair.fx.fiat;
  const age = reading.blockTimestamp >= reading.updatedAt ? reading.blockTimestamp - reading.updatedAt : 0n;
  const fresh = strategy
    ? reading.updatedAt <= reading.blockTimestamp && age <= BigInt(strategy.maxStaleness)
    : undefined;
  return {
    pair: reading.pair.name,
    feed: reading.feed,
    description: reading.description,
    price: `${formatWad(reading.feedPriceWad)} ${fiat} per 1 USD`,
    answer: reading.answer.toString(),
    decimals: reading.decimals,
    roundId: reading.roundId.toString(),
    updatedAt: new Date(Number(reading.updatedAt) * 1000).toISOString(),
    ageSeconds: age.toString(),
    atBlock: reading.blockNumber.toString(),
    owner: reading.owner,
    ...(strategy
      ? {
          strategyMaxStalenessSeconds: strategy.maxStaleness,
          fresh,
          strategyBand: {
            min: `${formatWad(strategy.minPrice)} ${fiat} per 1 USD`,
            max: `${formatWad(strategy.maxPrice)} ${fiat} per 1 USD`,
            inBand: reading.feedPriceWad >= strategy.minPrice && reading.feedPriceWad <= strategy.maxPrice
          }
        }
      : {})
  };
}

/** The price a strategy is anchored to: the FXSwap feed (read exactly as FXSwap reads it) or the pegged price. */
async function readReferencePrice(
  client: ReadClient,
  strategy: LiveStrategy,
  blockNumber?: bigint
): Promise<ReferencePrice | undefined> {
  const { pair } = strategy;
  const usdcIsLt = BigInt(pair.usdc.address) < BigInt(pair.fx.address);
  const gap = 10n ** BigInt(pair.fx.decimals - pair.usdc.decimals);
  for (const instruction of strategy.instructions) {
    if (instruction.name === "FXSwap") {
      const args: FxSwapArgs = instruction.args;
      const reading = await readFxOracle(client, args.oracle, pair, blockNumber);
      const decimals = args.oracleDecimals === 0 ? reading.decimals : args.oracleDecimals;
      const feedWad = reading.answer > 0n ? scaleToWad(reading.answer, decimals) : 0n;
      const priceGtPerLt =
        (args.flags & FXSWAP.flagInvertPrice) === 0 ? feedWad : feedWad === 0n ? 0n : (WAD * WAD) / feedWad;
      const fxPerUsdcWad = usdcIsLt ? priceGtPerLt : priceGtPerLt === 0n ? 0n : (WAD * WAD) / priceGtPerLt;
      const oracle = describeOracle({ ...reading, feedPriceWad: feedWad }, args);
      const warnings = [
        ...(oracle.fresh === false
          ? [
              `The ${pair.fx.fiat}/USD feed answer is ${oracle.ageSeconds}s old, beyond this strategy's ${args.maxStaleness}s staleness window: swaps revert (FXSwapOracleStale) until the feed owner refreshes it (set_fx_price)`
            ]
          : []),
        ...(oracle.strategyBand?.inBand === false
          ? [
              `The ${pair.fx.fiat}/USD feed (${oracle.price}) is outside this strategy's band ${oracle.strategyBand.min}..${oracle.strategyBand.max}: swaps revert (FXSwapOraclePriceOutOfBand)`
            ]
          : [])
      ];
      return {
        source: "oracle",
        fxPerUsdcWad,
        oracle,
        ...(warnings.length > 0 ? { warning: warnings.join(". ") } : {})
      };
    }
    if (instruction.name === "PeggedSwap") {
      const [usdcRate, fxRate] = usdcIsLt
        ? [instruction.rateLt, instruction.rateGt]
        : [instruction.rateGt, instruction.rateLt];
      if (fxRate === 0n) {
        return undefined;
      }
      return { source: "pegged-program", fxPerUsdcWad: (usdcRate * WAD) / (fxRate * gap) };
    }
  }
  return undefined;
}

function pricingSummary(
  pair: FxPair,
  tokenIn: TokenInfo,
  amountIn: bigint,
  tokenOut: TokenInfo,
  amountOut: bigint,
  reference: ReferencePrice | undefined
) {
  const gap = 10n ** BigInt(pair.fx.decimals - pair.usdc.decimals);
  const usdcIn = tokenIn.symbol === pair.usdc.symbol;
  const executionWad = usdcIn
    ? amountIn === 0n
      ? 0n
      : (amountOut * WAD) / (amountIn * gap)
    : amountOut === 0n
      ? 0n
      : (amountIn * WAD) / (amountOut * gap);
  const executionPrice = `${formatWad(executionWad)} ${pair.fx.symbol} per USDC`;
  if (!reference || reference.fxPerUsdcWad === 0n) {
    return { priceSource: "none", executionPrice };
  }
  const referenceOut = usdcIn
    ? (amountIn * gap * reference.fxPerUsdcWad) / WAD
    : (amountIn * WAD) / (reference.fxPerUsdcWad * gap);
  const spreadHundredthsBps = referenceOut === 0n ? 0n : ((referenceOut - amountOut) * 1_000_000n) / referenceOut;
  const priceText = `${formatWad(reference.fxPerUsdcWad)} ${pair.fx.symbol} per USDC`;
  return {
    priceSource: reference.source,
    ...(reference.source === "oracle" ? { oraclePrice: priceText } : { fixedPrice: priceText }),
    executionPrice,
    amountOutAtReferencePrice: formatTokenAmount(referenceOut, tokenOut),
    effectiveSpreadBps: formatSignedHundredths(spreadHundredthsBps),
    spreadNote:
      reference.source === "oracle"
        ? "Shortfall versus trading the whole amount at the oracle price: FXSwap dynamic fee, any flat fee and curve slippage. Negative means better than the oracle (a rebalancing trade)."
        : "Shortfall versus the pegged program price: flat fee plus curve slippage."
  };
}

function strategyReference(strategy: LiveStrategy) {
  return {
    pair: strategy.pair.name,
    opcode: strategy.venue.opcode,
    venue: { name: strategy.venue.name, adapter: strategy.venue.adapter, router: strategy.venue.router },
    strategyId: strategy.strategyId,
    classId: strategy.classId.toString(),
    feePpb: strategy.feePpb,
    instructions: summarizeInstructions(strategy.instructions),
    resolvedBy: strategy.resolvedBy
  };
}

function strategyIdentity(
  chainId: number,
  spec: StrategySpec,
  aquaVenue: AquaVenue,
  choice: OpcodeChoice,
  strategist: Lowercase<string>,
  strategyKey: Hex,
  classId: bigint,
  live: boolean,
  oracle: FxOracleReading | undefined
) {
  const common = {
    chainId,
    pair: spec.pair.name,
    opcode: spec.opcode,
    opcodeSource: choice.source,
    ...(choice.note ? { opcodeNote: choice.note } : {}),
    venue: { name: aquaVenue.name, adapter: aquaVenue.adapter, router: aquaVenue.router },
    label: spec.label,
    strategist,
    strategyKey,
    classId: classId.toString(),
    strategyId: spec.strategyId,
    live
  };
  if (spec.opcode === "pegged") {
    return {
      ...common,
      program: {
        instructions: "FlatFeeAmountIn (opcode 21) -> PeggedSwap (opcode 31)",
        price: `${formatUnits(spec.priceE2, 2)} ${spec.pair.fx.fiat} per 1 USDC`,
        priceE2: spec.priceE2.toString(),
        feePpb: spec.feePpb,
        feeBps: formatUnits(BigInt(spec.feePpb), 5),
        usdcShip: formatTokenAmount(spec.usdcShip, spec.pair.usdc),
        fxShip: formatTokenAmount(spec.fxShip, spec.pair.fx),
        linearWidth: spec.linearWidth.toString(),
        maker: normalizeAddress(spec.order.maker),
        makerTraits: toHex(spec.order.traits),
        program: spec.program
      }
    };
  }
  const { args } = spec;
  const fiat = spec.pair.fx.fiat;
  return {
    ...common,
    program: {
      instructions:
        spec.flatFeePpb > 0 ? "FlatFeeAmountIn (opcode 21) -> FXSwap (opcode 34)" : "FXSwap (opcode 34)",
      priceSource: `oracle ${spec.oracle}, read on every swap`,
      priceBand: {
        min: `${formatWad(spec.band.minPrice)} ${fiat} per 1 USD`,
        max: `${formatWad(spec.band.maxPrice)} ${fiat} per 1 USD`,
        source: spec.band.source
      },
      maxStalenessSeconds: args.maxStaleness,
      oracleDecimals: args.oracleDecimals === 0 ? "read from the feed on every swap" : args.oracleDecimals,
      A: formatUnits(args.a, 4),
      gamma: formatUnits(args.gamma, 18),
      midFeeBps: formatUnits(args.midFee, 14),
      outFeeBps: formatUnits(args.outFee, 14),
      feeGamma: formatUnits(args.feeGamma, 18),
      flatFeeBps: formatUnits(BigInt(spec.flatFeePpb), 5),
      declaredFeePpb: spec.feePpb,
      declaredFeeNote:
        "feePpb declared to shipStrategyWithFee: the mid fee (the least the curve charges, at balance) composed with any flat fee. The AquaAdapter does not read opcodes; the declaration never overstates the fee.",
      invertPrice: (args.flags & FXSWAP.flagInvertPrice) !== 0,
      rateLt: args.rateLt.toString(),
      rateGt: args.rateGt.toString(),
      usdcShip: formatTokenAmount(spec.usdcShip, spec.pair.usdc),
      fxShip: formatTokenAmount(spec.fxShip, spec.pair.fx),
      maker: normalizeAddress(spec.order.maker),
      makerTraits: toHex(spec.order.traits),
      program: spec.program
    },
    ...(oracle ? { oracle: describeOracle(oracle, { ...args }) } : {})
  };
}

function summarizeProgram(program: Hex): string {
  return summarizeInstructions(safeDecodeProgram(program));
}

function summarizeInstructions(instructions: readonly DecodedInstruction[]): string {
  if (instructions.length === 0) {
    return "unknown program";
  }
  return instructions
    .map((instruction) => {
      switch (instruction.name) {
        case "FlatFeeAmountIn":
          return `FlatFeeAmountIn ${formatUnits(BigInt(instruction.feePpb), 5)} bps`;
        case "PeggedSwap":
          return "PeggedSwap (fixed price)";
        case "FXSwap":
          return `FXSwap (oracle ${normalizeAddress(instruction.args.oracle)}, A ${formatUnits(instruction.args.a, 4)}, mid fee ${formatUnits(instruction.args.midFee, 14)} bps)`;
        default:
          return `opcode ${instruction.opcode}`;
      }
    })
    .join(" -> ");
}

function safeDecodeProgram(program: Hex): DecodedInstruction[] {
  try {
    return decodeSwapVMProgram(program);
  } catch {
    return [];
  }
}

function resolveFeedTarget(venue: SwapVMVenue, input: SetFxPriceInput): { pair: FxPair; feed: Lowercase<string> } {
  if (!venue.fxswap) {
    throw new Error("FXSwap venue not configured, so there are no FX feeds to set");
  }
  const oracles = venue.fxswap.oracles;
  if (input.feed) {
    const feed = normalizeAddress(input.feed);
    const symbol = Object.keys(oracles).find((key) => oracles[key] === feed);
    if (!symbol) {
      throw new Error(`Feed ${feed} is not one of the configured FXSwap feeds (${Object.values(oracles).join(", ")})`);
    }
    const pair = resolvePair(symbol);
    if (input.pair && resolvePair(input.pair).name !== pair.name) {
      throw new Error(`Feed ${feed} is the ${pair.fx.fiat}/USD feed, not ${input.pair}`);
    }
    return { pair, feed };
  }
  if (!input.pair) {
    throw new Error('Pass pair (e.g. "ARS" or "USDC/BRL") or feed to choose the FX feed');
  }
  const pair = resolvePair(input.pair);
  return { pair, feed: requireFxSwapFeed(venue, pair).feed };
}

function computeNewAnswer(reading: FxOracleReading, input: SetFxPriceInput): bigint {
  if ((input.price === undefined) === (input.changePercent === undefined)) {
    throw new Error('Pass exactly one of price (e.g. 5.6) or changePercent (e.g. 5 or "-2.5")');
  }
  let answer: bigint;
  if (input.price !== undefined) {
    answer = parseTokenAmount(input.price, reading.decimals, {
      field: `price (${reading.pair.fx.fiat} per 1 USD)`
    });
  } else {
    if (reading.answer <= 0n) {
      throw new Error("The feed has no positive answer to move by a percentage; pass price instead");
    }
    const change = parseSignedPercentWad(input.changePercent as AmountValue, "changePercent");
    if (change <= -WAD) {
      throw new Error("changePercent must be above -100");
    }
    answer = (reading.answer * (WAD + change)) / WAD;
  }
  if (answer <= 0n) {
    throw new Error("The new price must be greater than zero");
  }
  if (answer > (1n << 255n) - 1n) {
    throw new Error("The new price does not fit an int256 answer");
  }
  return answer;
}

function feedMoveWarnings(pair: FxPair, reading: FxOracleReading, newAnswer: bigint): string[] {
  const reference = FXSWAP_REFERENCE_PRICE_WAD[pair.fx.symbol];
  if (reference === undefined) {
    return [];
  }
  const newWad = scaleToWad(newAnswer, reading.decimals);
  return newWad < reference / 2n || newWad > reference * 2n
    ? [
        `${formatWad(newWad)} ${pair.fx.fiat} per USD is outside the default FXSwap band ${formatWad(reference / 2n)}..${formatWad(reference * 2n)}: strategies created with the default band will revert swaps until the price is back inside`
      ]
    : [];
}

function parseSignedPercentWad(value: AmountValue, field: string): bigint {
  let negative = false;
  let magnitude: AmountValue;
  if (typeof value === "number") {
    negative = value < 0;
    magnitude = Math.abs(value);
  } else {
    const text = value.trim();
    negative = text.startsWith("-");
    magnitude = text.replace(/^[+-]\s*/, "");
  }
  const parsed = parseTokenAmount(magnitude, 16, { field });
  return negative ? -parsed : parsed;
}

function formatChange(before: bigint, after: bigint): string {
  if (before <= 0n) {
    return "n/a";
  }
  return `${formatSignedHundredths(((after - before) * 10_000n) / before)}%`;
}

function formatSignedHundredths(value: bigint): string {
  const sign = value < 0n ? "-" : "+";
  const abs = value < 0n ? -value : value;
  return `${sign}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/** WAD value with at most 6 decimals, e.g. `1386.123456`. */
function formatWad(value: bigint): string {
  return formatUnits(value / 10n ** 12n, 6);
}

function scaleToWad(answer: bigint, decimals: number): bigint {
  return decimals < 18 ? answer * 10n ** BigInt(18 - decimals) : answer / 10n ** BigInt(decimals - 18);
}

function positionSummary(token: TokenInfo, position: VaultPosition) {
  return {
    token: token.symbol,
    vault: token.vault,
    lpPrincipal: formatTokenAmount(position.principal, token),
    lpCommitted: position.committed,
    classCommittedBacking: formatTokenAmount(position.committedBacking, token),
    classAvailableFor: formatTokenAmount(position.availableFor, token)
  };
}

/** Backing the class would see once this LP's principal is committed. */
function effectiveBacking(position: VaultPosition): bigint {
  return position.availableFor + (position.committed ? 0n : position.principal);
}

function resolveSwapDirection(pair: FxPair, tokenIn: string | undefined) {
  const token = tokenIn ? resolveToken(tokenIn) : pair.usdc;
  if (token.symbol === pair.usdc.symbol) {
    return { tokenIn: pair.usdc, tokenOut: pair.fx };
  }
  if (token.symbol === pair.fx.symbol) {
    return { tokenIn: pair.fx, tokenOut: pair.usdc };
  }
  throw new Error(`tokenIn ${tokenIn} is not part of ${pair.name}`);
}

function resolveMinAmountOut(
  input: Pick<FxSwapInput, "minAmountOut" | "slippageBps" | "unit">,
  tokenOut: TokenInfo,
  quoted: bigint | undefined
): bigint | undefined {
  if (input.minAmountOut !== undefined) {
    return parseTokenAmount(input.minAmountOut, tokenOut.decimals, {
      unit: input.unit,
      field: "minAmountOut"
    });
  }
  if (quoted === undefined) {
    return undefined;
  }
  const slippageBps = input.slippageBps ?? 50;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5_000) {
    throw new Error("slippageBps must be an integer between 0 and 5000");
  }
  return (quoted * BigInt(10_000 - slippageBps)) / 10_000n;
}

function resolveDepositToken(input: FxDepositInput): TokenInfo {
  const fromToken = input.token ? resolveToken(input.token) : undefined;
  const fromVault = input.vault ? resolveToken(input.vault) : undefined;
  if (fromToken && fromVault && fromToken.symbol !== fromVault.symbol) {
    throw new Error(`token ${input.token} does not match vault ${input.vault}`);
  }
  return fromToken ?? fromVault ?? resolveToken("USDC");
}

function requirePositive(value: bigint, field: string): bigint {
  if (value <= 0n) {
    throw new Error(`${field} must be greater than zero`);
  }
  return value;
}

async function readClassId(client: ReadClient, venue: SwapVMVenue, strategyKey: Hex): Promise<bigint> {
  return client.readContract({
    address: getAddress(venue.registry),
    abi: vaultRegistryAbi,
    functionName: "classForStrategy",
    args: [strategyKey]
  });
}

async function readLegStrategist(
  client: ReadClient,
  vault: string,
  classId: bigint
): Promise<Lowercase<string>> {
  return normalizeAddress(
    await client.readContract({
      address: getAddress(vault),
      abi: assetVaultAbi,
      functionName: "classStrategist",
      args: [classId]
    })
  );
}

async function readVaultUint(
  client: ReadClient,
  vault: string,
  functionName: "committedBacking" | "availableFor",
  classId: bigint
): Promise<bigint> {
  return client.readContract({
    address: getAddress(vault),
    abi: assetVaultAbi,
    functionName,
    args: [classId]
  });
}

async function readVaultPosition(
  client: ReadClient,
  token: TokenInfo,
  lp: string,
  classId: bigint
): Promise<VaultPosition> {
  const vault = getAddress(token.vault);
  const [principal, committed, availableFor, committedBacking] = await Promise.all([
    client.readContract({ address: vault, abi: assetVaultAbi, functionName: "principal", args: [getAddress(lp)] }),
    client.readContract({
      address: vault,
      abi: assetVaultAbi,
      functionName: "committed",
      args: [getAddress(lp), classId]
    }),
    readVaultUint(client, token.vault, "availableFor", classId),
    readVaultUint(client, token.vault, "committedBacking", classId)
  ]);
  return { principal, committed, availableFor, committedBacking };
}

async function readTokenBalance(client: ReadClient, token: TokenInfo, owner: string): Promise<bigint> {
  return client.readContract({
    address: getAddress(token.address),
    abi: mintableErc20Abi,
    functionName: "balanceOf",
    args: [getAddress(owner)]
  });
}

async function isStrategyLive(client: ReadClient, adapter: string, strategyId: Hex): Promise<boolean> {
  const aquaHash = await client.readContract({
    address: getAddress(adapter),
    abi: aquaAdapterAbi,
    functionName: "currentAquaHash",
    args: [strategyId]
  });
  return BigInt(aquaHash) !== 0n;
}

async function mapInChunks<T, R>(
  items: readonly T[],
  size: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += size) {
    results.push(...(await Promise.all(items.slice(index, index + size).map(fn))));
  }
  return results;
}
