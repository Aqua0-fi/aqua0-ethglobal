/**
 * Circle developer-controlled wallets as an Aqua0 execution signer.
 *
 * The wallet is an EOA on ARC-TESTNET: CIRCLE_WALLET_ID when set, otherwise the wallet in CIRCLE_WALLET_SET_ID whose
 * refId is CIRCLE_USER_REF, created on first use. Contract calls go through Circle's contract-execution API and are
 * polled to a final state. EIP-712 signatures come from Circle's signTypedData and are checked by recovery, because
 * the AquaAdapter verifies EOA strategist signatures with plain ECDSA.
 */
import {
  initiateDeveloperControlledWalletsClient,
  type CircleDeveloperControlledWalletsClient
} from "@circle-fin/developer-controlled-wallets";
import { formatUnits, isHex, keccak256, recoverTypedDataAddress, toBytes, type Hex } from "viem";

import { normalizeAddress } from "./graph.js";

/** Circle's blockchain id for Arc Testnet (chain 5042002). */
export const CIRCLE_BLOCKCHAIN = "ARC-TESTNET" as const;

/** The Circle client calls Aqua0 makes; tests pass a mock with this shape. */
export type CircleWalletsApi = Pick<
  CircleDeveloperControlledWalletsClient,
  | "getWallet"
  | "listWallets"
  | "createWallets"
  | "createContractExecutionTransaction"
  | "getTransaction"
  | "signTypedData"
>;

export type CircleWalletRef = {
  walletId: string;
  address: Lowercase<string>;
  /** True when this lookup created the wallet. */
  provisioned: boolean;
};

