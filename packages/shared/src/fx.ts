/**
 * On-chain flows for the Arc USDC-FX demo through the Aqua0 AquaAdapter + AquaSwapVMRouter:
 * create a strategy (class -> vault legs -> backing -> commitments -> ship), deposit with human
 * units, quote/swap against a live strategy, and read how one USDC deposit backs several classes.
 *
 * Every write has a prepare path (calldata / EIP-712 typed data, nothing sent) and an execute path
 * that only runs behind `assertExecutionAllowed` (MCP_WRITE_MODE=execute, key set, Arc or local RPC).
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
  mintableErc20Abi,
  vaultRegistryAbi
} from "./abis.js";
import { ARC_TESTNET_DEPLOYMENT } from "./constants.js";
import { normalizeAddress, normalizeBytes32 } from "./graph.js";
import {
  ARC_TOKENS,
  OPERATOR_ROLE,
  SWAPVM,
  VENUE_SETTLER_ROLE,
  assertSupportedChain,
  buildPeggedStrategySpec,
  buildShipTypedData,
  buildTakerTraitsAndData,
  decodeSwapVMOrder,
  describeContractError,
  formatRate,
  formatTokenAmount,
  parseTokenAmount,
  resolvePair,
  resolveToken,
  toJsonSafe,
  type AmountUnit,
  type AmountValue,
  type FxPair,
  type PeggedStrategySpec,
  type StrategyParamsInput,
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

export type SwapVMVenue = {
  chainId: number;
  registry: Lowercase<string>;
  adapter: Lowercase<string>;
  router: Lowercase<string>;
  aqua: Lowercase<string>;
  aquaStartBlock: bigint;
  fxswapRouter?: Lowercase<string>;
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
  return {
    chainId,
    registry: normalizeAddress(config.vaultRegistryAddress ?? contracts.vaultRegistry),
    adapter: normalizeAddress(config.aquaAdapterAddress ?? contracts.aquaAdapter),
    router: normalizeAddress(config.aquaSwapVMRouterAddress ?? contracts.aquaSwapVMRouter),
    aqua: normalizeAddress(contracts.aqua),
    aquaStartBlock: BigInt(ARC_TESTNET_DEPLOYMENT.startBlocks.aqua),
    ...(config.fxswapRouterAddress
      ? { fxswapRouter: normalizeAddress(config.fxswapRouterAddress) }
      : {})
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

export type StrategyOpcode = "pegged";

export function resolveStrategyOpcode(
  opcode: string | undefined,
  config: WriteConfig
): StrategyOpcode {
  const value = (opcode ?? "pegged").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (["", "pegged", "peg", "peggedswap", "stable", "stableswap", "fixed", "fixedrate"].includes(value)) {
    return "pegged";
  }
  if (["fxswap", "fx", "dynamic", "dynamicfx"].includes(value)) {
    if (!config.fxswapRouterAddress) {
      throw new Error(
        'FXSwap router not configured yet: set FXSWAP_ROUTER_ADDRESS once the FXSwap router is deployed. Meanwhile use opcode "pegged" (stable-rate strategy at a fixed FX price).'
      );
    }
    throw new Error(
      `FXSwap router ${normalizeAddress(config.fxswapRouterAddress)} is configured, but FXSwap program encoding is not available in this build yet. Use opcode "pegged" meanwhile.`
    );
  }
  throw new Error(
    `Unknown opcode "${opcode}". Supported: "pegged" (stable-rate fallback) and "fxswap" (needs FXSWAP_ROUTER_ADDRESS)`
  );
}

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
  const opcode = resolveStrategyOpcode(input.opcode, config);
  const venue = resolveSwapVMVenue(config);
  assertSupportedChain(input.chain, venue.chainId);
  const pair = resolvePair(input.pair);
  const spec = buildPeggedStrategySpec(venue.adapter, pair, input.params ?? {});
  const ctx = await createExecContext(config);
  const client = ctx.publicClient;
  if (input.strategist && normalizeAddress(input.strategist) !== ctx.signer) {
    throw new Error(
      `In execute mode the strategist is the configured signer ${ctx.signer}; got ${input.strategist}. Omit strategist, or use dryRun to prepare for another address.`
    );
  }
  const strategyKey = deriveStrategyKey({
    strategist: ctx.signer,
    chainId: venue.chainId,
    token0: pair.usdc.address,
    token1: pair.fx.address,
    label: spec.label
  }).strategyKey;

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

  const alreadyLive = await isStrategyLive(client, venue, spec.strategyId);

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

  // 5. Ship the SwapVM program through the adapter.
  if (alreadyLive) {
    skipStep(ctx, "shipStrategyWithFee", "strategy already live on the AquaAdapter");
  } else {
    await shipStrategy(ctx, venue, spec, registeredClassId);
  }

  const [usdcPosition, fxPosition] = await Promise.all([
    readVaultPosition(client, pair.usdc, ctx.signer, registeredClassId),
    readVaultPosition(client, pair.fx, ctx.signer, registeredClassId)
  ]);
  return {
    mode: "execute",
    ...strategyIdentity(venue.chainId, spec, opcode, ctx.signer, strategyKey, registeredClassId, true),
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
  const opcode = resolveStrategyOpcode(input.opcode, config);
  const venue = resolveSwapVMVenue(config);
  assertSupportedChain(input.chain, venue.chainId);
  const pair = resolvePair(input.pair);
  const spec = buildPeggedStrategySpec(venue.adapter, pair, input.params ?? {});
  const strategist = input.strategist
    ? normalizeAddress(input.strategist)
    : configuredSignerAddress(config);
  if (!strategist) {
    throw new Error(
      "strategist is required in prepare mode (no WRITE_PRIVATE_KEY signer is configured to default to)"
    );
  }
  const client = createReadClient(config);
  const strategyKey = deriveStrategyKey({
    strategist,
    chainId: venue.chainId,
    token0: pair.usdc.address,
    token1: pair.fx.address,
    label: spec.label
  }).strategyKey;
  const [classId, live] = await Promise.all([
    readClassId(client, venue, strategyKey),
    isStrategyLive(client, venue, spec.strategyId)
  ]);
  const identity = strategyIdentity(venue.chainId, spec, opcode, strategist, strategyKey, classId, live);
  const warnings: string[] = [];

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
      explanation: "The strategy is already live on the AquaAdapter; only missing registrations/commitments (if any) are listed. Nothing was executed.",
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
      address: getAddress(venue.adapter),
      abi: aquaAdapterAbi,
      functionName: "strategistNonces",
      args: [getAddress(strategist)]
    }),
    client.getBlock(),
    readVenueReadiness(client, venue, [pair.usdc, pair.fx])
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
    adapter: venue.adapter,
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
      to: venue.adapter,
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
      caller: "must hold OPERATOR_ROLE on the AquaAdapter and be an EOA"
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
};

export async function quoteFxSwap(config: WriteConfig, input: FxSwapInput) {
  const venue = resolveSwapVMVenue(config);
  const client = createReadClient(config);
  const strategy = await resolveLiveStrategy(client, venue, input);
  const { tokenIn, tokenOut } = resolveSwapDirection(strategy.pair, input.tokenIn);
  const amountIn = requirePositive(
    parseTokenAmount(input.amount, tokenIn.decimals, { unit: input.unit, field: "amount" }),
    "amount"
  );
  const taker = input.taker ? normalizeAddress(input.taker) : configuredSignerAddress(config);
  const amountOut = await quoteOnRouter(client, venue, strategy, tokenIn, tokenOut, amountIn, taker);
  return {
    source: "AquaSwapVMRouter.quote via eth_call (read-only; nothing is sent)",
    chainId: venue.chainId,
    router: venue.router,
    ...strategyReference(strategy),
    amountIn: formatTokenAmount(amountIn, tokenIn),
    amountOut: formatTokenAmount(amountOut, tokenOut),
    rate: formatRate(amountIn, tokenIn, amountOut, tokenOut)
  };
}

export async function prepareFxSwap(config: WriteConfig, input: FxSwapInput) {
  const venue = resolveSwapVMVenue(config);
  const client = createReadClient(config);
  const strategy = await resolveLiveStrategy(client, venue, input);
  const { tokenIn, tokenOut } = resolveSwapDirection(strategy.pair, input.tokenIn);
  const amountIn = requirePositive(
    parseTokenAmount(input.amount, tokenIn.decimals, { unit: input.unit, field: "amount" }),
    "amount"
  );
  const taker = input.taker ? normalizeAddress(input.taker) : configuredSignerAddress(config);
  if (!taker) {
    throw new Error("taker is required in prepare mode (no WRITE_PRIVATE_KEY signer is configured)");
  }
  const warnings: string[] = [];
  let quoted: bigint | undefined;
  try {
    quoted = await quoteOnRouter(client, venue, strategy, tokenIn, tokenOut, amountIn, taker);
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
    router: venue.router,
    ...strategyReference(strategy),
    taker,
    amountIn: formatTokenAmount(amountIn, tokenIn),
    quotedAmountOut: quoted === undefined ? null : formatTokenAmount(quoted, tokenOut),
    minAmountOut: minAmountOut === undefined ? null : formatTokenAmount(minAmountOut, tokenOut),
    explanation: `Send from ${taker}: approve the router, then swap. Skip the approve if the router allowance already covers the amount. Nothing was executed.`,
    transactions: [
      prepareStep(`approve ${tokenIn.symbol}`, tokenIn.address, mintableErc20Abi, "approve", [
        getAddress(venue.router),
        amountIn
      ]),
      prepareStep(`swap ${tokenIn.symbol} -> ${tokenOut.symbol}`, venue.router, aquaSwapVMRouterAbi, "swap", [
        strategy.order,
        getAddress(tokenIn.address),
        getAddress(tokenOut.address),
        amountIn,
        buildTakerTraitsAndData(minAmountOut)
      ])
    ],
    warnings
  };
}

export async function executeFxSwap(config: WriteConfig, input: FxSwapInput) {
  assertExecutionAllowed(config);
  const venue = resolveSwapVMVenue(config);
  const ctx = await createExecContext(config);
  const client = ctx.publicClient;
  const strategy = await resolveLiveStrategy(client, venue, input);
  const { tokenIn, tokenOut } = resolveSwapDirection(strategy.pair, input.tokenIn);
  const amountIn = requirePositive(
    parseTokenAmount(input.amount, tokenIn.decimals, { unit: input.unit, field: "amount" }),
    "amount"
  );
  if (input.taker && normalizeAddress(input.taker) !== ctx.signer) {
    throw new Error(`In execute mode the taker is the configured signer ${ctx.signer}; got ${input.taker}`);
  }
  const balance = await readTokenBalance(client, tokenIn, ctx.signer);
  if (balance < amountIn) {
    throw new Error(
      `Signer ${ctx.signer} holds ${formatUnits(balance, tokenIn.decimals)} ${tokenIn.symbol}; swapping ${formatUnits(amountIn, tokenIn.decimals)} needs more`
    );
  }
  const quoted = await quoteOnRouter(client, venue, strategy, tokenIn, tokenOut, amountIn, ctx.signer);
  const minAmountOut = resolveMinAmountOut(input, tokenOut, quoted) ?? 0n;
  await approveIfNeeded(ctx, tokenIn, venue.router, amountIn);
  const before = await readTokenBalance(client, tokenOut, ctx.signer);
  await sendTransaction(
    ctx,
    `swap ${tokenIn.symbol} -> ${tokenOut.symbol}`,
    venue.router,
    () =>
      client.simulateContract({
        account: ctx.account,
        address: getAddress(venue.router),
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
    async () => (await readVenueReadiness(client, venue, [strategy.pair.usdc, strategy.pair.fx])).hint
  );
  const received = (await readTokenBalance(client, tokenOut, ctx.signer)) - before;
  return {
    mode: "execute" as const,
    chainId: ctx.chainId,
    router: venue.router,
    ...strategyReference(strategy),
    taker: ctx.signer,
    amountIn: formatTokenAmount(amountIn, tokenIn),
    quotedAmountOut: formatTokenAmount(quoted, tokenOut),
    minAmountOut: formatTokenAmount(minAmountOut, tokenOut),
    received: formatTokenAmount(received, tokenOut),
    rate: formatRate(amountIn, tokenIn, received, tokenOut),
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

  const shipped = relevant.length > 0 ? await scanShippedStrategies(client, venue) : { strategies: [] };
  const shippedClassIds = await mapInChunks(shipped.strategies, 16, async (strategy) => ({
    strategyId: strategy.strategyId,
    classId: await client.readContract({
      address: getAddress(venue.adapter),
      abi: aquaAdapterAbi,
      functionName: "strategyClassId",
      args: [strategy.strategyId]
    })
  }));

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

    const candidates = new Set<Hex>(
      shippedClassIds.filter((row) => row.classId === classId).map((row) => row.strategyId)
    );
    if (pair) {
      try {
        candidates.add(buildPeggedStrategySpec(venue.adapter, pair, input.params ?? {}).strategyId);
      } catch {
        // Invalid params only affect recognition of a non-default strategy.
      }
    }
    const strategies = (
      await Promise.all(
        [...candidates].map(async (strategyId) => {
          const [strategyClassId, aquaHash, feePpb] = await Promise.all([
            client.readContract({
              address: getAddress(venue.adapter),
              abi: aquaAdapterAbi,
              functionName: "strategyClassId",
              args: [strategyId]
            }),
            client.readContract({
              address: getAddress(venue.adapter),
              abi: aquaAdapterAbi,
              functionName: "currentAquaHash",
              args: [strategyId]
            }),
            client.readContract({
              address: getAddress(venue.adapter),
              abi: aquaAdapterAbi,
              functionName: "strategyFeePpb",
              args: [strategyId]
            })
          ]);
          if (strategyClassId !== classId) {
            return undefined;
          }
          const amounts = pair
            ? await Promise.all(
                [pair.usdc, pair.fx].map((token) =>
                  client.readContract({
                    address: getAddress(venue.adapter),
                    abi: aquaAdapterAbi,
                    functionName: "strategyAmount",
                    args: [strategyId, getAddress(token.address)]
                  })
                )
              )
            : undefined;
          return {
            strategyId,
            live: BigInt(aquaHash) !== 0n,
            feePpb,
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
  return {
    source: "rpc",
    sourceNote:
      "Direct on-chain reads (VaultRegistry, AssetVault, AquaAdapter, Aqua Shipped events). Graph indexing for the Aqua adapter is being added separately.",
    chainId: venue.chainId,
    blockNumber: blockNumber.toString(),
    lp,
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
        liveStrategies: item.strategies.filter((strategy) => strategy.live).length
      })),
      sharedBacking: backed.length >= 2,
      explanation:
        backed.length >= 2
          ? `The same ${principalText} principal is committed to ${backed.length} strategy classes at once (${backed
              .map((item) => `class ${item.classId} ${item.pair ?? "unknown pair"}`)
              .join(", ")}). Each class counts it as committed backing: the deposit is shared, not split.`
          : backed.length === 1
            ? `${principalText} principal is committed to one strategy class (${backed[0]?.pair ?? "unknown pair"}).`
            : "This address has no USDC committed to any strategy class yet."
    },
    ...(shipped.error ? { warnings: [`Aqua Shipped event scan incomplete: ${shipped.error}`] } : {})
  };
}

// ---------------------------------------------------------------------------------------------
// venue readiness

export type VenueReadiness = {
  ready: boolean;
  adapterAllowed: boolean;
  vaultsMissingVenueSettlerRole: Lowercase<string>[];
  hint?: string;
};

export async function readVenueReadiness(
  client: ReadClient,
  venue: SwapVMVenue,
  tokens: readonly TokenInfo[]
): Promise<VenueReadiness> {
  const [adapterAllowed, roles] = await Promise.all([
    client.readContract({
      address: getAddress(venue.registry),
      abi: vaultRegistryAbi,
      functionName: "isAllowedAdapter",
      args: [getAddress(venue.adapter)]
    }),
    Promise.all(
      tokens.map((token) =>
        client.readContract({
          address: getAddress(token.vault),
          abi: assetVaultAbi,
          functionName: "hasRole",
          args: [VENUE_SETTLER_ROLE, getAddress(venue.adapter)]
        })
      )
    )
  ]);
  const missing = tokens.filter((_, index) => !roles[index]).map((token) => token.vault);
  const ready = adapterAllowed && missing.length === 0;
  if (ready) {
    return { ready, adapterAllowed, vaultsMissingVenueSettlerRole: missing };
  }
  const actions = [
    ...(adapterAllowed ? [] : [`VaultRegistry.setAdapterAllowed(${venue.adapter}, true)`]),
    ...(missing.length > 0
      ? [`grantRole(VENUE_SETTLER_ROLE, ${venue.adapter}) on vault(s) ${missing.join(", ")}`]
      : [])
  ];
  return {
    ready,
    adapterAllowed,
    vaultsMissingVenueSettlerRole: missing,
    hint: `The AquaAdapter is not wired into Aqua0 core yet: the core admin must send ${actions.join(" and ")}. Ships and swaps revert until then.`
  };
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

async function ensureFxBacking(
  ctx: ExecContext,
  spec: PeggedStrategySpec,
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
  spec: PeggedStrategySpec,
  classId: bigint
): Promise<void> {
  const client = ctx.publicClient;
  const { pair } = spec;
  const [usdcAvailable, fxAvailable, isOperator, domainVersionHash, nonce, block] = await Promise.all([
    readVaultUint(client, pair.usdc.vault, "availableFor", classId),
    readVaultUint(client, pair.fx.vault, "availableFor", classId),
    client.readContract({
      address: getAddress(venue.adapter),
      abi: aquaAdapterAbi,
      functionName: "hasRole",
      args: [OPERATOR_ROLE, getAddress(ctx.signer)]
    }),
    client.readContract({
      address: getAddress(venue.adapter),
      abi: aquaAdapterAbi,
      functionName: "DOMAIN_VERSION_HASH"
    }),
    client.readContract({
      address: getAddress(venue.adapter),
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
      `Signer ${ctx.signer} lacks OPERATOR_ROLE on AquaAdapter ${venue.adapter}; the adapter admin must grantRole(${OPERATOR_ROLE}, ${ctx.signer})`
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
      adapter: venue.adapter,
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
    venue.adapter,
    () =>
      client.simulateContract({
        account: ctx.account,
        address: getAddress(venue.adapter),
        abi: aquaAdapterAbi,
        functionName: "shipStrategyWithFee",
        args: [
          classId,
          spec.strategyBytes,
          spec.tokens,
          spec.amounts,
          spec.feePpb,
          nonce,
          deadline,
          signature
        ]
      }),
    async () => (await readVenueReadiness(client, venue, [pair.usdc, pair.fx])).hint
  );
  if (!(await isStrategyLive(client, venue, spec.strategyId))) {
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

async function resolveLiveStrategy(
  client: ReadClient,
  venue: SwapVMVenue,
  input: Pick<FxSwapInput, "pair" | "strategyId" | "params">
): Promise<LiveStrategy> {
  let pair = input.pair ? resolvePair(input.pair) : undefined;
  let strategyId: Hex | undefined;
  let order: SwapVMOrder | undefined;
  let resolvedBy: LiveStrategy["resolvedBy"] = "pair-params";
  if (pair) {
    const spec = buildPeggedStrategySpec(venue.adapter, pair, input.params ?? {});
    strategyId = spec.strategyId;
    order = spec.order;
  }
  if (input.strategyId) {
    const wanted = normalizeBytes32(input.strategyId) as Hex;
    if (strategyId?.toLowerCase() !== wanted) {
      const found = await scanShippedStrategies(client, venue, wanted);
      const match = found.strategies[0];
      if (!match) {
        throw new Error(
          `strategyId ${wanted} does not match ${pair ? `the ${pair.name} params given` : "any params given"} and no Aqua Shipped event for it was found${
            found.error ? ` (event scan failed: ${found.error})` : ""
          }. Pass the pair plus the same params used when the strategy was created.`
        );
      }
      strategyId = wanted;
      order = match.order;
      resolvedBy = "aqua-shipped-event";
      pair = pair ?? (await pairForStrategy(client, venue, wanted));
    }
  }
  if (!pair || !strategyId || !order) {
    throw new Error('Pass pair (e.g. "USDC/ARS") or strategyId to choose the strategy');
  }
  const [aquaHash, classId, feePpb] = await Promise.all([
    client.readContract({
      address: getAddress(venue.adapter),
      abi: aquaAdapterAbi,
      functionName: "currentAquaHash",
      args: [strategyId]
    }),
    client.readContract({
      address: getAddress(venue.adapter),
      abi: aquaAdapterAbi,
      functionName: "strategyClassId",
      args: [strategyId]
    }),
    client.readContract({
      address: getAddress(venue.adapter),
      abi: aquaAdapterAbi,
      functionName: "strategyFeePpb",
      args: [strategyId]
    })
  ]);
  if (BigInt(aquaHash) === 0n) {
    throw new Error(
      `The ${pair.name} strategy ${strategyId} is not live on the AquaAdapter. Create it first with create_strategy (same params), or pass the params/strategyId used at creation.`
    );
  }
  return { pair, strategyId, order, classId, feePpb, resolvedBy };
}

async function pairForStrategy(client: ReadClient, venue: SwapVMVenue, strategyId: Hex): Promise<FxPair> {
  const tokens = await client.readContract({
    address: getAddress(venue.adapter),
    abi: aquaAdapterAbi,
    functionName: "getStrategyTokens",
    args: [strategyId]
  });
  if (tokens.length !== 2) {
    throw new Error(`Strategy ${strategyId} has ${tokens.length} tokens; expected a USDC/FX pair`);
  }
  return resolvePair(tokens.join("/"));
}

/** Aqua `Shipped` events made by the adapter, newest first, in 10k-block windows. Best effort. */
async function scanShippedStrategies(
  client: ReadClient,
  venue: SwapVMVenue,
  wanted?: Hex
): Promise<{ strategies: Array<{ strategyId: Hex; order: SwapVMOrder }>; error?: string }> {
  const strategies: Array<{ strategyId: Hex; order: SwapVMOrder }> = [];
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
        if (!maker || !strategyHash || !strategy || normalizeAddress(maker) !== venue.adapter) {
          continue;
        }
        const strategyId = strategyHash.toLowerCase() as Hex;
        if ((wanted && strategyId !== wanted) || strategies.some((item) => item.strategyId === strategyId)) {
          continue;
        }
        try {
          strategies.push({ strategyId, order: decodeSwapVMOrder(strategy) });
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
  venue: SwapVMVenue,
  strategy: LiveStrategy,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: bigint,
  taker: string | undefined
): Promise<bigint> {
  try {
    const { result } = await client.simulateContract({
      address: getAddress(venue.router),
      abi: aquaSwapVMRouterAbi,
      functionName: "quote",
      args: [
        strategy.order,
        getAddress(tokenIn.address),
        getAddress(tokenOut.address),
        amountIn,
        buildTakerTraitsAndData()
      ],
      account: taker ? getAddress(taker) : undefined
    });
    return result[1];
  } catch (error) {
    throw new Error(`quote reverted: ${describeContractError(error)}`);
  }
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

function strategyReference(strategy: LiveStrategy) {
  return {
    pair: strategy.pair.name,
    strategyId: strategy.strategyId,
    classId: strategy.classId.toString(),
    feePpb: strategy.feePpb,
    resolvedBy: strategy.resolvedBy
  };
}

function strategyIdentity(
  chainId: number,
  spec: PeggedStrategySpec,
  opcode: StrategyOpcode,
  strategist: Lowercase<string>,
  strategyKey: Hex,
  classId: bigint,
  live: boolean
) {
  return {
    chainId,
    pair: spec.pair.name,
    opcode,
    label: spec.label,
    strategist,
    strategyKey,
    classId: classId.toString(),
    strategyId: spec.strategyId,
    live,
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

async function isStrategyLive(client: ReadClient, venue: SwapVMVenue, strategyId: Hex): Promise<boolean> {
  const aquaHash = await client.readContract({
    address: getAddress(venue.adapter),
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
