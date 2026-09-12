/**
 * Execute-mode signers. `local` signs with WRITE_PRIVATE_KEY through a viem wallet client (the original path);
 * `circle` signs with a Circle developer-controlled EOA wallet, so the MCP can act for a user without holding a key.
 * Both give the execute paths the same three things: an account to simulate from, a contract write that returns the
 * transaction hash (callers still wait for and check the receipt), and EIP-712 signing.
 */
import {
  concat,
  encodeFunctionData,
  getAddress,
  keccak256,
  toBytes,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type HttpTransport,
  type WalletClient
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import {
  createCircleClient,
  executeCircleContractCall,
  resolveCircleWallet,
  signTypedDataWithCircle,
  type CircleTransactionOptions,
  type CircleTypedData,
  type CircleWalletRef,
  type CircleWalletsApi
} from "./circle.js";
import { normalizeAddress } from "./graph.js";
import type { WriteConfig } from "./write.js";

export type SignerKind = "local" | "circle";

/** A contract call as simulateContract returns it in `request`, or as the execute paths build it directly. */
export type ContractWriteRequest = {
  abi: Abi | readonly unknown[];
  address: Address;
  functionName: string;
  args?: readonly unknown[] | undefined;
  /** Bytes appended after the ABI-encoded call (e.g. a signed RedStone payload). */
  dataSuffix?: Hex | undefined;
  value?: bigint | undefined;
};

export type WriteSigner = {
  kind: SignerKind;
  address: Lowercase<string>;
  /** `account` for simulateContract: the local viem account, or the Circle wallet address (eth_call `from`). */
  account: PrivateKeyAccount | Address;
  /** Send the call and return its hash; callers wait for and check the receipt. */
  writeContract(request: ContractWriteRequest): Promise<Hex>;
  signTypedData(typedData: CircleTypedData): Promise<Hex>;
};

export type SignerEnvConfig = Pick<
  WriteConfig,
  | "signer"
  | "circleApiKey"
  | "circleEntitySecret"
  | "circleWalletSetId"
  | "circleWalletId"
  | "circleUserRef"
  | "circleOperatorWalletId"
  | "onboardUsdc"
  | "onboardDailyCapUsdc"
  | "onboardLedgerFile"
>;

/** SIGNER and the CIRCLE_* settings. SIGNER defaults to local even when Circle variables are present. */
export function readSignerEnv(env: Readonly<Record<string, string | undefined>>): SignerEnvConfig {
  const signer = env.SIGNER?.trim() || "local";
  if (signer !== "local" && signer !== "circle") {
    throw new Error("SIGNER must be local or circle");
  }
  if (signer === "local") {
    return { signer };
  }
  const entitySecret = env.CIRCLE_ENTITY_SECRET || env.ENTITY_SECRET;
  return {
    signer,
    ...(env.CIRCLE_API_KEY ? { circleApiKey: env.CIRCLE_API_KEY } : {}),
    ...(entitySecret ? { circleEntitySecret: entitySecret } : {}),
    ...(env.CIRCLE_WALLET_SET_ID ? { circleWalletSetId: env.CIRCLE_WALLET_SET_ID } : {}),
    ...(env.CIRCLE_WALLET_ID ? { circleWalletId: env.CIRCLE_WALLET_ID } : {}),
    ...(env.CIRCLE_USER_REF ? { circleUserRef: env.CIRCLE_USER_REF } : {}),
    ...(env.CIRCLE_OPERATOR_WALLET_ID ? { circleOperatorWalletId: env.CIRCLE_OPERATOR_WALLET_ID } : {}),
    ...(env.AQUA0_ONBOARD_USDC?.trim() ? { onboardUsdc: env.AQUA0_ONBOARD_USDC.trim() } : {}),
    ...(env.AQUA0_ONBOARD_DAILY_CAP_USDC?.trim() ? { onboardDailyCapUsdc: env.AQUA0_ONBOARD_DAILY_CAP_USDC.trim() } : {}),
    ...(env.AQUA0_ONBOARD_LEDGER?.trim() ? { onboardLedgerFile: env.AQUA0_ONBOARD_LEDGER.trim() } : {})
  };
}

/** The shared operator wallet (CIRCLE_OPERATOR_WALLET_ID) as a signer, or undefined when none is configured. */
export async function createCircleOperatorSigner(config: WriteConfig): Promise<WriteSigner | undefined> {
  if (resolveSignerKind(config) !== "circle" || !config.circleOperatorWalletId) {
    return undefined;
  }
  const { circleUserRef: _userRef, circleWalletSetId: _walletSetId, ...shared } = config;
  return createCircleSigner({ ...shared, circleWalletId: config.circleOperatorWalletId });
}

export function resolveSignerKind(config: WriteConfig): SignerKind {
  return config.signer === "circle" ? "circle" : "local";
}

/** Why the configured signer cannot sign, or undefined when it is fully configured (no network calls). */
export function signerConfigProblem(config: WriteConfig): string | undefined {
  if (resolveSignerKind(config) === "local") {
    return config.writePrivateKey ? undefined : "WRITE_PRIVATE_KEY is required";
  }
  const missing = [
    ...(config.circleClient || config.circleApiKey ? [] : ["CIRCLE_API_KEY"]),
    ...(config.circleClient || config.circleEntitySecret ? [] : ["CIRCLE_ENTITY_SECRET"]),
    ...(config.circleWalletId || (config.circleWalletSetId && config.circleUserRef)
      ? []
      : ["CIRCLE_WALLET_ID, or CIRCLE_WALLET_SET_ID with CIRCLE_USER_REF or a Privy sign-in (login)"])
  ];
  return missing.length > 0 ? `SIGNER=circle requires ${missing.join(", ")}` : undefined;
}

export function isSignerConfigured(config: WriteConfig): boolean {
  return signerConfigProblem(config) === undefined;
}

/** Address of the configured signer (never a secret), or undefined when none is configured. */
export async function resolveSignerAddress(config: WriteConfig): Promise<Lowercase<string> | undefined> {
  if (resolveSignerKind(config) === "local") {
    if (!config.writePrivateKey || !/^0x[0-9a-fA-F]{64}$/.test(config.writePrivateKey)) {
      return undefined;
    }
    return normalizeAddress(privateKeyToAccount(config.writePrivateKey as Hex).address);
  }
  if (!isSignerConfigured(config)) {
    return undefined;
  }
  return (await resolveCircleWalletForConfig(config)).address;
}

export function createLocalSigner(account: PrivateKeyAccount, wallet: WalletClient<HttpTransport, Chain>): WriteSigner {
  return {
    kind: "local",
    address: normalizeAddress(account.address),
    account,
    writeContract: (request) => wallet.writeContract({ ...request, account } as never),
    signTypedData: (typedData) => account.signTypedData(typedData as never)
  };
}

export async function createCircleSigner(
  config: WriteConfig,
  options: CircleTransactionOptions = {}
): Promise<WriteSigner> {
  const client = circleClientFor(config);
  const wallet = await resolveCircleWalletForConfig(config);
  return {
    kind: "circle",
    address: wallet.address,
    account: getAddress(wallet.address),
    writeContract: (request) =>
      withRedactedErrors(config, () =>
        executeCircleContractCall(
          client,
          {
            walletId: wallet.walletId,
            contractAddress: getAddress(request.address),
            callData: encodeContractWrite(request),
            value: request.value
          },
          options
        )
      ),
    signTypedData: (typedData) => withRedactedErrors(config, () => signTypedDataWithCircle(client, wallet, typedData))
  };
}

/** Calldata for a contract write: the ABI-encoded call plus any dataSuffix, as viem's writeContract sends it. */
export function encodeContractWrite(request: ContractWriteRequest): Hex {
  const data = encodeFunctionData({
    abi: request.abi,
    functionName: request.functionName,
    args: request.args
  } as Parameters<typeof encodeFunctionData>[0]);
  return request.dataSuffix ? concat([data, request.dataSuffix]) : data;
}

/** Replace every configured secret in a message. */
export function redactSecrets(
  message: string,
  config: Pick<WriteConfig, "circleApiKey" | "circleEntitySecret" | "writePrivateKey">
): string {
  const secrets = [config.circleApiKey, config.circleEntitySecret, config.writePrivateKey].filter(
    (value): value is string => value !== undefined && value.length >= 8
  );
  // Circle API keys are ENV:ID:SECRET; the parts can surface on their own.
  const keyParts = config.circleApiKey?.split(":").filter((part) => part.length >= 16) ?? [];
  let result = message;
  for (const secret of [...secrets, ...keyParts].sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join("[redacted]");
  }
  return result;
}

const circleClients = new Map<Hex, CircleWalletsApi>();
const circleWallets = new WeakMap<CircleWalletsApi, Map<string, Promise<CircleWalletRef>>>();

function circleClientFor(config: WriteConfig): CircleWalletsApi {
  if (config.circleClient) {
    return config.circleClient;
  }
  const { circleApiKey: apiKey, circleEntitySecret: entitySecret } = config;
  if (!apiKey || !entitySecret) {
    throw new Error("SIGNER=circle requires CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET");
  }
  const cacheKey = keccak256(toBytes(`${apiKey}\n${entitySecret}`));
  let client = circleClients.get(cacheKey);
  if (!client) {
    client = createCircleClient({ apiKey, entitySecret });
    circleClients.set(cacheKey, client);
  }
  return client;
}

/** Resolve (provisioning on first use) once per client and wallet selector; a failed lookup is retried next time. */
function resolveCircleWalletForConfig(config: WriteConfig): Promise<CircleWalletRef> {
  const client = circleClientFor(config);
  const selector = config.circleWalletId
    ? `id:${config.circleWalletId}`
    : `set:${config.circleWalletSetId ?? ""}:ref:${config.circleUserRef ?? ""}`;
  let lookups = circleWallets.get(client);
  if (!lookups) {
    lookups = new Map();
    circleWallets.set(client, lookups);
  }
  const cached = lookups.get(selector);
  if (cached) {
    return cached;
  }
  const byClient = lookups;
  const pending = withRedactedErrors(config, () =>
    resolveCircleWallet(client, {
      walletId: config.circleWalletId,
      walletSetId: config.circleWalletSetId,
      userRef: config.circleUserRef
    })
  ).catch((error: unknown) => {
    byClient.delete(selector);
    throw error;
  });
  byClient.set(selector, pending);
  return pending;
}

async function withRedactedErrors<T>(config: WriteConfig, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new Error(redactSecrets(error instanceof Error ? error.message : String(error), config));
  }
}
