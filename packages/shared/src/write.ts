import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  toBytes,
  type Chain,
  type Hex,
  type HttpTransport,
  type PublicClient,
  type WalletClient
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { assetVaultAbi, vaultRegistryAbi } from "./abis.js";
import type { CircleWalletsApi } from "./circle.js";

export type ReadClient = PublicClient<HttpTransport, Chain>;
import { ARC_TESTNET } from "./constants.js";
import { normalizeAddress, normalizeBytes32 } from "./graph.js";
import {
  createCircleSigner,
  createLocalSigner,
  isSignerConfigured,
  resolveSignerKind,
  signerConfigProblem,
  type SignerKind,
  type WriteSigner
} from "./signer.js";

export type WriteMode = "prepare" | "execute";

export type WriteConfig = {
  writeRpcUrl?: string;
  writeChainId?: number;
  vaultRegistryAddress?: string;
  writePrivateKey?: string;
  /** Execute-mode signer: local (WRITE_PRIVATE_KEY, the default) or circle (a Circle developer-controlled wallet). */
  signer?: SignerKind;
  /** Circle API key for SIGNER=circle. Secret. */
  circleApiKey?: string;
  /** Circle entity secret for SIGNER=circle. Secret. */
  circleEntitySecret?: string;
  /** Wallet set holding one Circle wallet per user ref. */
  circleWalletSetId?: string;
  /** Fixed Circle wallet to sign with; takes precedence over the wallet set lookup. */
  circleWalletId?: string;
  /** User ref: the wallet in circleWalletSetId with this refId, created on first use. */
  circleUserRef?: string;
  /** Pre-built Circle client (tests, embedding); otherwise built from circleApiKey and circleEntitySecret. */
  circleClient?: CircleWalletsApi;
  /**
   * Shared Circle operator wallet (an EOA holding OPERATOR_ROLE on the AquaAdapters). It sends shipStrategyWithFee
   * for users whose own wallet lacks the role, while the user's wallet still signs the strategy, and it tops up
   * newly signed-in users with testnet USDC.
   */
  circleOperatorWalletId?: string;
  /** Testnet USDC the operator sends a signed-in user holding under 1 USDC ("0" disables). Default 5. */
  onboardUsdc?: string;
  /** Most testnet USDC all top-ups may send in a rolling 24 hours. Default 50. */
  onboardDailyCapUsdc?: string;
  /** Top-up ledger (once per wallet and user). Default `~/.aqua0/onboarding-topups.json`. */
  onboardLedgerFile?: string;
  mcpWriteMode?: WriteMode;
  /** Aqua0 AquaAdapter (SwapVM venue). Defaults to the Arc Testnet deployment when WRITE_CHAIN_ID is Arc. */
  aquaAdapterAddress?: string;
  /** 1inch AquaSwapVMRouter. Defaults to the Arc Testnet deployment when WRITE_CHAIN_ID is Arc. */
  aquaSwapVMRouterAddress?: string;
  /** AquaForexSwapVMRouter (forex venue). Defaults to the Arc Testnet deployment when WRITE_CHAIN_ID is Arc. */
  fxswapRouterAddress?: string;
  /** AquaAdapter bound to the forex router (a second adapter: each binds one router immutably). */
  fxswapAquaAdapterAddress?: string;
  /** ARS-per-USD feed (ManualFxOracle / Chainlink-style) used by USDC/ARS forex strategies. */
  fxOracleArsUsdAddress?: string;
  /** BRL-per-USD feed used by USDC/BRL forex strategies. */
  fxOracleBrlUsdAddress?: string;
};

export type PreparedTransaction = {
  to: Lowercase<string>;
  value: "0";
  data: Hex;
  functionName: string;
  args: unknown[];
};

export type CreateStrategyInput = {
  strategist: string;
  token0: string;
  token1: string;
  label: string;
  vaults: string[];
};