export type CircleTransactionOptions = {
  /** Delay between getTransaction polls, default 1.5 s. */
  pollIntervalMs?: number;
  /** Budget from submission to COMPLETE, default 3 minutes. */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/** EIP-712 typed data in viem's shape (`buildShipTypedData`, `hashTypedData` input). */
export type CircleTypedData = {
  domain?: Record<string, unknown> | undefined;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
};

type CircleWallet = {
  id: string;
  address: string;
  blockchain: string;
  state: string;
  accountType?: string | undefined;
  refId?: string | undefined;
  createDate?: string | undefined;
};

const FAILED_STATES = new Set(["FAILED", "DENIED", "CANCELLED"]);

const DOMAIN_FIELD_TYPES = [
  ["name", "string"],
  ["version", "string"],
  ["chainId", "uint256"],
  ["verifyingContract", "address"],
  ["salt", "bytes32"]
] as const;

export function createCircleClient(input: { apiKey: string; entitySecret: string }): CircleWalletsApi {
  return initiateDeveloperControlledWalletsClient({ apiKey: input.apiKey, entitySecret: input.entitySecret });
}

/**
 * The signing wallet: `walletId` when given; otherwise the oldest LIVE wallet in `walletSetId` whose refId is
 * `userRef`, provisioning an ARC-TESTNET EOA with that refId when none exists.
 */
export async function resolveCircleWallet(
  client: CircleWalletsApi,
  input: { walletId?: string | undefined; walletSetId?: string | undefined; userRef?: string | undefined }
): Promise<CircleWalletRef> {
  const { walletId, walletSetId, userRef } = input;
  if (walletId) {
    const response = await circleCall("getWallet", () => client.getWallet({ id: walletId }));
    const wallet = response.data?.wallet as CircleWallet | undefined;
    if (!wallet) {
      throw new Error(`Circle wallet ${walletId} was not found`);
    }
    return { ...usableWallet(wallet), provisioned: false };
  }
  if (!walletSetId || !userRef) {
    throw new Error("The Circle signer needs CIRCLE_WALLET_ID, or CIRCLE_WALLET_SET_ID with CIRCLE_USER_REF");
  }

  const listed = await circleCall("listWallets", () =>
    client.listWallets({ walletSetId, refId: userRef, blockchain: CIRCLE_BLOCKCHAIN, pageSize: 50 })
  );
  const matches = ((listed.data?.wallets ?? []) as CircleWallet[])
    .filter((wallet) => wallet.refId === userRef && wallet.blockchain === CIRCLE_BLOCKCHAIN)
    .sort((a, b) => (a.createDate ?? "").localeCompare(b.createDate ?? ""));
  const live = matches.find((wallet) => wallet.state === "LIVE");
  if (live) {
    return { ...usableWallet(live), provisioned: false };
  }
  if (matches[0]) {
    throw new Error(`Circle wallet ${matches[0].id} for user ref ${userRef} is ${matches[0].state}, not LIVE`);
  }

  const created = await circleCall("createWallets", () =>
    client.createWallets({
      walletSetId,
      blockchains: [CIRCLE_BLOCKCHAIN],
      count: 1,
      accountType: "EOA",
      metadata: [{ name: userRef, refId: userRef }],
      idempotencyKey: provisioningIdempotencyKey(walletSetId, userRef)
    })
  );
  const wallet = (created.data?.wallets ?? [])[0] as CircleWallet | undefined;
  if (!wallet) {
    throw new Error(`Circle createWallets returned no wallet for user ref ${userRef}`);
  }
  return { ...usableWallet(wallet), provisioned: true };
}

/** Deterministic UUID for one user's provisioning request, so two concurrent first uses create one wallet. */
export function provisioningIdempotencyKey(walletSetId: string, userRef: string): string {
  const hex = keccak256(toBytes(`aqua0:circle-wallet:${walletSetId}:${userRef}`)).slice(2, 34).split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const id = hex.join("");
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/**
 * Submit a contract call from the wallet and poll it to COMPLETE; returns the transaction hash. Throws with Circle's
 * errorReason on FAILED, DENIED or CANCELLED, and after `timeoutMs` in any other state.
 */
export async function executeCircleContractCall(
  client: CircleWalletsApi,
  input: { walletId: string; contractAddress: string; callData: Hex; value?: bigint | undefined },
  options: CircleTransactionOptions = {}
): Promise<Hex> {
  const created = await circleCall("createContractExecutionTransaction", () =>
    client.createContractExecutionTransaction({
      walletId: input.walletId,
      contractAddress: input.contractAddress,
      callData: input.callData,
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      // Circle takes native value in whole units; Arc's native USDC has 18 decimals at the EVM level.
      ...(input.value && input.value > 0n ? { amount: formatUnits(input.value, 18) } : {})
    })
  );
  const id = created.data?.id;
  if (!id) {
    throw new Error("Circle createContractExecutionTransaction returned no transaction id");
  }
  return waitForCircleTransaction(client, id, options);
}

export async function waitForCircleTransaction(
  client: CircleWalletsApi,
  id: string,
  options: CircleTransactionOptions = {}
): Promise<Hex> {
  const pollIntervalMs = options.pollIntervalMs ?? 1_500;
  const timeoutMs = options.timeoutMs ?? 180_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let lastState = "unknown";
  let pollError: string | undefined;

  for (;;) {
    let transaction:
      | { state: string; txHash?: string | undefined; errorReason?: string | undefined; errorDetails?: string | undefined }
      | undefined;
    try {
      // A failed poll is not a failed transaction: keep polling until the deadline.
      transaction = (await client.getTransaction({ id })).data?.transaction;
      pollError = undefined;
    } catch (error) {
      pollError = describeCircleError("getTransaction", error);
    }
    if (transaction) {
      lastState = transaction.state;
      if (transaction.state === "COMPLETE") {
        if (!transaction.txHash || !isHex(transaction.txHash)) {
          throw new Error(`Circle transaction ${id} is COMPLETE but has no txHash`);
        }
        return transaction.txHash;
      }
      if (FAILED_STATES.has(transaction.state)) {
        const reason = transaction.errorReason ? `: ${transaction.errorReason}` : "";
        const details = transaction.errorDetails ? ` (${transaction.errorDetails})` : "";
        const hash = transaction.txHash ? `, tx ${transaction.txHash}` : "";
        throw new Error(`Circle transaction ${id} ${transaction.state}${reason}${details}${hash}`);
      }
    }
    if (now() >= deadline) {
      throw new Error(
        `Circle transaction ${id} did not reach COMPLETE within ${Math.round(timeoutMs / 1000)}s (last state ${lastState}${pollError ? `; ${pollError}` : ""}). It may still be mined: check the wallet before retrying.`
      );
    }
    await sleep(pollIntervalMs);
  }
}

/** EIP-712 JSON for Circle's signTypedData: an explicit EIP712Domain type and bigints as decimal strings. */
export function serializeTypedDataForCircle(typedData: CircleTypedData): string {
  const domain = typedData.domain ?? {};
  const eip712Domain = DOMAIN_FIELD_TYPES.filter(([name]) => domain[name] !== undefined).map(([name, type]) => ({
    name,
    type
  }));
  return JSON.stringify(
    {
      types: { EIP712Domain: eip712Domain, ...typedData.types },
      domain,
      primaryType: typedData.primaryType,
      message: typedData.message
    },
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value)
  );
}

/** Sign with the Circle wallet, refusing any signature that does not recover to the wallet address. */
export async function signTypedDataWithCircle(
  client: CircleWalletsApi,
  wallet: { walletId: string; address: string },
  typedData: CircleTypedData
): Promise<Hex> {
  const response = await circleCall("signTypedData", () =>
    client.signTypedData({ walletId: wallet.walletId, data: serializeTypedDataForCircle(typedData) })
  );
  const signature = response.data?.signature;
  if (!signature || !isHex(signature)) {
    throw new Error(`Circle signTypedData returned no hex signature for wallet ${wallet.walletId}`);
  }
  await assertTypedDataSigner(typedData, signature, wallet.address, `Circle wallet ${wallet.walletId}`);
  return signature;
}

export async function assertTypedDataSigner(
  typedData: CircleTypedData,
  signature: Hex,
  expected: string,
  label: string
): Promise<void> {
  let recovered: Lowercase<string>;
  try {
    recovered = normalizeAddress(
      await recoverTypedDataAddress({ ...typedData, signature } as Parameters<typeof recoverTypedDataAddress>[0])
    );
  } catch (error) {
    throw new Error(`${label} returned a signature that does not recover: ${errorMessage(error)}`);
  }
  if (recovered !== normalizeAddress(expected)) {
    throw new Error(
      `${label} signature recovers to ${recovered}, not the wallet address ${normalizeAddress(expected)}; refusing to use it`
    );
  }
}

/** Circle API failure as a message: status, code and Circle's message only, never the request config or headers. */
export function describeCircleError(operation: string, error: unknown): string {
  const fields = (typeof error === "object" && error !== null ? error : {}) as { status?: unknown; code?: unknown };
  const tags = [
    typeof fields.status === "number" ? `HTTP ${fields.status}` : undefined,
    fields.code !== undefined && fields.code !== fields.status ? `code ${String(fields.code)}` : undefined
  ].filter((tag): tag is string => tag !== undefined);
  return `Circle ${operation} failed${tags.length > 0 ? ` (${tags.join(", ")})` : ""}: ${errorMessage(error)}`;
}

async function circleCall<T>(operation: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    // A fresh Error without `cause`, so the SDK's axios error (request headers included) is never logged.
    throw new Error(describeCircleError(operation, error));
  }
}

function usableWallet(wallet: CircleWallet): Omit<CircleWalletRef, "provisioned"> {
  if (wallet.blockchain !== CIRCLE_BLOCKCHAIN) {
    throw new Error(`Circle wallet ${wallet.id} is on ${wallet.blockchain}; the Aqua0 signer needs an ${CIRCLE_BLOCKCHAIN} wallet`);
  }
  if (wallet.accountType && wallet.accountType !== "EOA") {
    throw new Error(
      `Circle wallet ${wallet.id} is an ${wallet.accountType} wallet; the AquaAdapter checks ship signatures with ECDSA, so the signer must be an EOA`
    );
  }
  if (wallet.state !== "LIVE") {
    throw new Error(`Circle wallet ${wallet.id} is ${wallet.state}, not LIVE`);
  }
  return { walletId: wallet.id, address: normalizeAddress(wallet.address) };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return (error as Error & { shortMessage?: string }).shortMessage ?? error.message;
  }
  return String(error);
}