export type PreparedCreateStrategy = {
  mode: "prepare";
  strategyKey: Hex;
  normalized: {
    strategist: Lowercase<string>;
    chainId: number;
    token0: Lowercase<string>;
    token1: Lowercase<string>;
    sortedToken0: Lowercase<string>;
    sortedToken1: Lowercase<string>;
    label: string;
    labelHash: Hex;
    vaults: Lowercase<string>[];
  };
  currentClassId: string;
  stage: "registerStrategyClass" | "registerVaultLegs";
  explanation: string;
  transactions: PreparedTransaction[];
};

export type ExecutionResult = {
  mode: "execute";
  chainId: number;
  strategyKey?: Hex;
  classId?: string;
  receipts: Array<{
    stage: string;
    to: Lowercase<string>;
    hash: Hex;
    blockNumber: string;
    status: "success" | "reverted";
  }>;
};

export function deriveStrategyKey(input: {
  strategist: string;
  chainId: number;
  token0: string;
  token1: string;
  label: string;
}): {
  strategyKey: Hex;
  strategist: Lowercase<string>;
  token0: Lowercase<string>;
  token1: Lowercase<string>;
  sortedToken0: Lowercase<string>;
  sortedToken1: Lowercase<string>;
  label: string;
  labelHash: Hex;
} {
  const strategist = normalizeAddress(input.strategist);
  const token0 = normalizeAddress(input.token0);
  const token1 = normalizeAddress(input.token1);
  const [sortedToken0, sortedToken1] =
    token0 < token1 ? [token0, token1] : [token1, token0];
  const label = input.label.trim();
  const labelHash = keccak256(toBytes(label));
  const encoded = encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" },
      { type: "address" },
      { type: "address" },
      { type: "bytes32" }
    ],
    [
      getAddress(strategist),
      BigInt(input.chainId),
      getAddress(sortedToken0),
      getAddress(sortedToken1),
      labelHash
    ]
  );

  return {
    strategyKey: keccak256(encoded),
    strategist,
    token0,
    token1,
    sortedToken0,
    sortedToken1,
    label,
    labelHash
  };
}

export function isExecutionAllowedByConfig(config: WriteConfig): boolean {
  if (config.mcpWriteMode !== "execute") {
    return false;
  }
  if (!config.writeRpcUrl || !config.writeChainId || !isSignerConfigured(config)) {
    return false;
  }
  if (config.writeChainId === 1 || config.writeChainId === 8453) {
    return false;
  }
  return config.writeChainId === ARC_TESTNET.chainId || isLocalRpcUrl(config.writeRpcUrl);
}

export function assertExecutionAllowed(config: WriteConfig): void {
  if (config.mcpWriteMode !== "execute") {
    throw new Error("Execution refused: MCP_WRITE_MODE must be execute");
  }
  const signerProblem = signerConfigProblem(config);
  if (signerProblem) {
    throw new Error(`Execution refused: ${signerProblem}`);
  }
  if (!config.writeRpcUrl) {
    throw new Error("Execution refused: WRITE_RPC_URL is required");
  }
  if (!config.writeChainId) {
    throw new Error("Execution refused: WRITE_CHAIN_ID is required");
  }
  if (config.writeChainId === 1 || config.writeChainId === 8453) {
    throw new Error("Execution refused: mainnet/Base writes are not allowed");
  }
  if (config.writeChainId !== ARC_TESTNET.chainId && !isLocalRpcUrl(config.writeRpcUrl)) {
    throw new Error(
      `Execution refused: chain ${config.writeChainId} is not Arc Testnet and WRITE_RPC_URL is not local Anvil`
    );
  }
}

export function prepareAuthorizeStrategy(input: {
  vault: string;
  strategyId: string;
  backing: boolean;
}): PreparedTransaction {
  const vault = normalizeAddress(input.vault);
  const strategyId = parseUint(input.strategyId, "strategyId");
  return {
    to: vault,
    value: "0",
    functionName: "setCommitment",
    args: [strategyId.toString(), input.backing],
    data: encodeFunctionData({
      abi: assetVaultAbi,
      functionName: "setCommitment",
      args: [strategyId, input.backing]
    })
  };
}

export function prepareDeposit(input: {
  vault: string;
  assets: string;
  receiver: string;
}): PreparedTransaction {
  const vault = normalizeAddress(input.vault);
  const receiver = normalizeAddress(input.receiver);
  const assets = parseUint(input.assets, "assets");
  return {
    to: vault,
    value: "0",
    functionName: "deposit",
    args: [assets.toString(), receiver],
    data: encodeFunctionData({
      abi: assetVaultAbi,
      functionName: "deposit",
      args: [assets, getAddress(receiver)]
    })
  };
}

export function prepareWithdraw(input: {
  vault: string;
  assets: string;
  receiver: string;
  owner: string;
}): PreparedTransaction {
  const vault = normalizeAddress(input.vault);
  const receiver = normalizeAddress(input.receiver);
  const owner = normalizeAddress(input.owner);
  const assets = parseUint(input.assets, "assets");
  return {
    to: vault,
    value: "0",
    functionName: "withdraw",
    args: [assets.toString(), receiver, owner],
    data: encodeFunctionData({
      abi: assetVaultAbi,
      functionName: "withdraw",
      args: [assets, getAddress(receiver), getAddress(owner)]
    })
  };
}

export async function prepareCreateStrategy(
  config: WriteConfig,
  input: CreateStrategyInput
): Promise<PreparedCreateStrategy> {
  const chainId = requireWriteChainId(config);
  const registry = requireRegistry(config);
  const key = deriveStrategyKey({ ...input, chainId });
  const vaults = input.vaults.map(normalizeAddress);
  if (vaults.length === 0) {
    throw new Error("At least one vault leg is required");
  }
  const classId = await readClassForStrategy(config, key.strategyKey);

  const normalized = {
    strategist: key.strategist,
    chainId,
    token0: key.token0,
    token1: key.token1,
    sortedToken0: key.sortedToken0,
    sortedToken1: key.sortedToken1,
    label: key.label,
    labelHash: key.labelHash,
    vaults
  };

  if (classId === 0n) {
    return {
      mode: "prepare",
      strategyKey: key.strategyKey,
      normalized,
      currentClassId: "0",
      stage: "registerStrategyClass",
      explanation:
        "No class id exists for this strategyKey. Submit stage 1 registerStrategyClass, wait for mining, then re-read classForStrategy before registering vault legs.",
      transactions: [
        {
          to: registry,
          value: "0",
          functionName: "registerStrategyClass",
          args: [key.strategyKey],
          data: encodeFunctionData({
            abi: vaultRegistryAbi,
            functionName: "registerStrategyClass",
            args: [key.strategyKey]
          })
        }
      ]
    };
  }

  const publicClient = createReadClient(config);
  const legStates = await Promise.all(
    vaults.map(async (vault) => ({
      vault,
      strategist: normalizeAddress(
        await publicClient.readContract({
          address: getAddress(vault),
          abi: assetVaultAbi,
          functionName: "classStrategist",
          args: [classId]
        })
      )
    }))
  );
  const zero = "0x0000000000000000000000000000000000000000";
  const conflicting = legStates.find(
    ({ strategist }) => strategist !== zero && strategist !== key.strategist
  );
  if (conflicting) {
    throw new Error(
      `Strategy class ${classId} on vault ${conflicting.vault} already belongs to strategist ${conflicting.strategist}`
    );
  }
  const missingVaults = legStates
    .filter(({ strategist }) => strategist === zero)
    .map(({ vault }) => vault);

  return {
    mode: "prepare",
    strategyKey: key.strategyKey,
    normalized,
    currentClassId: classId.toString(),
    stage: "registerVaultLegs",
    explanation:
      missingVaults.length === 0
        ? "classForStrategy returned an existing class id and every supplied vault leg is already registered to this strategist. No transaction is required."
        : "classForStrategy returned an existing class id. Submit registerStrategy only for the supplied vault legs that are not already registered to this strategist.",
    transactions: missingVaults.map((vault) => ({
      to: vault,
      value: "0",
      functionName: "registerStrategy",
      args: [classId.toString(), key.strategist],
      data: encodeFunctionData({
        abi: assetVaultAbi,
        functionName: "registerStrategy",
        args: [classId, getAddress(key.strategist)]
      })
    }))
  };
}

export async function executeCreateStrategy(
  config: WriteConfig,
  input: CreateStrategyInput
): Promise<ExecutionResult> {
  assertExecutionAllowed(config);
  const chainId = requireWriteChainId(config);
  const { signer, publicClient } = await createExecutionClients(config);
  const prepared = await prepareCreateStrategy(config, input);
  const receipts: ExecutionResult["receipts"] = [];
  let classId = BigInt(prepared.currentClassId);

  if (prepared.stage === "registerStrategyClass") {
    const tx = prepared.transactions[0];
    if (!tx) {
      throw new Error("Missing registerStrategyClass transaction");
    }
    const hash = await signer.writeContract({
      abi: vaultRegistryAbi,
      address: getAddress(tx.to),
      functionName: "registerStrategyClass",
      args: [prepared.strategyKey]
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assertReceiptSuccess(receipt, "registerStrategyClass", hash);
    receipts.push(formatReceipt("registerStrategyClass", tx.to, hash, receipt));
    classId = await readClassForStrategy(config, prepared.strategyKey);
    if (classId === 0n) {
      throw new Error("classForStrategy still returned 0 after registerStrategyClass mined");
    }
  }

  const legTransactions =
    prepared.stage === "registerVaultLegs"
      ? prepared.transactions
      : (await prepareCreateStrategy(config, input)).transactions;
  for (const tx of legTransactions) {
    if (tx.functionName !== "registerStrategy") continue;
    const hash = await signer.writeContract({
      abi: assetVaultAbi,
      address: getAddress(tx.to),
      functionName: "registerStrategy",
      args: [classId, getAddress(prepared.normalized.strategist)]
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assertReceiptSuccess(receipt, "registerStrategy", hash);
    receipts.push(formatReceipt("registerStrategy", tx.to, hash, receipt));
  }

  return {
    mode: "execute",
    chainId,
    strategyKey: prepared.strategyKey,
    classId: classId.toString(),
    receipts
  };
}

export async function executeAuthorizeStrategy(
  config: WriteConfig,
  input: { vault: string; strategyId: string; backing: boolean }
): Promise<ExecutionResult> {
  assertExecutionAllowed(config);
  const chainId = requireWriteChainId(config);
  const { signer, publicClient } = await createExecutionClients(config);
  const tx = prepareAuthorizeStrategy(input);
  const hash = await signer.writeContract({
    abi: assetVaultAbi,
    address: getAddress(tx.to),
    functionName: "setCommitment",
    args: [parseUint(input.strategyId, "strategyId"), input.backing]
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assertReceiptSuccess(receipt, "setCommitment", hash);

  return {
    mode: "execute",
    chainId,
    receipts: [formatReceipt("setCommitment", tx.to, hash, receipt)]
  };
}

async function readClassForStrategy(config: WriteConfig, strategyKey: Hex): Promise<bigint> {
  const publicClient = createReadClient(config);
  return publicClient.readContract({
    address: getAddress(requireRegistry(config)),
    abi: vaultRegistryAbi,
    functionName: "classForStrategy",
    args: [normalizeBytes32(strategyKey) as Hex]
  });
}

export function createReadClient(config: WriteConfig): ReadClient {
  const chainId = requireWriteChainId(config);
  const rpcUrl = requireWriteRpcUrl(config);
  return createPublicClient({
    chain: makeChain(chainId, rpcUrl),
    transport: http(rpcUrl)
  });
}

export async function createExecutionClients(
  config: WriteConfig
): Promise<{ publicClient: ReadClient; wallet: WalletClient<HttpTransport, Chain>; signer: WriteSigner }> {
  const chainId = requireWriteChainId(config);
  const rpcUrl = requireWriteRpcUrl(config);
  const chain = makeChain(chainId, rpcUrl);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== chainId) {
    throw new Error(
      `Execution refused: WRITE_CHAIN_ID ${chainId} does not match RPC chain ${actualChainId}`
    );
  }
  if (actualChainId === 1 || actualChainId === 8453) {
    throw new Error("Execution refused: mainnet/Base writes are not allowed");
  }
  const wallet = createWalletClient({ chain, transport: http(rpcUrl) });
  const signer = await createWriteSigner(config, wallet);
  return { publicClient, wallet, signer };
}

/**
 * The execute-mode signer SIGNER selects: the WRITE_PRIVATE_KEY account (default) or a Circle developer-controlled
 * wallet. Circle broadcasts to Arc Testnet itself, so it is refused on a local fork RPC, which would never see the
 * transaction.
 */
export async function createWriteSigner(
  config: WriteConfig,
  wallet: WalletClient<HttpTransport, Chain>
): Promise<WriteSigner> {
  if (resolveSignerKind(config) === "local") {
    return createLocalSigner(privateKeyToAccount(normalizePrivateKey(config.writePrivateKey)), wallet);
  }
  if (config.writeChainId !== ARC_TESTNET.chainId || !config.writeRpcUrl || isLocalRpcUrl(config.writeRpcUrl)) {
    throw new Error(
      `Execution refused: SIGNER=circle sends through Circle on Arc Testnet, so it needs WRITE_CHAIN_ID ${ARC_TESTNET.chainId} and a non-local WRITE_RPC_URL`
    );
  }
  return createCircleSigner(config);
}

function makeChain(chainId: number, rpcUrl: string) {
  return defineChain({
    id: chainId,
    name: chainId === ARC_TESTNET.chainId ? "Arc Testnet" : "Local Anvil",
    nativeCurrency:
      chainId === ARC_TESTNET.chainId
        ? { name: "USDC", symbol: "USDC", decimals: 6 }
        : { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } }
  });
}

export function requireWriteChainId(config: WriteConfig): number {
  if (!config.writeChainId || !Number.isSafeInteger(config.writeChainId) || config.writeChainId <= 0) {
    throw new Error("WRITE_CHAIN_ID is required");
  }
  return config.writeChainId;
}

function requireWriteRpcUrl(config: WriteConfig): string {
  if (!config.writeRpcUrl) {
    throw new Error("WRITE_RPC_URL is required");
  }
  return config.writeRpcUrl;
}

function requireRegistry(config: WriteConfig): Lowercase<string> {
  if (!config.vaultRegistryAddress) {
    throw new Error("VAULT_REGISTRY_ADDRESS is required");
  }
  return normalizeAddress(config.vaultRegistryAddress);
}

function parseUint(value: string, field: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${field} must be a non-negative integer string`);
  }
  return BigInt(trimmed);
}

export function normalizePrivateKey(value: string | undefined): Hex {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("WRITE_PRIVATE_KEY must be a 32-byte hex string");
  }
  return value as Hex;
}

function isLocalRpcUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "ws:") &&
      ["127.0.0.1", "localhost", "0.0.0.0"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export function assertReceiptSuccess(
  receipt: { status: "success" | "reverted" },
  stage: string,
  hash: Hex
): void {
  if (receipt.status !== "success") {
    throw new Error(`${stage} transaction ${hash} reverted`);
  }
}

function formatReceipt(
  stage: string,
  to: Lowercase<string>,
  hash: Hex,
  receipt: { blockNumber: bigint; status: "success" | "reverted" }
): ExecutionResult["receipts"][number] {
  return {
    stage,
    to,
    hash,
    blockNumber: receipt.blockNumber.toString(),
    status: receipt.status
  };
}
